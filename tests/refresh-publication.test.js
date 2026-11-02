import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepository } from './helpers.js';
import { syntheticWeekend } from '../fixtures/synthetic-weekend.js';
import { SyncService } from '../src/services/sync.service.js';
import { createJolpicaSeasonScheduler } from '../src/jobs/current-season-scheduler.js';
import { createJolpicaLatestRaceRefresh } from '../src/jobs/latest-race-refresh.js';
import { ReadService } from '../src/services/read.service.js';
import { operations, validateSchema } from '../src/schemas/contract.js';
import { preserveRefreshDatasets } from '../src/services/preserve-refresh-data.js';

test('preservation retains explicit nulls, absent incoming values, zero/false and known enrichment', async () => {
  const previous = {
    key: 'standings:2026:drivers',
    schema: 'Standing',
    items: [{ id: 'same', nullable: null, omitted: null, known: 12, zero: 7, flag: true }],
  };
  const incoming = {
    key: previous.key,
    schema: 'Standing',
    items: [{ id: 'same', nullable: null, newNull: null, known: null, zero: 0, flag: false }],
  };
  await preserveRefreshDatasets({ get: async () => previous }, 'fixture', [incoming]);
  assert.deepEqual(incoming.items[0], {
    id: 'same',
    nullable: null,
    omitted: null,
    newNull: null,
    known: 12,
    zero: 0,
    flag: false,
  });
});

for (const mode of ['scheduler', 'manual']) {
  test(`${mode} publishes changed driver/constructor collections through the real preservation pipeline`, async () => {
    const previous = syntheticWeekend();
    Object.assign(previous.race, {
      season: '2026',
      round: '18',
      raceName: 'Fictional R18',
      date: '2026-10-25',
      time: '20:00:00Z',
    });
    const next = syntheticWeekend();
    Object.assign(next.race, {
      season: '2026',
      round: '19',
      raceName: 'Fictional R19',
      date: '2026-11-01',
      time: '20:00:00Z',
    });
    const upcoming = structuredClone(next.race);
    delete upcoming.Results;
    previous.calendar = [previous.race, upcoming];
    next.calendar = [previous.race, next.race];
    for (const kind of ['drivers', 'constructors']) {
      const added = structuredClone(next.standings[kind][0]);
      Object.assign(added, { position: '2', points: '0', wins: '0' });
      if (kind === 'drivers') added.Driver.driverId = 'fictional-new-driver';
      else added.Constructor.constructorId = 'fictional-new-constructor';
      next.standings[kind].push(added);
    }
    const repo = new MemoryRepository();
    repo.sets.clear();
    repo.aliases = {};
    await new SyncService(repo).publish(previous, 'jolpica');
    const client = {
      async query(sql) {
        return { rows: sql.includes('pg_try_advisory_lock') ? [{ locked: true }] : [] };
      },
      release() {},
    };
    const pool = { connect: async () => client, query: client.query };
    const provider = {
      async weekend(year, round) {
        assert.deepEqual([year, round], [2026, 19]);
        return structuredClone(next);
      },
      async refreshWeekend(year, round) {
        return this.weekend(year, round);
      },
    };
    const now = () => new Date('2026-11-02T10:05:00Z');
    if (mode === 'scheduler') {
      const scheduler = createJolpicaSeasonScheduler({
        pool,
        repository: repo,
        provider,
        now,
        config: { autoSyncEnabled: true },
        scheduleTimer: () => ({ unref() {} }),
        cancelTimer() {},
      });
      const outcome = await scheduler.poll();
      await scheduler.stop();
      assert.notEqual(outcome.status, 'failed', JSON.stringify(outcome));
    } else {
      const refresh = createJolpicaLatestRaceRefresh({ pool, repository: repo, provider, now });
      assert.equal((await refresh.refresh(2026)).status, 'updated');
    }
    const event = repo.sets.get('events:2026').items.find((event) => event.round === 19);
    assert.equal(event.status, 'completed');
    assert.equal(repo.sets.get(`results:session:${event.id}:race`).items.length, 2);
    for (const kind of ['drivers', 'constructors']) {
      const set = repo.sets.get(`standings:2026:${kind}`);
      assert.equal(set.items.length, 2);
      for (const row of set.items) {
        assert.equal(row.standingSnapshotId, 'standing:2026:19');
        assert.equal(row.podiums, null);
        assert.equal(validateSchema('Standing', row).valid, true);
      }
      const response = await new ReadService(repo).read(
        operations.find((op) => op.operationId === 'getStandings'),
        { params: { year: 2026, kind }, query: { round: 19 } },
      );
      assert.equal(validateSchema(response.responseSchema, response.body).valid, true);
      assert.equal(response.body.data.items[0].podiums, kind === 'drivers' ? 2 : 4);
      assert.equal(response.body.data.items[1].podiums, 0);
      assert.ok(response.body.data.titleOutlook);
    }
  });
}
