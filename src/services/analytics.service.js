import { invalid, missing } from '../errors/api-error.js';
import { hash, meta } from '../models/dataset.js';

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
const completedResult = (row) =>
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
    .filter((row) => completedResult(row))
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
  const fastest = item.results.find((row) => completedResult(row) && row.fastestLap?.rank === 1);
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
    const events = (eventsSet?.items || [])
      .filter((event) => !filters.fromRound || event.round >= filters.fromRound)
      .filter((event) => !filters.toRound || event.round <= filters.toRound)
      .filter(
        (event) => !filters.circuitIds.length || filters.circuitIds.includes(event.circuit?.id),
      )
      .sort((a, b) => a.round - b.round);
    const eventContexts = await Promise.all(
      events.map(async (event) => {
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
        return {
          event,
          sessions,
          session: selected,
          results: resultSet?.items || [],
          qualifying: qualifyingSet?.items || [],
          evidence: resultSet || qualifyingSet || detail || eventsSet,
        };
      }),
    );
    const profiles = await Promise.all((await keys('profile:')).map(get));
    const profileItems = profiles.flatMap((set) => set?.items || []);
    const driverProfiles = profileItems.filter((profile) => profile.kind === 'driver');
    const constructorProfiles = profileItems.filter((profile) => profile.kind === 'constructor');
    const circuitProfiles = profileItems.filter((profile) => profile.kind === 'circuit');
    return {
      snapshot,
      filters,
      seasonsSet,
      eventsSet,
      events,
      eventContexts,
      driverProfiles,
      constructorProfiles,
      circuitProfiles,
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
    const fromRows = context.eventContexts.flatMap((item) => driverRows(item.results));
    const byId = new Map(context.driverProfiles.map((profile) => [profile.id, profile.entity]));
    for (const row of fromRows) byId.set(row.driverId, row.driver);
    return [...byId.values()]
      .filter(Boolean)
      .sort((a, b) => display(a).localeCompare(display(b)))
      .map((entity) => ({ id: entity.id, name: display(entity) }));
  }

  async dashboard(query) {
    const context = await this.loadContext(query);
    const { filters, eventContexts } = context;
    const raceContexts = eventContexts.map((item) => ({
      ...item,
      rows: this.filterRows(item.results, filters),
    }));
    const driverMap = new Map();
    const constructorMap = new Map();
    for (const item of raceContexts) {
      for (const row of driverRows(item.rows)) driverMap.set(row.driverId, row.driver);
      for (const row of item.rows) {
        if (row.entry?.constructor)
          constructorMap.set(row.entry.constructor.id, row.entry.constructor);
      }
    }
    for (const driver of context.driverProfiles) driverMap.set(driver.id, driver.entity);
    for (const constructor of context.constructorProfiles)
      constructorMap.set(constructor.id, constructor.entity);
    const selectedDriverIds = filters.driverIds.length
      ? filters.driverIds.filter((id) => driverMap.has(id))
      : [...driverMap.keys()];
    const progressionEvents = raceContexts.filter(
      (item) => item.results.length || item.event.status === 'completed',
    );
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
          if (row?.points != null) total += numeric(row.points) || 0;
          return row ? total : null;
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
    const driverConstructorMap = new Map();
    for (const item of raceContexts) {
      for (const row of item.rows) {
        const constructor = row.entry?.constructor;
        for (const driver of row.entry?.drivers || [])
          driverConstructorMap.set(driver.id, constructor || null);
        if (!constructor) continue;
        const record = constructorTotals.get(constructor.id) || {
          constructorId: constructor.id,
          constructorName: display(constructor),
          totalPoints: 0,
          drivers: new Map(),
        };
        record.totalPoints += numeric(row.points) || 0;
        for (const driver of row.entry.drivers || [])
          record.drivers.set(driver.id, {
            driverId: driver.id,
            driverName: display(driver),
            points: (record.drivers.get(driver.id)?.points || 0) + (numeric(row.points) || 0),
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
      circuitMap.set(circuit.id, circuit);
      for (const row of driverRows(item.rows)) {
        circuitCells.push({
          circuitId: circuit.id,
          driverId: row.driverId,
          value: row.position,
          starts: completedResult(row) ? 1 : 0,
          averageFinish: row.position ?? null,
        });
      }
    }
    const latest = [...raceContexts]
      .reverse()
      .find((item) => item.event.status === 'completed' || item.results.length);
    const next = raceContexts.find(
      (item) => item.event.status === 'scheduled' && !item.results.length,
    );
    const totalPoints = raceContexts.reduce(
      (total, item) =>
        total + item.rows.reduce((subtotal, row) => subtotal + (numeric(row.points) || 0), 0),
      0,
    );
    const defaultComparison = await this.driverComparisonFromContext(context, filters.driverIds);
    const championshipLeader = [...defaultComparison.drivers]
      .sort((a, b) => b.metrics.points - a.metrics.points)
      .at(0);
    const constructorLeader = constructorContribution[0] || null;
    const completedEvents = raceContexts.filter(
      (item) => item.event.status === 'completed' || item.results.length,
    ).length;
    const resultRows = raceContexts.flatMap((item) => item.rows);
    const startedRows = resultRows.filter(
      (row) => !['not-started', 'withdrawn', 'disqualified'].includes(row.status),
    );
    const classifiedRows = startedRows.filter(completedResult);
    const raceBreakdown = {
      entries: resultRows.length,
      starts: startedRows.length,
      classified: classifiedRows.length,
      dnfs: Math.max(0, startedRows.length - classifiedRows.length),
      wins: classifiedRows.filter((row) => row.position === 1).length,
      podiums: classifiedRows.filter((row) => row.position >= 1 && row.position <= 3).length,
      fastestLaps: classifiedRows.filter((row) => row.fastestLap?.rank === 1).length,
    };
    const dashboard = {
      filters,
      filterOptions: {
        seasons: context.seasonsSet.items
          .map((season) => ({ year: season.year, name: String(season.year) }))
          .sort((a, b) => b.year - a.year),
        drivers: this.driverOptions(context),
        constructors: [...context.constructorProfiles]
          .map((profile) => ({ id: profile.id, name: display(profile.entity) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        circuits: [...context.circuitProfiles]
          .map((profile) => ({ id: profile.id, name: display(profile.entity) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        sessionTypes: ['race', 'qualifying', 'sprint'],
      },
      quickStats: {
        totalEvents: context.events.length,
        completedEvents: raceContexts.filter(
          (item) => item.event.status === 'completed' || item.results.length,
        ).length,
        totalPoints,
        driverCount: new Set(
          raceContexts.flatMap((item) => driverRows(item.rows).map((row) => row.driverId)),
        ).size,
        constructorCount: constructorTotals.size,
        circuitCount: circuitMap.size,
        podiumRate: percentage(raceBreakdown.podiums, raceBreakdown.starts),
        dnfRate: percentage(raceBreakdown.dnfs, raceBreakdown.starts),
      },
      latestHighlights: {
        latestCompleted: latest?.event || null,
        nextEvent: next?.event || null,
      },
      seasonIntelligence: {
        progress: {
          totalEvents: context.events.length,
          completedEvents,
          percentage: context.events.length
            ? Math.round((completedEvents / context.events.length) * 100)
            : 0,
        },
        championshipLeader: championshipLeader
          ? {
              driverId: championshipLeader.id,
              driverName: championshipLeader.name,
              points: championshipLeader.metrics.points,
              wins: championshipLeader.metrics.wins,
              podiums: championshipLeader.metrics.podiums,
              averageFinish: championshipLeader.metrics.averageFinish,
              dnfRate: championshipLeader.metrics.dnfRate,
              fastestLaps: championshipLeader.metrics.fastestLaps,
              constructor: driverConstructorMap.get(championshipLeader.id) || null,
            }
          : null,
        constructorLeader: constructorLeader
          ? {
              constructorId: constructorLeader.constructorId,
              constructorName: constructorLeader.constructorName,
              points: constructorLeader.totalPoints,
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
          ? `${championshipLeader.name} leads the selected driver standings with ${championshipLeader.metrics.points} published points.`
          : 'Driver standings are unavailable for this selection.',
        constructorContribution[0]
          ? `${constructorContribution[0].constructorName} leads the selected race points contribution.`
          : 'Constructor contribution is unavailable for this selection.',
        `${completedEvents} of ${context.events.length} events have published results in this selection.`,
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
        const finishes = driverRowsForId.filter((row) => row.position != null);
        const starts = driverRowsForId.filter((row) => completedResult(row));
        const points = finishes.reduce((total, row) => total + (numeric(row.points) || 0), 0);
        const wins = finishes.filter((row) => row.position === 1).length;
        const podiums = finishes.filter((row) => row.position >= 1 && row.position <= 3).length;
        const average = (values) =>
          values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
        return {
          id,
          name: display(available.get(id)),
          metrics: {
            races: starts.length,
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
            dnfRate: driverRowsForId.length
              ? (driverRowsForId.length - starts.length) / driverRowsForId.length
              : 0,
            fastestLaps: finishes.filter((row) => row.fastestLap?.rank === 1).length,
            pointsPerRace: starts.length ? points / starts.length : 0,
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
