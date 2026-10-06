import test from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../src/jobs/run-sync.js';

test('sync importer reports shared advisory-lock contention as busy', async () => {
  const statements = [];
  let released = false;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          statements.push(sql);
          return { rows: [{ locked: false }] };
        },
        release() {
          released = true;
        },
      };
    },
  };

  await assert.rejects(
    runSync(pool, 'jolpica', '2026:16', async () => 'publication'),
    {
      code: 'SYNC_BUSY',
    },
  );
  assert.ok(statements.some((sql) => sql.includes('pg_try_advisory_lock(7198403)')));
  assert.equal(released, true);
});
