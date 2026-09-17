import fs from 'node:fs/promises';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';
export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7198402)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const file of (await fs.readdir(new URL('../supabase/migrations/', import.meta.url)))
      .filter((x) => x.endsWith('.sql'))
      .sort()) {
      const existing = await client.query('SELECT name FROM schema_migrations WHERE name=$1', [
        file,
      ]);
      if (existing.rows.length) continue;
      await client.query(
        await fs.readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'),
      );
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [file]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/migrate.js')) {
  const pool = createPool(loadConfig());
  try {
    await migrate(pool);
    console.log('Migrations complete.');
  } catch {
    console.error(
      'Migration failed; inspect database connectivity, role permissions and migration compatibility.',
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
