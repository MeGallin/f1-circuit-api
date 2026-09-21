import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { appFixture } from './helpers.js';
import { deriveExpected } from './question-contract/expected.js';

function fixtureData(repository) {
  return {
    get: repository.get.bind(repository),
    keys: repository.keys.bind(repository),
  };
}

function evidenceFrom(response) {
  return [
    ...(response.body.data.questionResult.evidenceIds || []),
    response.body.meta.evidenceId,
  ].filter(Boolean);
}

async function ask(app, text, context = {}) {
  const body = Object.keys(context).length ? { text, context } : { text };
  return request(app).post('/api/v1/questions').send(body).expect(200);
}

test('fixture contract proves event, seasonal aggregate and evidence lineage independently', async () => {
  const { app, repository } = appFixture();
  const data = fixtureData(repository);

  const eventScenario = {
    derive: 'eventWinner',
    constraints: { event: 'Synthetic Grand Prix', year: 2024 },
    year: 2024,
    event: 'Synthetic Grand Prix',
  };
  const eventExpected = await deriveExpected(eventScenario, data);
  const eventResponse = await ask(app, 'Who won the Synthetic Grand Prix in 2024?');
  const eventResult = eventResponse.body.data.questionResult;
  assert.equal(eventExpected.status, 'answered');
  assert.equal(eventResult.resolvedIntent, 'event_winner');
  assert.equal(eventResult.values.driver, eventExpected.fields.driver);
  assert.equal(eventResult.values.year, eventExpected.fields.year);
  assert.ok(
    eventExpected.requiredEvidenceIds.some((id) => evidenceFrom(eventResponse).includes(id)),
  );
  assert.equal('matches' in (eventResult.values || {}), false);

  const circuitScenario = {
    derive: 'eventCircuit',
    constraints: { event: 'Synthetic Grand Prix', year: 2024 },
    year: 2024,
    event: 'Synthetic Grand Prix',
  };
  const circuitExpected = await deriveExpected(circuitScenario, data);
  const circuitResponse = await ask(app, 'Which circuit hosted the 2024 Synthetic Grand Prix?');
  const circuitResult = circuitResponse.body.data.questionResult;
  assert.equal(circuitResult.resolvedIntent, 'event_circuit');
  assert.equal(circuitResult.values.circuit, circuitExpected.fields.circuit);
  assert.match(circuitResult.values.answer, /2024 Synthetic Grand Prix/);
  assert.ok(
    circuitExpected.requiredEvidenceIds.some((id) => evidenceFrom(circuitResponse).includes(id)),
  );

  const seasonScenario = {
    derive: 'driverSeasonWins',
    constraints: { driver: 'Example One', year: 2024 },
    driver: 'Example One',
  };
  const seasonExpected = await deriveExpected(seasonScenario, data);
  const seasonResponse = await ask(app, 'How many races did Example One win in 2024?');
  const seasonResult = seasonResponse.body.data.questionResult;
  assert.equal(seasonResult.resolvedIntent, 'driver_race_wins_season');
  assert.equal(seasonResult.values.count, seasonExpected.fields.count);
  assert.equal(seasonResult.values.season, 2024);
  assert.match(seasonResult.values.answer, /in 2024\./);
  assert.ok(
    seasonExpected.requiredEvidenceIds.some((id) => evidenceFrom(seasonResponse).includes(id)),
  );
  assert.equal('matches' in (seasonResult.values || {}), false);
});

test('fixture contract records explicit unavailable sparse coverage instead of generic search', async () => {
  const { app, repository } = appFixture();
  const expected = await deriveExpected(
    {
      derive: 'unavailableDataset',
      constraints: { event: 'Synthetic Grand Prix', year: 2024 },
      datasetPrefix: 'weather:',
      unavailableReason: 'WEATHER_NOT_PUBLISHED',
    },
    fixtureData(repository),
  );
  const response = await ask(app, 'What was the weather at the Synthetic Grand Prix in 2024?');
  const result = response.body.data.questionResult;
  assert.equal(expected.status, 'unavailable');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reasonCode, expected.reasonCode);
  assert.equal(result.resolvedIntent, undefined);
  assert.equal('matches' in (result.values || {}), false);
});
