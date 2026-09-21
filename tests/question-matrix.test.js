import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { appFixture, sessionId } from './helpers.js';

function addLeaderboardRows(repository) {
  const source = repository.sets.get(`results:${sessionId}`);
  const rowsByYear = {
    2018: [
      { driverId: 'driver:example-one', driver: 'Example One', constructorId: 'constructor:example-team', constructor: 'Example Team', position: 1, points: '25', fastest: true },
      { driverId: 'driver:example-two', driver: 'Example Two', constructorId: 'constructor:second-team', constructor: 'Second Team', position: 2, points: '18', fastest: false },
    ],
    2019: [
      { driverId: 'driver:example-one', driver: 'Example One', constructorId: 'constructor:example-team', constructor: 'Example Team', position: 2, points: '18', fastest: true },
      { driverId: 'driver:example-two', driver: 'Example Two', constructorId: 'constructor:second-team', constructor: 'Second Team', position: 1, points: '25', fastest: false },
    ],
    2020: [
      { driverId: 'driver:example-one', driver: 'Example One', constructorId: 'constructor:second-team', constructor: 'Second Team', position: 1, points: '25', fastest: true },
    ],
  };
  const keys = Object.keys(rowsByYear).map(
    (year) => `results:session:event:${year}:matrix-grand-prix:race`,
  );
  keys.forEach((key, index) => {
    const year = 2018 + index;
    const session = `session:event:${year}:matrix-grand-prix:race`;
    const set = JSON.parse(JSON.stringify(source));
    set.key = key;
    set.items = rowsByYear[year].map((entry, rowIndex) => ({
      ...source.items[0],
      id: `${key}:${rowIndex + 1}`,
      sessionId: session,
      position: entry.position,
      points: entry.points,
      entry: {
        ...source.items[0].entry,
        id: `${session}:${entry.driverId}`,
        constructor: { id: entry.constructorId, displayName: entry.constructor },
        drivers: [{ ...source.items[0].entry.drivers[0], id: entry.driverId, displayName: entry.driver }],
      },
      fastestLap: entry.fastest ? { rank: 1, lapNumber: 30 + rowIndex, durationMs: 90000 } : null,
    }));
    repository.sets.set(key, set);
  });
  return keys;
}

test('question matrix supports natural leaderboard wording and combined constraints', async () => {
  const { app, repository } = appFixture();
  const keys = addLeaderboardRows(repository);

  const fastest = await request(app)
    .post('/api/v1/questions')
    .send({
      text: 'Who set the most fastest laps between 2018 and 2020, and which teams did they drive for?',
    })
    .expect(200);
  assert.equal(fastest.body.data.questionResult.status, 'answered');
  assert.equal(fastest.body.data.questionResult.resolvedIntent, 'fastest_lap_leaderboard');
  assert.match(fastest.body.data.questionResult.values.answer, /Example One recorded 3 fastest laps/);

  const podiums = await request(app)
    .post('/api/v1/questions')
    .send({
      text: 'Who had the most podiums from 2018 through 2020, and what teams did they represent?',
    })
    .expect(200);
  assert.equal(podiums.body.data.questionResult.status, 'answered');
  assert.equal(podiums.body.data.questionResult.resolvedIntent, 'podium_leaderboard');
  assert.match(podiums.body.data.questionResult.values.answer, /Example One recorded 3 podium finishes/);

  const wins = await request(app)
    .post('/api/v1/questions')
    .send({
      text: 'Who won the most races from 2018 through 2020, and which teams did they drive for?',
    })
    .expect(200);
  assert.equal(wins.body.data.questionResult.status, 'answered');
  assert.equal(wins.body.data.questionResult.resolvedIntent, 'race_win_leaderboard');
  assert.match(wins.body.data.questionResult.values.answer, /Example One won 2 races/);

  keys.forEach((key) => repository.sets.delete(key));
});
