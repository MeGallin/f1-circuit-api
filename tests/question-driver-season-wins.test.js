import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { appFixture } from './helpers.js';

function addDriverProfile(repository, id, displayName) {
  const baseKey = [...repository.sets.keys()].find((key) => key === 'profile:driver:example-one');
  const base = repository.sets.get(baseKey);
  repository.sets.set(`profile:${id}`, {
    ...base,
    key: `profile:${id}`,
    items: [
      {
        ...base.items[0],
        id,
        entity: { ...base.items[0].entity, id, displayName },
      },
    ],
    evidenceId: `evidence:${id}`,
  });
}

function addSeasonResults(repository, year, driverId, displayName, positions) {
  const baseKey = [...repository.sets.keys()].find((key) => key.startsWith('results:'));
  const base = repository.sets.get(baseKey);
  const sessionId = `session:event:${year}:season-wins-grand-prix:race`;
  repository.sets.set(`results:${sessionId}`, {
    ...base,
    key: `results:${sessionId}`,
    items: positions.map((position, index) => ({
      ...base.items[0],
      id: `result:${sessionId}:${driverId}:${index}`,
      sessionId,
      position,
      entry: {
        ...base.items[0].entry,
        id: `entry:${sessionId}:${driverId}:${index}`,
        drivers: [{ ...base.items[0].entry.drivers[0], id: driverId, displayName }],
      },
    })),
    coverage: 'complete',
    evidenceId: `evidence:results:${year}:${driverId}`,
  });
}

async function ask(app, text) {
  const response = await request(app).post('/api/v1/questions').send({ text }).expect(200);
  return response.body.data.questionResult;
}

function assertNotGenericSearch(result, text) {
  assert.notEqual(result.resolvedIntent, 'archive_search', text);
  assert.equal('matches' in (result.values || {}), false, text);
}

test('seasonal driver race wins answer exact and natural aliases from published rows', async () => {
  const { app, repository } = appFixture();
  addDriverProfile(repository, 'driver:max-verstappen', 'Max Verstappen');
  addDriverProfile(repository, 'driver:lewis-hamilton', 'Lewis Hamilton');
  addSeasonResults(repository, 2023, 'driver:max-verstappen', 'Max Verstappen', [1, 1, 2]);
  addSeasonResults(repository, 2020, 'driver:lewis-hamilton', 'Lewis Hamilton', [1]);

  const cases = [
    {
      text: 'How many races did Max Verstappen win in 2023?',
      driver: 'Max Verstappen',
      season: 2023,
      count: 2,
    },
    {
      text: 'How many wins did Max Verstappen have in 2023?',
      driver: 'Max Verstappen',
      season: 2023,
      count: 2,
    },
    {
      text: 'How many Grand Prix victories did Max Verstappen have during the 2023 season?',
      driver: 'Max Verstappen',
      season: 2023,
      count: 2,
    },
    {
      text: 'How many races did Lewis Hamilton win in 2020?',
      driver: 'Lewis Hamilton',
      season: 2020,
      count: 1,
    },
  ];

  for (const entry of cases) {
    const result = await ask(app, entry.text);
    assert.equal(result.status, 'answered', entry.text);
    assert.equal(result.resolvedIntent, 'driver_race_wins_season', entry.text);
    assert.equal(result.templateKey, 'driver_race_wins_season', entry.text);
    assert.equal(result.values.driver, entry.driver, entry.text);
    assert.equal(result.values.metric, 'race_wins', entry.text);
    assert.equal(result.values.season, entry.season, entry.text);
    assert.equal(result.values.count, entry.count, entry.text);
    assert.equal(result.values.coverage, 'complete', entry.text);
    assert.match(
      result.values.answer,
      new RegExp(`${entry.driver} won ${entry.count} race`),
      entry.text,
    );
    assert.match(result.values.answer, new RegExp(`in ${entry.season}\\.`), entry.text);
    assert.doesNotMatch(result.values.answer, /career|71 races/, entry.text);
    assert.ok(result.evidenceIds.length, entry.text);
    assertNotGenericSearch(result, entry.text);
  }
});

test('seasonal win questions keep missing drivers and seasons explicit', async () => {
  const { app, repository } = appFixture();
  addDriverProfile(repository, 'driver:max-verstappen', 'Max Verstappen');
  addSeasonResults(repository, 2023, 'driver:max-verstappen', 'Max Verstappen', [1, 1]);

  const missingDriver = await ask(app, 'How many races did Unknown Driver win in 2023?');
  assert.equal(missingDriver.status, 'clarification');
  assert.equal(missingDriver.message, 'Which driver do you mean?');
  assertNotGenericSearch(missingDriver, 'missing driver');

  const missingSeason = await ask(app, 'How many races did Max Verstappen win in 2022?');
  assert.equal(missingSeason.status, 'unavailable');
  assert.equal(missingSeason.reasonCode, 'DRIVER_RACE_WINS_SEASON_NOT_PUBLISHED');
  assertNotGenericSearch(missingSeason, 'missing season');
});
