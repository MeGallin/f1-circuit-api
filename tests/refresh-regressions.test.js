import test from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../src/jobs/run-sync.js';
import { createJolpicaLatestRaceRefresh } from '../src/jobs/latest-race-refresh.js';
import { preserveRefreshDatasets } from '../src/services/preserve-refresh-data.js';
import { Jolpica } from '../src/providers/jolpica/client.js';
import { ProviderHttp } from '../src/providers/http-client.js';

test('automatic results and standings survive the optional lap deadline without reducing import breadth', async () => {
  const paths = [];
  const race = { season: '2026', round: '1', raceName: 'Fixture race' };
  const provider = new Jolpica({
    async get(path, { signal }) {
      paths.push(path);
      if (path.includes('/laps.')) {
        return new Promise((resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      }
      let table = 'RaceTable';
      let field = 'Races';
      let records = [race];
      if (path.includes('/results.')) records = [{ ...race, Results: [{ position: '1' }] }];
      else if (path.includes('standings.')) {
        table = 'StandingsTable';
        field = 'StandingsLists';
        records = [
          {
            [path.includes('driverstandings') ? 'DriverStandings' : 'ConstructorStandings']: [
              { position: '1' },
            ],
          },
        ];
      } else if (
        path.includes('/qualifying.') ||
        path.includes('/sprint.') ||
        path.includes('/pitstops.')
      )
        records = [];
      return {
        payload: { MRData: { total: String(records.length), [table]: { [field]: records } } },
      };
    },
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const bundle = await provider.weekend(2026, 1, { totalTimeoutMs: 50 });
    assert.equal(bundle.race.Results.length, 1);
    assert.equal(bundle.standings.drivers.length, 1);
    assert.equal(bundle.standings.constructors.length, 1);
    assert.deepEqual(bundle.failures, ['laps']);
    assert.ok(
      paths.findIndex((path) => path.includes('constructorstandings')) <
        paths.findIndex((path) => path.includes('/laps.')),
    );
    for (const suffix of ['qualifying', 'sprint', 'pitstops', 'laps'])
      assert.ok(paths.some((path) => path.includes(`/${suffix}.`)));
  } finally {
    clearTimeout(keepAlive);
  }
});

test('automatic weekend source budget covers calendar and queued enrichment reads', async () => {
  let reads = 0;
  const provider = new Jolpica(
    new ProviderHttp({
      baseUrl: 'https://example.invalid/',
      intervalMs: 0,
      fetcher: async (_url, { signal }) => {
        reads++;
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    }),
  );
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(provider.weekend(2026, 1, { totalTimeoutMs: 20 }), {
      name: 'TimeoutError',
    });
    assert.equal(reads, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('sync cleanup releases poisoned connections and preserves the original work error', async () => {
  for (const failure of ['audit', 'unlock']) {
    const root = new Error('original import failure');
    const cleanup = new Error('cleanup failure');
    let released = false;
    let releaseError;
    const client = {
      async query(sql) {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
        if (
          (failure === 'audit' && sql.includes("status='failed'")) ||
          (failure === 'unlock' && sql.includes('pg_advisory_unlock'))
        )
          throw cleanup;
        return { rows: [] };
      },
      release(error) {
        released = true;
        releaseError = error;
      },
    };
    await assert.rejects(
      runSync({ connect: async () => client }, 'jolpica', '2026:1', async () => {
        throw root;
      }),
      (error) => error === root,
    );
    assert.equal(released, true);
    if (failure === 'unlock') assert.equal(releaseError, cleanup);
  }
});

test('manual refresh rechecks persistent cooldown after acquiring the shared lock', async () => {
  let reads = 0;
  let imported = false;
  const statements = [];
  const pool = {
    async query() {
      // Another process finishes between the optimistic read and lock acquisition.
      return {
        rows: ++reads === 1 ? [] : [{ status: 'completed', lastAt: '2026-10-06T12:00:00Z' }],
      };
    },
    async connect() {
      return {
        query: async (sql) => {
          statements.push(sql);
          return sql.includes('FROM sync_runs') ? pool.query() : { rows: [{ locked: true }] };
        },
        release() {},
      };
    },
  };
  const refresh = createJolpicaLatestRaceRefresh({
    pool,
    now: () => new Date('2026-10-06T12:00:01Z'),
    repository: {
      snapshot: async () => ({ id: 'published' }),
      get: async (key) => ({
        items:
          key === 'seasons'
            ? [{ year: 2026 }]
            : [
                {
                  id: 'event:1',
                  name: 'Race',
                  circuit: { id: 'circuit:1', displayName: 'Circuit' },
                  round: 1,
                  schedule: { startsAt: '2026-10-04T12:00:00Z', timePrecision: 'second' },
                },
              ],
      }),
    },
    provider: {
      async refreshWeekend() {
        imported = true;
        throw new Error('must not import');
      },
    },
  });
  const result = await refresh.refresh(2026);
  assert.equal(result.status, 'cooldown');
  assert.equal(result.retryAfterMs, 299000);
  assert.equal(imported, false);
  assert.equal(
    statements.some((sql) => sql.startsWith('INSERT') || sql.startsWith('UPDATE')),
    false,
  );
  assert.ok(statements.some((sql) => sql.includes('pg_advisory_unlock')));
});

test('refresh accepts source corrections removing fastest laps and obsolete standing rows', async () => {
  const prior = new Map([
    ['results:race', { items: [{ id: 'result:1', fastestLap: { rank: 1 }, points: '25' }] }],
    [
      'event:event:1',
      {
        items: [
          {
            event: { id: 'event:1' },
            fastestLap: { id: 'fastest:1' },
            podium: [{ id: 'result:1' }],
            winner: { id: 'entry:1' },
          },
        ],
      },
    ],
    ['standings:2026:drivers', { items: [{ id: 'standing:1' }, { id: 'standing:2' }] }],
  ]);
  const incoming = [
    { key: 'results:race', items: [{ id: 'result:1', fastestLap: null, points: '0' }] },
    {
      key: 'event:event:1',
      items: [{ event: { id: 'event:1' }, fastestLap: null, podium: [], winner: null }],
    },
    { key: 'standings:2026:drivers', items: [{ id: 'standing:1' }] },
  ];
  await preserveRefreshDatasets({ get: async (key) => prior.get(key) }, 'published', incoming);
  assert.equal(incoming[0].items[0].fastestLap, null);
  assert.equal(incoming[0].items[0].points, '0');
  assert.equal(incoming[1].items[0].fastestLap, null);
  assert.equal(incoming[1].items[0].winner, null);
  assert.deepEqual(incoming[1].items[0].podium, []);
  assert.equal(incoming[2].items.length, 1);
});
