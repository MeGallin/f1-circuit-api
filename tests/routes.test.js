import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { operations, validateSchema } from '../src/schemas/contract.js';
import { appFixture, eventId, exampleRequest, sessionId } from './helpers.js';
test('every documented operation returns its schema with explicit data/coverage', async () => {
  const { app, repository } = appFixture();
  for (const operation of operations) {
    const e = exampleRequest(operation, repository);
    let r = request(app)[operation.method](e.path).query(e.query);
    if (operation.method === 'post') r = r.send(e.body);
    const result = await r;
    assert.equal(result.status, 200, `${operation.operationId}: ${result.text}`);
    const name = operation.responses['200'].content['application/json'].schema.$ref
      .split('/')
      .at(-1);
    assert.ok(validateSchema(name, result.body).valid, operation.operationId);
  }
});
test('pagination/filtering, snapshots, validation and ETag are consistent', async () => {
  const { app } = appFixture();
  const path = `/api/v1/sessions/${encodeURIComponent(sessionId)}/results`;
  const first = await request(app).get(path).query({ limit: 1 }).expect(200);
  assert.equal(first.body.data.items.length, 1);
  assert.equal(first.body.data.page.hasMore, true);
  const second = await request(app)
    .get(path)
    .query({ limit: 1, cursor: first.body.data.page.nextCursor })
    .expect(200);
  assert.notEqual(first.body.data.items[0].id, second.body.data.items[0].id);
  await request(app)
    .get(path)
    .query({ limit: 2, cursor: first.body.data.page.nextCursor })
    .expect(400);
  const filtered = await request(app)
    .get(path)
    .query({ driverId: 'driver:example-two' })
    .expect(200);
  assert.equal(filtered.body.data.items[0].entry.drivers[0].id, 'driver:example-two');
  await request(app).get(path).query({ snapshotId: 'expired' }).expect(409);
  await request(app).get(path).query({ limit: 'NaN' }).expect(400);
  await request(app).get(path).query({ bad: 'x' }).expect(400);
  await request(app)
    .get(path)
    .query({ limit: 1 })
    .set('If-None-Match', first.headers.etag)
    .expect(304);
  await request(app).get('/api/v1/events/unknown').expect(404);
  await request(app).get('/api/v1/sessions/unknown/laps').expect(404);
});
test('profile history resolves named event and session context without exposing only IDs', async () => {
  const { app } = appFixture();
  const result = await request(app)
    .get('/api/v1/drivers/driver%3Aexample-one/results')
    .query({ year: 2024 })
    .expect(200);
  const row = result.body.data.items[0];
  assert.equal(row.eventContext.event.name, 'Synthetic Grand Prix');
  assert.equal(row.eventContext.event.year, 2024);
  assert.equal(row.eventContext.session.label, 'Race');
  assert.equal(row.eventContext.session.kind, 'race');
});
test('search matches comma-separated terms while preserving record type filters', async () => {
  const { app } = appFixture();
  const all = await request(app)
    .get('/api/v1/search')
    .query({ q: 'Example,+Synthetic' })
    .expect(200);
  const allNames = all.body.data.items.map((item) => item.entity.displayName);
  assert.ok(allNames.includes('Example One'));
  assert.ok(allNames.includes('Synthetic Grand Prix'));

  const events = await request(app)
    .get('/api/v1/search')
    .query({ q: 'Example,+Synthetic', kind: 'event' })
    .expect(200);
  assert.deepEqual(
    events.body.data.items.map((item) => item.entity.displayName),
    ['Synthetic Grand Prix'],
  );
});

test('natural-language questions return database-backed answers without a model', async () => {
  const { app, repository } = appFixture();
  const winner = await request(app)
    .post('/api/v1/questions')
    .send({
      text: 'Who won?',
      context: {
        year: 2024,
        eventId,
        sessionId,
        driverId: null,
        constructorId: null,
      },
    })
    .expect(200);
  assert.equal(winner.body.data.questionResult.status, 'answered');
  assert.match(winner.body.data.questionResult.values.answer, /Example One won/);
  assert.ok(winner.body.data.questionResult.evidenceIds.length);

  const explicitYear = await request(app)
    .post('/api/v1/questions')
    .send({
      text: 'Who won the Synthetic Grand Prix in 2024?',
      context: {
        year: 2026,
        eventId: null,
        sessionId: null,
        driverId: null,
        constructorId: null,
      },
    })
    .expect(200);
  assert.equal(explicitYear.body.data.questionResult.values.year, 2024);

  const count = await request(app)
    .post('/api/v1/questions')
    .send({ text: 'How many times did Example One drive for Example Team in 2024?' })
    .expect(200);
  assert.equal(count.body.data.questionResult.status, 'answered');
  assert.equal(count.body.data.questionResult.values.count, 1);
  assert.match(count.body.data.questionResult.values.answer, /1 race start/);

  const lastWin = await request(app)
    .post('/api/v1/questions')
    .send({ text: 'When did Example One last win a race?' })
    .expect(200);
  assert.equal(lastWin.body.data.questionResult.status, 'answered');
  assert.equal(lastWin.body.data.questionResult.values.event, 'Synthetic Grand Prix');
  assert.equal(lastWin.body.data.questionResult.values.date, '2024-01-01');

  const raceWins = await request(app)
    .post('/api/v1/questions')
    .send({ text: 'How many races has Example One won in his career?' })
    .expect(200);
  assert.equal(raceWins.body.data.questionResult.status, 'answered');
  assert.equal(raceWins.body.data.questionResult.values.count, 1);
  assert.match(raceWins.body.data.questionResult.values.answer, /has won 1 race/);

  const raceWinsWithFirst = await request(app)
    .post('/api/v1/questions')
    .send({ text: 'How many races has Example One won in his career and which was his first?' })
    .expect(200);
  assert.equal(raceWinsWithFirst.body.data.questionResult.values.count, 1);
  assert.equal(
    raceWinsWithFirst.body.data.questionResult.values.firstWinEvent,
    'Synthetic Grand Prix',
  );
  assert.match(raceWinsWithFirst.body.data.questionResult.values.answer, /first win was/);

  const comparedWins = await request(app)
    .post('/api/v1/questions')
    .send({ text: 'How many races has Example One won in his career compared to Example Two?' })
    .expect(200);
  assert.equal(comparedWins.body.data.questionResult.resolvedIntent, 'driver_race_wins_comparison');
  assert.equal(comparedWins.body.data.questionResult.values.count, 1);
  assert.equal(comparedWins.body.data.questionResult.values.comparisonCount, 0);
  assert.match(
    comparedWins.body.data.questionResult.values.answer,
    /compared with Example Two's 0/,
  );

  const podium = await request(app)
    .post('/api/v1/questions')
    .send({ text: 'Who finished on the podium at the Synthetic Grand Prix in 2024?' })
    .expect(200);
  assert.equal(podium.body.data.questionResult.resolvedIntent, 'event_podium');
  assert.match(podium.body.data.questionResult.values.podium, /P1 Example One/);
  assert.equal(podium.body.data.questionResult.values.missingPositions, '3');

  const pole = await request(app)
    .post('/api/v1/questions')
    .send({ text: 'Who was on pole at the Synthetic Grand Prix in 2024?' })
    .expect(200);
  assert.equal(pole.body.data.questionResult.values.drivers, 'Example One');

  const fastestLap = await request(app)
    .post('/api/v1/questions')
    .send({ text: 'Who set the fastest lap at the Synthetic Grand Prix in 2024?' })
    .expect(200);
  assert.equal(fastestLap.body.data.questionResult.status, 'unavailable');
  assert.equal(fastestLap.body.data.questionResult.reasonCode, 'FASTEST_LAP_NOT_PUBLISHED');

  const mostPitStops = await request(app)
    .post('/api/v1/questions')
    .send({ text: 'Who made the most pit stops at the Synthetic Grand Prix in 2024?' })
    .expect(200);
  assert.equal(mostPitStops.body.data.questionResult.values.count, 1);
  assert.match(mostPitStops.body.data.questionResult.values.answer, /Example One/);

  const fastestPitStop = await request(app)
    .post('/api/v1/questions')
    .send({ text: 'What was the fastest pit stop at the Synthetic Grand Prix in 2024?' })
    .expect(200);
  assert.equal(fastestPitStop.body.data.questionResult.values.durationMs, 20000);
  assert.equal(fastestPitStop.body.data.questionResult.values.durationType, 'lane');

  const podiums = await request(app)
    .post('/api/v1/questions')
    .send({ text: 'How many podiums has Example One had in his career?' })
    .expect(200);
  assert.equal(podiums.body.data.questionResult.values.metric, 'podiums');
  assert.equal(podiums.body.data.questionResult.values.count, 1);

  const raceStarts = await request(app)
    .post('/api/v1/questions')
    .send({ text: 'How many race starts has Example One made?' })
    .expect(200);
  assert.equal(raceStarts.body.data.questionResult.values.metric, 'race_starts');
  assert.equal(raceStarts.body.data.questionResult.values.count, 1);

  const ambiguousDnf = await request(app)
    .post('/api/v1/questions')
    .send({ text: 'How many DNFs has Example One had?' })
    .expect(200);
  assert.equal(ambiguousDnf.body.data.questionResult.status, 'clarification');
  assert.match(ambiguousDnf.body.data.questionResult.message, /retirements/);

  const resultRows = (await repository.get(`results:${sessionId}`)).items;
  const entryId = resultRows[0].entry.id;
  repository.sets.set(`stints:${sessionId}`, {
    key: `stints:${sessionId}`,
    schema: 'Stint',
    items: [
      {
        entryId: await entryId,
        sequence: 1,
        startLap: 1,
        endLap: 5,
        compoundLabel: 'Soft',
        compoundClass: 'soft',
        tyreAgeAtStart: 0,
        tyreState: 'new',
      },
      {
        entryId: await entryId,
        sequence: 2,
        startLap: 6,
        endLap: 10,
        compoundLabel: 'Medium',
        compoundClass: 'medium',
        tyreAgeAtStart: 0,
        tyreState: 'new',
      },
    ],
    coverage: 'partial',
    verification: 'source-only',
    evidenceId: 'evidence:synthetic-stints',
    provenance: { retrievedAt: '2024-01-02T00:00:00Z', sources: [] },
    warnings: [],
  });
  repository.sets.set(`weather:${sessionId}`, {
    key: `weather:${sessionId}`,
    schema: 'Weather',
    items: [
      { airTemperatureC: 23, trackTemperatureC: 35, rainfall: false },
      { airTemperatureC: 24, trackTemperatureC: 36, rainfall: true },
    ],
    coverage: 'partial',
    verification: 'source-only',
    evidenceId: 'evidence:synthetic-weather',
    provenance: { retrievedAt: '2024-01-02T00:00:00Z', sources: [] },
    warnings: [],
  });
  repository.sets.set(`race-control:${sessionId}`, {
    key: `race-control:${sessionId}`,
    schema: 'RaceControl',
    items: [
      { category: 'SafetyCar', message: 'Safety Car deployed', flag: null },
      { category: 'Flag', message: 'Red flag', flag: 'RED' },
    ],
    coverage: 'partial',
    verification: 'source-only',
    evidenceId: 'evidence:synthetic-control',
    provenance: { retrievedAt: '2024-01-02T00:00:00Z', sources: [] },
    warnings: [],
  });
  repository.sets.set(`overtakes:${sessionId}`, {
    key: `overtakes:${sessionId}`,
    schema: 'Overtake',
    items: [
      { passingEntryId: entryId, passedEntryId: resultRows[1].entry.id, lap: 5 },
      { passingEntryId: entryId, passedEntryId: resultRows[1].entry.id, lap: 12 },
      { passingEntryId: resultRows[1].entry.id, passedEntryId: entryId, lap: 18 },
    ],
    coverage: 'partial',
    verification: 'source-only',
    evidenceId: 'evidence:synthetic-overtakes',
    provenance: { retrievedAt: '2024-01-02T00:00:00Z', sources: [] },
    warnings: [],
  });

  const tyres = await request(app)
    .post('/api/v1/questions')
    .send({ text: 'What tyres did Example One use at the Synthetic Grand Prix in 2024?' })
    .expect(200);
  assert.equal(tyres.body.data.questionResult.values.compounds, 'Soft, Medium');
  assert.equal(tyres.body.data.questionResult.values.stintCount, 2);

  const weather = await request(app)
    .post('/api/v1/questions')
    .send({ text: 'Did it rain at the Synthetic Grand Prix in 2024?' })
    .expect(200);
  assert.equal(weather.body.data.questionResult.values.rainfallObservations, 1);

  const raceControl = await request(app)
    .post('/api/v1/questions')
    .send({ text: 'How many safety cars were there at the Synthetic Grand Prix in 2024?' })
    .expect(200);
  assert.equal(raceControl.body.data.questionResult.values.safetyCarEvents, 1);

  const abbreviatedRaceControl = await request(app)
    .post('/api/v1/questions')
    .send({ text: 'How many safety cars were there at the Synthetic GP in 2024?' })
    .expect(200);
  assert.equal(abbreviatedRaceControl.body.data.questionResult.values.safetyCarEvents, 1);

  const overtakes = await request(app)
    .post('/api/v1/questions')
    .send({ text: 'Who made the most overtakes at the Synthetic Grand Prix in 2024?' })
    .expect(200);
  assert.equal(overtakes.body.data.questionResult.status, 'answered');
  assert.equal(overtakes.body.data.questionResult.values.count, 2);
  assert.match(overtakes.body.data.questionResult.values.answer, /Example One/);
});
