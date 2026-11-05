import { randomUUID } from 'node:crypto';
import { hash } from '../models/dataset.js';
import {
  completeCalendarObservation,
  calendarContentHash,
} from '../questions/calendar-evidence.js';
const WRITE_BATCH_SIZE = 500;

async function insertRows(client, sql, rows, suffix = '') {
  for (let offset = 0; offset < rows.length; offset += WRITE_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + WRITE_BATCH_SIZE);
    const values = batch.map(
      (row, index) =>
        `(${row.map((_, column) => `$${index * row.length + column + 1}`).join(',')})`,
    );
    await client.query(`${sql} VALUES ${values.join(',')} ${suffix}`, batch.flat());
  }
}
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
          "SELECT id,created_at FROM publications WHERE id=$1 AND id NOT IN (SELECT publication_id FROM archive_batches WHERE status='staging') AND id NOT IN (SELECT publication_id FROM archive_activation_holds)",
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
  async getMany(keys, snapshotId) {
    const unique = [...new Set(keys)];
    if (!unique.length) return new Map();
    const placeholders = unique.map((_, index) => `$${index + 2}`).join(',');
    const parameters = [snapshotId, ...unique];
    const { rows } = await this.pool.query(
      `SELECT * FROM datasets WHERE publication_id=$1 AND key IN (${placeholders})`,
      parameters,
    );
    const records = await this.pool.query(
      `SELECT dataset_key,payload FROM normalized_records WHERE publication_id=$1 AND dataset_key IN (${placeholders}) ORDER BY dataset_key,ordinal,id`,
      parameters,
    );
    const result = new Map(
      rows.map((row) => [
        row.key,
        {
          ...row.metadata,
          key: row.key,
          schema: row.schema_name,
          coverage: row.coverage,
          verification: row.verification,
          evidenceId: row.evidence_id,
          items: [],
        },
      ]),
    );
    for (const row of records.rows) result.get(row.dataset_key)?.items.push(row.payload);
    return result;
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
  async calendarProof(year, calendar, snapshotId) {
    const ids = calendar?.provenance?.observationIds;
    if (
      !Number.isInteger(year) ||
      !snapshotId ||
      (ids !== undefined && (!Array.isArray(ids) || ids.length > 64))
    )
      return { complete: false, reasonCode: 'CALENDAR_PROOF_CONTEXT_INVALID' };
    const owned = await this.pool.query(
      'SELECT d.evidence_id,p.created_at FROM datasets d JOIN publications p ON p.id=d.publication_id WHERE d.publication_id=$1 AND d.key=$2 AND d.evidence_id=$3',
      [snapshotId, `events:${year}`, calendar.evidenceId],
    );
    if (!owned.rows.length) return { complete: false, reasonCode: 'CALENDAR_PUBLICATION_MISMATCH' };
    if (ids?.length) {
      const observations = await this.pool.query(
        'SELECT id,provider,retrieved_at,checksum,payload FROM source_observations WHERE id=ANY($1::text[]) AND retrieved_at<=$2',
        [ids, owned.rows[0].created_at],
      );
      const proof = observations.rows.find((observation) =>
        completeCalendarObservation(year, calendar, observation),
      );
      return proof
        ? { complete: true, proofType: 'explicit-reference', observationId: proof.id }
        : { complete: false, reasonCode: 'CALENDAR_COLLECTION_UNPROVEN' };
    }
    const [physical, aliasRows] = await Promise.all([
      this.pool.query(
        'SELECT payload FROM normalized_records WHERE publication_id=$1 AND dataset_key=$2 ORDER BY ordinal,id',
        [snapshotId, `events:${year}`],
      ),
      this.pool.query(
        'SELECT alias,canonical_id FROM entity_aliases WHERE publication_id=$1 AND starts_with(alias,$2)',
        [snapshotId, `race:${year}:`],
      ),
    ]);
    const calendarHash = calendarContentHash(physical.rows.map((row) => row.payload));
    if (calendarHash !== calendarContentHash(calendar.items))
      return { complete: false, reasonCode: 'CALENDAR_CONTENT_MISMATCH' };
    const resultKeys = calendar.items
      .filter((event) => ['completed', 'finished'].includes(event.status))
      .map((event) => `results:session:${event.id}:race`);
    const results = await this.pool.query(
      "SELECT d.key,d.coverage,count(n.id) FILTER (WHERE n.payload->>'sessionId'=substring(d.key from 9))::int AS rows,count(n.id) FILTER (WHERE n.payload->>'sessionId'=substring(d.key from 9) AND n.payload->>'position'='1')::int AS winners FROM datasets d LEFT JOIN normalized_records n ON n.publication_id=d.publication_id AND n.dataset_key=d.key WHERE d.publication_id=$1 AND d.key=ANY($2::text[]) GROUP BY d.key,d.coverage",
      [snapshotId, resultKeys],
    );
    const published = new Set(
      results.rows
        .filter(
          (row) =>
            ['complete', 'partial'].includes(row.coverage) && row.rows > 0 && row.winners === 1,
        )
        .map((row) => row.key),
    );
    const allCompletedResultsPublished =
      resultKeys.length > 0 && resultKeys.every((key) => published.has(key));
    if (!allCompletedResultsPublished)
      return { complete: false, reasonCode: 'CALENDAR_RACE_EVIDENCE_MISSING' };
    const observations = await this.pool.query(
      "SELECT id,provider,retrieved_at,checksum,source_url,payload FROM source_observations WHERE provider='jolpica' AND split_part(source_url,'?',1)=$1 AND retrieved_at<=$2 ORDER BY id LIMIT 32",
      [`https://api.jolpi.ca/ergast/f1/${year}.json`, owned.rows[0].created_at],
    );
    const options = {
      allowContentMatch: true,
      publicationCreatedAt: owned.rows[0].created_at,
      calendarHash,
      aliases: new Map(aliasRows.rows.map((row) => [row.alias, row.canonical_id])),
      allCompletedResultsPublished,
    };
    const proof = observations.rows.find((observation) =>
      completeCalendarObservation(year, calendar, observation, options),
    );
    return proof
      ? {
          complete: true,
          proofType: 'inferred-content-match',
          lineageClaim: false,
          calendarHash,
          observationId: proof.id,
          observationChecksum: proof.checksum,
        }
      : { complete: false, reasonCode: 'CALENDAR_COLLECTION_UNPROVEN' };
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
        await insertRows(
          client,
          'INSERT INTO normalized_records(publication_id,dataset_key,id,ordinal,payload)',
          items.map((item, i) => [
            id,
            set.key,
            item.id || `${set.key}:${i}`,
            i,
            JSON.stringify(item),
          ]),
        );
      }
      await insertRows(
        client,
        'INSERT INTO entity_aliases(publication_id,alias,canonical_id)',
        Object.entries(aliases).map(([alias, canonical]) => [id, alias, canonical]),
        'ON CONFLICT(publication_id,alias) DO UPDATE SET canonical_id=EXCLUDED.canonical_id',
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
