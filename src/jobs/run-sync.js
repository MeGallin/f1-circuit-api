import { randomUUID } from 'node:crypto';
export async function runSync(pool, provider, scope, work, { beforeWork } = {}) {
  const client = await pool.connect();
  const id = randomUUID();
  let locked = false;
  let failure;
  let publication;
  let unlockFailure;
  let auditStarted = false;
  try {
    const result = await client.query('SELECT pg_try_advisory_lock(7198403) AS locked');
    locked = result.rows[0].locked;
    if (!locked) {
      const error = new Error('Another import is running.');
      error.code = 'SYNC_BUSY';
      throw error;
    }
    await beforeWork?.(client);
    await client.query(
      "INSERT INTO sync_runs(id,provider,scope,status) VALUES($1,$2,$3,'running')",
      [id, provider, scope],
    );
    auditStarted = true;
    publication = await work();
    await client.query(
      "UPDATE sync_runs SET status='completed',completed_at=now(),publication_id=$2 WHERE id=$1",
      [id, publication],
    );
  } catch (error) {
    failure = error;
    if (auditStarted) {
      try {
        await client.query(
          "UPDATE sync_runs SET status='failed',completed_at=now(),error_code='SYNC_FAILED' WHERE id=$1",
          [id],
        );
      } catch {
        // Preserve the import error when recording its failure is unavailable.
      }
    }
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock(7198403)');
    } catch (error) {
      unlockFailure = error;
    } finally {
      // A session lock may remain: destroy this connection rather than reuse it.
      client.release(unlockFailure);
    }
  }
  if (failure) throw failure;
  if (unlockFailure) throw unlockFailure;
  return publication;
}
