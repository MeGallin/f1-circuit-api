import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';

const [runId = 'archive-20260918', phase = 'backbone'] = process.argv.slice(2);
const pool = createPool(loadConfig());
try {
  const batch = (
    await pool.query('SELECT id,phase,status,publication_id FROM archive_batches WHERE id=$1', [
      `${runId}-${phase}`,
    ])
  ).rows[0];
  if (!batch) throw new Error('Unknown batch.');
  const publication = batch.publication_id;
  const categories = (
    await pool.query(
      'SELECT d.schema_name AS category,count(DISTINCT d.key)::int AS datasets,count(n.id)::int AS records FROM datasets d LEFT JOIN normalized_records n ON n.publication_id=d.publication_id AND n.dataset_key=d.key WHERE d.publication_id=$1 GROUP BY d.schema_name ORDER BY d.schema_name',
      [publication],
    )
  ).rows;
  const seasons = (
    await pool.query(
      "SELECT n.payload->>'year' AS year,(n.payload->>'eventCount')::int AS calendar_events,(n.payload->>'completedCount')::int AS completed_events FROM normalized_records n WHERE n.publication_id=$1 AND n.dataset_key='seasons' AND (n.payload->>'eventCount')::int>0 ORDER BY year DESC",
      [publication],
    )
  ).rows;
  const checkpoints = (
    await pool.query(
      "SELECT split_part(key,':',2) AS year,count(*)::int AS rounds FROM archive_steps WHERE batch_id=$1 AND key LIKE 'jolpica:%:%:%' GROUP BY year ORDER BY year DESC",
      [batch.id],
    )
  ).rows;
  const duplicates = Number(
    (
      await pool.query(
        'SELECT count(*) AS n FROM (SELECT dataset_key,id FROM normalized_records WHERE publication_id=$1 GROUP BY dataset_key,id HAVING count(*)>1) x',
        [publication],
      )
    ).rows[0].n,
  );
  const storage = (
    await pool.query('SELECT pg_database_size(current_database())::text AS database_bytes')
  ).rows[0];
  console.log(
    JSON.stringify({
      runId,
      phase,
      status: batch.status,
      categories,
      seasons,
      checkpoints,
      duplicates,
      ...storage,
    }),
  );
} catch (error) {
  console.error(JSON.stringify({ status: 'audit-failed', type: error.name }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
