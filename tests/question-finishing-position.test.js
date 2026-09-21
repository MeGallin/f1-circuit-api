import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { appFixture } from './helpers.js';

function addResultSet(repository, rows) {
  const baseKey = [...repository.sets.keys()].find((key) => key.startsWith('results:'));
  const base = repository.sets.get(baseKey);
  const key = 'results:session:event:2023:position-test-grand-prix:race';
  repository.sets.set(key, {
    ...base,
    key,
    items: rows,
    evidenceId: 'evidence:position-test',
  });
}

function resultRow(baseRow, { driverId, displayName, position, suffix }) {
  const sessionId = 'session:event:2023:position-test-grand-prix:race';
  return {
    ...baseRow,
    id: `result:${sessionId}:${driverId}:${suffix}`,
    sessionId,
    position,
    entry: {
      ...baseRow.entry,
      id: `entry:${sessionId}:${driverId}:${suffix}`,
      drivers: [{ ...baseRow.entry.drivers[0], id: driverId, displayName }],
    },
  };
}

async function ask(app, text) {
  const response = await request(app).post('/api/v1/questions').send({ text }).expect(200);
  return response.body.data.questionResult;
}

function assertNoGenericSearch(result, text) {
  assert.notEqual(result.resolvedIntent, 'archive_search', text);
  assert.equal('matches' in (result.values || {}), false, text);
}

test('finishing-position leaderboards cover ordinal, numeric and legacy second-place aliases', async () => {
  const { app, repository } = appFixture();
  const baseRows = (
    await repository.get([...repository.sets.keys()].find((key) => key.startsWith('results:')))
  ).items;
  addResultSet(repository, [
    resultRow(baseRows[0], {
      driverId: 'driver:example-one',
      displayName: 'Example One',
      position: 5,
      suffix: 'fifth-one',
    }),
    resultRow(baseRows[1], {
      driverId: 'driver:example-two',
      displayName: 'Example Two',
      position: 5,
      suffix: 'fifth-two-a',
    }),
    resultRow(baseRows[1], {
      driverId: 'driver:example-two',
      displayName: 'Example Two',
      position: 5,
      suffix: 'fifth-two-b',
    }),
    resultRow(baseRows[0], {
      driverId: 'driver:example-one',
      displayName: 'Example One',
      position: 3,
      suffix: 'third-one',
    }),
    resultRow(baseRows[1], {
      driverId: 'driver:example-two',
      displayName: 'Example Two',
      position: 3,
      suffix: 'third-two',
    }),
  ]);

  const cases = [
    {
      text: 'Which driver has had the most first-place finishes?',
      driver: 'Example One',
      count: 1,
      position: 1,
    },
    {
      text: 'Which driver has had the most second-place finishes?',
      driver: 'Example Two',
      count: 1,
      position: 2,
    },
    {
      text: 'Which driver has finished 2nd most often in Formula 1?',
      driver: 'Example Two',
      count: 1,
      position: 2,
    },
    {
      text: 'Who has the most second places?',
      driver: 'Example Two',
      count: 1,
      position: 2,
    },
    {
      text: 'Which driver has had the most 5th-place finishes?',
      driver: 'Example Two',
      count: 2,
      position: 5,
    },
  ];

  for (const entry of cases) {
    const result = await ask(app, entry.text);
    assert.equal(result.status, 'answered', entry.text);
    assert.equal(result.resolvedIntent, 'driver_finishing_position', entry.text);
    assert.equal(result.templateKey, 'driver_finishing_position', entry.text);
    assert.equal(result.values.driver, entry.driver, entry.text);
    assert.equal(result.values.count, entry.count, entry.text);
    assert.equal(result.values.position, entry.position, entry.text);
    assert.equal(result.values.coverage, 'partial', entry.text);
    assert.ok(result.evidenceIds.length, entry.text);
    assertNoGenericSearch(result, entry.text);
  }
});

test('finishing-position leaderboards preserve ties and explicit position wording', async () => {
  const { app, repository } = appFixture();
  const baseRows = (
    await repository.get([...repository.sets.keys()].find((key) => key.startsWith('results:')))
  ).items;
  addResultSet(repository, [
    resultRow(baseRows[0], {
      driverId: 'driver:example-one',
      displayName: 'Example One',
      position: 3,
      suffix: 'third-one',
    }),
    resultRow(baseRows[1], {
      driverId: 'driver:example-two',
      displayName: 'Example Two',
      position: 3,
      suffix: 'third-two',
    }),
  ]);

  const result = await ask(app, 'Who has the most podium finishes in position 3?');
  assert.equal(result.status, 'answered');
  assert.equal(result.resolvedIntent, 'driver_finishing_position');
  assert.equal(result.values.driver, 'Example One and Example Two');
  assert.equal(result.values.count, 1);
  assert.equal(result.values.position, 3);
  assert.equal(result.values.tied, true);
  assertNoGenericSearch(result, 'position 3 tie');
});

test('invalid or absent finishing positions are explicit and never archive searches', async () => {
  const { app, repository } = appFixture();
  for (const text of [
    'Which driver has the most 0th-place finishes?',
    'Which driver has the most finishes?',
    'Which driver has the most pole positions?',
  ]) {
    const result = await ask(app, text);
    assert.equal(result.status, 'unsupported', text);
    assert.equal(result.reasonCode, 'FINISHING_POSITION_INVALID', text);
    assertNoGenericSearch(result, text);
  }

  for (const key of await repository.keys('results:')) repository.sets.delete(key);
  const unavailable = await ask(app, 'Which driver has the most fifth-place finishes?');
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.reasonCode, 'FINISHING_POSITION_RESULTS_NOT_PUBLISHED');
  assertNoGenericSearch(unavailable, 'missing fifth-place data');
});
