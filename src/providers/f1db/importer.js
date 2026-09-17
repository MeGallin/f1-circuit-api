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
export function f1dbWeekend(data, year, round, mapping = {}) {
  const race = data.races.find((r) => r.year === year && r.round === round);
  if (!race) throw new Error('F1DB event is absent.');
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
