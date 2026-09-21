import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { appFixture } from './helpers.js';

function addEvent(repository, year, name, circuitName, circuitId) {
  const baseEvents = repository.sets.get('events:2024');
  const baseEvent = baseEvents.items[0];
  const eventId = `event:${year}:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const event = {
    ...baseEvent,
    id: eventId,
    year,
    name,
    schedule: { ...baseEvent.schedule, date: `${year}-09-11` },
    circuit: { ...baseEvent.circuit, id: circuitId, displayName: circuitName },
  };
  repository.sets.set(`events:${year}`, {
    ...baseEvents,
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
}

async function ask(app, text) {
  const response = await request(app).post('/api/v1/questions').send({ text }).expect(200);
  return response.body.data.questionResult;
}

function assertNotGenericSearch(result, text) {
  assert.notEqual(result.resolvedIntent, 'archive_search', text);
  assert.equal('matches' in (result.values || {}), false, text);
}

test('event circuit questions resolve one published venue from event and season constraints', async () => {
  const { app, repository } = appFixture();
  addEvent(repository, 2022, 'Italian Grand Prix', 'Autodromo Nazionale Monza', 'circuit:monza');

  const cases = [
    'Which circuit hosted the 2022 Italian Grand Prix?',
    'Where was the 2022 Italian Grand Prix held?',
    'What circuit hosted the 2022 Italian GP?',
  ];

  for (const text of cases) {
    const result = await ask(app, text);
    assert.equal(result.status, 'answered', text);
    assert.equal(result.resolvedIntent, 'event_circuit', text);
    assert.equal(result.templateKey, 'event_circuit', text);
    assert.equal(result.values.event, 'Italian Grand Prix', text);
    assert.equal(result.values.year, 2022, text);
    assert.equal(result.values.circuit, 'Autodromo Nazionale Monza', text);
    assert.equal(result.values.circuitId, 'circuit:monza', text);
    assert.equal(result.values.coverage, 'complete', text);
    assert.match(result.values.answer, /2022 Italian Grand Prix/);
    assert.match(result.values.answer, /Autodromo Nazionale Monza/, text);
    assert.ok(result.evidenceIds.length, text);
    assertNotGenericSearch(result, text);
  }
});

test('event circuit questions keep unknown events and seasons unavailable', async () => {
  const { app, repository } = appFixture();
  addEvent(repository, 2022, 'Italian Grand Prix', 'Autodromo Nazionale Monza', 'circuit:monza');

  const unknownEvent = await ask(app, 'Which circuit hosted the 2022 Mars Grand Prix?');
  assert.equal(unknownEvent.status, 'unavailable');
  assert.equal(unknownEvent.reasonCode, 'EVENT_NOT_PUBLISHED');
  assertNotGenericSearch(unknownEvent, 'unknown event');

  const unknownSeason = await ask(app, 'Which circuit hosted the 2021 Italian Grand Prix?');
  assert.equal(unknownSeason.status, 'unavailable');
  assert.equal(unknownSeason.reasonCode, 'EVENT_NOT_PUBLISHED');
  assertNotGenericSearch(unknownSeason, 'unknown season');
});
