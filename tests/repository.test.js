import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newDb, DataType } from 'pg-mem';
import { PublicationRepository } from '../src/repositories/publication.repository.js';
test('SQL repository publishes versioned normalized records and replaces data without duplicates', async () => {
  const db = newDb();
  db.public.registerFunction({
    name: 'jsonb_typeof',
    args: [DataType.jsonb],
    returns: DataType.text,
    implementation: (value) => (Array.isArray(value) ? 'array' : typeof value),
  });
  db.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.integer],
    returns: DataType.integer,
    implementation: () => 1,
  });
  // pg-mem does not implement RLS. Real PostgreSQL/Supabase migration validation remains a release gate.
  const sql = fs
    .readFileSync(new URL('../supabase/migrations/001_snapshot_store.sql', import.meta.url), 'utf8')
    .replace(/^ALTER TABLE .* ENABLE ROW LEVEL SECURITY;$/gm, '');
  db.public.none(sql);
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const repo = new PublicationRepository(pool);
  const set = {
    key: 'test',
    schema: 'Season',
    items: [{ id: 'one', year: 2000 }],
    coverage: 'partial',
    verification: 'source-only',
    evidenceId: 'e1',
    provenance: {},
  };
  const first = await repo.publish([set], { 'test:alias': 'one' }, {});
  assert.equal((await repo.get('test', first)).items.length, 1);
  const second = await repo.publish([set], { 'test:alias': 'one' }, {});
  assert.notEqual(first, second);
  assert.equal((await repo.snapshot()).id, second);
  assert.equal((await repo.get('test', second)).items.length, 1);
  assert.equal(await repo.resolve('test:alias', second), 'one');
  assert.equal((await repo.get('test', first)).items[0].year, 2000);
  await pool.end();
});
test('publication failure rolls back and always releases connection', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('INSERT INTO publications')) throw new Error('failure');
      return { rows: [] };
    },
    release() {
      calls.push('released');
    },
  };
  const repo = new PublicationRepository({
    async connect() {
      return client;
    },
  });
  await assert.rejects(repo.publish([], {}, {}));
  assert.ok(calls.includes('ROLLBACK'));
  assert.equal(calls.at(-1), 'released');
  assert.ok(!calls.includes('COMMIT'));
});
