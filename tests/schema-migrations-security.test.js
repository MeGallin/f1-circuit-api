import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { migrate } from '../scripts/migrate.js';

const securityMigrationUrl = new URL(
  '../supabase/migrations/006_schema_migrations_security.sql',
  import.meta.url,
);

// The fake client verifies emitted SQL and transaction ordering, not server-side ACL enforcement.
test('migration runner emits ledger security SQL and retains migration tracking flow', async () => {
  const calls = [];
  const applied = new Set([
    '001_snapshot_store.sql',
    '002_archive_batches.sql',
    '003_archive_activation_holds.sql',
    '004_enrichment_manifests.sql',
    '005_question_rag_index.sql',
  ]);
  const client = {
    async query(sql, values = []) {
      calls.push(sql);
      if (sql.startsWith('SELECT name FROM public.schema_migrations')) {
        return { rows: applied.has(values[0]) ? [{ name: values[0] }] : [] };
      }
      if (sql.startsWith('INSERT INTO public.schema_migrations')) applied.add(values[0]);
      return { rows: [] };
    },
    release() {},
  };

  await migrate({ connect: async () => client });

  const bootstrap = calls.findIndex((sql) =>
    sql.startsWith('CREATE TABLE IF NOT EXISTS public.schema_migrations'),
  );
  const bootstrapRls = calls.findIndex((sql) =>
    sql.startsWith('ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY'),
  );
  const bootstrapRevoke = calls.findIndex((sql) =>
    sql.startsWith(
      'REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM PUBLIC, anon, authenticated',
    ),
  );
  const ledgerRead = calls.findIndex((sql) =>
    sql.startsWith('SELECT name FROM public.schema_migrations'),
  );
  const ledgerInsert = calls.findIndex((sql) =>
    sql.startsWith('INSERT INTO public.schema_migrations'),
  );

  assert.ok(bootstrap >= 0, 'the runner creates the migration ledger');
  assert.ok(bootstrap < bootstrapRls, 'RLS is enabled immediately after bootstrap');
  assert.ok(bootstrapRls < bootstrapRevoke, 'Data API grants are revoked after RLS is enabled');
  assert.ok(bootstrapRevoke < ledgerRead, 'the runner secures the ledger before reading it');
  assert.ok(ledgerRead < ledgerInsert, 'the runner retains its migration tracking flow');

  const securityMigration = await fs.readFile(securityMigrationUrl, 'utf8');
  const freshDatabaseMigration = await fs.readFile(
    new URL('../supabase/migrations/001_snapshot_store.sql', import.meta.url),
    'utf8',
  );
  assert.match(freshDatabaseMigration, /CREATE TABLE IF NOT EXISTS public\.schema_migrations/i);
  assert.match(
    freshDatabaseMigration,
    /ALTER TABLE public\.schema_migrations ENABLE ROW LEVEL SECURITY;/i,
  );
  assert.match(
    freshDatabaseMigration,
    /REVOKE ALL PRIVILEGES ON TABLE public\.schema_migrations FROM PUBLIC,\s*anon,\s*authenticated;/i,
  );
  assert.match(
    securityMigration,
    /ALTER TABLE public\.schema_migrations ENABLE ROW LEVEL SECURITY;/i,
  );
  assert.match(
    securityMigration,
    /REVOKE ALL PRIVILEGES ON TABLE public\.schema_migrations FROM PUBLIC,\s*anon,\s*authenticated;/i,
  );
  assert.doesNotMatch(securityMigration, /\b(?:REVOKE|ALTER\s+ROLE)\b[^;]*\bpostgres\b/i);
  assert.ok(calls.includes(securityMigration), 'the runner submits the upgrade migration SQL');
  assert.equal(
    calls.filter((sql) => sql.startsWith('INSERT INTO public.schema_migrations')).length,
    1,
    'only the new migration is recorded when 001 through 005 are already applied',
  );
  assert.deepEqual([...applied].sort(), [
    '001_snapshot_store.sql',
    '002_archive_batches.sql',
    '003_archive_activation_holds.sql',
    '004_enrichment_manifests.sql',
    '005_question_rag_index.sql',
    '006_schema_migrations_security.sql',
  ]);

  const initialSecurityMigrationCalls = calls.filter((sql) => sql === securityMigration).length;
  await migrate({ connect: async () => client });
  assert.equal(
    calls.filter((sql) => sql === securityMigration).length,
    initialSecurityMigrationCalls,
    'a second run skips the already-recorded upgrade migration',
  );
  assert.equal(
    calls.filter((sql) => sql.startsWith('INSERT INTO public.schema_migrations')).length,
    1,
  );
  assert.equal(
    calls.filter((sql) =>
      sql.startsWith('ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY'),
    ).length,
    2,
    'bootstrap security remains safe to repeat',
  );
  assert.equal(
    calls.filter((sql) =>
      sql.startsWith(
        'REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM PUBLIC, anon, authenticated',
      ),
    ).length,
    2,
    'bootstrap revocation remains safe to repeat',
  );
});

test('migration runner rolls back before reading the ledger if access revocation fails', async () => {
  const calls = [];
  let released = false;
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations')) {
        throw new Error('revocation denied');
      }
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };

  await assert.rejects(() => migrate({ connect: async () => client }), /revocation denied/);
  assert.ok(calls.includes('ROLLBACK'));
  assert.ok(!calls.some((sql) => sql.startsWith('SELECT name FROM public.schema_migrations')));
  assert.ok(!calls.includes('COMMIT'));
  assert.equal(released, true);
});
