import Decimal from 'decimal.js';
import { shape } from '../schemas/contract.js';
import { dataset, slug } from './dataset.js';
export const number = (value) =>
  value === null || value === undefined || value === ''
    ? null
    : Number.isFinite(Number(value))
      ? Number(value)
      : null;
export const points = (value) =>
  value === null || value === undefined || value === ''
    ? null
    : new Decimal(String(value)).toFixed();
export function duration(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value);
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(s)) return null;
  return Math.round(s.split(':').reduce((sum, v) => sum * 60 + Number(v), 0) * 1000);
}
export function schedule(date, time) {
  return {
    startsAt: date && time ? new Date(`${date}T${time}`).toISOString() : null,
    date: date || null,
    timePrecision: date ? (time ? 'second' : 'date') : 'unknown',
    circuitTimeZone: null,
  };
}
export const entity = (kind, key, name) => ({
  id: `${kind}:${key}`,
  displayName: name,
  clientPath: `/${kind === 'constructor' ? 'constructors' : kind + 's'}/${encodeURIComponent(`${kind}:${key}`)}`,
});
export function driver(d) {
  return entity('driver', d.driverId, `${d.givenName} ${d.familyName}`.trim());
}
export function constructor(c) {
  return entity('constructor', c.constructorId, c.name);
}
export const entry = (row, sessionId) => ({
  id: `entry:${sessionId}:${row.Driver.driverId}`,
  drivers: [driver(row.Driver)],
  constructor: row.Constructor ? constructor(row.Constructor) : null,
  number: row.number == null ? null : String(row.number),
});
export function classification(row, sessionId) {
  const status = row.status || 'Unknown';
  let kind;
  if (status === 'Finished' || /^\+\d+ Laps?$/.test(status)) kind = 'finished';
  else if (/disqual/i.test(status)) kind = 'disqualified';
  else if (/did not start|did not qualify/i.test(status)) kind = 'not-started';
  else if (/withdraw/i.test(status)) kind = 'withdrawn';
  else if (status === 'Unknown') kind = 'unknown';
  else kind = 'retired';
  const position = number(row.position);
  const gap =
    position === 1
      ? { kind: 'leader' }
      : row.Time?.time?.startsWith('+')
        ? { kind: 'time', milliseconds: duration(row.Time.time.slice(1)) }
        : /^\+(\d+) Laps?$/.test(status)
          ? { kind: 'laps', laps: Number(status.match(/\d+/)[0]) }
          : { kind: 'unknown' };
  if (gap.kind === 'time' && gap.milliseconds === null) {
    gap.kind = 'unknown';
    delete gap.milliseconds;
  }
  return {
    ...shape('Classification'),
    id: `result:${sessionId}:${row.Driver.driverId}`,
    sessionId,
    entry: entry(row, sessionId),
    position,
    publishedOrder: number(row._order) || position || 1,
    classified: null,
    status: kind,
    statusLabel: status,
    lapsCompleted: number(row.laps),
    grid:
      number(row.grid) > 0 ? { kind: 'position', position: Number(row.grid) } : { kind: 'unknown' },
    points: points(row.points),
    elapsedMs: row.Time?.time?.startsWith('+') ? null : number(row.Time?.millis),
    gap,
    fastestLap: row.FastestLap
      ? {
          lapNumber: number(row.FastestLap.lap),
          durationMs: duration(row.FastestLap.Time?.time),
          rank: number(row.FastestLap.rank),
        }
      : null,
  };
}
export function normalizeWeekend(bundle, provenance) {
  const sets = [],
    aliases = {},
    year = Number(bundle.race.season),
    round = Number(bundle.race.round);
  const add = (key, schema, items, options = {}) => {
    const d = dataset(key, schema, items, provenance, options);
    sets.push(d);
    return d;
  };
  const events = bundle.calendar.map((r) => {
    const id = bundle.eventIds?.[r.round] || `event:${year}:${slug(r.raceName)}`;
    aliases[`race:${year}:${r.round}`] = id;
    return {
      ...shape('EventSummary'),
      id,
      year,
      round: Number(r.round),
      name: r.raceName,
      schedule: schedule(r.date, r.time),
      status: r.date > new Date().toISOString().slice(0, 10) ? 'scheduled' : 'unknown',
      circuit: entity('circuit', r.Circuit.circuitId, r.Circuit.circuitName),
      layout: null,
      features: [],
    };
  });
  const event = events.find((x) => x.round === round);
  const race = bundle.race;
  const sessions = [];
  const session = (key, kind, label, date, time) => {
    const id = `session:${event.id}:${key}`;
    const s = {
      ...shape('Session'),
      id,
      eventId: event.id,
      kind,
      label,
      sequence: sessions.length + 1,
      status: 'unknown',
      schedule: schedule(date, time),
    };
    sessions.push(s);
    aliases[id] = id;
    return s;
  };
  const raceSession = session('race', 'race', 'Race', race.date, race.time);
  if (race.Results?.length) {
    raceSession.status = 'completed';
    event.status = 'completed';
  }
  const results = add(
    `results:${raceSession.id}`,
    'Classification',
    (race.Results || []).map((r, i) => classification({ ...r, _order: i + 1 }, raceSession.id)),
  );
  if (race.Qualifying || race.QualifyingResults?.length) {
    const s = session(
      'qualifying',
      'qualifying',
      'Qualifying',
      race.Qualifying?.date,
      race.Qualifying?.time,
    );
    const rows = (race.QualifyingResults || []).map((r) => ({
      ...shape('Qualifying'),
      id: `qualifying:${s.id}:${r.Driver.driverId}`,
      sessionId: s.id,
      entry: entry(r, s.id),
      position: number(r.position),
      phases: ['Q1', 'Q2', 'Q3']
        .filter((k) => r[k] != null)
        .map((k) => ({
          key: k,
          label: k,
          bestTimeMs: duration(r[k]),
          participation: 'participated',
        })),
    }));
    if (rows.length) s.status = 'completed';
    add(`qualifying:${s.id}`, 'Qualifying', rows);
  }
  if (race.Sprint || race.SprintResults?.length) {
    const s = session('sprint', 'sprint', 'Sprint', race.Sprint?.date, race.Sprint?.time);
    const rows = (race.SprintResults || []).map((r, i) =>
      classification({ ...r, _order: i + 1 }, s.id),
    );
    if (rows.length) s.status = 'completed';
    add(`results:${s.id}`, 'Classification', rows);
  }
  for (const [key, label] of [
    ['FirstPractice', 'Practice 1'],
    ['SecondPractice', 'Practice 2'],
    ['ThirdPractice', 'Practice 3'],
    ['SprintQualifying', 'Sprint qualifying'],
  ])
    if (race[key])
      session(
        key,
        key === 'SprintQualifying' ? 'sprint-qualifying' : 'practice',
        label,
        race[key].date,
        race[key].time,
      );
  const entrants = new Map(
    (race.Results || []).map((r) => [r.Driver.driverId, entry(r, raceSession.id)]),
  );
  const pitRows = (race.PitStops || [])
    .filter((r) => entrants.has(r.driverId))
    .map((r) => ({
      ...shape('PitStop'),
      id: `pit:${raceSession.id}:${r.driverId}:${r.stop}`,
      sessionId: raceSession.id,
      entryId: entrants.get(r.driverId).id,
      sequence: Number(r.stop),
      lap: number(r.lap),
      timestamp: null,
      laneDurationMs: duration(r.duration),
      stationaryDurationMs: null,
    }));
  add(`pit-stops:${raceSession.id}`, 'PitStop', pitRows);
  const laps = new Map();
  for (const lap of race.Laps || [])
    for (const r of lap.Timings || []) {
      if (!entrants.has(r.driverId)) continue;
      const id = `lap:${raceSession.id}:${r.driverId}:${lap.number}`;
      laps.set(id, {
        ...shape('Lap'),
        id,
        sessionId: raceSession.id,
        entryId: entrants.get(r.driverId).id,
        lapNumber: Number(lap.number),
        startedAt: null,
        durationMs: duration(r.time),
        sectors: [],
        speeds: [],
        validity: 'unknown',
        isPitInLap: null,
        isPitOutLap: null,
      });
    }
  add(
    `laps:${raceSession.id}`,
    'Lap',
    [...laps.values()].sort((a, b) => a.lapNumber - b.lapNumber || a.id.localeCompare(b.id)),
  );
  const profileMap = new Map();
  for (const r of [
    ...(race.Results || []),
    ...(race.QualifyingResults || []),
    ...(race.SprintResults || []),
  ]) {
    for (const [kind, ref, raw] of [
      ['driver', driver(r.Driver), r.Driver],
      ...(r.Constructor ? [['constructor', constructor(r.Constructor), r.Constructor]] : []),
    ]) {
      const p = {
        ...shape('Profile'),
        id: ref.id,
        entity: ref,
        kind,
        aliases: [],
        nationality: raw.nationality || null,
        country: null,
        birthDate: raw.dateOfBirth || null,
        latitude: null,
        longitude: null,
        metrics: [],
        features: [],
      };
      profileMap.set(ref.id, p);
      aliases[ref.id] = ref.id;
    }
  }
  for (const raw of bundle.calendar) {
    const ref = entity('circuit', raw.Circuit.circuitId, raw.Circuit.circuitName);
    profileMap.set(ref.id, {
      ...shape('Profile'),
      id: ref.id,
      entity: ref,
      kind: 'circuit',
      aliases: [],
      nationality: null,
      country: raw.Circuit.Location?.country || null,
      birthDate: null,
      latitude: number(raw.Circuit.Location?.lat),
      longitude: number(raw.Circuit.Location?.long),
      metrics: [],
      features: [],
    });
    aliases[ref.id] = ref.id;
  }
  for (const p of profileMap.values()) add(`profile:${p.id}`, 'Profile', [p]);
  for (const [kind, rawRows] of Object.entries(bundle.standings || {})) {
    const rows = rawRows.map((r, i) => {
      const ref = kind === 'drivers' ? driver(r.Driver) : constructor(r.Constructor);
      return {
        ...shape('Standing'),
        id: `standing:${year}:${round}:${ref.id}`,
        entity: ref,
        constructors: (r.Constructors || []).map(constructor),
        rank: number(r.position) || i + 1,
        points: points(r.points),
        wins: number(r.wins),
        podiums: null,
        standingSnapshotId: `standing:${year}:${round}`,
      };
    });
    add(`standings:${year}:${kind}:${round}`, 'Standing', rows);
    add(`standings:${year}:${kind}`, 'Standing', rows);
  }
  event.features = ['results', 'laps', 'pit-stops', 'stints', 'weather', 'race-control'].map(
    (key) => ({
      key,
      coverage: sets.find((x) => x.key === `${key}:${raceSession.id}`)?.coverage || 'unavailable',
      reasonCode: 'SOURCE_COVERAGE',
      endpoint: `/api/v1/sessions/${encodeURIComponent(raceSession.id)}/${key}`,
    }),
  );
  const eventSet = add(`events:${year}`, 'EventSummary', events);
  add(`sessions:${event.id}`, 'Session', sessions);
  add(`event:${event.id}`, 'EventDetail', [
    {
      event: eventSet.items.find((x) => x.id === event.id),
      sessions: sessions.map((s) => ({ ...s, evidenceId: results.evidenceId })),
      podium: results.items.filter((x) => x.position >= 1 && x.position <= 3),
      winner: results.items.find((x) => x.position === 1)?.entry || null,
      fastestLap: (() => {
        const fastest = results.items.find((r) => r.fastestLap?.rank === 1);
        if (!fastest) return null;
        return {
          ...shape('Lap'),
          id: `fastest:${raceSession.id}:${fastest.entry.id}`,
          evidenceId: results.evidenceId,
          sessionId: raceSession.id,
          entryId: fastest.entry.id,
          lapNumber: fastest.fastestLap.lapNumber,
          durationMs: fastest.fastestLap.durationMs,
          validity: 'unknown',
        };
      })(),
      metrics: [],
    },
  ]);
  add('seasons', 'Season', [
    {
      ...shape('Season'),
      id: `season:${year}`,
      year,
      eventCount: events.length,
      completedCount: events.filter((x) => x.status === 'completed').length,
      isCurrent: year === new Date().getUTCFullYear(),
      coverage: 'partial',
    },
  ]);
  aliases[`season:${year}`] = `season:${year}`;
  return { sets, aliases };
}
