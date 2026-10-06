import { ApiError, invalid } from '../errors/api-error.js';
import { hash } from '../models/dataset.js';
import { normalizeWeekend } from '../models/normalization.js';
import { Jolpica } from '../providers/jolpica/client.js';
import { SyncService } from '../services/sync.service.js';
import { preserveRefreshDatasets } from '../services/preserve-refresh-data.js';
import { runSync } from './run-sync.js';
import { cacheSnapshot } from '../repositories/snapshot-cache.js';

export const MANUAL_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
export const MANUAL_REFRESH_STALE_RUN_MS = 5 * 60 * 1000;
export const MANUAL_REFRESH_RETRY_AFTER_MS = 15 * 1000;
export const MANUAL_REFRESH_TIMEOUT_MS = 29 * 1000;

const iso = (value) => value.toISOString();
const unavailable = () =>
  new ApiError(
    503,
    'SERVICE_UNAVAILABLE',
    'Race data could not be checked right now. The current publication remains active.',
  );

function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => key !== 'evidenceId')
      .sort()
      .map((key) => [key, comparable(value[key])]),
  );
}

function sameItems(left, right) {
  return JSON.stringify(comparable(left || [])) === JSON.stringify(comparable(right || []));
}

function rawCalendar(events) {
  return events.map((event) => {
    const startsAt = event.schedule?.startsAt;
    return {
      season: String(event.year),
      round: String(event.round),
      raceName: event.name,
      date: event.schedule?.date || startsAt?.slice(0, 10) || null,
      time: startsAt ? `${new Date(startsAt).toISOString().slice(11, 19)}Z` : null,
      Circuit: {
        circuitId: String(event.circuit?.id || '').replace(/^circuit:/, ''),
        circuitName: event.circuit?.displayName,
      },
    };
  });
}

async function currentRaceCalendar(repository, year, round) {
  const snapshot = await repository.snapshot();
  if (!snapshot) throw unavailable();
  const [seasons, eventSet] = await Promise.all([
    repository.get('seasons', snapshot.id),
    repository.get(`events:${year}`, snapshot.id),
  ]);
  const season = (seasons?.items || []).find((item) => Number(item.year) === year);
  const events = eventSet?.items || [];
  if (
    !season ||
    !events.length ||
    (Number.isInteger(Number(season.eventCount)) && Number(season.eventCount) !== events.length)
  )
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'The published race calendar is incomplete.');
  const target = events.find((event) => Number(event.round) === round);
  if (
    !target ||
    events.some((event) => !event.name || !event.circuit?.id || !event.circuit.displayName)
  )
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'The published race calendar is incomplete.');
  return { snapshot, events, target, calendar: rawCalendar(events) };
}

async function importAndPublish({ repository, provider, service, year, round, now }) {
  const { snapshot, events, target, calendar } = await currentRaceCalendar(repository, year, round);
  const eventIds = Object.fromEntries(events.map((event) => [event.round, event.id]));
  const bundle = await provider.refreshWeekend(year, round, {
    calendar,
    totalTimeoutMs: MANUAL_REFRESH_TIMEOUT_MS,
  });
  if (!bundle.race?.Results?.length) {
    const error = new Error(`Jolpica has not published results for ${year} round ${round}.`);
    error.code = 'RACE_RESULTS_NOT_PUBLISHED';
    throw error;
  }
  bundle.eventIds = eventIds;

  const retrievedAt = iso(now());
  const normalized = normalizeWeekend(bundle, {
    retrievedAt,
    sources: [
      {
        id: 'jolpica',
        name: 'jolpica',
        url: 'https://api.jolpi.ca/ergast/f1/',
        attribution: 'Jolpica F1 / Ergast contributors',
        version: null,
      },
    ],
  });
  const cachedRepository = await cacheSnapshot(
    repository,
    snapshot.id,
    normalized.sets.map((set) => set.key),
  );
  await preserveRefreshDatasets(cachedRepository, snapshot.id, normalized.sets);
  const sessionId = `session:${target.id}:race`;
  const candidateKeys = new Set([
    `events:${year}`,
    `sessions:${target.id}`,
    `results:${sessionId}`,
    `event:${target.id}`,
  ]);
  for (const set of normalized.sets)
    if (
      (set.key.startsWith(`qualifying:session:${target.id}:`) && set.items.length) ||
      (set.key.startsWith(`standings:${year}:`) && set.items.length)
    )
      candidateKeys.add(set.key);
  let changed = false;
  for (const key of candidateKeys) {
    const set = normalized.sets.find((item) => item.key === key);
    if (!set) continue;
    const previous = await cachedRepository.get(key, snapshot.id);
    if (!previous || !sameItems(previous.items, set.items)) {
      changed = true;
      break;
    }
  }

  if (!changed) {
    for (const observation of bundle.observations || [])
      await repository.observation?.({
        id: hash(['jolpica', observation.url, observation.payload]),
        provider: 'jolpica',
        version: null,
        retrievedAt: observation.retrievedAt,
        checksum: observation.checksum || hash(observation.payload),
        url: observation.url,
        payload: observation.payload,
      });
    return { changed: false, publicationId: snapshot.id };
  }

  const publicationId = await service.publish(bundle, 'jolpica', null, { preserveExisting: true });
  const active = await repository.snapshot();
  const results = await repository.get(`results:session:${target.id}:race`, active?.id);
  if (active?.id !== publicationId || !results?.items?.length)
    throw new ApiError(
      503,
      'SERVICE_UNAVAILABLE',
      'The race-result publication could not be verified.',
    );
  return { changed: true, publicationId };
}

export class LatestRaceDataRefresh {
  constructor({
    repository,
    importRound,
    getLastRun = async () => null,
    now = () => new Date(),
    cooldownMs = MANUAL_REFRESH_COOLDOWN_MS,
  }) {
    if (!repository || typeof repository.snapshot !== 'function')
      throw new Error('Latest-race refresh requires a repository.');
    if (typeof importRound !== 'function')
      throw new Error('Latest-race refresh requires an importer.');
    this.repository = repository;
    this.importRound = importRound;
    this.getLastRun = getLastRun;
    this.now = now;
    this.cooldownMs = cooldownMs;
    this.active = null;
  }

  refresh(season) {
    const currentYear = this.now().getUTCFullYear();
    if (!Number.isInteger(season) || season !== currentYear)
      return Promise.reject(invalid('Only the current season can be refreshed.'));
    if (this.active) return this.active;
    const request = this.execute(season).finally(() => {
      if (this.active === request) this.active = null;
    });
    this.active = request;
    return request;
  }

  async execute(season) {
    const checkedTime = this.now();
    const snapshot = await this.repository.snapshot();
    if (!snapshot) return this.noRace();
    const seasonSet = await this.repository.get('seasons', snapshot.id);
    if (!(seasonSet?.items || []).some((item) => Number(item.year) === season))
      return this.noRace();
    const calendar = await this.repository.get(`events:${season}`, snapshot.id);
    const due = (calendar?.items || [])
      .filter((event) => {
        if (!Number.isInteger(Number(event.round)) || Number(event.round) < 1 || !event.id)
          return false;
        if (['cancelled', 'canceled', 'postponed'].includes(String(event.status).toLowerCase()))
          return false;
        if (!['minute', 'second'].includes(event.schedule?.timePrecision)) return false;
        const start = Date.parse(event.schedule.startsAt || '');
        return Number.isFinite(start) && start <= checkedTime.getTime();
      })
      .sort(
        (left, right) =>
          Date.parse(right.schedule.startsAt) - Date.parse(left.schedule.startsAt) ||
          Number(right.round) - Number(left.round),
      );
    const event = due[0];
    if (!event) return this.noRace();

    let lastRun;
    try {
      lastRun = await this.getLastRun(season, Number(event.round));
    } catch {
      throw unavailable();
    }
    const startedAt = Date.parse(lastRun?.lastAt || lastRun?.startedAt || '');
    if (
      lastRun?.status === 'running' &&
      Number.isFinite(startedAt) &&
      checkedTime.getTime() - startedAt <= MANUAL_REFRESH_STALE_RUN_MS
    )
      return this.busy();
    if (Number.isFinite(startedAt)) {
      const retryAfterMs = Math.max(0, this.cooldownMs - (checkedTime.getTime() - startedAt));
      if (retryAfterMs > 0) return this.cooldown(retryAfterMs);
    }

    try {
      const result = await this.importRound({ year: season, round: Number(event.round), event });
      if (!result || typeof result.changed !== 'boolean' || !result.publicationId)
        throw new Error('Refresh did not confirm an active publication.');
      const checkedAt = this.now();
      return {
        status: result.changed ? 'updated' : 'unchanged',
        message: result.changed
          ? 'Latest race results were imported and published.'
          : 'The source was checked; the active publication already contains these results.',
        checkedAt: iso(checkedAt),
        publicationId: result.publicationId,
        retryAfterMs: await this.remainingCooldown(season, Number(event.round), checkedAt),
      };
    } catch (error) {
      if (error?.code === 'RACE_RESULTS_NOT_PUBLISHED') {
        const checkedAt = this.now();
        return {
          status: 'pending',
          message: 'The source race results are not published yet; this was checked just now.',
          checkedAt: iso(checkedAt),
          publicationId: null,
          retryAfterMs: await this.remainingCooldown(season, Number(event.round), checkedAt),
        };
      }
      if (error?.code === 'SYNC_BUSY') return this.busy();
      if (error?.code === 'SYNC_COOLDOWN') return this.cooldown(error.retryAfterMs);
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  }

  async remainingCooldown(season, round, checkedAt) {
    try {
      const run = await this.getLastRun(season, round);
      const completedAt = new Date(run?.lastAt || '').getTime();
      if (Number.isFinite(completedAt))
        return Math.min(
          this.cooldownMs,
          Math.max(0, this.cooldownMs - (this.now().getTime() - completedAt)),
        );
    } catch {
      // A successful source check stays successful if its audit read is unavailable.
    }
    return Math.max(0, this.cooldownMs - (this.now().getTime() - checkedAt.getTime()));
  }

  noRace() {
    return {
      status: 'no-race',
      message: 'There is no finished scheduled race in the current season to check.',
      checkedAt: null,
      publicationId: null,
    };
  }

  busy() {
    return {
      status: 'busy',
      message: 'Another race-data import is running; try again shortly.',
      checkedAt: null,
      publicationId: null,
      retryAfterMs: MANUAL_REFRESH_RETRY_AFTER_MS,
    };
  }

  cooldown(retryAfterMs) {
    return {
      status: 'cooldown',
      message: 'This race was checked recently; please wait before checking again.',
      checkedAt: null,
      publicationId: null,
      retryAfterMs,
    };
  }
}

export function createJolpicaLatestRaceRefresh({
  pool,
  repository,
  provider = new Jolpica(),
  service = new SyncService(repository),
  now = () => new Date(),
  cooldownMs = MANUAL_REFRESH_COOLDOWN_MS,
  runSyncJob = runSync,
}) {
  const getLastRun = async (year, round, connection = pool) => {
    const { rows } = await connection.query(
      'SELECT status,COALESCE(completed_at,started_at) AS "lastAt" FROM sync_runs WHERE provider=$1 AND scope=$2 ORDER BY started_at DESC LIMIT 1',
      ['jolpica', `${year}:${round}`],
    );
    return rows[0] || null;
  };
  return new LatestRaceDataRefresh({
    repository,
    getLastRun,
    now,
    cooldownMs,
    async importRound({ year, round }) {
      let changed = false;
      const publicationId = await runSyncJob(
        pool,
        'jolpica',
        `${year}:${round}`,
        async () => {
          const imported = await importAndPublish({
            repository,
            provider,
            service,
            year,
            round,
            now,
          });
          changed = imported.changed;
          return imported.publicationId;
        },
        {
          async beforeWork(client) {
            const run = await getLastRun(year, round, client);
            const lastAt = Date.parse(run?.lastAt || '');
            const retryAfterMs = cooldownMs - (now().getTime() - lastAt);
            if (Number.isFinite(retryAfterMs) && retryAfterMs > 0)
              throw Object.assign(new Error('Race was checked recently.'), {
                code: 'SYNC_COOLDOWN',
                retryAfterMs: Math.min(cooldownMs, retryAfterMs),
              });
          },
        },
      );
      return { changed, publicationId };
    },
  });
}
