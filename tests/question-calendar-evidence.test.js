import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { completeCalendarObservation } from '../src/questions/calendar-evidence.js';

const events = [1, 2].map((round) => ({
  id: `event:2000:race-${round}`,
  year: 2000,
  round,
  name: `Race ${round}`,
  circuit: { id: `circuit:venue-${round}` },
  schedule: { date: `2000-0${round}-01` },
}));

function legacyFixture() {
  const calendar = {
    items: structuredClone(events),
    provenance: { sources: [{ id: 'jolpica' }], retrievedAt: '2026-09-18T00:00:00Z' },
  };
  const value = observation();
  value.source_url = 'https://api.jolpi.ca/ergast/f1/2000.json?limit=100&offset=0';
  const identityRows = calendar.items.map((event) => ({
    id: event.id,
    year: event.year,
    round: event.round,
    name: event.name,
    date: event.schedule.date,
    circuitId: event.circuit.id,
  }));
  return {
    calendar,
    value,
    options: {
      allowContentMatch: true,
      publicationCreatedAt: '2026-11-04T19:38:01.982Z',
      calendarHash: createHash('sha256').update(JSON.stringify(identityRows)).digest('hex'),
      aliases: new Map(events.map((event) => [`race:2000:${event.round}`, event.id])),
      allCompletedResultsPublished: true,
    },
  };
}

test('legacy completeness can be corroborated by identical pinned content without inventing an original reference', () => {
  const { calendar, value, options } = legacyFixture();
  assert.equal(completeCalendarObservation(2000, calendar, value, options), true);
  assert.equal(calendar.provenance.observationIds, undefined);
});

for (const [name, mutate] of [
  [
    'after-publication observation',
    (fixture) => {
      fixture.value.retrieved_at = '2027-01-01T00:00:00Z';
    },
  ],
  [
    'wrong provider',
    (fixture) => {
      fixture.value.provider = 'other';
    },
  ],
  [
    'wrong source URL',
    (fixture) => {
      fixture.value.source_url = 'https://untrusted.invalid/2000.json';
    },
  ],
  [
    'wrong season',
    (fixture) => {
      fixture.value.payload.MRData.RaceTable.season = '2001';
    },
  ],
  [
    'partial page',
    (fixture) => {
      fixture.value.payload.MRData.total = '3';
    },
  ],
  [
    'changed published name',
    (fixture) => {
      fixture.value.payload.MRData.RaceTable.Races[1].raceName = 'Changed';
    },
  ],
  [
    'missing final event',
    (fixture) => {
      fixture.value.payload.MRData.RaceTable.Races.pop();
    },
  ],
  [
    'duplicate rounds',
    (fixture) => {
      fixture.value.payload.MRData.RaceTable.Races[1].round = '1';
    },
  ],
  [
    'wrong pinned hash',
    (fixture) => {
      fixture.options.calendarHash = '0'.repeat(64);
    },
  ],
  [
    'missing canonical alias',
    (fixture) => {
      fixture.options.aliases.delete('race:2000:2');
    },
  ],
  [
    'missing published race classification',
    (fixture) => {
      fixture.options.allCompletedResultsPublished = false;
    },
  ],
])
  test(`legacy corroboration rejects ${name}`, () => {
    const fixture = legacyFixture();
    assert.equal(
      completeCalendarObservation(2000, fixture.calendar, fixture.value, fixture.options),
      true,
      'positive control must pass before mutation',
    );
    mutate(fixture);
    assert.equal(
      completeCalendarObservation(2000, fixture.calendar, fixture.value, fixture.options),
      false,
    );
  });
function observation() {
  return {
    id: 'observation:calendar',
    provider: 'jolpica',
    retrieved_at: '2026-09-18T00:00:00Z',
    payload: {
      MRData: {
        total: '2',
        limit: '100',
        offset: '0',
        RaceTable: {
          season: '2000',
          Races: events.map((event) => ({
            season: '2000',
            round: String(event.round),
            raceName: event.name,
            date: event.schedule.date,
            Circuit: { circuitId: event.circuit.id.slice(8) },
          })),
        },
      },
    },
  };
}
test('complete persisted provider collection proves calendar completeness independently of field coverage', () =>
  assert.equal(
    completeCalendarObservation(
      2000,
      { items: events, provenance: { observationIds: ['observation:calendar'] } },
      observation(),
    ),
    true,
  ));
for (const mutation of [
  (value) => {
    value.payload.MRData.total = '3';
  },
  (value) => {
    value.retrieved_at = 'garbage';
  },
  (value) => {
    delete value.payload.MRData.limit;
  },
  (value) => {
    value.payload.MRData.limit = 'garbage';
  },
  (value) => {
    value.payload.MRData.RaceTable.Races[1].season = '2001';
  },
  (value) => {
    value.payload.MRData.RaceTable.Races.pop();
  },
  (value) => {
    value.payload.MRData.offset = '1';
  },
  (value) => {
    value.payload.MRData.RaceTable.Races[1].Circuit.circuitId = 'other';
  },
  (value) => {
    value.payload.MRData.RaceTable.Races[1].round = '1';
  },
  (value) => {
    value.retrieved_at = '2000-06-01T00:00:00Z';
  },
  (value) => {
    value.payload.MRData.RaceTable.season = '2001';
  },
])
  test(`calendar evidence rejects incomplete, mismatched or not-closed source ${mutation.toString()}`, () => {
    const value = observation();
    mutation(value);
    assert.equal(
      completeCalendarObservation(
        2000,
        { items: events, provenance: { observationIds: ['observation:calendar'] } },
        value,
      ),
      false,
    );
  });

test('unlinked matching source cannot leak into the publication', () =>
  assert.equal(
    completeCalendarObservation(2000, { items: events, provenance: {} }, observation()),
    false,
  ));

test('invalid matching race dates are not finality evidence', () => {
  const value = observation();
  const badEvents = structuredClone(events);
  value.payload.MRData.RaceTable.Races[1].date = badEvents[1].schedule.date = '2000-02-31';
  assert.equal(
    completeCalendarObservation(
      2000,
      { items: badEvents, provenance: { observationIds: [value.id] } },
      value,
    ),
    false,
  );
});
