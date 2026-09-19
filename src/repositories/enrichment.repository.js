import { randomUUID } from 'node:crypto';
import { PublicationRepository } from './publication.repository.js';
import { hash } from '../models/dataset.js';
const allowedOpenF1 = new Set([
  'Lap',
  'PitStop',
  'Stint',
  'Weather',
  'RaceControl',
  'ProviderStatus',
]);
const allowedF1db = new Set([
  'EventSummary',
  'EventDetail',
  'Session',
  'Classification',
  'Qualifying',
  'Profile',
  'Standing',
  'Season',
  'Layout',
  'Lap',
  'PitStop',
  'ProviderStatus',
]);
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
  async publish(sets, aliases, context = {}) {
    const provider = context.provider || 'openf1';
    const allowed = provider === 'f1db' ? allowedF1db : allowedOpenF1;
    if (provider === 'f1db' && !context.namespace)
      throw new Error('F1DB held overlays require an explicit namespace.');
    if (
      provider === 'f1db' &&
      sets.some((s) => s.schema !== 'Layout' && !s.key.startsWith(context.namespace))
    )
      throw new Error('F1DB held overlays must use their explicit namespace.');
    if (
      provider === 'f1db' &&
      sets.some((s) => s.schema === 'Layout' && !s.key.startsWith('layouts:'))
    )
      throw new Error('F1DB layout projections must use canonical layouts:<circuit> keys.');
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
      const existing = new Map(
        (
          await c.query(
            'SELECT key,metadata FROM datasets WHERE publication_id=$1 AND key=ANY($2::text[])',
            [id, sets.map((set) => set.key)],
          )
        ).rows.map((row) => [row.key, row.metadata]),
      );
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
      const changed = sets.filter((set) => existing.get(set.key)?.storageHash !== hash(set));
      const keys = changed.map((set) => set.key);
      if (keys.length) {
        await c.query(
          'DELETE FROM publication_dataset_refs WHERE publication_id=$1 AND key=ANY($2::text[])',
          [id, keys],
        );
        await c.query(
          'DELETE FROM normalized_records WHERE publication_id=$1 AND dataset_key=ANY($2::text[])',
          [id, keys],
        );
        await c.query('DELETE FROM datasets WHERE publication_id=$1 AND key=ANY($2::text[])', [
          id,
          keys,
        ]);
        const metadata = changed.map((set) => {
          const rest = { ...set };
          delete rest.items;
          return {
            key: rest.key,
            schema: rest.schema,
            coverage: rest.coverage,
            verification: rest.verification,
            evidence: rest.evidenceId,
            metadata: { ...rest, storageHash: hash(set) },
          };
        });
        const datasetValues = [],
          datasetSlots = [];
        for (const row of metadata) {
          const n = datasetValues.length;
          datasetSlots.push('(' + [1, 2, 3, 4, 5, 6, 7].map((v) => '$' + (n + v)).join(',') + ')');
          datasetValues.push(
            id,
            row.key,
            row.schema,
            row.coverage,
            row.verification,
            row.evidence,
            JSON.stringify(row.metadata),
          );
        }
        await c.query(
          'INSERT INTO datasets(publication_id,key,schema_name,coverage,verification,evidence_id,metadata) VALUES ' +
            datasetSlots.join(','),
          datasetValues,
        );
        const rows = changed.flatMap((set) =>
          set.items.map((payload, ordinal) => ({
            key: set.key,
            id: payload.id || `${set.key}:${ordinal}`,
            ordinal,
            payload,
          })),
        );
        for (let offset = 0; offset < rows.length; offset += 1000) {
          const values = [],
            slots = [];
          for (const row of rows.slice(offset, offset + 1000)) {
            const n = values.length;
            slots.push('(' + [1, 2, 3, 4, 5].map((v) => '$' + (n + v)).join(',') + ')');
            values.push(id, row.key, row.id, row.ordinal, JSON.stringify(row.payload));
          }
          await c.query(
            'INSERT INTO normalized_records(publication_id,dataset_key,id,ordinal,payload) VALUES ' +
              slots.join(','),
            values,
          );
        }
        const refValues = [],
          refSlots = [];
        for (const key of keys) {
          const n = refValues.length;
          refSlots.push('(' + [1, 2, 3].map((v) => '$' + (n + v)).join(',') + ')');
          refValues.push(id, key, id);
        }
        await c.query(
          'INSERT INTO publication_dataset_refs(publication_id,key,dataset_publication_id) VALUES ' +
            refSlots.join(','),
          refValues,
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
