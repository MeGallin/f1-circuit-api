import fs from 'node:fs';
import { newDb, DataType } from 'pg-mem';
export async function enrichmentFixture() {
  const db = newDb();
  db.public.registerFunction({
    name: 'jsonb_typeof',
    args: [DataType.jsonb],
    returns: DataType.text,
    implementation: (v) => (Array.isArray(v) ? 'array' : typeof v),
  });
  db.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.integer],
    returns: DataType.integer,
    implementation: () => 1,
  });
  db.public.registerFunction({
    name: 'current_database',
    returns: DataType.text,
    implementation: () => 'test',
  });
  db.public.registerFunction({
    name: 'pg_database_size',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: () => 1000000,
  });
  for (const file of ['001_snapshot_store.sql', '002_archive_batches.sql'])
    db.public.none(
      fs
        .readFileSync(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8')
        .replace(/^ALTER TABLE .* ENABLE ROW LEVEL SECURITY;$/gm, ''),
    );
  db.public.none(
    'CREATE TABLE archive_activation_holds(publication_id text PRIMARY KEY REFERENCES publications(id))',
  );
  db.public.none(
    fs
      .readFileSync(
        new URL('../supabase/migrations/004_enrichment_manifests.sql', import.meta.url),
        'utf8',
      )
      .replace(/^ALTER TABLE .* ENABLE ROW LEVEL SECURITY;$/gm, ''),
  );
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await pool.query(
    "INSERT INTO publications(id,content_hash,provenance) VALUES('base','test','{}')",
  );
  await pool.query("INSERT INTO current_publication VALUES(1,'base')");
  await pool.query(
    "INSERT INTO datasets VALUES('base','core','Season','complete','source-only','core-evidence','{}')",
  );
  for (let i = 0; i < 100; i++)
    await pool.query("INSERT INTO normalized_records VALUES('base','core',$1,$2,$3)", [
      String(i),
      i,
      JSON.stringify({ id: String(i), year: 2000 + i }),
    ]);
  return { pool, db };
}
