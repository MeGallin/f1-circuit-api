import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncService } from '../src/services/sync.service.js';
import { MemoryRepository } from './helpers.js';
import { syntheticWeekend } from '../fixtures/synthetic-weekend.js';
import { reconcileDataset } from '../src/reconciliation/datasets.js';
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
  );
  assert.equal(published, false);
});
