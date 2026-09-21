import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { appFixture } from './helpers.js';

function addRace(repository, year, round, name, date) {
  const baseEventSet = repository.sets.get('events:2024');
  const baseEvent = baseEventSet.items[0];
  const eventId = `event:${year}:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const event = {
    ...baseEvent,
    id: eventId,
    year,
    round,
    name,
    schedule: { ...baseEvent.schedule, date, startsAt: `${date}T12:00:00Z` },
  };
  repository.sets.set(`events:${year}`, {
    ...baseEventSet,
    key: `events:${year}`,
    items: [event],
    coverage: 'complete',
    evidenceId: `evidence:events:${year}`,
  });
  const baseDetail = repository.sets.get(`event:${baseEvent.id}`);
  repository.sets.set(`event:${eventId}`, {
    ...baseDetail,
    key: `event:${eventId}`,
    items: [{ ...baseDetail.items[0], event }],
    coverage: 'complete',
    evidenceId: `evidence:event:${year}`,
  });
  const baseResults = repository.sets.get(`results:session:${baseEvent.id}:race`);
  const sessionId = `session:${eventId}:race`;
  repository.sets.set(`results:${sessionId}`, {
    ...baseResults,
    key: `results:${sessionId}`,
    items: [
      {
        ...baseResults.items[0],
        id: `result:${eventId}:example-one`,
        sessionId,
        position: 10,
        entry: {
          ...baseResults.items[0].entry,
          drivers: [{ ...baseResults.items[0].entry.drivers[0], id: 'driver:example-one' }],
        },
      },
    ],
    coverage: 'complete',
    evidenceId: `evidence:results:${year}`,
  });
}

test('last-race questions resolve one driver and order published races by date', async () => {
  const { app, repository } = appFixture();
  addRace(repository, 2023, 20, 'Earlier Grand Prix', '2023-10-01');
  addRace(repository, 2024, 1, 'Later Grand Prix', '2024-11-01');

  const response = await request(app)
    .post('/api/v1/questions')
    .send({ text: "When was Example One's last race?" })
    .expect(200);
  const result = response.body.data.questionResult;

  assert.equal(result.status, 'answered');
  assert.equal(result.resolvedIntent, 'driver_last_race');
  assert.equal(result.values.driver, 'Example One');
  assert.equal(result.values.event, 'Later Grand Prix');
  assert.equal(result.values.date, '2024-11-01');
  assert.match(result.values.answer, /Later Grand Prix/);
  assert.ok(result.evidenceIds.length);
  assert.notEqual(result.resolvedIntent, 'archive_search');
  assert.equal('matches' in (result.values || {}), false);
});
