import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { appFixture, MemoryRepository } from './helpers.js';

test('record scopes and comparison kinds reject incompatible identities', async () => {
  const { app } = appFixture();
  await request(app)
    .get('/api/v1/records')
    .query({ scope: 'driver', entityId: 'constructor:example-team', metric: 'wins' })
    .expect(400);
  await request(app)
    .get('/api/v1/records')
    .query({ scope: 'circuit', entityId: 'circuit:example-circuit', metric: 'points' })
    .expect(400);
  await request(app)
    .get('/api/v1/comparisons')
    .query({
      kind: 'driver',
      leftId: 'driver:example-one',
      rightId: 'constructor:example-team',
      fromYear: 2024,
      toYear: 2024,
      metric: 'wins',
    })
    .expect(400);
  await request(app).get('/api/v1/circuits/driver%3Aexample-one/layouts').expect(404);
  await request(app)
    .get('/api/v1/records')
    .query({ scope: 'season', year: 2099, metric: 'wins' })
    .expect(404);
  await request(app)
    .get('/api/v1/drivers/driver%3Aexample-one/results')
    .query({ year: 2099 })
    .expect(404);
});

test('known season comparisons return unavailable metrics instead of looking up driver profiles', async () => {
  const repository = new MemoryRepository();
  const seasons = repository.sets.get('seasons');
  seasons.items.push({ ...seasons.items[0], id: 'season:2023', year: 2023 });
  const { app } = appFixture(repository);
  await request(app)
    .get('/api/v1/comparisons')
    .query({
      kind: 'season',
      leftId: 'season:2023',
      rightId: 'season:2024',
      fromYear: 2023,
      toYear: 2024,
      metric: 'wins',
    })
    .expect(200)
    .expect((response) => {
      if (response.body.meta.coverage !== 'unavailable')
        throw new Error('Unavailable metrics must remain explicit.');
    });
});

test('historical standings without driver numbers remain readable', async () => {
  const repository = new MemoryRepository();
  for (const key of ['standings:2024:drivers', 'standings:2024:constructors'])
    repository.sets.get(key).items.forEach((row) => delete row.number);

  const { app } = appFixture(repository);
  await request(app)
    .get('/api/v1/seasons/2024/summary')
    .expect(200)
    .expect((response) => {
      assert.equal(response.body.data.seasonSummary.leadingDrivers[0].number, null);
      assert.equal(response.body.data.seasonSummary.leadingConstructors[0].number, null);
    });
  await request(app)
    .get('/api/v1/seasons/2024/standings/drivers')
    .expect(200)
    .expect((response) => assert.equal(response.body.data.items[0].number, null));
});
