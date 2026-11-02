import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncService } from '../src/services/sync.service.js';
import { MemoryRepository } from './helpers.js';
import { syntheticWeekend } from '../fixtures/synthetic-weekend.js';
import { reconcileDataset } from '../src/reconciliation/datasets.js';
import { normalizeWeekend } from '../src/models/normalization.js';
import { validateSchema, operations, contract } from '../src/schemas/contract.js';
import { ReadService } from '../src/services/read.service.js';

test('R19 refresh preserves nullable Standing fields through normalization, preservation, publication and reads', async () => {
  // Fictional identities with provider-shaped R18/R19 data; not asserted race facts.
  const bundle = (round) => {
    const value = syntheticWeekend();
    value.race.season = '2026';
    value.race.round = String(round);
    value.race.date = round === 19 ? '2026-11-01' : '2026-10-25';
    value.race.time = '20:00:00Z';
    return value;
  };
  const repo = new MemoryRepository();
  repo.sets.clear();
  repo.aliases = {};
  const service = new SyncService(repo);
  await service.publish(bundle(18), 'jolpica');
  // Stored legacy standings lack a now-required nullable metric. Newly appearing
  // rows exercise the same missing-prior-value branch without any legacy shape.
  for (const set of repo.sets.values())
    if (set.schema === 'Standing') {
      for (const row of set.items) delete row.podiums;
    }
  const next = bundle(19);
  for (const kind of ['drivers', 'constructors']) {
    const added = structuredClone(next.standings[kind][0]);
    added.position = '2';
    added.points = '0';
    added.wins = '0';
    if (kind === 'drivers') added.Driver.driverId = 'new-driver';
    else added.Constructor.constructorId = 'new-constructor';
    next.standings[kind].push(added);
  }
  const normalized = normalizeWeekend(next, { sources: [], retrievedAt: '2026-11-02T10:00:00Z' });
  for (const set of normalized.sets.filter((set) => set.schema === 'Standing'))
    for (const row of set.items) assert.equal(validateSchema('Standing', row).valid, true);
  await service.publish(next, 'jolpica', null, { preserveExisting: true });
  for (const kind of ['drivers', 'constructors']) {
    for (const key of [`standings:2026:${kind}`, `standings:2026:${kind}:19`]) {
      const set = repo.sets.get(key);
      for (const row of set.items) {
        for (const required of contract.components.schemas.Standing.required)
          assert.notEqual(row[required], undefined, `${key} missing ${required}`);
        assert.equal(row.podiums, null);
        assert.equal(row.podiumCoverage, null);
        assert.equal(row.gapCoverage, null);
        assert.equal(validateSchema('Standing', row).valid, true);
      }
    }
    const result = await new ReadService(repo).read(
      operations.find((op) => op.operationId === 'getStandings'),
      { params: { year: 2026, kind }, query: { round: 19 } },
    );
    assert.equal(validateSchema(result.responseSchema, result.body).valid, true);
    assert.equal(result.body.data.items[0].podiumCoverage.throughRound, 19);
    assert.ok(result.body.data.titleOutlook);
  }
});
test('sync validates and republishes without duplicating identities', async () => {
  const repo = new MemoryRepository();
  const service = new SyncService(repo);
  await service.publish(syntheticWeekend(), 'jolpica');
  await service.publish(syntheticWeekend(), 'jolpica');
  assert.equal(repo.sets.get('seasons').items.length, 1);
  assert.equal([...repo.sets.values()].find((s) => s.key.startsWith('results:')).items.length, 2);
});
test('source precedence retains primary facts and records disagreements', () => {
  const old = {
    key: 'example',
    schema: 'Standing',
    items: [{ id: 'one', evidenceId: 'old', points: '25' }],
    evidenceId: 'old',
    coverage: 'partial',
    verification: 'source-only',
    warnings: [],
    provenance: {
      retrievedAt: '2024-01-01T00:00:00Z',
      sources: [{ id: 'jolpica', version: null, url: 'https://example.invalid' }],
    },
  };
  const next = structuredClone(old);
  next.items[0].points = '26';
  next.evidenceId = 'new';
  next.provenance.sources[0].id = 'f1db';
  const result = reconcileDataset(old, next);
  assert.equal(result.items[0].points, '25');
  assert.equal(result.verification, 'conflict');
  assert.equal(result.fieldComparisons[0].assertions[1].value, '26');
});
test('bad normalization cannot become a publication', async () => {
  const repo = new MemoryRepository();
  let published = false;
  repo.publish = async () => {
    published = true;
  };
  const service = new SyncService(repo);
  await assert.rejects(
    service.publishSets(
      {
        sets: [{ key: 'bad', schema: 'Season', items: [{ id: 'bad', year: 'invalid' }] }],
        aliases: {},
      },
      [],
      'jolpica',
    ),
    { code: 'NORMALIZED_SCHEMA_INVALID' },
  );
  assert.equal(published, false);
});

test('empty refresh enrichment retains old records, source evidence, and provenance', async () => {
  const repo = new MemoryRepository();
  const key = 'laps:session:event:2026:round-16:race';
  const previous = {
    key,
    schema: 'Lap',
    items: [{ id: 'lap:one', evidenceId: 'evidence:old-laps', durationMs: 91234 }],
    evidenceId: 'evidence:old-laps',
    coverage: 'complete',
    verification: 'source-only',
    warnings: [],
    provenance: { retrievedAt: '2026-09-27T00:00:00.000Z', sources: [{ id: 'openf1' }] },
  };
  repo.sets.set(key, structuredClone(previous));
  const refresh = {
    key,
    schema: 'Lap',
    items: [],
    evidenceId: 'evidence:new-results-only',
    coverage: 'unavailable',
    verification: 'source-only',
    warnings: [],
    provenance: { retrievedAt: '2026-10-05T19:46:00.000Z', sources: [{ id: 'jolpica' }] },
  };

  await new SyncService(repo).publishSets({ sets: [refresh], aliases: {} }, [], 'jolpica');

  const retained = repo.sets.get(key);
  assert.equal(retained.items[0].durationMs, 91234);
  assert.equal(retained.items[0].evidenceId, 'evidence:old-laps');
  assert.equal(retained.evidenceId, 'evidence:old-laps');
  assert.deepEqual(retained.provenance, previous.provenance);
  assert.equal(retained.coverage, 'partial');
  assert.ok(retained.warnings.some((warning) => warning.code === 'RETAINED_SNAPSHOT'));
});
