import { randomUUID } from 'node:crypto';
export async function runSync(pool, provider, scope, work) {
  const client = await pool.connect();
  const id = randomUUID();
  let locked = false;
  try {
    const result = await client.query('SELECT pg_try_advisory_lock(7198403) AS locked');
    locked = result.rows[0].locked;
    if (!locked) throw new Error('Another import is running.');
    await client.query(
      "INSERT INTO sync_runs(id,provider,scope,status) VALUES($1,$2,$3,'running')",
      [id, provider, scope],
    );
    const publication = await work();
    await client.query(
      "UPDATE sync_runs SET status='completed',completed_at=now(),publication_id=$2 WHERE id=$1",
      [id, publication],
    );
    return publication;
  } catch (error) {
    if (locked)
      await client.query(
        "UPDATE sync_runs SET status='failed',completed_at=now(),error_code='SYNC_FAILED' WHERE id=$1",
        [id],
      );
    throw error;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(7198403)');
    client.release();
  }
}
