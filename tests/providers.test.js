import test from 'node:test';
import assert from 'node:assert/strict';
import { duration, classification, normalizeWeekend } from '../src/models/normalization.js';
import { validateSchema } from '../src/schemas/contract.js';
import { syntheticWeekend } from '../fixtures/synthetic-weekend.js';
import { compareAssertions } from '../src/reconciliation/compare.js';
import { Jolpica } from '../src/providers/jolpica/client.js';
import { OpenF1 } from '../src/providers/openf1/client.js';
test('normalization preserves fractional points, unknown times and source-only quality', () => {
  assert.equal(duration('1:23.456'), 83456);
  assert.equal(duration('unknown'), null);
  assert.equal(duration(null), null);
  const bundle = syntheticWeekend();
  const { sets } = normalizeWeekend(bundle, { retrievedAt: '2024-01-02T00:00:00Z', sources: [] });
  for (const set of sets)
    for (const item of set.items) {
      const result = validateSchema(set.schema, item);
      assert.ok(result.valid, `${set.key}: ${JSON.stringify(result.errors)}`);
    }
  const result = classification(bundle.race.Results[0], 'test');
  assert.equal(result.points, '12.5');
  assert.equal(result.classified, null);
  assert.deepEqual(classification(bundle.race.Results[1], 'test').gap, { kind: 'laps', laps: 1 });
});
test('reconciliation distinguishes shared lineage, independent agreement and conflicts', () => {
  const a = { value: '12.50', unit: 'points', lineage: 'a' },
    b = { value: '12.5', unit: 'points', lineage: 'b' };
  assert.equal(compareAssertions([a, b]).state, 'reconciled');
  assert.equal(compareAssertions([a, { ...b, lineage: 'a' }]).state, 'source-only');
  assert.equal(compareAssertions([a, { ...b, value: '13' }]).state, 'conflict');
});
test('Jolpica lap pagination counts timing rows, not enclosing laps', async () => {
  const paths = [];
  const client = new Jolpica({
    async get(path) {
      paths.push(path);
      const second = paths.length === 2;
      return {
        payload: {
          MRData: {
            total: '3',
            RaceTable: { Races: [{ Laps: [{ number: '1', Timings: second ? [{}] : [{}, {}] }] }] },
          },
        },
      };
    },
  });
  await client.pages('2024/1/laps', 'RaceTable', 'Races', 'Laps');
  assert.ok(paths[1].endsWith('offset=2'));
});
test('OpenF1 rejects future and unsupported sessions before detail reads', async () => {
  const client = new OpenF1({
    async get() {
      return { payload: [{ session_key: 1, date_end: '2999-01-01T00:00:00Z', year: 2999 }] };
    },
  });
  await assert.rejects(client.session(1), /historical/);
});

test('missing standing ranks remain unknown instead of inferred row numbers', () => {
  const bundle = syntheticWeekend();
  delete bundle.standings.drivers[0].position;
  const result = normalizeWeekend(bundle, { retrievedAt: '2024-01-01T00:00:00Z', sources: [] });
  assert.equal(
    result.sets.find((s) => s.key === `standings:${bundle.race.season}:drivers`).items[0].rank,
    null,
  );
});
