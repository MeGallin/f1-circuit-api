// Native PostgreSQL verification uses only connection-local temporary tables.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';
import { ArchiveRepository } from '../src/repositories/archive.repository.js';
import { SyncService } from '../src/services/sync.service.js';
import { syntheticWeekend } from '../fixtures/synthetic-weekend.js';

const pool = createPool(loadConfig());
let connection;
try {
  connection = await pool.connect();
  for (const name of [
    'publications',
    'current_publication',
    'datasets',
    'normalized_records',
    'entity_aliases',
    'source_observations',
  ])
    await connection.query(`CREATE TEMP TABLE ${name} (LIKE public.${name} INCLUDING ALL)`);
  const sql = (
    await fs.readFile(
      new URL('../supabase/migrations/002_archive_batches.sql', import.meta.url),
      'utf8',
    )
  )
    .replaceAll('CREATE TABLE ', 'CREATE TEMP TABLE ')
    .replace(/^ALTER TABLE .* ENABLE ROW LEVEL SECURITY;$/gm, '');
  await connection.query(sql);
  const pinned = {
    query: (...args) => connection.query(...args),
    async connect() {
      return { query: (...args) => connection.query(...args), release() {} };
    },
  };
  const repo = new ArchiveRepository(pinned);
  await repo.open('native-verification', 'backbone');
  repo.step = 'round';
  const service = new SyncService(repo);
  await service.publish(syntheticWeekend(), 'jolpica');
  assert.equal((await connection.query('SELECT * FROM current_publication')).rows.length, 0);
  const count = Number(
    (await connection.query('SELECT count(*) n FROM normalized_records')).rows[0].n,
  );
  await service.publish(syntheticWeekend(), 'jolpica');
  assert.equal(
    Number((await connection.query('SELECT count(*) n FROM normalized_records')).rows[0].n),
    count,
  );
  const resumed = new ArchiveRepository(pinned);
  await resumed.open('native-verification', 'backbone');
  assert.equal(resumed.done('round'), true);
  resumed.step = 'must-rollback';
  await assert.rejects(
    resumed.publish(
      [
        {
          key: 'invalid',
          schema: 'Season',
          coverage: 'partial',
          verification: 'source-only',
          evidenceId: 'test',
          items: [{ id: 'duplicate' }, { id: 'duplicate' }],
        },
      ],
      {},
    ),
  );
  assert.equal(resumed.done('must-rollback'), false);
  assert.equal(
    Number((await connection.query('SELECT count(*) n FROM normalized_records')).rows[0].n),
    count,
  );
  await resumed.activate();
  assert.equal(
    (await connection.query('SELECT publication_id FROM current_publication')).rows[0]
      .publication_id,
    resumed.batch.publication_id,
  );
  const completed = new ArchiveRepository(pinned);
  await completed.open('native-verification', 'backbone');
  assert.equal(completed.batch.status, 'completed');
  assert.equal(await completed.activate(), resumed.batch.publication_id);
  console.log(
    JSON.stringify({
      status: 'passed',
      scope: 'temporary-tables-only',
      checks: [
        'bulk-insert',
        'resume',
        'idempotency',
        'atomic-rollback',
        'activation',
        'completed-no-op',
      ],
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'failed',
      scope: 'temporary-tables-only',
      type: error.name,
      code: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'CHECK_FAILED',
    }),
  );
  process.exitCode = 1;
} finally {
  connection?.release(true);
  await pool.end();
}
