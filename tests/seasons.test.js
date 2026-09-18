import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { Jolpica } from '../src/providers/jolpica/client.js';
import { SyncService } from '../src/services/sync.service.js';
import { MemoryRepository, appFixture } from './helpers.js';
import { validateSchema } from '../src/schemas/contract.js';
test('provider season index follows pagination instead of generating years', async () => {
  const paths = [];
  const client = new Jolpica({
    async get(path) {
      paths.push(path);
      return {
        payload: {
          MRData: {
            total: '2',
            SeasonTable: { Seasons: [{ season: paths.length === 1 ? '1950' : '2026' }] },
          },
        },
      };
    },
  });
  const result = await client.seasons();
  assert.deepEqual(
    result.records.map((row) => row.season),
    ['1950', '2026'],
  );
  assert.ok(paths[1].endsWith('offset=1'));
});
test('catalogue publication retains imported seasons, event facts and honest missing coverage', async () => {
  const repo = new MemoryRepository();
  const before = structuredClone(repo.sets.get('events:2024'));
  const bundle = {
    records: [
      { season: '1950' },
      { season: '2024' },
      { season: String(new Date().getUTCFullYear()) },
    ],
    observations: [],
  };
  await new SyncService(repo).publishSeasonCatalogue(bundle);
  await new SyncService(repo).publishSeasonCatalogue(bundle);
  const rows = repo.sets.get('seasons').items;
  assert.equal(rows.length, 3);
  assert.equal(rows.find((row) => row.year === 1950).coverage, 'unavailable');
  assert.equal(rows.find((row) => row.year === 1950).eventCount, 0);
  assert.equal(rows.find((row) => row.year === 2024).eventCount, before.items.length);
  assert.deepEqual(repo.sets.get('events:2024'), before);
  for (const row of rows) assert.equal(validateSchema('Season', row).valid, true);
  const { app } = appFixture(repo);
  const calendar = await request(app).get('/api/v1/seasons/1950/calendar').expect(200);
  assert.deepEqual(calendar.body.data.items, []);
  assert.equal(calendar.body.meta.coverage, 'unavailable');
  const summary = await request(app).get('/api/v1/seasons/1950/summary').expect(200);
  assert.equal(summary.body.data.seasonSummary.season.coverage, 'unavailable');
  assert.equal(summary.body.data.seasonSummary.nextEvent, null);
  await request(app).get('/api/v1/seasons/1900/calendar').expect(400);
  await request(app).get('/api/v1/seasons/2099/calendar').expect(404);
});
test('invalid catalogue does not publish invented seasons', async () => {
  const repo = new MemoryRepository();
  const service = new SyncService(repo);
  await assert.rejects(
    service.publishSeasonCatalogue({ records: [{ season: 'not-a-year' }], observations: [] }),
  );
  assert.equal(repo.sets.get('seasons').items.length, 1);
});
