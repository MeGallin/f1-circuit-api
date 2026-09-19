import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  duration,
  classification,
  normalizeWeekend,
  normalizeLayouts,
} from '../src/models/normalization.js';
import { validateSchema } from '../src/schemas/contract.js';
import { syntheticWeekend } from '../fixtures/synthetic-weekend.js';
import { compareAssertions } from '../src/reconciliation/compare.js';
import { Jolpica } from '../src/providers/jolpica/client.js';
import { OpenF1 } from '../src/providers/openf1/client.js';
import {
  matchesSessionDate,
  reviewedSessionMapping,
} from '../src/providers/openf1/session-mapping.js';
import { f1dbWeekend, f1dbLayouts, validateF1dbMapping } from '../src/providers/f1db/importer.js';
test('normalization preserves fractional points, unknown times and source-only quality', () => {
  assert.equal(duration('1:23.456'), 83456);
  assert.equal(duration('unknown'), null);
  assert.equal(duration(null), null);
  const bundle = syntheticWeekend();
  const { sets } = normalizeWeekend(bundle, { retrievedAt: '2024-01-02T00:00:00Z', sources: [] });
  for (const set of sets)
    for (const item of set.items) {
      const result = validateSchema(set.schema, item);
      assert.ok(result.valid, `${set.key}: ${JSON.stringify(result.errors)}`);
    }
  const result = classification(bundle.race.Results[0], 'test');
  assert.equal(result.points, '12.5');
  assert.equal(result.classified, null);
  assert.deepEqual(classification(bundle.race.Results[1], 'test').gap, { kind: 'laps', laps: 1 });
});
test('reconciliation distinguishes shared lineage, independent agreement and conflicts', () => {
  const a = { value: '12.50', unit: 'points', lineage: 'a' },
    b = { value: '12.5', unit: 'points', lineage: 'b' };
  assert.equal(compareAssertions([a, b]).state, 'reconciled');
  assert.equal(compareAssertions([a, { ...b, lineage: 'a' }]).state, 'source-only');
  assert.equal(compareAssertions([a, { ...b, value: '13' }]).state, 'conflict');
});
test('Jolpica lap pagination counts timing rows, not enclosing laps', async () => {
  const paths = [];
  const client = new Jolpica({
    async get(path) {
      paths.push(path);
      const second = paths.length === 2;
      return {
        payload: {
          MRData: {
            total: '3',
            RaceTable: { Races: [{ Laps: [{ number: '1', Timings: second ? [{}] : [{}, {}] }] }] },
          },
        },
      };
    },
  });
  await client.pages('2024/1/laps', 'RaceTable', 'Races', 'Laps');
  assert.ok(paths[1].endsWith('offset=2'));
});
test('OpenF1 rejects future and unsupported sessions before detail reads', async () => {
  const client = new OpenF1({
    async get() {
      return { payload: [{ session_key: 1, date_end: '2999-01-01T00:00:00Z', year: 2999 }] };
    },
  });
  await assert.rejects(client.session(1), /historical/);
});

test('reviewed Las Vegas UTC rollover mapping is narrow and timezone-aware', async () => {
  const canonical = {
    id: 'session:event:2024:las-vegas-grand-prix:race',
    eventId: 'event:2024:las-vegas-grand-prix',
    kind: 'race',
    schedule: { date: '2024-11-23' },
  };
  const event = {
    id: 'event:2024:las-vegas-grand-prix',
    year: 2024,
    round: 22,
    circuit: { id: 'circuit:vegas' },
  };
  const mapping = reviewedSessionMapping(canonical.id, 9644);
  const client = new OpenF1({
    async get(url) {
      return {
        url: 'https://api.openf1.org/v1/' + url,
        retrievedAt: '2024-11-25T00:00:00Z',
        payload: url.startsWith('sessions')
          ? [
              {
                session_key: 9644,
                year: 2024,
                session_name: 'Race',
                circuit_short_name: 'Las Vegas',
                date_start: '2024-11-24T06:00:00Z',
                date_end: '2024-11-24T08:00:00Z',
              },
            ]
          : [],
      };
    },
  });
  await assert.doesNotReject(
    client.detail(
      9644,
      canonical,
      [],
      { retrievedAt: '2024-11-25T00:00:00Z', sources: [] },
      {
        event,
        mapping,
      },
    ),
  );
  await assert.rejects(
    client.detail(
      9644,
      {
        ...canonical,
        id: 'session:event:2024:other-grand-prix:race',
        eventId: 'event:2024:other-grand-prix',
      },
      [],
      { retrievedAt: '2024-11-25T00:00:00Z', sources: [] },
      { event, mapping },
    ),
    /date mismatch/,
  );
  await assert.rejects(
    client.detail(
      9644,
      canonical,
      [],
      { retrievedAt: '2024-11-25T00:00:00Z', sources: [] },
      { event: { ...event, circuit: { id: 'circuit:other' } }, mapping },
    ),
    /date mismatch/,
  );
});

test('reviewed non-race UTC rollover mappings require event, circuit and local date agreement', () => {
  const cases = [
    {
      canonical: {
        id: 'session:event:2023:las-vegas-grand-prix:FirstPractice',
        eventId: 'event:2023:las-vegas-grand-prix',
        schedule: { date: '2023-11-16' },
      },
      event: {
        id: 'event:2023:las-vegas-grand-prix',
        year: 2023,
        round: 21,
        circuit: { id: 'circuit:vegas' },
      },
      provider: {
        session_key: 9182,
        year: 2023,
        circuit_short_name: 'Las Vegas',
        date_start: '2023-11-17T04:30:00Z',
      },
    },
    {
      canonical: {
        id: 'session:event:2024:las-vegas-grand-prix:qualifying',
        eventId: 'event:2024:las-vegas-grand-prix',
        schedule: { date: '2024-11-22' },
      },
      event: {
        id: 'event:2024:las-vegas-grand-prix',
        year: 2024,
        round: 22,
        circuit: { id: 'circuit:vegas' },
      },
      provider: {
        session_key: 9640,
        year: 2024,
        circuit_short_name: 'Las Vegas',
        date_start: '2024-11-23T06:00:00Z',
      },
    },
  ];
  for (const { canonical, event, provider } of cases) {
    const mapping = reviewedSessionMapping(canonical.id, provider.session_key);
    assert.ok(mapping);
    assert.equal(matchesSessionDate(canonical, provider, event, mapping), true);
    assert.equal(
      matchesSessionDate(canonical, provider, { ...event, round: event.round + 1 }, mapping),
      false,
    );
  }
});

test('OpenF1 reviewed manifest covers every staged 2023-2024 canonical session', async () => {
  const manifest = JSON.parse(
    await fs.readFile(new URL('../src/providers/openf1/session-mapping.json', import.meta.url)),
  );
  assert.equal(Object.keys(manifest).length, 221);
  const providerKeys = new Set();
  for (const [id, mapping] of Object.entries(manifest)) {
    assert.equal(mapping.canonicalSessionId, id);
    assert.match(id, /^session:event:(2023|2024):.+/);
    assert.ok(Number.isInteger(mapping.openf1SessionKey));
    assert.ok(!providerKeys.has(mapping.openf1SessionKey));
    providerKeys.add(mapping.openf1SessionKey);
    assert.ok(['EXACT_DATE', 'UTC_DATE_ROLLOVER'].includes(mapping.reasonCode));
  }
  assert.equal(
    reviewedSessionMapping('session:event:2024:united-states-grand-prix:SprintQualifying', 9612)
      ?.canonicalRound,
    19,
  );
});

test('F1DB imports require complete, collision-free canonical identity mapping', () => {
  const data = {
    drivers: [{ id: 'driver-a', firstName: 'A', lastName: 'Driver', dateOfBirth: null }],
    constructors: [{ id: 'team-a', name: 'Team A' }],
    circuits: [
      { id: 'venue-a', name: 'Venue A', latitude: null, longitude: null, countryId: null },
    ],
    races: [
      {
        year: 2024,
        round: 1,
        circuitId: 'venue-a',
        officialName: 'Test Grand Prix',
        date: '2024-01-01',
        time: null,
        raceResults: [
          {
            driverId: 'driver-a',
            constructorId: 'team-a',
            positionNumber: 1,
            positionDisplayOrder: 1,
            points: 25,
            gridPositionNumber: 1,
            laps: 50,
            positionText: '1',
          },
        ],
        driverStandings: [{ driverId: 'driver-a', positionNumber: 1, points: 25 }],
        constructorStandings: [{ constructorId: 'team-a', positionNumber: 1, points: 25 }],
      },
    ],
  };
  assert.throws(() => validateF1dbMapping(data, 2024, 1), /driver:driver-a is unmapped/);
  const mapping = {
    'driver:driver-a': 'driver:canonical_a',
    'constructor:team-a': 'constructor:canonical_a',
    'circuit:venue-a': 'circuit:canonical_a',
  };
  const report = validateF1dbMapping(data, 2024, 1, mapping);
  assert.deepEqual(report.references.driver, ['driver-a']);
  const bundle = f1dbWeekend(data, 2024, 1, mapping);
  assert.equal(bundle.race.Results[0].Driver.driverId, 'driver:canonical_a');
  assert.throws(
    () => f1dbWeekend(data, 2024, 1, { ...mapping, 'driver:driver-a': 'constructor:canonical_a' }),
    /invalid canonical identity/,
  );
});

test('reviewed F1DB 2000-2025 manifest keeps explicit namespace aliases', async () => {
  const mapping = JSON.parse(
    await fs.readFile(new URL('../docs/f1db-mapping-2000-2025.json', import.meta.url)),
  );
  assert.equal(Object.keys(mapping).length, 206);
  for (const [source, target] of Object.entries(mapping)) {
    const kind = source.split(':', 1)[0];
    assert.match(source, new RegExp(`^${kind}:[a-z0-9-]+$`));
    assert.match(target, new RegExp(`^${kind}:[a-z0-9_]+$`));
  }
  assert.equal(mapping['circuit:melbourne'], 'circuit:albert_park');
  assert.equal(mapping['driver:carlos-sainz-jr'], 'driver:sainz');
  assert.equal(mapping['constructor:racing-bulls'], 'constructor:rb');
});

test('F1DB layout projection keeps canonical IDs, observed ranges and attribution', () => {
  const data = {
    circuits: [
      {
        id: 'venue-a',
        name: 'Venue A',
        fullName: 'Venue A Circuit',
        layouts: [
          { id: 'venue-a-1', effective: false, length: 5.2 },
          { id: 'venue-a-2', effective: true, length: 5.3 },
        ],
      },
    ],
    races: [{ year: 2024, round: 1, circuitId: 'venue-a', circuitLayoutId: 'venue-a-1' }],
  };
  const projection = f1dbLayouts(
    data,
    { 'circuit:venue-a': 'circuit:canonical_a' },
    { version: '2026.14.0' },
  );
  assert.deepEqual(projection.coverage, {
    fromYear: 2000,
    toYear: 2025,
    scopedCircuits: 1,
    approvedCircuits: 1,
    approvedLayouts: 2,
  });
  assert.deepEqual(projection.missing, []);
  const [set] = normalizeLayouts(projection, { retrievedAt: '2024-01-01T00:00:00Z', sources: [] });
  assert.equal(set.key, 'layouts:circuit:canonical_a');
  assert.equal(set.items[0].circuitId, 'circuit:canonical_a');
  assert.equal(set.items[0].validFrom, '2024-01-01');
  assert.equal(set.items[0].validTo, '2024-12-31');
  assert.equal(set.items[0].lengthMetres, 5200);
  assert.equal(set.items[0].licence, 'CC BY 4.0');
  for (const item of set.items) {
    const result = validateSchema('Layout', item);
    assert.ok(result.valid, JSON.stringify(result.errors));
  }
});

test('missing standing ranks remain unknown instead of inferred row numbers', () => {
  const bundle = syntheticWeekend();
  bundle.standings.drivers[0].Driver = {
    ...bundle.standings.drivers[0].Driver,
    permanentNumber: '1',
  };
  delete bundle.standings.drivers[0].position;
  const result = normalizeWeekend(bundle, { retrievedAt: '2024-01-01T00:00:00Z', sources: [] });
  const standing = result.sets.find((s) => s.key === `standings:${bundle.race.season}:drivers`)
    .items[0];
  assert.equal(standing.rank, null);
  assert.equal(standing.number, '1');
});
