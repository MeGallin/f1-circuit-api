import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createRouter } from '../src/routes/index.js';
import {
  LatestRaceDataRefresh,
  createJolpicaLatestRaceRefresh,
} from '../src/jobs/latest-race-refresh.js';
import { Jolpica } from '../src/providers/jolpica/client.js';
import { ProviderHttp } from '../src/providers/http-client.js';
import { preserveRefreshDatasets } from '../src/services/preserve-refresh-data.js';
import { ApiError } from '../src/errors/api-error.js';
import { normalizeWeekend } from '../src/models/normalization.js';

const now = () => new Date('2026-10-05T19:46:00.000Z');

const raceEvent = (round, startsAt, status = 'scheduled') => ({
  id: `event:2026:round-${round}`,
  year: 2026,
  round,
  name: `Round ${round}`,
  status,
  schedule: {
    date: startsAt.slice(0, 10),
    startsAt,
    timePrecision: 'second',
  },
  circuit: { id: `circuit:round-${round}`, displayName: `Circuit ${round}` },
});

function repository(events) {
  return {
    async snapshot() {
      return { id: 'publication-current' };
    },
    async get(key) {
      if (key === 'seasons') return { items: [{ year: 2026 }] };
      if (key === 'events:2026') return { items: events };
      return null;
    },
  };
}

function fixture(importRound, { events, getLastRun = async () => null } = {}) {
  return new LatestRaceDataRefresh({
    repository: repository(
      events || [
        raceEvent(15, '2026-09-26T11:00:00.000Z', 'completed'),
        raceEvent(16, '2026-10-04T07:00:00.000Z'),
        raceEvent(17, '2026-10-11T12:00:00.000Z'),
      ],
    ),
    importRound,
    getLastRun,
    now,
  });
}

function publishedBundle() {
  const circuit = { circuitId: 'sepang', circuitName: 'Sepang International Circuit' };
  const calendar = [
    {
      season: '2026',
      round: '16',
      raceName: 'Round 16',
      date: '2026-10-04',
      time: '07:00:00Z',
      Circuit: circuit,
    },
  ];
  return {
    calendar,
    race: {
      ...calendar[0],
      Results: [
        {
          Driver: { driverId: 'one', givenName: 'One', familyName: 'Driver' },
          Constructor: { constructorId: 'team', name: 'Team' },
          position: '1',
          status: 'Finished',
          points: '25',
          laps: '57',
          grid: '1',
        },
      ],
      QualifyingResults: [],
    },
    standings: { drivers: [], constructors: [] },
    failures: ['qualifying', 'standings:drivers', 'standings:constructors'],
    observations: [
      {
        url: 'https://api.jolpi.ca/ergast/f1/2026/16/results.json?limit=100&offset=0',
        payload: { race: 16, result: 'source fixture' },
        retrievedAt: '2026-10-05T19:46:00.000Z',
      },
    ],
    eventIds: { 16: 'event:2026:round-16' },
  };
}

function refreshRepository({ seedNormalized = false } = {}) {
  const event = raceEvent(16, '2026-10-04T07:00:00.000Z');
  const sets = new Map([
    ['seasons', { items: [{ year: 2026, eventCount: 1 }] }],
    ['events:2026', { items: [event] }],
  ]);
  if (seedNormalized) {
    const normalized = normalizeWeekend(publishedBundle(), {
      retrievedAt: '2026-10-05T19:40:00.000Z',
      sources: [{ id: 'jolpica', name: 'jolpica', url: 'https://api.jolpi.ca/ergast/f1/' }],
    });
    for (const set of normalized.sets) sets.set(set.key, set);
  }
  return {
    id: 'publication-current',
    sets,
    async snapshot() {
      return { id: this.id };
    },
    async get(key) {
      return this.sets.get(key) || null;
    },
    async observation() {},
  };
}

function factoryRefresh({ repositoryForRefresh, providerBundle = publishedBundle(), service }) {
  let syncCalls = 0;
  const pool = {
    async query() {
      return { rows: [] };
    },
  };
  const provider = {
    async refreshWeekend(_year, _round, options) {
      assert.equal(options.totalTimeoutMs, 29_000);
      assert.equal(options.calendar.length, 1);
      return structuredClone(providerBundle);
    },
  };
  const refresh = createJolpicaLatestRaceRefresh({
    pool,
    repository: repositoryForRefresh,
    provider,
    service,
    now,
    runSyncJob: async (_pool, _provider, _scope, work) => {
      syncCalls++;
      return work();
    },
  });
  return { refresh, syncCalls: () => syncCalls };
}

test('manual refresh selects the latest past race even while its result is pending', async () => {
  const calls = [];
  const refresh = fixture(async (target) => {
    calls.push(target);
    return { changed: true, publicationId: 'publication-16' };
  });

  const result = await refresh.refresh(2026);

  assert.deepEqual(
    calls.map(({ year, round, event }) => [year, round, event.id]),
    [[2026, 16, 'event:2026:round-16']],
  );
  assert.deepEqual(result, {
    status: 'updated',
    message: 'Latest race results were imported and published.',
    checkedAt: '2026-10-05T19:46:00.000Z',
    publicationId: 'publication-16',
    retryAfterMs: 300_000,
  });
});

test('manual refresh returns pending when the provider has not published race results', async () => {
  const refresh = fixture(async () => {
    throw Object.assign(new Error('No race results'), {
      code: 'RACE_RESULTS_NOT_PUBLISHED',
    });
  });

  const result = await refresh.refresh(2026);

  assert.equal(result.status, 'pending');
  assert.match(result.message, /not published yet/i);
  assert.equal(result.checkedAt, now().toISOString());
  assert.equal(result.publicationId, null);
  assert.equal(result.retryAfterMs, 300_000);
});

test('manual refresh converts provider network failures to API 503 errors', async () => {
  const refresh = fixture(async () => {
    throw Object.assign(new Error('socket detail'), { code: 'UPSTREAM_UNAVAILABLE' });
  });

  await assert.rejects(refresh.refresh(2026), { status: 503, code: 'SERVICE_UNAVAILABLE' });
});

test('bounded core results publish despite missing qualifying and standings enrichment', async () => {
  const repositoryForRefresh = refreshRepository();
  let publishOptions;
  const service = {
    async publish(bundle, provider, version, options) {
      assert.equal(provider, 'jolpica');
      assert.equal(bundle.race.Results.length, 1);
      publishOptions = options;
      repositoryForRefresh.id = 'publication-round-16';
      repositoryForRefresh.sets.set('results:session:event:2026:round-16:race', {
        items: [{ id: 'result:session:event:2026:round-16:race:one' }],
      });
      return repositoryForRefresh.id;
    },
  };
  const { refresh } = factoryRefresh({ repositoryForRefresh, service });

  const result = await refresh.refresh(2026);

  assert.equal(result.status, 'updated');
  assert.equal(result.publicationId, 'publication-round-16');
  assert.deepEqual(publishOptions, { preserveExisting: true });
});

test('unchanged source records do not republish for retrieval-time or evidence-id changes', async () => {
  const repositoryForRefresh = refreshRepository({ seedNormalized: true });
  let publishCalls = 0;
  const service = {
    async publish() {
      publishCalls++;
      throw new Error('unchanged data must not publish');
    },
  };
  const { refresh } = factoryRefresh({ repositoryForRefresh, service });

  const result = await refresh.refresh(2026);

  assert.equal(result.status, 'unchanged');
  assert.equal(result.publicationId, 'publication-current');
  assert.equal(result.checkedAt, now().toISOString());
  assert.equal(publishCalls, 0);
});

test('manual refresh reports unchanged only after a successful source check', async () => {
  let checked = false;
  const refresh = fixture(async () => {
    checked = true;
    return { changed: false, publicationId: 'publication-current' };
  });

  const result = await refresh.refresh(2026);

  assert.equal(checked, true);
  assert.equal(result.status, 'unchanged');
  assert.equal(result.publicationId, 'publication-current');
  assert.equal(result.retryAfterMs, 300_000);
});

test('success reports the remaining persistent server cooldown, not a client-assumed duration', async () => {
  let checked = false;
  const refresh = fixture(
    async () => {
      checked = true;
      return { changed: false, publicationId: 'publication-current' };
    },
    {
      getLastRun: async () =>
        checked ? { status: 'completed', lastAt: '2026-10-05T19:45:50.000Z' } : null,
    },
  );
  assert.equal((await refresh.refresh(2026)).retryAfterMs, 290_000);
});

test('manual refresh is single-flight, observes cooldown, and maps advisory-lock contention', async () => {
  let release;
  let imports = 0;
  const refresh = fixture(
    async () => {
      imports++;
      await new Promise((resolve) => (release = resolve));
      return { changed: true, publicationId: 'publication-16' };
    },
    { getLastRun: async () => null },
  );

  const first = refresh.refresh(2026);
  const second = refresh.refresh(2026);
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(imports, 1);
  release();
  assert.equal((await first).status, 'updated');

  const cooling = fixture(async () => assert.fail('cooldown must avoid a provider call'), {
    getLastRun: async () => ({ status: 'completed', startedAt: '2026-10-05T19:45:00.000Z' }),
  });
  const coolingResult = await cooling.refresh(2026);
  assert.equal(coolingResult.status, 'cooldown');
  assert.equal(coolingResult.retryAfterMs, 240_000);

  const busy = fixture(async () => {
    throw Object.assign(new Error('Import lock is held'), { code: 'SYNC_BUSY' });
  });
  assert.equal((await busy.refresh(2026)).status, 'busy');
});

test('stale running audit rows retry through the importer advisory lock', async () => {
  let imports = 0;
  const refresh = fixture(
    async () => {
      imports++;
      return { changed: true, publicationId: 'publication-16' };
    },
    { getLastRun: async () => ({ status: 'running', startedAt: '2026-10-05T19:40:00.000Z' }) },
  );

  assert.equal((await refresh.refresh(2026)).status, 'updated');
  assert.equal(imports, 1);
});

test('manual refresh accepts only the current season and returns no-race without polling', async () => {
  let imports = 0;
  const futureOnly = fixture(async () => imports++, {
    events: [raceEvent(17, '2026-10-11T12:00:00.000Z')],
  });

  assert.equal((await futureOnly.refresh(2026)).status, 'no-race');
  await assert.rejects(futureOnly.refresh(2025), { code: 'INVALID_REQUEST' });
  assert.equal(imports, 0);
});

test('manual refresh endpoint rejects arbitrary import parameters and exposes the response contract', async () => {
  const repositoryForApi = repository([raceEvent(17, '2026-10-11T12:00:00.000Z')]);
  const manualRefresh = fixture(async () => assert.fail('no-race must not poll the provider'), {
    events: [raceEvent(17, '2026-10-11T12:00:00.000Z')],
  });
  const app = createApp({
    repository: repositoryForApi,
    config: { origins: [] },
    logger: { info() {}, error() {} },
    router: createRouter(repositoryForApi, {
      manualRefresh,
    }),
  });

  await request(app)
    .post('/api/v1/refresh-data')
    .send({ season: 2026 })
    .expect(200)
    .then(({ body }) => {
      assert.equal(body.status, 'no-race');
      assert.equal(typeof body.message, 'string');
      assert.equal(body.checkedAt, null);
      assert.equal(body.publicationId, null);
    });
  await request(app).post('/api/v1/refresh-data').send({ season: 2026, round: 16 }).expect(400);
});

test('manual refresh provider failures use the standard API 503 envelope', async () => {
  const repositoryForApi = repository([raceEvent(17, '2026-10-11T12:00:00.000Z')]);
  const app = createApp({
    repository: repositoryForApi,
    config: { origins: [] },
    logger: { info() {}, error() {} },
    router: createRouter(repositoryForApi, {
      manualRefresh: {
        async refresh() {
          throw new ApiError(
            503,
            'SERVICE_UNAVAILABLE',
            'Race data could not be checked right now.',
          );
        },
      },
    }),
  });

  const result = await request(app).post('/api/v1/refresh-data').send({ season: 2026 }).expect(503);
  assert.equal(result.body.error.code, 'SERVICE_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(result.body), /provider detail/);
});

test('bounded Jolpica refresh requests results, qualifying, and standings without lap endpoints', async () => {
  const urls = [];
  const payloads = {
    results: [{ season: '2026', round: '16', Results: [{ Driver: { driverId: 'one' } }] }],
    qualifying: [
      { season: '2026', round: '16', QualifyingResults: [{ Driver: { driverId: 'one' } }] },
    ],
    driverstandings: [{ DriverStandings: [{ Driver: { driverId: 'one' } }] }],
    constructorstandings: [{ ConstructorStandings: [{ Constructor: { constructorId: 'one' } }] }],
  };
  const fetcher = async (url, init) => {
    urls.push({ url: url.pathname, signal: init.signal });
    const segment = url.pathname.split('/').at(-1).replace('.json', '');
    return new Response(
      JSON.stringify({
        MRData: {
          total: '1',
          RaceTable: { Races: payloads[segment] },
          StandingsTable: { StandingsLists: payloads[segment] },
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  };
  const provider = new Jolpica(
    new ProviderHttp({
      baseUrl: 'https://api.jolpi.ca/ergast/f1/',
      fetcher,
      intervalMs: 0,
      maxAttempts: 1,
      timeoutMs: 500,
    }),
  );

  const bundle = await provider.refreshWeekend(2026, 16, {
    calendar: [
      {
        season: '2026',
        round: '16',
        raceName: 'Sepang',
        date: '2026-10-04',
        time: '07:00:00Z',
        Circuit: { circuitId: 'sepang', circuitName: 'Sepang' },
      },
    ],
    totalTimeoutMs: 1000,
  });

  assert.equal(urls.length, 4);
  assert.deepEqual(
    new Set(urls.map(({ url }) => url.split('/').at(-1).replace('.json', ''))),
    new Set(['results', 'qualifying', 'driverstandings', 'constructorstandings']),
  );
  assert.equal(bundle.race.Results.length, 1);
  assert.equal(bundle.race.QualifyingResults.length, 1);
  assert.equal(bundle.standings.drivers.length, 1);
  assert.equal(bundle.standings.constructors.length, 1);
  assert.equal(bundle.calendar.length, 1);
  assert.ok(urls.every(({ signal }) => signal instanceof AbortSignal));
});

test('optional refresh enrichment timing out does not discard already fetched race results', async () => {
  const urls = [];
  const fetcher = async (url, { signal }) => {
    urls.push(url.pathname);
    if (url.pathname.endsWith('/results.json'))
      return new Response(
        JSON.stringify({
          MRData: {
            total: '1',
            RaceTable: {
              Races: [{ season: '2026', round: '16', Results: [{ Driver: { driverId: 'one' } }] }],
            },
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const provider = new Jolpica(
    new ProviderHttp({
      baseUrl: 'https://api.jolpi.ca/ergast/f1/',
      fetcher,
      intervalMs: 0,
      timeoutMs: 1000,
      maxAttempts: 1,
    }),
  );

  const keepTestProcessAlive = setInterval(() => {}, 1000);
  let bundle;
  try {
    bundle = await provider.refreshWeekend(2026, 16, {
      calendar: [
        {
          season: '2026',
          round: '16',
          raceName: 'Sepang',
          Circuit: { circuitId: 'sepang', circuitName: 'Sepang' },
        },
      ],
      totalTimeoutMs: 40,
    });
  } finally {
    clearInterval(keepTestProcessAlive);
  }

  assert.equal(bundle.race.Results.length, 1);
  assert.ok(bundle.failures.includes('qualifying'));
  assert.ok(bundle.failures.includes('standings:drivers'));
  assert.ok(bundle.failures.includes('standings:constructors'));
  assert.equal(urls.filter((url) => url.includes('/laps')).length, 0);
});

test('ProviderHttp bounds pathological Retry-After values instead of pausing its queue indefinitely', async () => {
  const waits = [];
  const provider = new ProviderHttp({
    baseUrl: 'https://api.jolpi.ca/ergast/f1/',
    intervalMs: 0,
    maxAttempts: 2,
    maxRetryAfterMs: 60_000,
    wait: async (milliseconds) => waits.push(milliseconds),
    fetcher: async () => new Response(null, { status: 429, headers: { 'Retry-After': '3600' } }),
  });

  await assert.rejects(provider.get('2026.json'), /safe limit/);
  assert.deepEqual(waits, [0]);
});

test('ProviderHttp aborts a queued rate-limit wait when the manual refresh deadline expires', async () => {
  let fetched = false;
  const provider = new ProviderHttp({
    baseUrl: 'https://api.jolpi.ca/ergast/f1/',
    intervalMs: 1,
    wait: (milliseconds, _value, { signal } = {}) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
        if (signal?.aborted) {
          clearTimeout(timer);
          reject(signal.reason);
        }
      }),
    fetcher: async () => {
      fetched = true;
      return new Response('{"ok":true}');
    },
  });
  provider.next = Date.now() + 10_000;

  await assert.rejects(provider.get('2026.json', { signal: AbortSignal.timeout(20) }), {
    name: 'TimeoutError',
  });
  assert.equal(fetched, false);
});

test('a source-check deadline also bounds waiting behind an already running provider request', async () => {
  let release;
  const urls = [];
  const provider = new ProviderHttp({
    baseUrl: 'https://api.jolpi.ca/ergast/f1/',
    intervalMs: 0,
    fetcher: async (url) => {
      urls.push(url.pathname);
      if (urls.length === 1)
        await new Promise((resolve) => {
          release = resolve;
        });
      return new Response('{"ok":true}');
    },
  });
  const first = provider.get('first.json');
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const second = provider.get('second.json', { signal: controller.signal });
  controller.abort(new DOMException('Deadline expired', 'TimeoutError'));
  const outcome = await Promise.race([
    second.then(
      () => 'resolved',
      () => 'aborted',
    ),
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), 30)),
  ]);
  release();
  await first;
  await second.catch(() => {});
  assert.equal(outcome, 'aborted');
  assert.equal(urls.length, 1);
});

test('core refresh preserves prior calendar, geography, sessions, and enriched lap records', async () => {
  const oldEvents = [
    { id: 'event:2026:round-15', round: 15, status: 'completed', layout: { id: 'layout:15' } },
    {
      id: 'event:2026:round-16',
      round: 16,
      status: 'scheduled',
      schedule: { date: '2026-10-04', circuitTimeZone: 'Asia/Kuala_Lumpur' },
      circuit: { id: 'circuit:sepang', displayName: 'Sepang International Circuit' },
      layout: { id: 'layout:sepang', lengthM: 5543 },
      features: [{ key: 'results', coverage: 'unavailable' }],
    },
    { id: 'event:2026:round-17', round: 17, status: 'scheduled', layout: { id: 'layout:17' } },
  ];
  const oldSessions = [
    {
      id: 'session:event:2026:round-16:qualifying',
      kind: 'qualifying',
      status: 'completed',
      evidenceId: 'old-session-evidence',
    },
    {
      id: 'session:event:2026:round-16:race',
      kind: 'race',
      status: 'unknown',
      evidenceId: 'old-session-evidence',
    },
  ];
  const previous = new Map([
    [
      'events:2026',
      {
        items: oldEvents,
        evidenceId: 'old-calendar-evidence',
        provenance: { retrievedAt: '2026-09-27T00:00:00.000Z' },
        coverage: 'complete',
        verification: 'source-only',
        warnings: [],
      },
    ],
    [
      'sessions:event:2026:round-16',
      {
        items: oldSessions,
        evidenceId: 'old-session-evidence',
        provenance: { retrievedAt: '2026-09-27T00:00:00.000Z' },
        coverage: 'complete',
        verification: 'source-only',
        warnings: [],
      },
    ],
    [
      'event:event:2026:round-16',
      { items: [{ event: oldEvents[1], sessions: [oldSessions[0], oldSessions[1]], podium: [] }] },
    ],
    [
      'profile:circuit:sepang',
      {
        items: [
          {
            id: 'circuit:sepang',
            entity: { id: 'circuit:sepang', displayName: 'Sepang International Circuit' },
            kind: 'circuit',
            country: 'Malaysia',
            latitude: 2.7608,
            longitude: 101.7381,
            metrics: [{ key: 'lengthM', value: 5543 }],
            features: [{ key: 'permanent', value: true }],
          },
        ],
      },
    ],
    [
      'laps:session:event:2026:round-16:race',
      {
        items: [
          { id: 'lap:race:verstappen:1', lapNumber: 1, durationMs: 102345, sectors: [1, 2, 3] },
        ],
        evidenceId: 'old-laps-evidence',
        provenance: { retrievedAt: '2026-09-27T00:00:00.000Z' },
        coverage: 'complete',
        verification: 'source-only',
        warnings: [],
      },
    ],
  ]);
  const repositoryForMerge = {
    async get(key) {
      return previous.get(key) || null;
    },
  };
  const incoming = [
    {
      key: 'events:2026',
      schema: 'EventSummary',
      evidenceId: 'new-calendar-evidence',
      provenance: { retrievedAt: '2026-10-05T19:46:00.000Z' },
      coverage: 'partial',
      verification: 'source-only',
      warnings: [],
      items: oldEvents.map((event) => ({
        id: event.id,
        round: event.round,
        status: event.round === 16 ? 'completed' : 'unknown',
        schedule: { date: event.round === 16 ? '2026-10-04' : null, circuitTimeZone: null },
        circuit: { id: 'circuit:sepang', displayName: 'Sepang' },
        layout: null,
        features: [{ key: 'results', coverage: 'partial' }],
      })),
    },
    {
      key: 'sessions:event:2026:round-16',
      schema: 'Session',
      evidenceId: 'new-session-evidence',
      provenance: { retrievedAt: '2026-10-05T19:46:00.000Z' },
      coverage: 'partial',
      verification: 'source-only',
      warnings: [],
      items: [
        {
          id: 'session:event:2026:round-16:qualifying',
          kind: 'qualifying',
          status: 'unknown',
          evidenceId: 'new-session-evidence',
        },
        {
          id: 'session:event:2026:round-16:race',
          kind: 'race',
          status: 'completed',
          evidenceId: 'new-session-evidence',
        },
      ],
    },
    {
      key: 'event:event:2026:round-16',
      items: [
        {
          event: { id: 'event:2026:round-16', status: 'completed' },
          sessions: [{ id: 'session:event:2026:round-16:race' }],
          podium: [{ id: 'result:one', position: 1 }],
        },
      ],
    },
    {
      key: 'profile:circuit:sepang',
      schema: 'Profile',
      items: [
        {
          id: 'circuit:sepang',
          kind: 'circuit',
          country: null,
          latitude: null,
          longitude: null,
          metrics: [],
          features: [],
        },
      ],
    },
    {
      key: 'laps:session:event:2026:round-16:race',
      schema: 'Lap',
      items: [],
      evidenceId: 'new-laps-evidence',
      provenance: { retrievedAt: '2026-10-05T19:46:00.000Z' },
      coverage: 'unavailable',
      verification: 'source-only',
      warnings: [],
    },
    {
      key: 'results:session:event:2026:round-16:race',
      evidenceId: 'new-results-evidence',
      items: [{ id: 'result:one' }],
    },
  ];

  await preserveRefreshDatasets(repositoryForMerge, 'publication-current', incoming);

  const events = incoming.find((set) => set.key === 'events:2026').items;
  assert.equal(events[0].status, 'completed');
  assert.deepEqual(events[0].layout, { id: 'layout:15' });
  assert.equal(events[1].status, 'completed');
  assert.equal(events[1].schedule.circuitTimeZone, 'Asia/Kuala_Lumpur');
  assert.deepEqual(events[1].layout, { id: 'layout:sepang', lengthM: 5543 });
  assert.equal(events[2].status, 'scheduled');
  assert.equal(
    incoming.find((set) => set.key === 'events:2026').evidenceId,
    'old-calendar-evidence',
  );
  const sessions = incoming.find((set) => set.key === 'sessions:event:2026:round-16');
  assert.ok(sessions.items.some((session) => session.kind === 'qualifying'));
  assert.equal(sessions.items.find((session) => session.kind === 'qualifying').status, 'completed');
  assert.equal(
    sessions.items.find((session) => session.kind === 'qualifying').evidenceId,
    'old-session-evidence',
  );
  assert.equal(
    sessions.items.find((session) => session.kind === 'race').evidenceId,
    'new-results-evidence',
  );
  assert.equal(sessions.evidenceId, 'old-session-evidence');
  assert.ok(
    incoming
      .find((set) => set.key === 'event:event:2026:round-16')
      .items[0].sessions.some((session) => session.kind === 'qualifying'),
  );
  assert.equal(
    incoming.find((set) => set.key === 'profile:circuit:sepang'),
    undefined,
  );
  const circuit = previous.get('profile:circuit:sepang').items[0];
  assert.equal(circuit.country, 'Malaysia');
  assert.equal(circuit.latitude, 2.7608);
  const laps = incoming.find((set) => set.key.startsWith('laps:'));
  assert.deepEqual(laps.items, []);
  assert.equal(laps.evidenceId, 'new-laps-evidence');
});
