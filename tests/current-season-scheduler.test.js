import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CurrentSeasonScheduler,
  createJolpicaSeasonScheduler,
  DEFAULT_AUTO_SYNC_GRACE_MS,
  DEFAULT_AUTO_SYNC_INTERVAL_MS,
  DEFAULT_AUTO_SYNC_RESCAN_MS,
  DEFAULT_AUTO_SYNC_WINDOW_MS,
} from '../src/jobs/current-season-scheduler.js';

const activationDelay = DEFAULT_AUTO_SYNC_GRACE_MS;
const interval = DEFAULT_AUTO_SYNC_INTERVAL_MS;
const windowDuration = DEFAULT_AUTO_SYNC_WINDOW_MS;

function event(round, startAt, status = 'unknown') {
  const startsAt = new Date(startAt).toISOString();
  return {
    id: `event:2026:round-${round}`,
    year: 2026,
    round,
    name: `Round ${round} Grand Prix`,
    status,
    schedule: { startsAt, date: startsAt.slice(0, 10), timePrecision: 'second' },
  };
}

function putCompletePublication(sets, raceEvent) {
  const sessionId = `session:${raceEvent.id}:race`;
  sets.set(`results:${sessionId}`, { items: [{ id: `result:${raceEvent.round}` }] });
  sets.set(`sessions:${raceEvent.id}`, {
    items: [{ id: sessionId, eventId: raceEvent.id, kind: 'race', status: 'completed' }],
  });
  for (const kind of ['drivers', 'constructors'])
    sets.set(`standings:${raceEvent.year}:${kind}`, {
      items: [{ standingSnapshotId: `standing:${raceEvent.year}:${raceEvent.round}` }],
    });
}

function repository(events, completedRounds = [], seasons = [{ year: 2026, isCurrent: true }]) {
  const sets = new Map([['seasons', { items: seasons }]]);
  for (const year of new Set(events.map((raceEvent) => raceEvent.year)))
    sets.set(`events:${year}`, {
      items: events.filter((raceEvent) => raceEvent.year === year),
    });
  for (const round of completedRounds)
    putCompletePublication(
      sets,
      events.find((raceEvent) => raceEvent.round === round),
    );
  let reads = 0;
  return {
    sets,
    get reads() {
      return reads;
    },
    async snapshot() {
      reads++;
      return { id: 'publication-1' };
    },
    async get(key) {
      reads++;
      return this.sets.get(key) || null;
    },
  };
}

function fakeClock(initialTime) {
  let time = initialTime;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => new Date(time),
    scheduleTimer(callback, delay) {
      const id = ++sequence;
      timers.set(id, { callback, dueAt: time + delay });
      return id;
    },
    cancelTimer(id) {
      timers.delete(id);
    },
    get pendingTimers() {
      return timers.size;
    },
    get pendingDelays() {
      return [...timers.values()].map((timer) => timer.dueAt - time);
    },
    async advance(milliseconds) {
      const target = time + milliseconds;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
        if (!due) break;
        const [id, timer] = due;
        time = timer.dueAt;
        timers.delete(id);
        timer.callback();
        await flushTasks();
      }
      time = target;
      await flushTasks();
    },
  };
}

async function flushTasks() {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

function schedulerFor({ repo, clock, importRound, ...options }) {
  return new CurrentSeasonScheduler({
    enabled: true,
    repository: repo,
    importRound,
    now: clock.now,
    scheduleTimer: clock.scheduleTimer,
    cancelTimer: clock.cancelTimer,
    ...options,
  });
}

test('scheduler defaults to a six-hour grace, 15-minute cadence and 24-hour window', () => {
  assert.equal(DEFAULT_AUTO_SYNC_GRACE_MS, 6 * 60 * 60 * 1000);
  assert.equal(DEFAULT_AUTO_SYNC_INTERVAL_MS, 15 * 60 * 1000);
  assert.equal(DEFAULT_AUTO_SYNC_WINDOW_MS, 24 * 60 * 60 * 1000);
  assert.equal(DEFAULT_AUTO_SYNC_RESCAN_MS, 6 * 60 * 60 * 1000);
});

test('does not poll between races and activates exactly at scheduled start plus six hours', async () => {
  const startAt = Date.parse('2026-09-20T12:00:00Z');
  const clock = fakeClock(startAt + activationDelay - 1);
  const repo = repository([event(1, startAt)]);
  const attempts = [];
  const scheduler = schedulerFor({
    repo,
    clock,
    importRound: async (round) => {
      attempts.push(round);
      throw Object.assign(new Error('Results not published yet'), {
        code: 'RACE_RESULTS_NOT_PUBLISHED',
      });
    },
  });

  assert.equal(scheduler.start(), true);
  await flushTasks();
  const idleReads = repo.reads;
  assert.equal(attempts.length, 0);
  assert.equal(clock.pendingTimers, 1);

  await clock.advance(0);
  assert.equal(repo.reads, idleReads);
  assert.equal(attempts.length, 0);
  await clock.advance(1);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].round, 1);
  await scheduler.stop();
});

test('checks immediately on activation and then at the configured interval', async () => {
  const startAt = Date.parse('2026-09-20T12:00:00Z');
  const clock = fakeClock(startAt + activationDelay);
  const repo = repository([event(1, startAt)]);
  const attempts = [];
  const scheduler = schedulerFor({
    repo,
    clock,
    importRound: async (round) => {
      attempts.push(round);
      throw Object.assign(new Error('Not published'), { code: 'RACE_RESULTS_NOT_PUBLISHED' });
    },
  });

  scheduler.start();
  await flushTasks();
  assert.equal(attempts.length, 1);
  await clock.advance(interval - 1);
  assert.equal(attempts.length, 1);
  await clock.advance(1);
  assert.equal(attempts.length, 2);
  await scheduler.stop();
});

test('an already completed race is skipped and the next race is scheduled', async () => {
  const firstStart = Date.parse('2026-09-10T12:00:00Z');
  const secondStart = Date.parse('2026-10-10T12:00:00Z');
  const clock = fakeClock(firstStart + activationDelay);
  const repo = repository([event(1, firstStart, 'completed'), event(2, secondStart)], [1]);
  let imports = 0;
  const scheduler = schedulerFor({ repo, clock, importRound: async () => imports++ });

  scheduler.start();
  await flushTasks();
  assert.equal(imports, 0);
  assert.equal(clock.pendingTimers, 1);
  await scheduler.stop();
});

test('completed event status without persisted race result rows does not resolve a race', async () => {
  const startAt = Date.parse('2026-09-20T12:00:00Z');
  const clock = fakeClock(startAt + activationDelay);
  const repo = repository([event(1, startAt, 'completed')]);
  let imports = 0;
  const scheduler = schedulerFor({
    repo,
    clock,
    importRound: async () => {
      imports++;
      throw Object.assign(new Error('Results not published yet'), {
        code: 'RACE_RESULTS_NOT_PUBLISHED',
      });
    },
  });

  scheduler.start();
  await flushTasks();
  assert.equal(imports, 1);
  assert.equal(clock.pendingTimers, 1);
  await scheduler.stop();
});

test('successful publication ends the watch immediately', async () => {
  const startAt = Date.parse('2026-09-20T12:00:00Z');
  const clock = fakeClock(startAt + activationDelay);
  const race = event(1, startAt);
  const repo = repository([race]);
  let imports = 0;
  const scheduler = schedulerFor({
    repo,
    clock,
    importRound: async () => {
      imports++;
      putCompletePublication(repo.sets, race);
      return 'publication-2';
    },
  });

  scheduler.start();
  await flushTasks();
  const readsAfterPublication = repo.reads;
  assert.equal(imports, 1);
  assert.deepEqual(clock.pendingDelays, [DEFAULT_AUTO_SYNC_RESCAN_MS]);
  await clock.advance(interval * 4);
  assert.equal(imports, 1);
  assert.equal(repo.reads, readsAfterPublication);
  await scheduler.stop();
});

test('result rows do not end the watch until race session and current driver and constructor standings publish', async () => {
  const startAt = Date.parse('2026-09-20T12:00:00Z');
  const clock = fakeClock(startAt + activationDelay);
  const race = event(1, startAt);
  const repo = repository([race]);
  const sessionId = `session:${race.id}:race`;
  repo.sets.set(`results:${sessionId}`, { items: [{ id: 'winner' }] });
  repo.sets.set(`sessions:${race.id}`, {
    items: [{ id: sessionId, kind: 'race', status: 'completed' }],
  });
  repo.sets.set('standings:2026:drivers', {
    items: [{ standingSnapshotId: 'standing:2026:1' }],
  });
  repo.sets.set('standings:2026:constructors', {
    items: [{ standingSnapshotId: 'standing:2025:22' }],
  });
  let imports = 0;
  const scheduler = schedulerFor({
    repo,
    clock,
    importRound: async () => {
      imports++;
      return 'incomplete-publication';
    },
  });

  scheduler.start();
  await flushTasks();
  assert.equal(imports, 1);
  assert.deepEqual(clock.pendingDelays, [interval]);
  await clock.advance(interval);
  assert.equal(imports, 2);
  await scheduler.stop();
});

test('database snapshot failures retry at the active race cadence, not the idle rescan cadence', async () => {
  const startAt = Date.parse('2026-09-20T12:00:00Z');
  const clock = fakeClock(startAt + activationDelay);
  const repo = repository([event(1, startAt)]);
  const latestSnapshot = repo.snapshot.bind(repo);
  let snapshots = 0;
  repo.snapshot = async () => {
    snapshots++;
    return snapshots === 3 || snapshots === 4 ? null : latestSnapshot();
  };
  let imports = 0;
  const scheduler = schedulerFor({
    repo,
    clock,
    importRound: async () => {
      imports++;
      throw Object.assign(new Error('Provider has no result yet'), {
        code: 'RACE_RESULTS_NOT_PUBLISHED',
      });
    },
  });

  scheduler.start();
  await flushTasks();
  assert.deepEqual(clock.pendingDelays, [interval]);
  await clock.advance(interval);
  assert.deepEqual(clock.pendingDelays, [interval]);
  await clock.advance(interval);
  assert.equal(imports, 1);
  assert.deepEqual(clock.pendingDelays, [interval]);
  await scheduler.stop();
});

test('a thrown coverage read at active-window activation retries at race cadence', async () => {
  const startAt = Date.parse('2026-09-20T12:00:00Z');
  const clock = fakeClock(startAt + activationDelay);
  const repo = repository([event(1, startAt)]);
  const latestSnapshot = repo.snapshot.bind(repo);
  let snapshots = 0;
  repo.snapshot = async () => {
    snapshots++;
    if (snapshots === 2) throw new Error('temporary database read failure');
    return latestSnapshot();
  };
  let imports = 0;
  const scheduler = schedulerFor({
    repo,
    clock,
    importRound: async () => {
      imports++;
      throw Object.assign(new Error('Results not published yet'), {
        code: 'RACE_RESULTS_NOT_PUBLISHED',
      });
    },
  });

  scheduler.start();
  await flushTasks();
  assert.deepEqual(clock.pendingDelays, [interval]);
  assert.equal(imports, 0);
  await clock.advance(interval);
  assert.equal(imports, 1);
  assert.deepEqual(clock.pendingDelays, [interval]);
  await scheduler.stop();
});

test('database failure while scheduling after expiry arms only a sparse rescan', async () => {
  const startAt = Date.parse('2026-09-20T12:00:00Z');
  const clock = fakeClock(startAt + activationDelay);
  const repo = repository([event(1, startAt)]);
  const latestSnapshot = repo.snapshot.bind(repo);
  let snapshots = 0;
  repo.snapshot = async () => {
    snapshots++;
    if (snapshots === 4) throw new Error('temporary database read failure');
    return latestSnapshot();
  };
  let imports = 0;
  const scheduler = schedulerFor({
    repo,
    clock,
    windowMs: interval,
    importRound: async () => {
      imports++;
      throw Object.assign(new Error('Results not published yet'), {
        code: 'RACE_RESULTS_NOT_PUBLISHED',
      });
    },
  });

  scheduler.start();
  await flushTasks();
  assert.deepEqual(clock.pendingDelays, [interval]);
  await clock.advance(interval);
  assert.deepEqual(clock.pendingDelays, [DEFAULT_AUTO_SYNC_RESCAN_MS]);
  assert.equal(imports, 1);
  await clock.advance(DEFAULT_AUTO_SYNC_RESCAN_MS);
  assert.equal(imports, 1);
  assert.deepEqual(clock.pendingDelays, [DEFAULT_AUTO_SYNC_RESCAN_MS]);
  await scheduler.stop();
});

test('watch stops at its 24-hour deadline when results remain unavailable', async () => {
  const startAt = Date.parse('2026-09-20T12:00:00Z');
  const clock = fakeClock(startAt + activationDelay);
  const repo = repository([event(1, startAt)]);
  let attempts = 0;
  const scheduler = schedulerFor({
    repo,
    clock,
    importRound: async () => {
      attempts++;
      throw Object.assign(new Error('Not published'), { code: 'RACE_RESULTS_NOT_PUBLISHED' });
    },
    intervalMs: 15 * 60 * 1000,
    windowMs: 30 * 60 * 1000,
  });

  scheduler.start();
  await flushTasks();
  await clock.advance(30 * 60 * 1000);
  assert.equal(attempts, 2);
  assert.deepEqual(clock.pendingDelays, [DEFAULT_AUTO_SYNC_RESCAN_MS]);
  await clock.advance(60 * 60 * 1000);
  assert.equal(attempts, 2);
  await scheduler.stop();
});

test('restart inside a window checks immediately; restart after expiry skips it', async () => {
  const startAt = Date.parse('2026-09-20T12:00:00Z');
  const activeClock = fakeClock(startAt + activationDelay + 2 * 60 * 60 * 1000);
  const activeRepo = repository([event(1, startAt)]);
  let activeAttempts = 0;
  const activeScheduler = schedulerFor({
    repo: activeRepo,
    clock: activeClock,
    importRound: async () => {
      activeAttempts++;
      throw Object.assign(new Error('Not published'), { code: 'RACE_RESULTS_NOT_PUBLISHED' });
    },
  });
  activeScheduler.start();
  await flushTasks();
  assert.equal(activeAttempts, 1);
  await activeScheduler.stop();

  const nextStart = Date.parse('2026-10-20T12:00:00Z');
  const expiredClock = fakeClock(startAt + activationDelay + windowDuration);
  const expiredRepo = repository([event(1, startAt), event(2, nextStart)]);
  let expiredAttempts = 0;
  const expiredScheduler = schedulerFor({
    repo: expiredRepo,
    clock: expiredClock,
    importRound: async () => expiredAttempts++,
  });
  expiredScheduler.start();
  await flushTasks();
  assert.equal(expiredAttempts, 0);
  assert.equal(expiredClock.pendingTimers, 1);
  await expiredClock.advance(nextStart + activationDelay - expiredClock.now().getTime());
  assert.equal(expiredAttempts, 1);
  await expiredScheduler.stop();
});

test('expired missed rounds are skipped, an active round catches up, and the next round waits', async () => {
  const oldStart = Date.parse('2026-09-01T12:00:00Z');
  const activeStart = Date.parse('2026-09-20T12:00:00Z');
  const nextStart = Date.parse('2026-10-10T12:00:00Z');
  const clock = fakeClock(activeStart + activationDelay + interval);
  const oldRace = event(1, oldStart);
  const activeRace = event(2, activeStart);
  const nextRace = event(3, nextStart);
  const repo = repository([oldRace, activeRace, nextRace]);
  const importedRounds = [];
  const scheduler = schedulerFor({
    repo,
    clock,
    importRound: async ({ round }) => {
      importedRounds.push(round);
      if (round === 2) {
        putCompletePublication(repo.sets, activeRace);
      } else if (round === 3) {
        putCompletePublication(repo.sets, nextRace);
      }
      return `publication-${round}`;
    },
  });

  scheduler.start();
  await flushTasks();
  assert.deepEqual(importedRounds, [2]);
  assert.equal(clock.pendingTimers, 1);
  await clock.advance(nextStart + activationDelay - clock.now().getTime());
  assert.deepEqual(importedRounds, [2, 3]);
  await scheduler.stop();
});

test('provider failure retains the last published snapshot and retries inside its window', async () => {
  const startAt = Date.parse('2026-09-20T12:00:00Z');
  const clock = fakeClock(startAt + activationDelay);
  const repo = repository([event(1, startAt)]);
  const priorCalendar = structuredClone(repo.sets.get('events:2026'));
  const scheduler = schedulerFor({
    repo,
    clock,
    importRound: async () => {
      throw Object.assign(new Error('Jolpica unavailable'), { code: 'UPSTREAM_FAILURE' });
    },
  });

  scheduler.start();
  await flushTasks();
  assert.deepEqual(repo.sets.get('events:2026'), priorCalendar);
  assert.equal(clock.pendingTimers, 1);
  await clock.advance(interval);
  assert.deepEqual(repo.sets.get('events:2026'), priorCalendar);
  await scheduler.stop();
});

test('disabled scheduler does not run and stops cleanly', async () => {
  let imports = 0;
  const clock = fakeClock(Date.now());
  const scheduler = new CurrentSeasonScheduler({
    enabled: false,
    repository: repository([]),
    importRound: async () => imports++,
    now: clock.now,
    scheduleTimer: clock.scheduleTimer,
    cancelTimer: clock.cancelTimer,
  });

  assert.equal(scheduler.start(), false);
  assert.deepEqual(await scheduler.trigger(), { status: 'disabled' });
  await scheduler.stop();
  assert.equal(imports, 0);
  assert.equal(clock.pendingTimers, 0);
});

test('missing snapshots and empty calendars arm sparse database-only rescans', async () => {
  const clock = fakeClock(Date.parse('2026-09-20T12:00:00Z'));
  const noSnapshotRepo = repository([]);
  const snapshot = noSnapshotRepo.snapshot.bind(noSnapshotRepo);
  let missingOnce = true;
  noSnapshotRepo.snapshot = async () => {
    if (missingOnce) {
      missingOnce = false;
      return null;
    }
    return snapshot();
  };
  let imports = 0;
  const noSnapshot = schedulerFor({
    repo: noSnapshotRepo,
    clock,
    importRound: async () => imports++,
  });
  noSnapshot.start();
  await flushTasks();
  assert.deepEqual(clock.pendingDelays, [DEFAULT_AUTO_SYNC_RESCAN_MS]);
  await clock.advance(DEFAULT_AUTO_SYNC_RESCAN_MS);
  assert.deepEqual(clock.pendingDelays, [DEFAULT_AUTO_SYNC_RESCAN_MS]);
  assert.equal(imports, 0);
  await noSnapshot.stop();

  const emptyClock = fakeClock(Date.parse('2026-09-20T12:00:00Z'));
  const emptyCalendar = schedulerFor({
    repo: repository([]),
    clock: emptyClock,
    importRound: async () => imports++,
  });
  emptyCalendar.start();
  await flushTasks();
  assert.deepEqual(emptyClock.pendingDelays, [DEFAULT_AUTO_SYNC_RESCAN_MS]);
  await emptyCalendar.stop();
});

test('date-only schedule is skipped instead of treating midnight as a race start', async () => {
  const clock = fakeClock(Date.parse('2026-09-20T12:00:00Z'));
  const race = event(1, Date.parse('2026-09-20T00:00:00Z'));
  race.schedule = { date: '2026-09-20', startsAt: null, timePrecision: 'date' };
  const repo = repository([race]);
  let imports = 0;
  const scheduler = schedulerFor({ repo, clock, importRound: async () => imports++ });

  scheduler.start();
  await flushTasks();
  assert.equal(imports, 0);
  assert.deepEqual(clock.pendingDelays, [DEFAULT_AUTO_SYNC_RESCAN_MS]);
  await scheduler.stop();
});

test('season selection ignores stale isCurrent and falls back to newest non-future catalogue year', async () => {
  const now = Date.parse('2026-09-20T12:00:00Z');
  const clock = fakeClock(now);
  const season2026Event = { ...event(1, now + 10 * 60 * 60 * 1000), year: 2026 };
  const season2027Event = {
    ...event(1, now + 20 * 60 * 60 * 1000),
    id: 'event:2027:round-1',
    year: 2027,
  };
  const exactCurrent = schedulerFor({
    repo: repository(
      [season2026Event, season2027Event],
      [],
      [
        { year: 2027, isCurrent: true },
        { year: 2026, isCurrent: false },
        { year: 2025, isCurrent: false },
      ],
    ),
    clock,
    importRound: async () => 'unused',
  });
  exactCurrent.start();
  await flushTasks();
  assert.deepEqual(clock.pendingDelays, [10 * 60 * 60 * 1000 + activationDelay]);
  await exactCurrent.stop();

  const fallbackClock = fakeClock(now);
  const fallback = schedulerFor({
    repo: repository(
      [season2027Event],
      [],
      [
        { year: 2027, isCurrent: true },
        { year: 2025, isCurrent: false },
      ],
    ),
    clock: fallbackClock,
    importRound: async () => 'unused',
  });
  fallback.start();
  await flushTasks();
  assert.deepEqual(fallbackClock.pendingDelays, [DEFAULT_AUTO_SYNC_RESCAN_MS]);
  await fallback.stop();
});

test('stop cancels active timer and waits for in-flight publication', async () => {
  const startAt = Date.parse('2026-09-20T12:00:00Z');
  const clock = fakeClock(startAt + activationDelay);
  let release;
  const scheduler = schedulerFor({
    repo: repository([event(1, startAt)]),
    clock,
    importRound: () => new Promise((resolve) => (release = resolve)),
  });

  scheduler.start();
  await flushTasks();
  assert.equal(typeof release, 'function');
  const stopping = scheduler.stop();
  release('publication-2');
  await stopping;
  assert.equal(clock.pendingTimers, 0);
});

test('Jolpica import uses runSync and atomically publishes provider results', async () => {
  const startAt = Date.parse('2026-09-20T12:00:00Z');
  const clock = fakeClock(startAt + activationDelay);
  const repo = repository([event(1, startAt)]);
  const providerCalls = [];
  const serviceCalls = [];
  const provider = {
    async weekend(year, round, options) {
      assert.equal(options.totalTimeoutMs, 240000);
      providerCalls.push([year, round]);
      return {
        calendar: [],
        race: { season: String(year), round: String(round), Results: [{ driverId: 'one' }] },
        standings: { drivers: [{ position: '1' }], constructors: [{ position: '1' }] },
      };
    },
  };
  const service = {
    async publish(bundle, providerName, version, options) {
      assert.deepEqual(options, { preserveExisting: true });
      serviceCalls.push([bundle, providerName]);
      const race = repo.sets.get('events:2026').items[0];
      putCompletePublication(repo.sets, race);
      return 'publication-2';
    },
  };
  let lockAcquired = false;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.startsWith('SELECT pg_try_advisory_lock')) {
            lockAcquired = true;
            return { rows: [{ locked: true }] };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const scheduler = createJolpicaSeasonScheduler({
    pool,
    repository: repo,
    config: {
      autoSyncEnabled: true,
      autoSyncIntervalMs: interval,
      autoSyncGraceMs: activationDelay,
      autoSyncWindowMs: windowDuration,
    },
    provider,
    service,
    now: clock.now,
    scheduleTimer: clock.scheduleTimer,
    cancelTimer: clock.cancelTimer,
  });

  scheduler.start();
  await flushTasks();
  assert.deepEqual(providerCalls, [[2026, 1]]);
  assert.equal(lockAcquired, true);
  assert.equal(serviceCalls[0][1], 'jolpica');
  assert.deepEqual(serviceCalls[0][0].race.Results, [{ driverId: 'one' }]);
  assert.deepEqual(clock.pendingDelays, [DEFAULT_AUTO_SYNC_RESCAN_MS]);
  await scheduler.stop();
});

test('Jolpica does not publish a result-only bundle while current-round standings are missing', async () => {
  for (const missingKind of ['drivers', 'constructors']) {
    const startAt = Date.parse('2026-09-20T12:00:00Z');
    const clock = fakeClock(startAt + activationDelay);
    const repo = repository([event(1, startAt)]);
    const priorCalendar = structuredClone(repo.sets.get('events:2026'));
    const priorSnapshotId = (await repo.snapshot()).id;
    let publishCalls = 0;
    let snapshotId = priorSnapshotId;
    const pool = {
      async connect() {
        return {
          async query(sql) {
            if (sql.startsWith('SELECT pg_try_advisory_lock')) return { rows: [{ locked: true }] };
            return { rows: [] };
          },
          release() {},
        };
      },
    };
    const standings = {
      drivers: [{ position: '1' }],
      constructors: [{ position: '1' }],
    };
    standings[missingKind] = [];
    const scheduler = createJolpicaSeasonScheduler({
      pool,
      repository: repo,
      config: {
        autoSyncEnabled: true,
        autoSyncIntervalMs: interval,
        autoSyncGraceMs: activationDelay,
        autoSyncWindowMs: windowDuration,
      },
      provider: {
        async weekend(year, round) {
          return {
            calendar: [],
            race: { season: String(year), round: String(round), Results: [{ driverId: 'one' }] },
            standings,
            failures: [`standings:${missingKind}`],
          };
        },
      },
      service: {
        async publish() {
          publishCalls++;
          snapshotId = 'publication-2';
        },
      },
      now: clock.now,
      scheduleTimer: clock.scheduleTimer,
      cancelTimer: clock.cancelTimer,
    });

    scheduler.start();
    await flushTasks();
    assert.equal(publishCalls, 0, `${missingKind} coverage must block publication`);
    assert.equal(snapshotId, priorSnapshotId, 'the previous publication remains active');
    assert.deepEqual(repo.sets.get('events:2026'), priorCalendar);
    assert.deepEqual(clock.pendingDelays, [interval]);
    await scheduler.stop();
  }
});

test('a held sync advisory lock blocks provider access and publication', async () => {
  const startAt = Date.parse('2026-09-20T12:00:00Z');
  const clock = fakeClock(startAt + activationDelay);
  const repo = repository([event(1, startAt)]);
  let providerCalls = 0;
  let publishCalls = 0;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.startsWith('SELECT pg_try_advisory_lock')) return { rows: [{ locked: false }] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const scheduler = createJolpicaSeasonScheduler({
    pool,
    repository: repo,
    config: {
      autoSyncEnabled: true,
      autoSyncIntervalMs: interval,
      autoSyncGraceMs: activationDelay,
      autoSyncWindowMs: windowDuration,
    },
    provider: {
      async weekend() {
        providerCalls++;
        return { race: { Results: [{ driverId: 'one' }] } };
      },
    },
    service: {
      async publish() {
        publishCalls++;
      },
    },
    now: clock.now,
    scheduleTimer: clock.scheduleTimer,
    cancelTimer: clock.cancelTimer,
  });

  scheduler.start();
  await flushTasks();
  assert.equal(providerCalls, 0);
  assert.equal(publishCalls, 0);
  assert.equal(clock.pendingTimers, 1);
  await scheduler.stop();
});

test('Jolpica results are required before the service may publish', async () => {
  const startAt = Date.parse('2026-09-20T12:00:00Z');
  const clock = fakeClock(startAt + activationDelay);
  const repo = repository([event(1, startAt)]);
  let publishCalls = 0;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.startsWith('SELECT pg_try_advisory_lock')) return { rows: [{ locked: true }] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const scheduler = createJolpicaSeasonScheduler({
    pool,
    repository: repo,
    config: {
      autoSyncEnabled: true,
      autoSyncIntervalMs: interval,
      autoSyncGraceMs: activationDelay,
      autoSyncWindowMs: windowDuration,
    },
    provider: {
      async weekend() {
        return { race: { Results: [] } };
      },
    },
    service: {
      async publish() {
        publishCalls++;
      },
    },
    now: clock.now,
    scheduleTimer: clock.scheduleTimer,
    cancelTimer: clock.cancelTimer,
  });

  scheduler.start();
  await flushTasks();
  assert.equal(publishCalls, 0);
  assert.equal(clock.pendingTimers, 1);
  await scheduler.stop();
});
