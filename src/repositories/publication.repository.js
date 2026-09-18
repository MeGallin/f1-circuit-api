import { randomUUID } from 'node:crypto';
import { hash } from '../models/dataset.js';
export class PublicationRepository {
  constructor(pool) {
    this.pool = pool;
  }
  async ready() {
    await this.pool.query('SELECT publication_id FROM current_publication LIMIT 1');
    return true;
  }
  async snapshot(id) {
    const result = id
      ? await this.pool.query(
          "SELECT id,created_at FROM publications WHERE id=$1 AND id NOT IN (SELECT publication_id FROM archive_batches WHERE status='staging')",
          [id],
        )
      : await this.pool.query(
          'SELECT p.id,p.created_at FROM publications p JOIN current_publication c ON c.publication_id=p.id WHERE c.singleton=1',
        );
    return result.rows[0] || null;
  }
  async get(key, snapshotId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM datasets WHERE publication_id=$1 AND key=$2',
      [snapshotId, key],
    );
    if (!rows.length) return null;
    const records = await this.pool.query(
      'SELECT payload FROM normalized_records WHERE publication_id=$1 AND dataset_key=$2 ORDER BY ordinal,id',
      [snapshotId, key],
    );
    return {
      ...rows[0].metadata,
      key,
      schema: rows[0].schema_name,
      coverage: rows[0].coverage,
      verification: rows[0].verification,
      evidenceId: rows[0].evidence_id,
      items: records.rows.map((x) => x.payload),
    };
  }
  async keys(prefix, snapshotId) {
    const { rows } = await this.pool.query(
      'SELECT key FROM datasets WHERE publication_id=$1 AND starts_with(key,$2) ORDER BY key',
      [snapshotId, prefix],
    );
    return rows.map((x) => x.key);
  }
  async resolve(alias, snapshotId) {
    const { rows } = await this.pool.query(
      'SELECT canonical_id FROM entity_aliases WHERE publication_id=$1 AND alias=$2',
      [snapshotId, alias],
    );
    return rows[0]?.canonical_id || null;
  }
  async evidence(evidenceId, snapshotId) {
    const { rows } = await this.pool.query(
      'SELECT key FROM datasets WHERE publication_id=$1 AND evidence_id=$2',
      [snapshotId, evidenceId],
    );
    return rows[0] ? this.get(rows[0].key, snapshotId) : null;
  }
  async observation(observation) {
    await this.pool.query(
      'INSERT INTO source_observations(id,provider,source_version,retrieved_at,checksum,source_url,payload) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
      [
        observation.id,
        observation.provider,
        observation.version,
        observation.retrievedAt,
        observation.checksum,
        observation.url,
        JSON.stringify(observation.payload),
      ],
    );
  }
  async publish(sets, aliases, provenance) {
    const client = await this.pool.connect();
    const id = randomUUID();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(7198401)');
      const old = await client.query(
        'SELECT publication_id FROM current_publication WHERE singleton=1',
      );
      await client.query('INSERT INTO publications(id,content_hash,provenance) VALUES($1,$2,$3)', [
        id,
        hash(sets),
        JSON.stringify(provenance),
      ]);
      if (old.rows.length) {
        const previous = old.rows[0].publication_id;
        await client.query(
          'INSERT INTO datasets SELECT $1,key,schema_name,coverage,verification,evidence_id,metadata FROM datasets WHERE publication_id=$2',
          [id, previous],
        );
        await client.query(
          'INSERT INTO normalized_records SELECT $1,dataset_key,id,ordinal,payload FROM normalized_records WHERE publication_id=$2',
          [id, previous],
        );
        await client.query(
          'INSERT INTO entity_aliases SELECT $1,alias,canonical_id FROM entity_aliases WHERE publication_id=$2',
          [id, previous],
        );
      }
      for (const set of sets) {
        await client.query(
          'DELETE FROM normalized_records WHERE publication_id=$1 AND dataset_key=$2',
          [id, set.key],
        );
        await client.query('DELETE FROM datasets WHERE publication_id=$1 AND key=$2', [
          id,
          set.key,
        ]);
        const { items, ...metadata } = set;
        await client.query(
          'INSERT INTO datasets(publication_id,key,schema_name,coverage,verification,evidence_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            id,
            set.key,
            set.schema,
            set.coverage,
            set.verification,
            set.evidenceId,
            JSON.stringify(metadata),
          ],
        );
        for (let i = 0; i < items.length; i++)
          await client.query(
            'INSERT INTO normalized_records(publication_id,dataset_key,id,ordinal,payload) VALUES($1,$2,$3,$4,$5)',
            [id, set.key, items[i].id || `${set.key}:${i}`, i, JSON.stringify(items[i])],
          );
      }
      for (const [alias, canonical] of Object.entries(aliases))
        await client.query(
          'INSERT INTO entity_aliases(publication_id,alias,canonical_id) VALUES($1,$2,$3) ON CONFLICT(publication_id,alias) DO UPDATE SET canonical_id=EXCLUDED.canonical_id',
          [id, alias, canonical],
        );
      await client.query(
        'INSERT INTO current_publication(singleton,publication_id) VALUES(1,$1) ON CONFLICT(singleton) DO UPDATE SET publication_id=EXCLUDED.publication_id',
        [id],
      );
      await client.query('COMMIT');
      return id;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
