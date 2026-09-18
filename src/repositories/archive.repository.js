import { randomUUID } from 'node:crypto';
import { PublicationRepository } from './publication.repository.js';
import { hash } from '../models/dataset.js';

// An unpublished snapshot is updated in bounded transactions. Public readers retain
// the original snapshot until activation. Existing publications are never pruned.
export class ArchiveRepository extends PublicationRepository {
  async open(id, phase) {
    this.batchId = id;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(7198401)');
      let batch = (await client.query('SELECT * FROM archive_batches WHERE id=$1', [id])).rows[0];
      if (!batch) {
        const base = (await super.snapshot())?.id || null;
        const publication = randomUUID();
        await client.query(
          'INSERT INTO publications(id,content_hash,provenance) VALUES($1,$2,$3)',
          [publication, hash([id, phase]), JSON.stringify({ archive: id, phase })],
        );
        if (base) {
          await client.query(
            'INSERT INTO datasets SELECT $1,key,schema_name,coverage,verification,evidence_id,metadata FROM datasets WHERE publication_id=$2',
            [publication, base],
          );
          await client.query(
            'INSERT INTO normalized_records SELECT $1,dataset_key,id,ordinal,payload FROM normalized_records WHERE publication_id=$2',
            [publication, base],
          );
          await client.query(
            'INSERT INTO entity_aliases SELECT $1,alias,canonical_id FROM entity_aliases WHERE publication_id=$2',
            [publication, base],
          );
        }
        batch = (
          await client.query(
            "INSERT INTO archive_batches(id,phase,base_publication,publication_id,status) VALUES($1,$2,$3,$4,'staging') RETURNING *",
            [id, phase, base, publication],
          )
        ).rows[0];
      }
      if (batch.phase !== phase) throw new Error('Archive phase differs from existing run.');
      this.batch = batch;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    this.cached = new Map();
    this.pendingObservations = new Map();
    this.observed = new Set();
    this.aliases = new Map(
      (
        await this.pool.query(
          'SELECT alias,canonical_id FROM entity_aliases WHERE publication_id=$1',
          [this.batch.publication_id],
        )
      ).rows.map((r) => [r.alias, r.canonical_id]),
    );
    this.steps = new Set(
      (await this.pool.query('SELECT key FROM archive_steps WHERE batch_id=$1', [id])).rows.map(
        (r) => r.key,
      ),
    );
    return this.batch;
  }
  async snapshot() {
    return { id: this.batch.publication_id };
  }
  async resolve(alias) {
    return this.aliases.get(alias) || null;
  }
  async get(key) {
    if (!this.cached.has(key))
      this.cached.set(key, await super.get(key, this.batch.publication_id));
    return structuredClone(this.cached.get(key));
  }
  done(step) {
    return this.steps.has(step);
  }
  async observation(value) {
    if (!this.observed.has(value.id)) this.pendingObservations.set(value.id, value);
  }
  async publish(sets, aliases) {
    if (this.batch.status !== 'staging') throw new Error('Completed archives are immutable.');
    const client = await this.pool.connect();
    const publication = this.batch.publication_id;
    const metadata = sets.map(({ items: _items, ...s }) => ({
      key: s.key,
      schema: s.schema,
      coverage: s.coverage,
      verification: s.verification,
      evidence: s.evidenceId,
      metadata: s,
    }));
    const rows = sets.flatMap((s) =>
      s.items.map((payload, ordinal) => ({
        key: s.key,
        id: payload.id || `${s.key}:${ordinal}`,
        ordinal,
        payload,
      })),
    );
    try {
      await client.query('BEGIN');
      const observations = [...this.pendingObservations.values()];
      for (let i = 0; i < observations.length; i += 20)
        await client.query(
          'INSERT INTO source_observations SELECT x.id,x.provider,x.version,x."retrievedAt",x.checksum,x.url,x.payload FROM jsonb_to_recordset($1::jsonb) AS x(id text,provider text,version text,"retrievedAt" timestamptz,checksum text,url text,payload jsonb) ON CONFLICT(id) DO NOTHING',
          [JSON.stringify(observations.slice(i, i + 20))],
        );
      await client.query(
        'DELETE FROM normalized_records WHERE publication_id=$1 AND dataset_key=ANY($2::text[])',
        [publication, sets.map((s) => s.key)],
      );
      await client.query('DELETE FROM datasets WHERE publication_id=$1 AND key=ANY($2::text[])', [
        publication,
        sets.map((s) => s.key),
      ]);
      await client.query(
        'INSERT INTO datasets SELECT $1,x.key,x.schema,x.coverage,x.verification,x.evidence,x.metadata FROM jsonb_to_recordset($2::jsonb) AS x(key text,schema text,coverage text,verification text,evidence text,metadata jsonb)',
        [publication, JSON.stringify(metadata)],
      );
      // Bounded SQL payloads; rows are sent as JSON parameters, never interpolated SQL.
      for (let i = 0; i < rows.length; i += 2000)
        await client.query(
          'INSERT INTO normalized_records SELECT $1,x.key,x.id,x.ordinal,x.payload FROM jsonb_to_recordset($2::jsonb) AS x(key text,id text,ordinal integer,payload jsonb)',
          [publication, JSON.stringify(rows.slice(i, i + 2000))],
        );
      await client.query(
        'INSERT INTO entity_aliases SELECT $1,x.alias,x.canonical FROM jsonb_to_recordset($2::jsonb) AS x(alias text,canonical text) ON CONFLICT(publication_id,alias) DO UPDATE SET canonical_id=EXCLUDED.canonical_id',
        [
          publication,
          JSON.stringify(
            Object.entries(aliases).map(([alias, canonical]) => ({ alias, canonical })),
          ),
        ],
      );
      if (this.step)
        await client.query(
          'INSERT INTO archive_steps(batch_id,key) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [this.batchId, this.step],
        );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    for (const s of sets) this.cached.set(s.key, structuredClone(s));
    for (const id of this.pendingObservations.keys()) this.observed.add(id);
    this.pendingObservations.clear();
    for (const [a, c] of Object.entries(aliases)) this.aliases.set(a, c);
    if (this.step) this.steps.add(this.step);
    return publication;
  }
  async activate() {
    if (this.batch.status === 'completed') return this.batch.publication_id;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(7198401)');
      const current =
        (await client.query('SELECT publication_id FROM current_publication WHERE singleton=1'))
          .rows[0]?.publication_id || null;
      if (current !== this.batch.base_publication)
        throw new Error('Publication changed during archive; review before activation.');
      const manifests = (
        await client.query(
          'SELECT key,evidence_id FROM datasets WHERE publication_id=$1 ORDER BY key',
          [this.batch.publication_id],
        )
      ).rows;
      await client.query('UPDATE publications SET content_hash=$2 WHERE id=$1', [
        this.batch.publication_id,
        hash(manifests),
      ]);
      await client.query(
        'INSERT INTO current_publication(singleton,publication_id) VALUES(1,$1) ON CONFLICT(singleton) DO UPDATE SET publication_id=EXCLUDED.publication_id',
        [this.batch.publication_id],
      );
      await client.query(
        "UPDATE archive_batches SET status='completed',completed_at=now() WHERE id=$1",
        [this.batchId],
      );
      await client.query('COMMIT');
      this.batch.status = 'completed';
      return this.batch.publication_id;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
