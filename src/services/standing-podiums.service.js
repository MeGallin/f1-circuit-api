import { rankedResult } from '../models/analytics-outcomes.js';

const MAX_ROUNDS = 64;
const available = (set) => ['complete', 'partial'].includes(set?.coverage);
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 160;

// Validate the complete stored collection before counting: a conflicting lower
// row can duplicate a podium entry/driver. Never silently deduplicate assertions.
function podium(set, session) {
  if (!available(set) || !Array.isArray(set.items) || set.items.length > 256) return null;
  const ids = new Set(),
    entries = new Set(),
    drivers = new Set(),
    positions = new Set();
  for (const row of set.items) {
    if (
      !row ||
      !id(row.id) ||
      ids.has(row.id) ||
      row.sessionId !== session.id ||
      !id(row.entry?.id) ||
      entries.has(row.entry.id) ||
      !id(row.entry.constructor?.id) ||
      !Array.isArray(row.entry.drivers) ||
      !row.entry.drivers.length ||
      row.entry.drivers.length > 8 ||
      (row.position !== null && (!Number.isSafeInteger(row.position) || row.position < 1))
    )
      return null;
    ids.add(row.id);
    entries.add(row.entry.id);
    for (const driver of row.entry.drivers) {
      if (!id(driver?.id) || drivers.has(driver.id)) return null;
      drivers.add(driver.id);
    }
    if (row.position !== null) {
      if (positions.has(row.position)) return null;
      positions.add(row.position);
    }
  }
  const rows = set.items.filter((row) => row.position >= 1 && row.position <= 3);
  if (
    rows.some(
      (row) =>
        !rankedResult(row) ||
        row.classified === false ||
        !['finished', 'retired'].includes(row.status),
    )
  )
    return null;
  return rows;
}

// Three bounded repository batches, independent of standing-row count or page.
// Every read uses the already selected immutable publication, never a provider.
export class StandingPodiumsService {
  constructor(repository) {
    this.repository = repository;
  }

  async project(set, { year, kind, round, snapshotId, readMany }) {
    if (!set || !Array.isArray(set.items)) return set;
    const match = /^standing:(\d+):([1-9]\d*)$/.exec(set.items[0]?.standingSnapshotId || '');
    const cutoff = Number(match?.[2]);
    const contextValid =
      match &&
      Number(match[1]) === year &&
      Number.isSafeInteger(cutoff) &&
      cutoff <= MAX_ROUNDS &&
      (!round || cutoff === round) &&
      set.items.every((row) => row?.standingSnapshotId === match[0] && id(row.entity?.id));
    const unavailable = () => ({
      ...set,
      items: set.items.map((row) => ({
        ...row,
        podiums: null,
        podiumCoverage: {
          coverage: 'unavailable',
          throughRound: contextValid ? cutoff : null,
          expectedRaces: contextValid ? cutoff : null,
          verifiedRaces: 0,
          observedRaces: 0,
          snapshotId,
          evidenceIds: [],
        },
      })),
    });
    if (!contextValid || !available(set)) return unavailable();
    const many = readMany || ((keys) => this.repository.getMany([...new Set(keys)], snapshotId));
    const first = await many([`events:${year}`]);
    const calendar = first.get(`events:${year}`);
    if (!available(calendar) || !Array.isArray(calendar.items) || calendar.items.length > 256)
      return unavailable();
    const events = calendar.items;
    const eventIds = new Set(),
      rounds = new Set();
    for (const event of events) {
      // Ignore only unambiguously later rounds. Unknown context may belong here.
      if (Number.isSafeInteger(event?.round) && event.round > cutoff) continue;
      if (
        !event ||
        !id(event.id) ||
        event.year !== year ||
        !Number.isSafeInteger(event.round) ||
        event.round < 1 ||
        event.round > MAX_ROUNDS ||
        eventIds.has(event.id) ||
        rounds.has(event.round)
      )
        return unavailable();
      eventIds.add(event.id);
      rounds.add(event.round);
    }
    // Later corruption is irrelevant unless it reuses an identity owned by this scope.
    if (
      events.some(
        (event) =>
          Number.isSafeInteger(event?.round) && event.round > cutoff && eventIds.has(event.id),
      )
    )
      return unavailable();
    const selected = events.filter((event) => event.round <= cutoff);
    const completed = selected.filter((event) => event.status === 'completed');
    const cancelled = selected.filter((event) => event.status === 'cancelled').length;
    const expectedRaces = cutoff - cancelled;
    const scopeComplete =
      selected.length === cutoff &&
      selected.every((event) => ['completed', 'cancelled'].includes(event.status));
    const second = await many(completed.map((event) => `sessions:${event.id}`));
    const sessionIdCounts = new Map();
    for (const event of completed) {
      const index = second.get(`sessions:${event.id}`);
      if (!available(index) || !Array.isArray(index.items) || index.items.length > 32) continue;
      for (const row of index.items)
        if (id(row?.id)) sessionIdCounts.set(row.id, (sessionIdCounts.get(row.id) || 0) + 1);
    }
    const sessions = completed.flatMap((event) => {
      const set = second.get(`sessions:${event.id}`);
      if (!available(set) || !Array.isArray(set.items) || set.items.length > 32) return [];
      const races = set.items.filter((session) => session?.kind === 'race');
      return races.length === 1 &&
        id(races[0].id) &&
        races[0].eventId === event.id &&
        races[0].status === 'completed'
        ? races
        : [];
    });
    // Check race ownership against every loaded index row, including Sprint/quali.
    if (sessions.some((session) => sessionIdCounts.get(session.id) !== 1)) return unavailable();
    const third = await many(sessions.map((session) => `results:${session.id}`));
    const counts = new Map(),
      evidenceIds = new Set();
    let verifiedRaces = 0,
      observedRaces = 0;
    for (const session of sessions) {
      const result = third.get(`results:${session.id}`);
      const rows = podium(result, session);
      if (!rows?.length) continue;
      observedRaces++;
      if (rows.length === 3) verifiedRaces++;
      if (id(result.evidenceId)) evidenceIds.add(result.evidenceId);
      for (const row of rows) {
        const entities = kind === 'drivers' ? row.entry.drivers : [row.entry.constructor];
        for (const entity of entities) counts.set(entity.id, (counts.get(entity.id) || 0) + 1);
      }
    }
    const coverage =
      scopeComplete && expectedRaces > 0 && verifiedRaces === expectedRaces
        ? 'complete'
        : observedRaces
          ? 'partial'
          : 'unavailable';
    return {
      ...set,
      items: set.items.map((row) => ({
        ...row,
        podiums: coverage === 'unavailable' ? null : counts.get(row.entity.id) || 0,
        podiumCoverage: {
          coverage,
          throughRound: cutoff,
          expectedRaces,
          verifiedRaces,
          observedRaces,
          snapshotId,
          evidenceIds: [...evidenceIds],
        },
      })),
    };
  }
}
