import { invalid, missing } from '../errors/api-error.js';
import { hash, meta } from '../models/dataset.js';
import { summarizeOutcomes } from '../models/analytics-outcomes.js';

const splitIds = (value, name) => {
  if (value == null || value === '') return [];
  const values = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!values.length || values.some((item) => item.length > 160))
    throw invalid(`Invalid ${name} filter.`);
  return [...new Set(values)];
};

const integer = (value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (value == null || value === '') return null;
  if (!/^\d+$/.test(String(value))) throw invalid(`${name} must be a whole number.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw invalid(`${name} is outside the supported range.`);
  return result;
};

const numeric = (value) => (value == null || value === '' ? null : Number(value));
const percentage = (value, total) => (total ? Math.round((value / total) * 1000) / 10 : null);
const sumPublishedPoints = (rows) => {
  const values = rows.map((row) => numeric(row.points)).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
};
const display = (entity) => entity?.displayName || entity?.name || entity?.id || null;
const driverRows = (rows) =>
  rows.flatMap((row) =>
    (row.entry?.drivers || []).map((driver) => ({
      ...row,
      driver,
      driverId: driver.id,
      driverName: display(driver),
    })),
  );
// A published rank is useful for position charts; it does not establish a finish,
// a start or the source's explicit classification boolean.
const rankedResult = (row) =>
  row?.position != null && !['not-started', 'withdrawn', 'disqualified'].includes(row.status);

const entryDriver = (row) => row?.entry?.drivers?.[0] || null;
const entryConstructor = (row) => row?.entry?.constructor || null;

const eventOverview = (item) => {
  if (!item?.event) return null;
  return {
    id: item.event.id,
    name: item.event.name,
    year: item.event.year,
    round: item.event.round,
    status: item.event.status,
    circuit: item.event.circuit || null,
    schedule: item.event.schedule || null,
    sessionSchedule: (item.sessions || [])
      .filter((session) => session.schedule?.startsAt || session.schedule?.date)
      .map((session) => ({
        kind: session.kind,
        label: session.label,
        schedule: session.schedule,
      })),
    evidenceId: item.evidence?.evidenceId || null,
  };
};

const raceOverview = (item) => {
  const event = eventOverview(item);
  if (!event) return null;
  const results = item.results
    .filter((row) => rankedResult(row))
    .sort((a, b) => a.position - b.position)
    .slice(0, 5)
    .map((row) => {
      const driver = entryDriver(row);
      const constructor = entryConstructor(row);
      return {
        position: row.position,
        driverId: driver?.id || null,
        driverName: display(driver),
        constructorId: constructor?.id || null,
        constructorName: display(constructor),
        number: row.entry?.number || null,
        gridPosition: row.grid?.position ?? null,
        points: numeric(row.points),
        status: row.status || null,
        statusLabel: row.statusLabel || null,
        gap: row.gap || null,
      };
    });
  const podium = results.filter((row) => row.position >= 1 && row.position <= 3);
  const fastest = item.results.find((row) => rankedResult(row) && row.fastestLap?.rank === 1);
  const fastestDriver = entryDriver(fastest);
  return {
    ...event,
    results,
    podium,
    fastestLap: fastest
      ? {
          driverId: fastestDriver?.id || null,
          driverName: display(fastestDriver),
          lapNumber: fastest.fastestLap.lapNumber ?? null,
          durationMs: fastest.fastestLap.durationMs ?? null,
        }
      : null,
  };
};

const coverage = (set) => set?.coverage || 'unavailable';

const numericRange = (values) => {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  const total = finite.reduce((sum, value) => sum + value, 0);
  return {
    min: Math.min(...finite),
    max: Math.max(...finite),
    average: Math.round((total / finite.length) * 10) / 10,
  };
};

const latestSessionHighlights = async (get, latest) => {
  if (!latest?.session?.id) return null;
  const sessionId = latest.session.id;
  const [weatherSet, stintsSet, pitStopsSet, overtakesSet, raceControlSet] = await Promise.all([
    get(`weather:${sessionId}`),
    get(`stints:${sessionId}`),
    get(`pit-stops:${sessionId}`),
    get(`overtakes:${sessionId}`),
    get(`race-control:${sessionId}`),
  ]);
  const results = latest.results || [];
  const entries = new Map(
    results
      .filter((row) => row.entry?.id)
      .map((row) => [
        row.entry.id,
        {
          driverId: entryDriver(row)?.id || null,
          driverName: display(entryDriver(row)),
          position: row.position ?? Number.MAX_SAFE_INTEGER,
        },
      ]),
  );
  const driverForEntry = (entryId) => entries.get(entryId) || null;
  const orderDrivers = (map) =>
    [...map.values()].sort(
      (a, b) => a.position - b.position || a.driverName.localeCompare(b.driverName),
    );
  const withoutPosition = ({ position: _position, ...driver }) => driver;

  const weatherRows = weatherSet?.items || [];
  const tyreMap = new Map();
  for (const stint of stintsSet?.items || []) {
    const driver = driverForEntry(stint.entryId);
    if (!driver) continue;
    const record = tyreMap.get(driver.driverId) || {
      ...driver,
      compounds: [],
      stintCount: 0,
      laps: 0,
    };
    const compound = stint.compoundLabel || stint.compoundClass || null;
    if (compound && !record.compounds.includes(compound)) record.compounds.push(compound);
    record.stintCount += 1;
    if (Number.isFinite(stint.startLap) && Number.isFinite(stint.endLap))
      record.laps += Math.max(0, stint.endLap - stint.startLap + 1);
    tyreMap.set(driver.driverId, record);
  }

  const pitStopRows = pitStopsSet?.items || [];
  const pitStopDrivers = new Map();
  for (const stop of pitStopRows) {
    const driver = driverForEntry(stop.entryId);
    if (!driver) continue;
    const record = pitStopDrivers.get(driver.driverId) || { ...driver, count: 0 };
    record.count += 1;
    pitStopDrivers.set(driver.driverId, record);
  }

  const overtakeDrivers = new Map();
  for (const overtake of overtakesSet?.items || []) {
    const driver = driverForEntry(overtake.passingEntryId);
    if (!driver) continue;
    const record = overtakeDrivers.get(driver.driverId) || { ...driver, count: 0 };
    record.count += 1;
    overtakeDrivers.set(driver.driverId, record);
  }

  const controlRows = raceControlSet?.items || [];
  return {
    sessionId,
    kind: latest.session.kind,
    weather: {
      coverage: coverage(weatherSet),
      observations: weatherRows.length,
      airTemperatureC: numericRange(weatherRows.map((row) => row.airTemperatureC)),
      trackTemperatureC: numericRange(weatherRows.map((row) => row.trackTemperatureC)),
      humidityPercent: numericRange(weatherRows.map((row) => row.humidityPercent)),
      rainfallObservations: weatherRows.filter((row) => row.rainfall === true).length,
    },
    tyres: {
      coverage: coverage(stintsSet),
      count: stintsSet?.items?.length || 0,
      drivers: orderDrivers(tyreMap).slice(0, 5).map(withoutPosition),
    },
    pitStops: {
      coverage: coverage(pitStopsSet),
      count: pitStopRows.length,
      drivers: orderDrivers(pitStopDrivers).slice(0, 5).map(withoutPosition),
    },
    overtakes: {
      coverage: coverage(overtakesSet),
      count: overtakesSet?.items?.length || 0,
      leaders: [...overtakeDrivers.values()]
        .sort((a, b) => b.count - a.count || a.position - b.position)
        .slice(0, 5)
        .map(withoutPosition),
    },
    raceControl: {
      coverage: coverage(raceControlSet),
      events: controlRows.length,
      flagEvents: controlRows.filter((row) => row.flag).length,
      flags: [...new Set(controlRows.map((row) => row.flag).filter(Boolean))],
    },
  };
};

function parseFilters(query, { comparison = false } = {}) {
  const season = integer(query.season, 'season', { min: 1900, max: 2200 });
  const fromRound = integer(query.fromRound, 'fromRound', { min: 1, max: 100 });
  const toRound = integer(query.toRound, 'toRound', { min: 1, max: 100 });
  if (fromRound && toRound && fromRound > toRound)
    throw invalid('fromRound must not be greater than toRound.');
  const filters = {
    season,
    fromRound,
    toRound,
    driverIds: splitIds(
      comparison ? query.drivers : query.driverIds,
      comparison ? 'drivers' : 'driverIds',
    ),
    constructorIds: splitIds(query.constructorIds, 'constructorIds'),
    circuitIds: splitIds(query.circuitIds, 'circuitIds'),
    sessionType: query.sessionType || 'race',
    snapshotId: query.snapshotId || null,
  };
  if (!['race', 'qualifying', 'sprint'].includes(filters.sessionType))
    throw invalid('sessionType must be race, qualifying, or sprint.');
  return filters;
}

export class AnalyticsService {
  constructor(repository) {
    this.repository = repository;
  }

  async loadContext(query, options = {}) {
    const filters = parseFilters(query, options);
    const snapshot = await this.repository.snapshot(filters.snapshotId);
    if (!snapshot) throw missing();
    const get = (key) => this.repository.get(key, snapshot.id);
    const keys = (prefix) => this.repository.keys(prefix, snapshot.id);
    const seasonsSet = await get('seasons');
    const seasons = seasonsSet?.items || [];
    if (!seasons.length) throw missing();
    const season = filters.season || Math.max(...seasons.map((item) => item.year));
    if (!seasons.some((item) => item.year === season)) throw missing();
    filters.season = season;
    const eventsSet = await get(`events:${season}`);
    const allEvents = [...(eventsSet?.items || [])].sort((a, b) => a.round - b.round);
    const events = allEvents
      .filter((event) => !filters.fromRound || event.round >= filters.fromRound)
      .filter((event) => !filters.toRound || event.round <= filters.toRound)
      .filter(
        (event) => !filters.circuitIds.length || filters.circuitIds.includes(event.circuit?.id),
      )
      .sort((a, b) => a.round - b.round);
    const allEventContexts = await Promise.all(
      allEvents.map(async (event) => {
        const detail = await get(`event:${event.id}`);
        const sessionsSet = detail || (await get(`sessions:${event.id}`));
        const sessions = detail?.items?.[0]?.sessions || sessionsSet?.items || [];
        const selected =
          sessions.find((session) => session.kind === filters.sessionType) ||
          (filters.sessionType === 'race'
            ? sessions.find((session) => session.kind === 'race')
            : null);
        const resultSet = selected
          ? await get(`${selected.kind === 'qualifying' ? 'qualifying' : 'results'}:${selected.id}`)
          : null;
        const qualifyingSession = sessions.find((session) => session.kind === 'qualifying');
        const qualifyingSet = qualifyingSession
          ? await get(`qualifying:${qualifyingSession.id}`)
          : null;
        const raceSession = sessions.find((session) => session.kind === 'race');
        const raceSet = raceSession
          ? selected?.id === raceSession.id
            ? resultSet
            : await get(`results:${raceSession.id}`)
          : null;
        const publishedRows = (session, set) =>
          session?.status === 'scheduled' || set?.coverage === 'unavailable'
            ? []
            : set?.items || [];
        return {
          event,
          sessions,
          session: selected,
          results: publishedRows(selected, resultSet),
          raceSession,
          raceResults: publishedRows(raceSession, raceSet),
          raceEvidence: raceSet,
          qualifying: publishedRows(qualifyingSession, qualifyingSet),
          evidence: resultSet || qualifyingSet || detail || eventsSet,
        };
      }),
    );
    const eventIds = new Set(events.map((event) => event.id));
    const eventContexts = allEventContexts.filter((item) => eventIds.has(item.event.id));
    const profiles = await Promise.all((await keys('profile:')).map(get));
    const profileItems = profiles.flatMap((set) => set?.items || []);
    const driverProfiles = profileItems.filter((profile) => profile.kind === 'driver');
    return {
      snapshot,
      filters,
      seasonsSet,
      eventsSet,
      events,
      allEvents,
      allEventContexts,
      eventContexts,
      driverProfiles,
    };
  }

  filterRows(rows, filters) {
    return rows.filter((row) => {
      const driverIds = (row.entry?.drivers || []).map((driver) => driver.id);
      const constructorId = row.entry?.constructor?.id;
      return (
        (!filters.driverIds.length || driverIds.some((id) => filters.driverIds.includes(id))) &&
        (!filters.constructorIds.length || filters.constructorIds.includes(constructorId))
      );
    });
  }

  driverOptions(context) {
    const fromRows = context.allEventContexts.flatMap((item) => driverRows(item.results));
    const byId = new Map();
    for (const row of fromRows) byId.set(row.driverId, row.driver);
    return [...byId.values()]
      .filter(Boolean)
      .sort((a, b) => display(a).localeCompare(display(b)))
      .map((entity) => ({ id: entity.id, name: display(entity) }));
  }

  async dashboard(query) {
    const context = await this.loadContext(query);
    const { filters, eventContexts } = context;
    const seasonContexts = context.allEventContexts.map((item) => ({
      ...item,
      session: item.raceSession,
      results: item.raceResults,
      evidence: item.raceEvidence,
    }));
    const standingGet = (key) => this.repository.get(key, context.snapshot.id);
    const latestStandings = await standingGet(`standings:${filters.season}:drivers`);
    const standingIds = [
      ...new Set(
        (latestStandings?.coverage === 'unavailable' ? [] : latestStandings?.items || []).map(
          (row) => row.standingSnapshotId,
        ),
      ),
    ];
    const standingMatch =
      standingIds.length === 1 ? String(standingIds[0]).match(/^standing:(\d+):(\d+)$/) : null;
    const standingRound =
      standingMatch && Number(standingMatch[1]) === filters.season
        ? Number(standingMatch[2])
        : null;
    const [driverStandings, constructorStandings] = standingRound
      ? await Promise.all([
          standingGet(`standings:${filters.season}:drivers:${standingRound}`),
          standingGet(`standings:${filters.season}:constructors:${standingRound}`),
        ])
      : [null, null];
    const standingRows = (set) =>
      (set?.coverage === 'unavailable' ? [] : set?.items || [])
        .filter((row) => row.standingSnapshotId === `standing:${filters.season}:${standingRound}`)
        .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
    const standingCoverage = (set) => {
      const rows = standingRows(set);
      if (!rows.length) return 'unavailable';
      return rows.length === set.items.length ? coverage(set) : 'partial';
    };
    const championship = {
      season: filters.season,
      round: standingRound,
      snapshotId: context.snapshot.id,
      drivers: standingRows(driverStandings).map((row) => ({
        ...row,
        number: row.number == null ? null : String(row.number),
      })),
      constructors: standingRows(constructorStandings),
      driverCoverage: standingCoverage(driverStandings),
      constructorCoverage: standingCoverage(constructorStandings),
      driverEvidenceId: driverStandings?.evidenceId || null,
      constructorEvidenceId: constructorStandings?.evidenceId || null,
    };
    const raceContexts = eventContexts.map((item) => ({
      ...item,
      rows: this.filterRows(item.results, filters),
    }));
    const driverMap = new Map();
    for (const item of raceContexts) {
      for (const row of driverRows(item.rows)) driverMap.set(row.driverId, row.driver);
    }
    const selectedDriverIds = filters.driverIds.length
      ? filters.driverIds.filter((id) => driverMap.has(id))
      : [...driverMap.keys()];
    const progressionEvents = raceContexts.filter((item) => item.rows.length);
    const progression = selectedDriverIds.map((driverId) => {
      let total = 0;
      const entity = driverMap.get(driverId);
      return {
        driverId,
        driverName: display(entity),
        number:
          context.driverProfiles
            .find((profile) => profile.id === driverId)
            ?.metrics?.find((metric) => metric.key === 'number')?.value || null,
        points: progressionEvents.map((item) => {
          const row = driverRows(item.rows).find((entry) => entry.driverId === driverId);
          if (row?.points == null) return null;
          total += numeric(row.points) || 0;
          return total;
        }),
      };
    });
    const qualifyingVsFinish = raceContexts.flatMap((item) => {
      const qualifyingByDriver = new Map(
        driverRows(item.qualifying).map((row) => [row.driverId, row]),
      );
      return driverRows(item.rows)
        .filter((row) => qualifyingByDriver.has(row.driverId))
        .map((row) => {
          const qualifying = qualifyingByDriver.get(row.driverId);
          return {
            eventId: item.event.id,
            eventName: item.event.name,
            round: item.event.round,
            driverId: row.driverId,
            driverName: row.driverName,
            qualifyingPosition: qualifying.position,
            finishPosition: row.position,
            gridPosition: row.grid?.position ?? null,
            points: numeric(row.points),
          };
        });
    });
    const constructorTotals = new Map();
    for (const item of raceContexts) {
      for (const row of item.rows) {
        const constructor = row.entry?.constructor;
        if (!constructor) continue;
        const record = constructorTotals.get(constructor.id) || {
          constructorId: constructor.id,
          constructorName: display(constructor),
          totalPoints: null,
          drivers: new Map(),
        };
        const publishedPoints = numeric(row.points);
        if (publishedPoints != null)
          record.totalPoints = (record.totalPoints ?? 0) + publishedPoints;
        for (const driver of row.entry.drivers || [])
          record.drivers.set(driver.id, {
            driverId: driver.id,
            driverName: display(driver),
            points:
              publishedPoints == null
                ? (record.drivers.get(driver.id)?.points ?? null)
                : (record.drivers.get(driver.id)?.points ?? 0) + publishedPoints,
          });
        constructorTotals.set(constructor.id, record);
      }
    }
    const constructorContribution = [...constructorTotals.values()]
      .map((record) => ({
        ...record,
        drivers: [...record.drivers.values()].sort((a, b) => b.points - a.points),
      }))
      .sort((a, b) => b.totalPoints - a.totalPoints);
    const circuitMap = new Map();
    const circuitCells = [];
    for (const item of raceContexts) {
      const circuit = item.event.circuit;
      if (!circuit) continue;
      const rows = driverRows(item.rows).filter(rankedResult);
      if (!rows.length) continue;
      circuitMap.set(circuit.id, circuit);
      for (const row of rows) {
        circuitCells.push({
          circuitId: circuit.id,
          driverId: row.driverId,
          value: row.position,
          starts: summarizeOutcomes([row]).starts,
          averageFinish: row.position ?? null,
        });
      }
    }
    const latest = [...seasonContexts]
      .reverse()
      .find((item) => item.event.status === 'completed' || item.results.length);
    const next = seasonContexts.find(
      (item) => item.event.status === 'scheduled' && !item.results.length,
    );
    const totalPoints = sumPublishedPoints(raceContexts.flatMap((item) => item.rows));
    const defaultComparison = await this.driverComparisonFromContext(context, filters.driverIds);
    const championshipLeader = championship.drivers.find((row) => row.rank === 1) || null;
    const seasonComparison = await this.driverComparisonFromContext(
      {
        ...context,
        eventContexts: seasonContexts,
        filters: {
          ...filters,
          driverIds: [],
          constructorIds: [],
          circuitIds: [],
          sessionType: 'race',
        },
      },
      [],
    );
    const leaderMetrics = seasonComparison.drivers.find(
      (row) => row.id === championshipLeader?.entity?.id,
    )?.metrics;
    const constructorLeader = championship.constructors.find((row) => row.rank === 1) || null;
    const completedEvents = seasonContexts.filter(
      (item) => item.event.status === 'completed' || item.results.length,
    ).length;
    const resultRows = raceContexts.flatMap((item) => item.rows);
    const outcomeCounts = summarizeOutcomes(resultRows);
    const rankedRows = resultRows.filter(rankedResult);
    const raceBreakdown = {
      ...outcomeCounts,
      wins: rankedRows.filter((row) => row.position === 1).length,
      podiums: rankedRows.filter((row) => row.position >= 1 && row.position <= 3).length,
      fastestLaps: rankedRows.filter((row) => row.fastestLap?.rank === 1).length,
    };
    const latestSessionData = await latestSessionHighlights(
      (key) => this.repository.get(key, context.snapshot.id),
      latest,
    );
    const raceWinnerIds = new Set();
    const podiumDriverIds = new Set();
    for (const item of raceContexts) {
      for (const row of driverRows(item.rows)) {
        if (!rankedResult(row)) continue;
        if (row.position === 1) raceWinnerIds.add(row.driverId);
        if (row.position >= 1 && row.position <= 3) podiumDriverIds.add(row.driverId);
      }
    }
    const weekendTimeline = seasonContexts.map((item) => {
      const overview = raceOverview(item);
      const winner = overview?.podium?.find((row) => row.position === 1) || null;
      return {
        id: item.event.id,
        name: item.event.name,
        year: item.event.year,
        round: item.event.round,
        status: item.event.status,
        completed: item.event.status === 'completed' || item.results.length > 0,
        circuit: item.event.circuit || null,
        schedule: item.event.schedule || null,
        winner: winner
          ? {
              driverId: winner.driverId,
              driverName: winner.driverName,
              constructorName: winner.constructorName,
            }
          : null,
      };
    });
    const dashboard = {
      filters,
      championship,
      analysisScope: {
        season: filters.season,
        sessionType: filters.sessionType,
        fromRound: filters.fromRound,
        toRound: filters.toRound,
        matchingEntries: resultRows.length,
        empty: resultRows.length === 0,
        coverage:
          raceContexts.length &&
          raceContexts.every((item) => item.evidence?.coverage === 'complete')
            ? 'complete'
            : resultRows.length
              ? 'partial'
              : 'unavailable',
        publishedSessions: raceContexts.filter((item) => item.rows.length).length,
        selectedEvents: context.events.length,
      },
      filterOptions: {
        seasons: context.seasonsSet.items
          .map((season) => ({ year: season.year, name: String(season.year) }))
          .sort((a, b) => b.year - a.year),
        drivers: this.driverOptions(context),
        constructors: [
          ...new Map(
            context.allEventContexts
              .flatMap((item) => item.results)
              .filter((row) => row.entry?.constructor)
              .map((row) => [row.entry.constructor.id, row.entry.constructor]),
          ).values(),
        ]
          .map((entity) => ({ id: entity.id, name: display(entity) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        circuits: [
          ...new Map(
            context.allEventContexts
              .filter((item) => item.results.length && item.event.circuit)
              .map((item) => [item.event.circuit.id, item.event.circuit]),
          ).values(),
        ]
          .map((entity) => ({ id: entity.id, name: display(entity) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        sessionTypes: ['race', 'qualifying', 'sprint'],
      },
      quickStats: {
        totalEvents: context.events.length,
        completedEvents: raceContexts.filter(
          (item) => item.event.status === 'completed' || item.results.length,
        ).length,
        totalPoints: resultRows.length ? totalPoints : null,
        driverCount: new Set(
          raceContexts.flatMap((item) => driverRows(item.rows).map((row) => row.driverId)),
        ).size,
        constructorCount: constructorTotals.size,
        circuitCount: circuitMap.size,
        raceWinnerCount: resultRows.length ? raceWinnerIds.size : null,
        podiumDriverCount: resultRows.length ? podiumDriverIds.size : null,
        publishedStarts: resultRows.length ? raceBreakdown.starts : null,
        fastestLapCount: resultRows.length ? raceBreakdown.fastestLaps : null,
        podiumRate: percentage(raceBreakdown.podiums, raceBreakdown.starts),
        retirementRate:
          filters.sessionType === 'qualifying'
            ? null
            : percentage(raceBreakdown.retirements, raceBreakdown.retirementEligibleStarts),
        dnfRate: null,
      },
      latestHighlights: {
        latestCompleted: latest?.event || null,
        nextEvent: next?.event || null,
      },
      latestSessionHighlights: latestSessionData,
      weekendTimeline,
      seasonIntelligence: {
        progress: {
          totalEvents: context.allEvents.length,
          completedEvents,
          percentage: context.allEvents.length
            ? Math.round((completedEvents / context.allEvents.length) * 100)
            : 0,
        },
        championshipLeader: championshipLeader
          ? {
              driverId: championshipLeader.entity.id,
              driverName: display(championshipLeader.entity),
              position: championshipLeader.rank,
              number:
                championshipLeader.number ||
                seasonContexts
                  .flatMap((item) => driverRows(item.results))
                  .find((row) => row.driverId === championshipLeader.entity.id)?.entry?.number ||
                null,
              points: numeric(championshipLeader.points),
              wins: championshipLeader.wins,
              podiums: leaderMetrics?.podiums ?? null,
              averageFinish: leaderMetrics?.averageFinish ?? null,
              retirementRate: leaderMetrics?.retirementRate ?? null,
              fastestLaps: leaderMetrics?.fastestLaps ?? null,
              positionsGained: leaderMetrics?.positionsGained ?? null,
              recentForm: leaderMetrics?.recentForm || [],
              constructor: championshipLeader.constructors?.[0] || null,
            }
          : null,
        constructorLeader: constructorLeader
          ? {
              constructorId: constructorLeader.entity.id,
              constructorName: display(constructorLeader.entity),
              points: numeric(constructorLeader.points),
            }
          : null,
        latestRace: raceOverview(latest),
        nextRace: eventOverview(next),
        raceBreakdown,
      },
      pointsProgression: {
        events: progressionEvents.map((item) => ({
          round: item.event.round,
          eventId: item.event.id,
          name: item.event.name,
        })),
        series: progression,
      },
      qualifyingVsFinish,
      constructorContribution,
      circuitPerformance: {
        circuits: [...circuitMap.values()].map((circuit) => ({
          id: circuit.id,
          name: display(circuit),
        })),
        drivers: [...driverMap.entries()].map(([id, entity]) => ({ id, name: display(entity) })),
        cells: circuitCells,
      },
      defaultComparison,
      insights: [
        latest
          ? `${latest.event.name} is the latest published event in this selection.`
          : 'No completed events are published for this selection.',
        championshipLeader
          ? `${display(championshipLeader.entity)} leads the published season championship after round ${standingRound} with ${championshipLeader.points} points.`
          : 'Driver standings are unavailable for this selection.',
        constructorContribution[0]?.totalPoints != null
          ? `${constructorContribution[0].constructorName} has ${constructorContribution[0].totalPoints} published points in the selected ${filters.sessionType} results.`
          : 'Constructor contribution is unavailable for this selection.',
        `${completedEvents} of ${context.allEvents.length} season events have published race results.`,
      ],
    };
    return {
      body: {
        data: { analyticsDashboard: dashboard },
        meta: meta(context.eventsSet, context.snapshot),
      },
      snapshot: context.snapshot,
      key: ['dashboard', filters, dashboard],
    };
  }

  async driverComparison(query) {
    const context = await this.loadContext(query, { comparison: true });
    const comparison = await this.driverComparisonFromContext(context, context.filters.driverIds);
    return {
      body: {
        data: { driverComparison: comparison },
        meta: meta(context.eventsSet, context.snapshot),
      },
      snapshot: context.snapshot,
      key: ['driver-comparison', context.filters, comparison],
    };
  }

  async driverComparisonFromContext(context, requestedIds) {
    const rows = context.eventContexts.flatMap((item) =>
      driverRows(this.filterRows(item.results, context.filters)).map((row) => ({
        ...row,
        event: item.event,
      })),
    );
    const available = new Map(rows.map((row) => [row.driverId, row.driver]));
    const ids = requestedIds.length
      ? requestedIds.filter((id) => available.has(id))
      : [...available.keys()];
    return {
      filters: context.filters,
      drivers: ids.map((id) => {
        const driverRowsForId = rows.filter((row) => row.driverId === id);
        const finishes = driverRowsForId.filter(rankedResult);
        const outcomes = summarizeOutcomes(driverRowsForId);
        const starts = driverRowsForId.filter((row) => summarizeOutcomes([row]).starts === 1);
        const points = sumPublishedPoints(driverRowsForId);
        const isQualifying = context.filters.sessionType === 'qualifying';
        const wins = finishes.filter((row) => row.position === 1).length;
        const podiums = finishes.filter((row) => row.position >= 1 && row.position <= 3).length;
        const average = (values) =>
          values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
        return {
          id,
          name: display(available.get(id)),
          metrics: {
            races: isQualifying ? driverRowsForId.length : starts.length,
            qualifyingEntries: isQualifying ? driverRowsForId.length : null,
            startDefinition: isQualifying
              ? 'published qualifying entries'
              : 'known outcome or positive published laps',
            wins,
            podiums,
            points,
            averageGrid: average(starts.map((row) => row.grid?.position).filter(Number.isFinite)),
            averageFinish: average(finishes.map((row) => row.position).filter(Number.isFinite)),
            positionsGained: starts.reduce(
              (total, row) =>
                total +
                ((row.grid?.position || row.position) - (row.position || row.grid?.position || 0)),
              0,
            ),
            outcomes,
            retirementRate:
              context.filters.sessionType === 'qualifying' ? null : outcomes.retirementRate,
            dnfRate: null,
            fastestLaps: finishes.filter((row) => row.fastestLap?.rank === 1).length,
            pointsPerRace:
              !isQualifying && points != null && starts.length ? points / starts.length : null,
            recentForm: finishes.slice(-5).map((row) => row.position),
          },
        };
      }),
    };
  }

  etag(result) {
    return `"${hash([result.snapshot.id, result.key])}"`;
  }
}
