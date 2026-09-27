import { Jolpica } from '../providers/jolpica/client.js';
import { SyncService } from '../services/sync.service.js';
import { runSync } from './run-sync.js';

export const DEFAULT_AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_AUTO_SYNC_GRACE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_AUTO_SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_AUTO_SYNC_RESCAN_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_AUTO_SYNC_STOP_TIMEOUT_MS = 10 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

const roundKey = ({ year, round }) => `${year}:${round}`;

function eventStart(event) {
  if (!['minute', 'second'].includes(event?.schedule?.timePrecision)) return null;
  const startsAt = event?.schedule?.startsAt;
  const exact = Date.parse(startsAt || '');
  return Number.isFinite(exact) ? exact : null;
}

function errorInfo(error, fallbackCode) {
  return {
    code: error?.code || fallbackCode,
    message: error?.message || 'Automatic publication failed.',
  };
}

function log(logger, level, details, message) {
  if (typeof logger?.[level] === 'function') logger[level](details, message);
}

export function hasPublishedRaceResults(resultSet) {
  return (resultSet?.items || []).length > 0;
}

async function publishedRaceCoverage(repository, event) {
  const snapshot = await repository.snapshot();
  if (!snapshot) return { complete: false, missing: ['snapshot'] };
  const sessionId = `session:${event.eventId}:race`;
  const [results, sessions, drivers, constructors] = await Promise.all([
    repository.get(`results:${sessionId}`, snapshot.id),
    repository.get(`sessions:${event.eventId}`, snapshot.id),
    repository.get(`standings:${event.year}:drivers`, snapshot.id),
    repository.get(`standings:${event.year}:constructors`, snapshot.id),
  ]);
  const expectedStanding = `standing:${event.year}:${event.round}`;
  const raceSession = (sessions?.items || []).find(
    (session) =>
      session.id === sessionId && session.kind === 'race' && session.status === 'completed',
  );
  const currentStandings = (set) =>
    (set?.items || []).length > 0 &&
    set.items.every((row) => row.standingSnapshotId === expectedStanding);
  const missing = [];
  if (!hasPublishedRaceResults(results)) missing.push('race-results');
  if (!raceSession) missing.push('race-session');
  if (!currentStandings(drivers)) missing.push('driver-standings');
  if (!currentStandings(constructors)) missing.push('constructor-standings');
  return { complete: missing.length === 0, missing };
}

async function currentSeasonEvents(repository, now) {
  const snapshot = await repository.snapshot();
  if (!snapshot) return { snapshot: null, year: null, events: [] };

  const seasons = await repository.get('seasons', snapshot.id);
  const seasonItems = seasons?.items || [];
  const currentYear = now.getUTCFullYear();
  const catalogued = seasonItems
    .filter((season) => Number.isInteger(Number(season.year)) && Number(season.year) <= currentYear)
    .sort((a, b) => Number(b.year) - Number(a.year));
  const currentSeason =
    catalogued.find((season) => Number(season.year) === currentYear) || catalogued[0];
  if (!currentSeason) return { snapshot, year: null, events: [] };

  const year = Number(currentSeason.year);
  const calendar = await repository.get(`events:${year}`, snapshot.id);
  const events = (calendar?.items || [])
    .map((event) => ({ event, startAt: eventStart(event), round: Number(event.round) }))
    .filter(
      ({ event, startAt, round }) =>
        Number.isInteger(round) && round > 0 && Number.isFinite(startAt) && event.id,
    )
    .sort((a, b) => a.startAt - b.startAt || a.round - b.round);
  return { snapshot, year, events };
}

export class CurrentSeasonScheduler {
  constructor({
    enabled = false,
    intervalMs = DEFAULT_AUTO_SYNC_INTERVAL_MS,
    graceMs = DEFAULT_AUTO_SYNC_GRACE_MS,
    windowMs = DEFAULT_AUTO_SYNC_WINDOW_MS,
    rescanMs = DEFAULT_AUTO_SYNC_RESCAN_MS,
    stopTimeoutMs = DEFAULT_AUTO_SYNC_STOP_TIMEOUT_MS,
    repository,
    importRound,
    logger = null,
    now = () => new Date(),
    scheduleTimer = setTimeout,
    cancelTimer = clearTimeout,
  }) {
    if (!repository || typeof repository.snapshot !== 'function')
      throw new Error('Current-season scheduler requires a repository.');
    if (typeof importRound !== 'function')
      throw new Error('Current-season scheduler requires an import function.');
    for (const [name, value] of [
      ['intervalMs', intervalMs],
      ['windowMs', windowMs],
      ['rescanMs', rescanMs],
    ])
      if (!Number.isSafeInteger(value) || value < 1000)
        throw new Error(`Automatic sync ${name} must be an integer of at least 1000ms.`);
    if (!Number.isSafeInteger(graceMs) || graceMs < 0)
      throw new Error('Automatic sync graceMs must be a non-negative integer.');
    this.enabled = enabled === true;
    this.intervalMs = intervalMs;
    this.graceMs = graceMs;
    this.windowMs = windowMs;
    this.rescanMs = rescanMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.repository = repository;
    this.importRound = importRound;
    this.logger = logger;
    this.now = now;
    this.scheduleTimer = scheduleTimer;
    this.cancelTimer = cancelTimer;
    this.timer = null;
    this.active = null;
    this.stopping = false;
    this.stopped = false;
    this.started = false;
    this.resolvedRounds = new Set();
  }

  start() {
    if (!this.enabled || this.started || this.stopped) return false;
    this.started = true;
    void this.trigger();
    return true;
  }

  async stop() {
    this.stopping = true;
    this.stopped = true;
    if (this.timer) this.cancelTimer(this.timer);
    this.timer = null;
    if (!this.active) return;
    let timeout;
    await Promise.race([
      this.active,
      new Promise((resolve) => {
        timeout = setTimeout(resolve, this.stopTimeoutMs);
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
  }

  trigger() {
    if (this.stopping) return Promise.resolve({ status: 'stopped' });
    if (!this.enabled) return Promise.resolve({ status: 'disabled' });
    if (this.active) return this.active;
    this.active = this.scheduleNext()
      .catch((error) => {
        const details = errorInfo(error, 'AUTO_SYNC_FAILED');
        log(
          this.logger,
          'error',
          details,
          'Automatic race scheduling failed; the previous publication remains active.',
        );
        if (!this.stopping) this.arm(this.rescanMs);
        return { status: 'failed', error: details };
      })
      .finally(() => {
        this.active = null;
      });
    return this.active;
  }

  triggerWindow(event) {
    if (this.stopping) return Promise.resolve({ status: 'stopped' });
    if (!this.enabled) return Promise.resolve({ status: 'disabled' });
    if (this.active) return this.active;
    this.active = this.checkWindow(event)
      .catch((error) => {
        const details = errorInfo(error, 'AUTO_SYNC_FAILED');
        log(
          this.logger,
          'error',
          { ...details, year: event.year, round: event.round, eventId: event.eventId },
          'Automatic race publication retry failed; the previous publication remains active.',
        );
        const remaining = event.expiresAt - this.now().getTime();
        if (remaining > 0)
          this.arm(Math.min(this.intervalMs, remaining), () => this.triggerWindow(event));
        else this.arm(this.rescanMs);
        return { status: 'failed', year: event.year, round: event.round, error: details };
      })
      .finally(() => {
        this.active = null;
      });
    return this.active;
  }

  poll() {
    return this.trigger();
  }

  arm(delayMs, callback = () => this.trigger()) {
    if (this.stopping) return;
    if (this.timer) this.cancelTimer(this.timer);
    const delay = Math.max(0, Math.min(delayMs, MAX_TIMER_DELAY_MS));
    this.timer = this.scheduleTimer(() => {
      this.timer = null;
      void callback();
    }, delay);
    this.timer?.unref?.();
  }

  armUntil(targetTime) {
    if (this.stopping) return;
    if (this.timer) this.cancelTimer(this.timer);
    const remaining = targetTime - this.now().getTime();
    const delay = Math.max(0, Math.min(remaining, MAX_TIMER_DELAY_MS));
    this.timer = this.scheduleTimer(() => {
      this.timer = null;
      if (targetTime > this.now().getTime()) this.armUntil(targetTime);
      else void this.trigger();
    }, delay);
    this.timer?.unref?.();
  }

  async scheduleNext() {
    if (this.stopping) return { status: 'stopped' };
    const currentTime = this.now();
    const current = await currentSeasonEvents(this.repository, currentTime);
    if (!current.snapshot) {
      log(
        this.logger,
        'warn',
        { code: 'NO_PUBLICATION' },
        'Automatic race scheduling skipped: no public snapshot.',
      );
      this.arm(this.rescanMs);
      return { status: 'skipped', reason: 'NO_PUBLICATION' };
    }

    if (!current.events.length) {
      this.arm(this.rescanMs);
      return { status: 'idle', year: current.year };
    }

    for (const { event, startAt, round } of current.events) {
      const details = {
        year: current.year,
        round,
        eventId: event.id,
        eventName: event.name,
        scheduledStart: event.schedule?.startsAt || event.schedule?.date || null,
        activationAt: startAt + this.graceMs,
        expiresAt: startAt + this.graceMs + this.windowMs,
      };
      if (this.resolvedRounds.has(roundKey(details))) continue;
      if (currentTime.getTime() >= details.expiresAt) continue;
      let publication;
      try {
        publication = await publishedRaceCoverage(this.repository, details);
      } catch (error) {
        const now = this.now().getTime();
        const remaining = details.expiresAt - now;
        const failure = errorInfo(error, 'AUTO_SYNC_FAILED');
        log(
          this.logger,
          'error',
          { ...failure, year: details.year, round: details.round, eventId: details.eventId },
          'Automatic race publication coverage read failed; the previous publication remains active.',
        );
        if (now < details.activationAt) this.armUntil(details.activationAt);
        else if (remaining > 0)
          this.arm(Math.min(this.intervalMs, remaining), () => this.triggerWindow(details));
        else this.arm(this.rescanMs);
        return { status: 'failed', year: details.year, round: details.round, error: failure };
      }
      if (publication.complete) {
        this.resolvedRounds.add(roundKey(details));
        continue;
      }

      const activationDelay = details.activationAt - currentTime.getTime();
      if (activationDelay > 0) {
        this.armUntil(details.activationAt);
        return {
          status: 'scheduled',
          year: current.year,
          round,
          activationAt: details.activationAt,
        };
      }

      return this.checkWindow(details);
    }

    this.arm(this.rescanMs);
    return { status: 'idle', year: current.year };
  }

  async checkWindow(event) {
    if (this.stopping) return { status: 'stopped' };
    const now = this.now().getTime();
    if (now >= event.expiresAt) {
      this.resolvedRounds.add(roundKey(event));
      log(
        this.logger,
        'info',
        { year: event.year, round: event.round, expiresAt: event.expiresAt },
        'Automatic race results watch expired without published results.',
      );
      return this.scheduleNext();
    }

    try {
      const publication = await publishedRaceCoverage(this.repository, event);
      if (publication.complete) {
        this.resolvedRounds.add(roundKey(event));
        log(
          this.logger,
          'info',
          { year: event.year, round: event.round },
          'Automatic race results and current standings are published; ending the watch.',
        );
        return this.scheduleNext();
      }

      if (publication.missing.includes('snapshot')) {
        log(
          this.logger,
          'warn',
          { year: event.year, round: event.round, code: 'NO_PUBLICATION' },
          'Automatic race results check skipped: no public snapshot.',
        );
        this.arm(Math.min(this.intervalMs, event.expiresAt - now), () => this.triggerWindow(event));
        return { status: 'skipped', reason: 'NO_PUBLICATION', round: event.round };
      }

      const publicationId = await this.importRound(event);
      const published = await publishedRaceCoverage(this.repository, event);
      if (published.complete) {
        this.resolvedRounds.add(roundKey(event));
        log(
          this.logger,
          'info',
          { year: event.year, round: event.round, publicationId },
          'Automatic race results and current standings are published; ending the watch.',
        );
        return this.scheduleNext();
      }
      log(
        this.logger,
        'warn',
        { year: event.year, round: event.round, publicationId, missing: published.missing },
        'Automatic race publication is incomplete; retaining the active watch for retry.',
      );
      const remaining = event.expiresAt - this.now().getTime();
      if (remaining > 0)
        this.arm(Math.min(this.intervalMs, remaining), () => this.triggerWindow(event));
      else {
        this.resolvedRounds.add(roundKey(event));
        return this.scheduleNext();
      }
      return {
        status: 'incomplete',
        year: event.year,
        round: event.round,
        missing: published.missing,
      };
    } catch (error) {
      if (error?.code !== 'RACE_RESULTS_NOT_PUBLISHED') {
        const details = errorInfo(error, 'AUTO_SYNC_FAILED');
        log(
          this.logger,
          'error',
          { ...details, year: event.year, round: event.round, eventId: event.eventId },
          'Automatic race publication failed; the previous publication remains active.',
        );
      }
      const remaining = event.expiresAt - this.now().getTime();
      if (remaining > 0)
        this.arm(Math.min(this.intervalMs, remaining), () => this.triggerWindow(event));
      else {
        this.resolvedRounds.add(roundKey(event));
        return this.scheduleNext();
      }
      return {
        status: error?.code === 'RACE_RESULTS_NOT_PUBLISHED' ? 'pending' : 'failed',
        year: event.year,
        round: event.round,
        error:
          error?.code === 'RACE_RESULTS_NOT_PUBLISHED'
            ? undefined
            : errorInfo(error, 'AUTO_SYNC_FAILED'),
      };
    }
  }
}

export function createJolpicaSeasonScheduler({
  pool,
  repository,
  config,
  logger,
  provider = new Jolpica(),
  service = new SyncService(repository),
  now,
  scheduleTimer,
  cancelTimer,
}) {
  return new CurrentSeasonScheduler({
    enabled: config.autoSyncEnabled,
    intervalMs: config.autoSyncIntervalMs,
    graceMs: config.autoSyncGraceMs,
    windowMs: config.autoSyncWindowMs,
    rescanMs: config.autoSyncRescanMs,
    repository,
    logger,
    now,
    scheduleTimer,
    cancelTimer,
    importRound: ({ year, round }) =>
      runSync(pool, 'jolpica', `${year}:${round}`, async () => {
        const bundle = await provider.weekend(year, round);
        if (!bundle?.race?.Results?.length) {
          const error = new Error(`Jolpica has not published results for ${year} round ${round}.`);
          error.code = 'RACE_RESULTS_NOT_PUBLISHED';
          throw error;
        }
        const missing = [];
        const providerFailures = new Set(bundle.failures || []);
        if (Number(bundle.race.season) !== year || Number(bundle.race.round) !== round)
          missing.push('completed-race-session');
        for (const kind of ['drivers', 'constructors'])
          if (
            providerFailures.has(`standings:${kind}`) ||
            !Array.isArray(bundle.standings?.[kind]) ||
            bundle.standings[kind].length === 0
          )
            missing.push(`${kind}-standings`);
        if (missing.length) {
          const error = new Error(
            `Jolpica has not published complete race coverage for ${year} round ${round}: ${missing.join(', ')}.`,
          );
          error.code = 'RACE_PUBLICATION_COVERAGE_INCOMPLETE';
          throw error;
        }
        // normalizeWeekend marks its generated race session completed from non-empty Results.
        return service.publish(bundle, 'jolpica');
      }),
  });
}
