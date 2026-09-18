import { randomUUID } from 'node:crypto';
import { PublicationRepository } from './publication.repository.js';
import { hash } from '../models/dataset.js';
const allowed = new Set(['Lap', 'PitStop', 'Stint', 'Weather', 'RaceControl', 'ProviderStatus']);
export class EnrichmentRepository extends PublicationRepository {
  constructor(pool, rawStore) {
    super(pool);
    this.rawStore = rawStore;
    this.observations = new Map();
  }
  async open({ basePublication } = {}) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(7198401)');
      const current = (
        await c.query('SELECT publication_id FROM current_publication WHERE singleton=1')
      ).rows[0]?.publication_id;
      if (!current) throw new Error('Publish a reviewed backbone before enrichment.');
      const base = basePublication || current;
      const batches = (
        await c.query("SELECT id,publication_id FROM archive_batches WHERE status='staging'")
      ).rows;
      if (batches.length) {
        const selected = batches.find((b) => b.publication_id === base);
        if (
          !selected ||
          batches.length !== 1 ||
          !(
            await c.query(
              "SELECT key FROM archive_steps WHERE batch_id=$1 AND key='scope:2000:coverage-finalized'",
              [selected.id],
            )
          ).rows.length
        )
          throw new Error('Backbone scope must be finalized before enrichment.');
      }
      let workspace = (await c.query('SELECT * FROM enrichment_workspace WHERE singleton=1'))
        .rows[0];
      if (
        workspace &&
        (workspace.base_publication !== base ||
          workspace.public_at_creation !== current ||
          workspace.publication_id === current)
      )
        throw new Error('Workspace rotation requires explicit retention review.');
      if (!workspace) {
        const id = randomUUID();
        await c.query('INSERT INTO publications(id,content_hash,provenance) VALUES($1,$2,$3)', [
          id,
          hash([base, 'openf1-stage']),
          JSON.stringify({ provider: 'openf1', staging: true }),
        ]);
        await c.query('INSERT INTO archive_activation_holds(publication_id) VALUES($1)', [id]);
        await c.query(
          'INSERT INTO enrichment_workspace(singleton,publication_id,base_publication,public_at_creation) VALUES(1,$1,$2,$3)',
          [id, base, current],
        );
        await c.query(
          'INSERT INTO publication_dataset_refs(publication_id,key,dataset_publication_id) SELECT $1,key,publication_id FROM datasets WHERE publication_id=$2',
          [id, base],
        );
        workspace = { publication_id: id, base_publication: base, public_at_creation: current };
      }
      if (
        !(
          await c.query(
            'SELECT publication_id FROM archive_activation_holds WHERE publication_id=$1',
            [workspace.publication_id],
          )
        ).rows.length
      )
        throw new Error('Enrichment staging must remain held.');
      await c.query('COMMIT');
      this.workspace = workspace;
      return workspace;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  }
  async snapshot() {
    return { id: this.workspace.publication_id };
  }
  async get(key) {
    const row = (
      await this.pool.query(
        'SELECT dataset_publication_id FROM publication_dataset_refs WHERE publication_id=$1 AND key=$2',
        [this.workspace.publication_id, key],
      )
    ).rows[0];
    return row ? super.get(key, row.dataset_publication_id) : null;
  }
  async keys(prefix) {
    return (
      await this.pool.query(
        'SELECT key FROM publication_dataset_refs WHERE publication_id=$1 AND key LIKE $2 ORDER BY key',
        [this.workspace.publication_id, prefix + '%'],
      )
    ).rows.map((r) => r.key);
  }
  async resolve(alias) {
    return (
      (await super.resolve(alias, this.workspace.publication_id)) ||
      (await super.resolve(alias, this.workspace.base_publication))
    );
  }
  async observation(value) {
    const payload = await this.rawStore.write(value);
    this.observations.set(value.id, { ...value, payload });
  }
  async activate() {
    throw new Error('Enrichment activation requires a separate reviewed manifest-aware release.');
  }
  async publish(sets, aliases) {
    if (sets.some((s) => !allowed.has(s.schema)))
      throw new Error('Unsupported enrichment dataset; telemetry is not persisted.');
    if (Object.keys(aliases).length)
      throw new Error('Enrichment must preserve existing canonical identities.');
    const c = await this.pool.connect(),
      id = this.workspace.publication_id;
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(7198401)');
      const current = (
        await c.query('SELECT publication_id FROM current_publication WHERE singleton=1')
      ).rows[0]?.publication_id;
      if (current !== this.workspace.public_at_creation || current === id)
        throw new Error('Public snapshot changed; staging review required.');
      if (
        !(
          await c.query(
            'SELECT publication_id FROM archive_activation_holds WHERE publication_id=$1',
            [id],
          )
        ).rows.length
      )
        throw new Error('Staging activation hold is required.');
      const size = Number(
        (await c.query('SELECT pg_database_size(current_database())::text AS bytes')).rows[0].bytes,
      );
      const reserve = Buffer.byteLength(JSON.stringify(sets)) * 4;
      if (size + reserve >= 450 * 1024 * 1024) throw new Error('Database storage budget reached.');
      for (const o of this.observations.values())
        await c.query(
          'INSERT INTO source_observations(id,provider,source_version,retrieved_at,checksum,source_url,payload) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
          [
            o.id,
            o.provider,
            o.version,
            o.retrievedAt,
            o.checksum,
            o.url,
            JSON.stringify(o.payload),
          ],
        );
      for (const set of sets) {
        const storageHash = hash(set);
        const existing = (
          await c.query('SELECT metadata FROM datasets WHERE publication_id=$1 AND key=$2', [
            id,
            set.key,
          ])
        ).rows[0];
        if (existing?.metadata?.storageHash === storageHash) continue;
        await c.query('DELETE FROM publication_dataset_refs WHERE publication_id=$1 AND key=$2', [
          id,
          set.key,
        ]);
        await c.query('DELETE FROM normalized_records WHERE publication_id=$1 AND dataset_key=$2', [
          id,
          set.key,
        ]);
        await c.query('DELETE FROM datasets WHERE publication_id=$1 AND key=$2', [id, set.key]);
        const { items, ...metadata } = set;
        await c.query(
          'INSERT INTO datasets(publication_id,key,schema_name,coverage,verification,evidence_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            id,
            set.key,
            set.schema,
            set.coverage,
            set.verification,
            set.evidenceId,
            JSON.stringify({ ...metadata, storageHash }),
          ],
        );
        for (let offset = 0; offset < items.length; offset += 500) {
          const values = [],
            slots = [];
          for (const [i, payload] of items.slice(offset, offset + 500).entries()) {
            const n = values.length;
            slots.push('(' + [1, 2, 3, 4, 5].map((v) => '$' + (n + v)).join(',') + ')');
            values.push(id, set.key, payload.id, offset + i, JSON.stringify(payload));
          }
          await c.query(
            'INSERT INTO normalized_records(publication_id,dataset_key,id,ordinal,payload) VALUES ' +
              slots.join(','),
            values,
          );
        }
        await c.query(
          'INSERT INTO publication_dataset_refs(publication_id,key,dataset_publication_id) VALUES($1,$2,$1)',
          [id, set.key],
        );
      }
      await c.query('COMMIT');
      this.observations.clear();
      return id;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  }
}
