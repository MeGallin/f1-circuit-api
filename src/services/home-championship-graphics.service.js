import Decimal from 'decimal.js';
import { invalid } from '../errors/api-error.js';
import { hash, meta } from '../models/dataset.js';

// Bound the projection to one season, not a cross-archive scan. Scoring uses
// decimal arithmetic; JS numbers are reserved for ranks/rounds and UI geometry.
const MAX_ROUNDS = 64;
const Score = Decimal.clone({ precision: 128 });
const score = (value) =>
  value != null && /^-?\d+(\.\d+)?$/.test(String(value)) && String(value).length <= 120
    ? new Score(value)
    : null;
const total = (values) =>
  values.length ? values.reduce((sum, value) => sum.plus(value), new Score(0)).toFixed() : null;
const available = (set) => ['complete', 'partial'].includes(set?.coverage);
const name = (entity) => entity?.displayName || entity?.id || 'Not supplied';
function standings(set, standingSnapshotId) {
  const rows = available(set) && Array.isArray(set.items) ? set.items : [];
  const ids = new Set();
  return rows.every((row) => {
    if (
      !row ||
      row.standingSnapshotId !== standingSnapshotId ||
      !row.entity?.id ||
      ids.has(row.entity.id)
    )
      return false;
    ids.add(row.entity.id);
    return true;
  })
    ? rows
    : [];
}
function classification(set, session) {
  const rows = available(set) && Array.isArray(set.items) ? set.items : [];
  const ids = new Set();
  const entries = new Set();
  const valid =
    Array.isArray(set?.items) &&
    rows.every((row) => {
      if (
        !row ||
        !row.id ||
        ids.has(row.id) ||
        row.sessionId !== session.id ||
        !row.entry?.id ||
        entries.has(row.entry.id) ||
        !Array.isArray(row.entry.drivers) ||
        !row.entry.drivers.length ||
        !row.entry.drivers.every((driver) => typeof driver?.id === 'string' && driver.id)
      )
        return false;
      ids.add(row.id);
      entries.add(row.entry.id);
      return true;
    });
  return {
    session,
    rows: valid ? rows : [],
    coverage: valid && available(set) ? set.coverage : 'unavailable',
  };
}
function standingRound(rows, standingCoverage, entityId) {
  const own = rows.find((row) => row.entity.id === entityId);
  // A second rank-one row is ambiguous even when its score is missing.
  const leaders = rows.filter((row) => row.rank === 1);
  const leader = leaders.length === 1 ? leaders[0] : null;
  const leaderPoints = score(leader?.points);
  const points = score(own?.points);
  const difference = points && leaderPoints ? leaderPoints.minus(points) : null;
  return {
    points: points?.toFixed() ?? null,
    gap: difference && !difference.isNegative() ? difference.toFixed() : null,
    rank: Number.isSafeInteger(own?.rank) && own.rank > 0 ? own.rank : null,
    leaderId: leader?.entity.id || null,
    leaderName: leader ? name(leader.entity) : null,
    leaderPoints: leaderPoints?.toFixed() ?? null,
    coverage: difference && !difference.isNegative() ? standingCoverage : 'unavailable',
  };
}
function driverRound(rows, standingCoverage, sessions, entityId) {
  const race = sessions.find((session) => session.session.kind === 'race');
  const entries =
    race?.rows.filter((row) => row.entry.drivers?.some((driver) => driver.id === entityId)) || [];
  const raceValues = entries.map((row) => score(row.points)).filter(Boolean);
  return {
    ...standingRound(rows, standingCoverage, entityId),
    racePoints: total(raceValues),
    raceCoverage: !raceValues.length
      ? 'unavailable'
      : race?.coverage === 'complete' && raceValues.length === entries.length
        ? 'complete'
        : 'partial',
  };
}
export class HomeChampionshipGraphicsService {
  constructor(repository) {
    this.repository = repository;
  }
  async read({ year, standingSnapshotId }, snapshot) {
    const match = /^standing:(\d+):([1-9]\d*)$/.exec(standingSnapshotId || '');
    const round = Number(match?.[2]);
    if (!match || Number(match[1]) !== year || !Number.isSafeInteger(round) || round > MAX_ROUNDS)
      throw invalid('Standing snapshot must belong to this season and a bounded round.');
    const many = (keys) =>
      this.repository.getMany
        ? this.repository.getMany([...new Set(keys)], snapshot.id)
        : Promise.all(
            [...new Set(keys)].map(async (key) => [
              key,
              await this.repository.get(key, snapshot.id),
            ]),
          ).then((rows) => new Map(rows));
    const first = await many([
      `events:${year}`,
      `standings:${year}:drivers:${round}`,
      `standings:${year}:constructors:${round}`,
    ]);
    const calendar = first.get(`events:${year}`);
    const calendarRows =
      available(calendar) &&
      Array.isArray(calendar.items) &&
      calendar.items.every((event) => event && typeof event.id === 'string' && event.id)
        ? calendar.items
        : [];
    const events = calendarRows
      .filter(
        (event) =>
          event.year === year &&
          event.status === 'completed' &&
          Number.isSafeInteger(event.round) &&
          event.round > 0 &&
          event.round <= round,
      )
      .sort((a, b) => a.round - b.round);
    if (
      events.length > MAX_ROUNDS ||
      new Set(events.map((event) => event.id)).size !== events.length ||
      new Set(events.map((event) => event.round)).size !== events.length
    )
      throw invalid('Ambiguous or unbounded completed rounds.');
    const selected = Object.fromEntries(
      ['drivers', 'constructors'].map((kind) => [
        kind,
        standings(first.get(`standings:${year}:${kind}:${round}`), standingSnapshotId).slice(0, 3),
      ]),
    );
    const second = await many(
      events.flatMap((event) => [
        `standings:${year}:drivers:${event.round}`,
        `standings:${year}:constructors:${event.round}`,
        `sessions:${event.id}`,
      ]),
    );
    const contexts = events.map((event) => {
      const supplied = second.get(`sessions:${event.id}`);
      const races = (
        available(supplied) && Array.isArray(supplied.items) ? supplied.items : []
      ).filter((session) => session?.kind === 'race');
      const sessions =
        races.length === 1 && races[0].eventId === event.id && races[0].id ? races : [];
      // A completed event without a published race session is a missing race,
      // not an invented zero. No guessed canonical session IDs are requested.
      if (!sessions.some((session) => session.kind === 'race'))
        sessions.push({ id: null, eventId: event.id, kind: 'race', status: 'unknown' });
      return { event, sessions, indexCoverage: supplied?.coverage || 'unavailable' };
    });
    const third = await many(
      contexts.flatMap((context) =>
        context.sessions
          .filter((session) => session.id && session.status !== 'scheduled')
          .map((session) => `results:${session.id}`),
      ),
    );
    const rounds = contexts.map(({ event, sessions, indexCoverage }) => ({
      event,
      sessions: sessions.map((session) => {
        const result = classification(
          session.status === 'scheduled' ? null : third.get(`results:${session.id}`),
          session,
        );
        if (result.coverage === 'complete' && indexCoverage !== 'complete')
          result.coverage = 'partial';
        return result;
      }),
      standingSet: second.get(`standings:${year}:drivers:${event.round}`),
      constructorStandingSet: second.get(`standings:${year}:constructors:${event.round}`),
    }));
    const graphics = {
      year,
      round,
      snapshotId: snapshot.id,
      standingSnapshotId,
      rounds: events.map((event) => ({ round: event.round, eventId: event.id, name: event.name })),
      drivers: selected.drivers.map((row) => ({
        entityId: row.entity.id,
        name: name(row.entity),
        rounds: rounds.map((context) => ({
          round: context.event.round,
          ...driverRound(
            standings(context.standingSet, `standing:${year}:${context.event.round}`),
            context.standingSet?.coverage,
            context.sessions,
            row.entity.id,
          ),
        })),
      })),
      constructors: selected.constructors.map((row) => ({
        entityId: row.entity.id,
        name: name(row.entity),
        rounds: rounds.map((context) => ({
          round: context.event.round,
          ...standingRound(
            standings(context.constructorStandingSet, `standing:${year}:${context.event.round}`),
            context.constructorStandingSet?.coverage,
            row.entity.id,
          ),
        })),
      })),
    };
    const complete =
      calendar?.coverage === 'complete' &&
      graphics.drivers.length > 0 &&
      graphics.constructors.length > 0 &&
      graphics.rounds.length > 0 &&
      [...graphics.drivers, ...graphics.constructors].every((row) =>
        row.rounds.every((cell) => cell.coverage === 'complete'),
      ) &&
      graphics.drivers.every((row) => row.rounds.every((cell) => cell.raceCoverage === 'complete'));
    const metadata = meta(
      { ...calendar, coverage: complete ? 'complete' : events.length ? 'partial' : 'unavailable' },
      snapshot,
    );
    metadata.warnings = [
      ...metadata.warnings,
      {
        code: 'HOME_GRAPHICS_SCOPE',
        message:
          'Displayed top three only; driver and constructor gaps use each round’s published standings leader across all rows. Missing/partial data is not zero. Supplementary driver race entry points are not standings changes or sprint totals.',
        scope: 'home-championship-graphics',
      },
    ];
    const body = { data: { championshipGraphics: graphics }, meta: metadata };
    return {
      body,
      responseSchema: 'getHomeChampionshipGraphicsResponse',
      etag: `"${hash([snapshot.id, year, standingSnapshotId, body.data, metadata.freshness])}"`,
    };
  }
}
