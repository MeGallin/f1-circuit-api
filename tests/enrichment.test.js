import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EnrichmentRepository } from '../src/repositories/enrichment.repository.js';
import { PublicationRepository } from '../src/repositories/publication.repository.js';
import { BoundedRawStore } from '../src/storage/bounded-raw-store.js';
import { enrichmentFixture } from './enrichment-fixture.js';
import { OpenF1 } from '../src/providers/openf1/client.js';
const set = (session, n = 20) => ({
  key: 'laps:' + session,
  schema: 'Lap',
  coverage: 'partial',
  verification: 'source-only',
  evidenceId: 'e:' + session,
  provenance: {},
  items: Array.from({ length: n }, (_, i) => ({ id: session + ':' + i, lapNumber: i + 1 })),
});
test('repeated enrichment sessions share core rows and keep one held workspace', async () => {
  const { pool } = await enrichmentFixture();
  try {
    const r = new EnrichmentRepository(pool, { write: async () => ({ storage: 'external' }) });
    await r.open();
    const id = (await r.snapshot()).id;
    for (let i = 0; i < 5; i++) await r.publish([set('session' + i)], {});
    await r.publish([set('session0')], {});
    const resumed = new EnrichmentRepository(pool, {});
    await resumed.open();
    assert.equal(resumed.workspace.publication_id, id);
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM publications')).rows[0].n), 2);
    assert.equal(
      Number(
        (await pool.query("SELECT count(*) AS n FROM normalized_records WHERE dataset_key='core'"))
          .rows[0].n,
      ),
      100,
    );
    assert.equal(
      Number((await pool.query('SELECT count(*) AS n FROM normalized_records')).rows[0].n),
      200,
    );
    assert.equal((await resumed.get('core')).items.length, 100);
    assert.equal((await resumed.get('laps:session0')).items.length, 20);
    assert.equal(
      (await pool.query('SELECT publication_id FROM current_publication')).rows[0].publication_id,
      'base',
    );
    assert.equal(await new PublicationRepository(pool).snapshot(id), null);
    await assert.rejects(r.activate(), /separate reviewed/);
    await assert.rejects(r.publish([{ ...set('x'), schema: 'Telemetry' }], {}), /Unsupported/);
  } finally {
    await pool.end();
  }
});
test('held F1DB overlays require a namespace and retain rows without item ids', async () => {
  const { pool } = await enrichmentFixture();
  try {
    const r = new EnrichmentRepository(pool, { write: async () => ({ storage: 'descriptor' }) });
    await r.open();
    await assert.rejects(
      r.publish([{ ...set('f1db:2000:1', 1), schema: 'EventDetail' }], {}, { provider: 'f1db' }),
      /explicit namespace/,
    );
    const key = 'f1db:2000:1:event:event:2000:1';
    await r.publish(
      [
        {
          key,
          schema: 'EventDetail',
          coverage: 'partial',
          verification: 'source-only',
          evidenceId: 'e:f1db',
          provenance: {},
          items: [{ event: null }],
        },
      ],
      {},
      { provider: 'f1db', namespace: 'f1db:2000:1:' },
    );
    const row = (
      await pool.query(
        'SELECT id FROM normalized_records WHERE publication_id=$1 AND dataset_key=$2',
        [r.workspace.publication_id, key],
      )
    ).rows[0];
    assert.equal(row.id, `${key}:0`);
  } finally {
    await pool.end();
  }
});
test('held unfinished backbone blocks enrichment and no workspace is created', async () => {
  const { pool } = await enrichmentFixture();
  try {
    await pool.query(
      "INSERT INTO archive_batches(id,phase,base_publication,publication_id,status) VALUES('backbone','backbone','base','base','staging')",
    );
    await assert.rejects(new EnrichmentRepository(pool, {}).open(), /finalized/);
    assert.equal(
      Number((await pool.query('SELECT count(*) AS n FROM enrichment_workspace')).rows[0].n),
      0,
    );
  } finally {
    await pool.end();
  }
});
test('compressed raw storage deduplicates payloads and stops at its byte budget', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'f1-raw-'));
  try {
    const r = new BoundedRawStore(dir, 4096);
    const a = await r.write({ payload: { laps: [1, 2, 3] } });
    const b = await r.write({ payload: { laps: [1, 2, 3] } });
    assert.deepEqual(a, b);
    assert.equal((await fs.readdir(dir)).length, 1);
    await assert.rejects(
      new BoundedRawStore(dir, 1).write({ payload: { different: true } }),
      /budget/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('representative mapped OpenF1 race measures 1000 laps without telemetry', async () => {
  const canonical = { id: 'session:sample', kind: 'race', schedule: { date: '2024-07-07' } };
  const entries = Array.from({ length: 20 }, (_, i) => ({
    id: 'entry:' + i,
    number: String(i + 1),
  }));
  const laps = entries.flatMap((e, i) =>
    Array.from({ length: 50 }, (_, j) => ({
      driver_number: i + 1,
      lap_number: j + 1,
      lap_duration: 90.123,
      date_start: '2024-07-07T14:00:00Z',
      duration_sector_1: 30,
      duration_sector_2: 30,
      duration_sector_3: 30.123,
      is_pit_out_lap: false,
    })),
  );
  const calls = [];
  const provider = new OpenF1({
    get: async (url) => {
      calls.push(url);
      return {
        url: 'https://api.openf1.org/v1/' + url,
        retrievedAt: '2024-07-08T00:00:00Z',
        payload: url.startsWith('sessions')
          ? [
              {
                session_key: 1,
                year: 2024,
                session_name: 'Race',
                date_start: '2024-07-07T14:00:00Z',
                date_end: '2024-07-07T16:00:00Z',
              },
            ]
          : url.startsWith('laps')
            ? laps
            : [],
      };
    },
  });
  const normalized = await provider.detail(1, canonical, entries, {
    retrievedAt: '2024-07-08T00:00:00Z',
    sources: [],
  });
  const lapSet = normalized.sets.find((s) => s.schema === 'Lap');
  assert.equal(lapSet.items.length, 1000);
  assert.equal(lapSet.items[0].entryId, 'entry:0');
  assert.equal(lapSet.items[0].durationMs, 90123);
  assert.equal(
    calls.some((url) => url.includes('car_data') || url.includes('location')),
    false,
  );
  const { pool } = await enrichmentFixture();
  try {
    const repo = new EnrichmentRepository(pool, {});
    await repo.open();
    await repo.publish(normalized.sets, {});
    await repo.publish(normalized.sets, {});
    assert.equal(
      Number((await pool.query('SELECT count(*) AS n FROM normalized_records')).rows[0].n),
      1100,
    );
    console.log(
      JSON.stringify({
        measurement: 'synthetic-mapped-openf1',
        laps: 1000,
        normalizedJsonBytes: Buffer.byteLength(JSON.stringify(lapSet.items)),
        coreRowsAfterTwoPublishes: 100,
        totalRows: 1100,
      }),
    );
  } finally {
    await pool.end();
  }
});
test('finalized held backbone is shared without activating it', async () => {
  const { pool } = await enrichmentFixture();
  try {
    await pool.query(
      "INSERT INTO publications(id,content_hash,provenance) VALUES('backbone-stage','x','{}')",
    );
    await pool.query("INSERT INTO archive_activation_holds VALUES('backbone-stage')");
    await pool.query(
      "INSERT INTO archive_batches(id,phase,base_publication,publication_id,status) VALUES('backbone','backbone','base','backbone-stage','staging')",
    );
    await pool.query(
      "INSERT INTO archive_steps(batch_id,key) VALUES('backbone','scope:2000:coverage-finalized')",
    );
    await pool.query(
      "INSERT INTO datasets VALUES('backbone-stage','held-core','Season','complete','source-only','e','{}')",
    );
    const r = new EnrichmentRepository(pool, {});
    await r.open({ basePublication: 'backbone-stage' });
    await r.publish([set('one')], {});
    assert.equal(r.workspace.base_publication, 'backbone-stage');
    assert.equal(
      (await pool.query('SELECT publication_id FROM current_publication')).rows[0].publication_id,
      'base',
    );
    assert.ok((await r.keys('held')).includes('held-core'));
    await pool.query('DELETE FROM archive_activation_holds WHERE publication_id=$1', [
      r.workspace.publication_id,
    ]);
    await assert.rejects(r.publish([set('two')], {}), /hold/);
  } finally {
    await pool.end();
  }
});
test('database reserve rejects writes before the 450 MiB stop threshold', async () => {
  const { pool } = await enrichmentFixture();
  const r = new EnrichmentRepository(pool, {});
  try {
    await r.open();
    const connect = pool.connect.bind(pool);
    pool.connect = async () => {
      const c = await connect(),
        query = c.query.bind(c);
      c.query = (sql, args) =>
        sql.startsWith('SELECT pg_database_size')
          ? Promise.resolve({ rows: [{ bytes: String(450 * 1024 * 1024) }] })
          : query(sql, args);
      return c;
    };
    await assert.rejects(r.publish([set('one')], {}), /storage budget/);
    assert.equal(
      Number((await pool.query('SELECT count(*) AS n FROM normalized_records')).rows[0].n),
      100,
    );
  } finally {
    await pool.end();
  }
});
