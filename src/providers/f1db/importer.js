import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
export async function readF1db(file, expectedHash, version) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || !/^\d{4}\.\d+\.\d+(?:\.[a-z0-9-]+)?$/.test(version))
    throw new Error('Pinned F1DB version and SHA-256 are required.');
  const stat = await fs.stat(file);
  if (stat.size > 200_000_000) throw new Error('F1DB file exceeds import size budget.');
  const bytes = await fs.readFile(file);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  if (checksum !== expectedHash) throw new Error('F1DB checksum mismatch.');
  const payload = JSON.parse(bytes.toString('utf8'));
  for (const key of ['drivers', 'constructors', 'circuits', 'seasons', 'races'])
    if (!Array.isArray(payload[key]))
      throw new Error('Unsupported F1DB JSON distribution. Use the single JSON artifact.');
  return {
    payload,
    checksum,
    version,
    url: `https://github.com/f1db/f1db/releases/tag/v${version}`,
    retrievedAt: new Date().toISOString(),
  };
}
function referencesForRace(race) {
  const refs = { driver: new Set(), constructor: new Set() };
  const addRows = (rows = []) =>
    (rows || []).forEach((row) => {
      if (row.driverId) refs.driver.add(row.driverId);
      if (row.constructorId) refs.constructor.add(row.constructorId);
    });
  addRows(race.raceResults);
  addRows(race.qualifyingResults);
  addRows(race.sprintRaceResults);
  addRows(race.driverStandings);
  addRows(race.constructorStandings);
  (race.fastestLaps || []).forEach((row) => row.driverId && refs.driver.add(row.driverId));
  (race.pitStops || []).forEach((row) => row.driverId && refs.driver.add(row.driverId));
  return refs;
}

/**
 * Return every F1DB identity used by the requested weekend and its year calendar.
 * The calendar is part of the normalized bundle, so every venue in that calendar
 * must be reviewed even when the selected round does not use it.
 */
export function f1dbReferences(data, year, round) {
  const race = data.races.find((r) => r.year === year && r.round === round);
  if (!race) throw new Error('F1DB event is absent.');
  const refs = { driver: new Set(), constructor: new Set(), circuit: new Set() };
  for (const calendarRace of data.races.filter((r) => r.year === year)) {
    refs.circuit.add(calendarRace.circuitId);
  }
  const raceRefs = referencesForRace(race);
  refs.driver = raceRefs.driver;
  refs.constructor = raceRefs.constructor;
  return refs;
}

/**
 * Project the reviewed F1DB circuit layouts into the canonical Layout shape.
 *
 * F1DB stores a layout's effective flag and the layout used by each race, but
 * does not publish validity dates.  The dates below are therefore bounded by
 * the first and last in-scope race that explicitly references the layout.  An
 * effective layout with no in-scope race reference is retained with an open
 * range; it is still useful for the current circuit profile, but never gets a
 * made-up historical date.
 */
export function f1dbLayouts(
  data,
  mapping = {},
  {
    version = '2026.14.0',
    fromYear = 2000,
    toYear = 2025,
    canonicalIds = null,
    strict = false,
  } = {},
) {
  const scopedRaces = data.races.filter((race) => race.year >= fromYear && race.year <= toYear);
  const circuits = new Map(data.circuits.map((circuit) => [circuit.id, circuit]));
  const sourceCircuitIds = [...new Set(scopedRaces.map((race) => race.circuitId))].sort();
  const missing = [];
  const sets = [];
  const assetBase = `https://raw.githubusercontent.com/f1db/f1db/v${version}/src/assets/circuits/white-outline`;
  const provenance = {
    source: 'F1DB',
    sourceVersion: version,
    releaseUrl: `https://github.com/f1db/f1db/releases/tag/v${version}`,
    assetStyle: 'white-outline',
  };

  for (const sourceId of sourceCircuitIds) {
    const circuit = circuits.get(sourceId);
    const canonicalId = mapping[`circuit:${sourceId}`];
    if (!circuit) {
      missing.push({ sourceId, reason: 'source-circuit-missing' });
      continue;
    }
    if (!canonicalId) {
      missing.push({ sourceId, reason: 'canonical-mapping-missing' });
      continue;
    }
    if (canonicalIds && !canonicalIds.circuit?.has(canonicalId)) {
      missing.push({ sourceId, canonicalId, reason: 'canonical-circuit-absent' });
      continue;
    }
    const sourceLayouts = Array.isArray(circuit.layouts) ? circuit.layouts : [];
    const rows = [];
    for (const layout of sourceLayouts) {
      const years = scopedRaces
        .filter((race) => race.circuitId === sourceId && race.circuitLayoutId === layout.id)
        .map((race) => Number(race.year))
        .filter(Number.isInteger)
        .sort((a, b) => a - b);
      if (!years.length && !layout.effective) continue;
      const range = years.length
        ? { validFrom: `${years[0]}-01-01`, validTo: `${years.at(-1)}-12-31` }
        : { validFrom: null, validTo: null };
      const rangeKey = years.length ? `${years[0]}-${years.at(-1)}` : 'current';
      rows.push({
        id: `layout:${canonicalId}:${layout.id}:${rangeKey}`,
        evidenceId: null,
        circuitId: canonicalId,
        name: `${circuit.fullName || circuit.name} — ${layout.id}`,
        validFrom: range.validFrom,
        validTo: range.validTo,
        lengthMetres:
          Number.isFinite(Number(layout.length)) && Number(layout.length) >= 0
            ? Number(layout.length) * 1000
            : null,
        assetUrl: `${assetBase}/${layout.id}.svg`,
        licence: 'CC BY 4.0',
        attribution: 'F1DB contributors — CC BY 4.0',
      });
    }
    if (!rows.length) {
      missing.push({ sourceId, canonicalId, reason: 'approved-layout-missing' });
      continue;
    }
    rows.sort((a, b) => String(b.validFrom || '').localeCompare(String(a.validFrom || '')));
    sets.push({ circuitId: canonicalId, sourceId, rows });
  }
  if (strict && missing.length)
    throw new Error(
      `F1DB circuit layout coverage is incomplete: ${missing.map((row) => `${row.sourceId}:${row.reason}`).join(', ')}`,
    );
  return {
    sets,
    missing,
    coverage: {
      fromYear,
      toYear,
      scopedCircuits: sourceCircuitIds.length,
      approvedCircuits: sets.length,
      approvedLayouts: sets.reduce((sum, set) => sum + set.rows.length, 0),
    },
    provenance,
  };
}

/**
 * Validate a reviewed, flat mapping such as driver:f1db-id -> driver:canonical_id.
 * F1DB imports are never allowed to fall back to provider-namespaced identities.
 */
export function validateF1dbMapping(data, year, round, mapping = {}, { canonicalIds = null } = {}) {
  const refs = f1dbReferences(data, year, round);
  const errors = [];
  for (const kind of ['driver', 'constructor', 'circuit']) {
    const seen = new Map();
    for (const sourceId of [...refs[kind]].sort()) {
      const key = `${kind}:${sourceId}`;
      const target = mapping[key];
      if (!target) {
        errors.push(`${key} is unmapped`);
        continue;
      }
      if (!new RegExp(`^${kind}:[a-z0-9_]+$`).test(target)) {
        errors.push(`${key} maps to invalid canonical identity ${target}`);
        continue;
      }
      if (seen.has(target)) errors.push(`${key} collides with ${seen.get(target)} at ${target}`);
      else seen.set(target, key);
      if (canonicalIds && !canonicalIds[kind]?.has(target))
        errors.push(`${key} maps to absent canonical identity ${target}`);
    }
  }
  if (errors.length)
    throw new Error(`F1DB identity mapping is incomplete or unsafe: ${errors.join('; ')}`);
  return {
    year,
    round,
    references: Object.fromEntries(
      Object.entries(refs).map(([kind, values]) => [kind, [...values].sort()]),
    ),
    mappings: Object.fromEntries(
      Object.keys(mapping)
        .filter(
          (key) =>
            key.startsWith('driver:') ||
            key.startsWith('constructor:') ||
            key.startsWith('circuit:'),
        )
        .sort()
        .map((key) => [key, mapping[key]]),
    ),
  };
}

export function f1dbWeekend(data, year, round, mapping = {}, options = {}) {
  const race = data.races.find((r) => r.year === year && r.round === round);
  if (!race) throw new Error('F1DB event is absent.');
  if (options.strict !== false)
    validateF1dbMapping(data, year, round, mapping, { canonicalIds: options.canonicalIds || null });
  const find = (key, id) => {
    const record = data[key].find((x) => x.id === id);
    if (!record) throw new Error('F1DB identity reference is unresolved.');
    return record;
  };
  const map = (kind, id) => mapping[`${kind}:${id}`] || `f1db-${id}`;
  const driver = (id) => {
    const d = find('drivers', id);
    return {
      driverId: map('driver', id),
      givenName: d.firstName,
      familyName: d.lastName,
      dateOfBirth: d.dateOfBirth,
      nationality: null,
    };
  };
  const constructor = (id) => {
    const c = find('constructors', id);
    return { constructorId: map('constructor', id), name: c.name };
  };
  const calendar = data.races
    .filter((r) => r.year === year)
    .map((r) => {
      const c = find('circuits', r.circuitId);
      return {
        season: String(year),
        round: String(r.round),
        raceName: r.officialName || `${r.grandPrixId} Grand Prix`,
        date: r.date,
        time: r.time ? `${r.time.replace(/Z$/, '')}Z` : null,
        Circuit: {
          circuitId: map('circuit', c.id),
          circuitName: c.name,
          Location: { lat: c.latitude, long: c.longitude, country: c.countryId },
        },
      };
    });
  const normalized = calendar.find((r) => Number(r.round) === round);
  const rows = (values = []) =>
    values.map((r) => ({
      Driver: driver(r.driverId),
      Constructor: constructor(r.constructorId),
      number: r.driverNumber,
      position: r.positionNumber,
      _order: r.positionDisplayOrder,
      points: r.points,
      grid: r.gridPositionNumber,
      laps: r.laps,
      status:
        r.reasonRetired ||
        (['DNF', 'DNS', 'DSQ', 'DNQ'].includes(r.positionText)
          ? { DNF: 'Retired', DNS: 'Did not start', DSQ: 'Disqualified', DNQ: 'Did not qualify' }[
              r.positionText
            ]
          : r.gapLaps > 0
            ? `+${r.gapLaps} Laps`
            : 'Finished'),
      Time: {
        millis: r.timeMillis,
        time: r.gap ? (String(r.gap).startsWith('+') ? r.gap : '+' + r.gap) : r.time,
      },
      Q1: r.q1,
      Q2: r.q2,
      Q3: r.q3,
      _sharedCar: r.sharedCar,
    }));
  normalized.Results = rows(race.raceResults || []);
  for (const fastest of race.fastestLaps || []) {
    const result = normalized.Results.find(
      (r) => r.Driver.driverId === map('driver', fastest.driverId),
    );
    if (result)
      result.FastestLap = {
        rank: fastest.positionNumber,
        lap: fastest.lap,
        Time: { time: fastest.time },
      };
  }
  normalized.QualifyingResults = rows(race.qualifyingResults || []);
  normalized.SprintResults = rows(race.sprintRaceResults || []);
  if (normalized.Results.some((r) => r._sharedCar))
    throw new Error(
      'Shared-drive event requires an explicit entry/credit mapping; import is not published.',
    );
  if (race.qualifyingDate)
    normalized.Qualifying = {
      date: race.qualifyingDate,
      time: race.qualifyingTime ? race.qualifyingTime + 'Z' : null,
    };
  if (race.sprintRaceDate)
    normalized.Sprint = {
      date: race.sprintRaceDate,
      time: race.sprintRaceTime ? race.sprintRaceTime + 'Z' : null,
    };
  normalized.PitStops = (race.pitStops || []).map((p) => ({
    driverId: map('driver', p.driverId),
    stop: p.stop,
    lap: p.lap,
    duration: p.time,
  }));
  const standings = {
    drivers: (race.driverStandings || []).map((r) => ({
      Driver: driver(r.driverId),
      number: r.driverNumber ?? r.number ?? null,
      position: r.positionNumber,
      points: r.points,
    })),
    constructors: (race.constructorStandings || []).map((r) => ({
      Constructor: constructor(r.constructorId),
      position: r.positionNumber,
      points: r.points,
    })),
  };
  return { calendar, race: normalized, standings, failures: [], observations: [] };
}
