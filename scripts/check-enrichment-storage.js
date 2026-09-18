import fs from 'node:fs/promises';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';
import { EnrichmentRepository } from '../src/repositories/enrichment.repository.js';
import { OpenF1 } from '../src/providers/openf1/client.js';
const pool = createPool(loadConfig()),
  client = await pool.connect();
try {
  // Session-local temp tables shadow production names. No persistent schema/data changes.
  for (const file of [
    '001_snapshot_store.sql',
    '002_archive_batches.sql',
    '004_enrichment_manifests.sql',
  ]) {
    const sql = (
      await fs.readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8')
    )
      .replace(/CREATE TABLE(?: IF NOT EXISTS)? /g, 'CREATE TEMP TABLE ')
      .replace(/^ALTER TABLE .* ENABLE ROW LEVEL SECURITY;$/gm, '');
    await client.query(sql);
    if (file === '002_archive_batches.sql')
      await client.query(
        'CREATE TEMP TABLE archive_activation_holds(publication_id text PRIMARY KEY REFERENCES publications(id))',
      );
  }
  await client.query(
    "INSERT INTO publications(id,content_hash,provenance) VALUES('test-base','test','{}')",
  );
  await client.query("INSERT INTO current_publication VALUES(1,'test-base')");
  await client.query(
    "INSERT INTO datasets VALUES('test-base','core','Season','complete','source-only','core-evidence','{}')",
  );
  await client.query(
    "INSERT INTO normalized_records SELECT 'test-base','core',i::text,i,jsonb_build_object('id',i::text,'year',2000) FROM generate_series(1,1000) i",
  );
  const isolated = {
    query: (sql, args) =>
      sql.includes('pg_advisory_xact_lock')
        ? Promise.resolve({ rows: [] })
        : client.query(sql, args),
    release() {},
  };
  const repository = new EnrichmentRepository({ ...isolated, connect: async () => isolated }, {});
  await repository.open();
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
  const provider = new OpenF1({
    get: async (url) => ({
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
    }),
  });
  const mapped = await provider.detail(
    1,
    { id: 'session:sample', kind: 'race', schedule: { date: '2024-07-07' } },
    entries,
    { retrievedAt: '2024-07-08T00:00:00Z', sources: [] },
  );
  const sizes = [];
  for (let pass = 0; pass < 3; pass++) {
    if (pass) await repository.publish(mapped.sets, {});
    const r = (
      await client.query(
        "SELECT count(*)::int AS rows, count(*) FILTER(WHERE publication_id='test-base')::int AS core_rows,sum(pg_column_size(payload))::text AS payload_bytes,pg_total_relation_size('pg_temp.normalized_records')::text AS physical_bytes FROM normalized_records",
      )
    ).rows[0];
    sizes.push({ pass, ...r });
  }
  if (
    sizes[0].rows !== 1000 ||
    sizes[1].rows !== 2000 ||
    sizes[2].rows !== 2000 ||
    sizes[2].core_rows !== 1000
  )
    throw new Error('Unexpected storage regression.');
  console.log(
    JSON.stringify({
      status: 'passed',
      scope: 'temporary-tables-only',
      syntheticMappedLaps: 1000,
      sizes,
      publicTestPointer: (await client.query('SELECT publication_id FROM current_publication'))
        .rows[0].publication_id,
    }),
  );
} catch (error) {
  console.log(JSON.stringify({ status: 'failed', type: error.name }));
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
