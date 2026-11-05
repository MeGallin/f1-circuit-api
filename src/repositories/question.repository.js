import {
  QUESTION_EMBEDDING_MODEL,
  QUESTION_EMBEDDING_DIMENSIONS,
  validateEmbedding,
} from '../providers/openai/embeddings.js';
import { buildQuestionDocuments } from '../questions/document-builder.js';
const vectorLiteral = (values) => `[${validateEmbedding(values).join(',')}]`;
// Full names/aliases remain a separate scoring signal. Generic question and
// archive vocabulary must not let every Grand Prix outrank a named driver.
const retrievalStopwords = new Set(
  'a an and are at be between by did do does during earliest first for from grand had has have how in is last latest many most much of on or place position prix race races recent s season seasons take the this to was were what when where which who with won win wins victory victories finish finishes finishing'.split(
    ' ',
  ),
);
const lexicalQuery = (text) =>
  (String(text).match(/[\p{L}\p{N}_]+/gu) || [])
    .filter((word) => !retrievalStopwords.has(word.toLowerCase()))
    .slice(0, 64)
    .join(' OR ');
export const QUESTION_RETRIEVAL_FILTERS = Object.freeze([
  'entityType',
  'season',
  'eventId',
  'driverId',
  'constructorId',
  'circuitId',
  'session',
  'datasetKey',
]);
function validateFilters(filters) {
  if (!filters || Object.keys(filters).some((key) => !QUESTION_RETRIEVAL_FILTERS.includes(key)))
    throw Object.assign(new Error('Unsupported question retrieval filter.'), {
      code: 'QUESTION_FILTER_UNSUPPORTED',
    });
}

function searchClauses(filters = {}) {
  validateFilters(filters);
  const clauses = [];
  const values = [];
  const add = (sql, value) => {
    values.push(value);
    clauses.push({ sql: sql.replace('$VALUE', `$${values.length + 3}`), value });
  };
  if (filters.entityType) add('d.entity_type = $VALUE', filters.entityType);
  if (filters.season)
    add(
      "(d.metadata->>'season' = $VALUE OR (d.entity_type IN ('driver','constructor','circuit') AND d.metadata->>'season' IS NULL))",
      String(filters.season),
    );
  if (filters.eventId) add("d.metadata->>'eventId' = $VALUE", filters.eventId);
  if (filters.driverId) add("d.metadata->>'driverId' = $VALUE", filters.driverId);
  if (filters.constructorId) add("d.metadata->>'constructorId' = $VALUE", filters.constructorId);
  if (filters.circuitId) add("d.metadata->>'circuitId' = $VALUE", filters.circuitId);
  if (filters.session) add("d.metadata->>'session' = $VALUE", filters.session);
  if (filters.datasetKey) add('d.dataset_key = $VALUE', filters.datasetKey);
  return { clauses, values };
}

export class QuestionRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async manifest(publicationId) {
    const result = await this.pool.query(
      'SELECT * FROM question_index_manifests WHERE publication_id=$1',
      [publicationId],
    );
    return result.rows[0] || null;
  }

  async search({
    publicationId,
    query,
    embedding = null,
    embeddingModel = QUESTION_EMBEDDING_MODEL,
    filters = {},
    limit = 12,
  }) {
    if (!publicationId) throw new Error('Question publication is required.');
    if (embedding && embeddingModel !== QUESTION_EMBEDDING_MODEL)
      throw Object.assign(new Error('Incompatible query embedding model.'), {
        code: 'QUESTION_EMBEDDING_INVALID',
      });
    const { clauses, values } = searchClauses(filters);
    const embeddingValue = embedding === null ? null : vectorLiteral(embedding);
    const params = [
      publicationId,
      lexicalQuery(query),
      embeddingValue,
      ...values,
      query,
      Math.min(Math.max(limit, 1), 50),
    ];
    const rawQueryParameter = `$${params.length - 1}`;
    const filterSql = clauses.length ? `AND ${clauses.map((item) => item.sql).join(' AND ')}` : '';
    const result = await this.pool.query(
      `WITH input AS (
         SELECT websearch_to_tsquery('simple', $2) AS query_text
       ), matched_aliases AS MATERIALIZED (
         SELECT DISTINCT canonical_id FROM entity_aliases
         WHERE publication_id=$1 AND length(alias)>=3
           AND strpos(' ' || regexp_replace(lower(${rawQueryParameter}), '[^[:alnum:]]+', ' ', 'g') || ' ', ' ' || lower(alias) || ' ')>0
       ), scored AS (
         SELECT
           d.publication_id,
           d.document_id,
           d.entity_type,
           d.entity_id,
           d.dataset_key,
           d.title,
           d.content,
           d.metadata,
           CASE WHEN length(d.title)>2 AND strpos(lower(${rawQueryParameter}),lower(d.title))>0 THEN 2
             WHEN d.entity_id IN (SELECT canonical_id FROM matched_aliases) THEN 1 ELSE 0 END AS name_score,
           ts_rank_cd(d.search_text, input.query_text) AS lexical_score,
           CASE
             WHEN $3::vector IS NULL THEN 0
             ELSE 1 - (d.embedding <=> $3::vector)
           END AS semantic_score
         FROM question_documents d, input
         WHERE d.publication_id=$1
           AND d.embedding_model='${QUESTION_EMBEDDING_MODEL}'
           AND ($3::vector IS NOT NULL OR d.search_text @@ input.query_text OR d.entity_id IN (SELECT canonical_id FROM matched_aliases))
           ${filterSql}
       )
       SELECT *, (name_score + 0.55 * lexical_score + 0.45 * semantic_score) AS score
       FROM scored
       ORDER BY score DESC, title, document_id
       LIMIT $${params.length}`,
      params,
    );
    return result.rows;
  }

  async lexicalRecords({ publicationId, query, filters = {}, limit = 12 }) {
    validateFilters(filters);
    const values = [publicationId, lexicalQuery(query)];
    const where = [
      'r.publication_id=$1',
      "(starts_with(r.dataset_key,'profile:') OR starts_with(r.dataset_key,'event:') OR starts_with(r.dataset_key,'events:'))",
      "to_tsvector('simple',r.payload::text) @@ websearch_to_tsquery('simple',$2)",
    ];
    const expressions = {
      entityType: "r.payload->>'kind'",
      season: "COALESCE(r.payload->>'year',r.payload#>>'{event,year}')",
      eventId:
        "COALESCE(r.payload#>>'{event,id}',r.payload->>'eventId',CASE WHEN starts_with(r.dataset_key,'event') THEN r.id END)",
      driverId:
        "COALESCE(r.payload#>>'{entry,drivers,0,id}',CASE WHEN r.payload->>'kind'='driver' THEN r.id END)",
      constructorId:
        "COALESCE(r.payload#>>'{entry,constructor,id}',r.payload#>>'{constructor,id}')",
      circuitId: "COALESCE(r.payload#>>'{circuit,id}',r.payload#>>'{event,circuit,id}')",
      session: "r.payload->>'session'",
      datasetKey: 'r.dataset_key',
    };
    for (const [key, value] of Object.entries(filters))
      if (value !== null && value !== undefined) {
        values.push(String(value));
        const equal = `${expressions[key]}=$${values.length}`;
        where.push(
          key === 'season'
            ? `(${equal} OR (r.payload->>'kind' IN ('driver','constructor','circuit') AND ${expressions.season} IS NULL))`
            : equal,
        );
      }
    values.push(Math.min(Math.max(limit, 1), 50));
    const { rows } = await this.pool.query(
      `SELECT r.publication_id,r.dataset_key,r.payload,d.evidence_id,d.coverage FROM normalized_records r JOIN datasets d ON d.publication_id=r.publication_id AND d.key=r.dataset_key WHERE ${where.join(' AND ')} ORDER BY r.dataset_key,r.ordinal,r.id LIMIT $${values.length}`,
      values,
    );
    return rows.flatMap((row) =>
      row.payload
        ? buildQuestionDocuments({
            publicationId,
            sets: [
              {
                key: row.dataset_key,
                items: [row.payload],
                evidenceId: row.evidence_id,
                coverage: row.coverage,
              },
            ],
          }).map((doc) => ({
            ...doc,
            publication_id: publicationId,
            lexical_score: 1,
            semantic_score: 0,
            score: 0.55,
          }))
        : [row],
    );
  }

  async retrieve({ publicationId, text, filters = {}, limit = 16, embeddingClient, deadline }) {
    validateFilters(filters);
    const manifest = await this.manifest(publicationId);
    let reasonCode = !manifest
      ? 'QUESTION_INDEX_MISSING'
      : manifest.embedding_model !== QUESTION_EMBEDDING_MODEL
        ? 'QUESTION_INDEX_INCOMPATIBLE'
        : manifest.status !== 'ready'
          ? 'QUESTION_INDEX_NOT_READY'
          : null;
    if (!reasonCode && embeddingClient) {
      try {
        if (embeddingClient.model !== QUESTION_EMBEDDING_MODEL) throw new Error('incompatible');
        const remaining =
          deadline instanceof Date
            ? deadline.getTime() - Date.now()
            : typeof deadline === 'number'
              ? deadline - Date.now()
              : 10000;
        if (remaining <= 0) throw new Error('deadline');
        const [embedding] = await embeddingClient.embed(text, {
          signal: AbortSignal.timeout(Math.max(1, Math.min(remaining, 10000))),
        });
        validateEmbedding(embedding);
        const candidates = await this.search({
          publicationId,
          query: text,
          embedding,
          filters,
          limit,
        });
        return {
          status: 'semantic',
          candidates,
          reasonCode: null,
          embeddingModel: QUESTION_EMBEDDING_MODEL,
          dimensions: QUESTION_EMBEDDING_DIMENSIONS,
          supportedFilters: QUESTION_RETRIEVAL_FILTERS,
        };
      } catch {
        reasonCode = 'QUESTION_EMBEDDING_UNAVAILABLE';
      }
    }
    let candidates = await this.search({ publicationId, query: text, filters, limit });
    if (!candidates.length)
      candidates = await this.lexicalRecords({ publicationId, query: text, filters, limit });
    return {
      status: 'lexical',
      candidates,
      reasonCode: reasonCode || 'QUESTION_LEXICAL_ONLY',
      embeddingModel: QUESTION_EMBEDDING_MODEL,
      dimensions: QUESTION_EMBEDDING_DIMENSIONS,
      supportedFilters: QUESTION_RETRIEVAL_FILTERS,
    };
  }

  async withIndexLock(handler) {
    const client = await this.pool.connect();
    let locked = false;
    let discard = false;
    try {
      const result = await client.query('SELECT pg_try_advisory_lock(7198405) AS locked');
      locked = result.rows[0]?.locked === true;
      if (!locked) return { status: 'busy' };
      return await handler();
    } finally {
      if (locked)
        try {
          await client.query('SELECT pg_advisory_unlock(7198405)');
        } catch {
          discard = true;
        }
      client.release(discard);
    }
  }

  async reusableEmbeddings(hashes) {
    if (!hashes.length) return [];
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON(content_hash) content_hash,embedding_model,embedding::text AS embedding FROM question_documents WHERE content_hash=ANY($1::text[]) AND embedding_model=$2 ORDER BY content_hash,created_at DESC`,
      [hashes, QUESTION_EMBEDDING_MODEL],
    );
    return rows.map((row) => ({
      ...row,
      embedding: typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding,
    }));
  }

  async integrity(publicationId) {
    const manifest = await this.manifest(publicationId);
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS count,count(*) FILTER(WHERE vector_dims(embedding)<>$2 OR embedding_model<>$3 OR vector_norm(embedding)=0 OR metadata->>'publicationId' IS DISTINCT FROM $1)::int AS invalid FROM question_documents WHERE publication_id=$1`,
      [publicationId, QUESTION_EMBEDDING_DIMENSIONS, QUESTION_EMBEDDING_MODEL],
    );
    const count = rows[0]?.count || 0;
    return {
      valid:
        manifest?.status === 'ready' &&
        manifest.embedding_model === QUESTION_EMBEDDING_MODEL &&
        count > 0 &&
        manifest.document_count === count &&
        rows[0]?.invalid === 0,
      documentCount: count,
      invalidCount: rows[0]?.invalid || 0,
      manifest,
    };
  }

  async recordIndexFailure({
    publicationId,
    embeddingModel = QUESTION_EMBEDDING_MODEL,
    sourceHash = '',
    errorCode = 'QUESTION_INDEX_BUILD_FAILED',
  }) {
    const safeCode = [
      'QUESTION_INDEX_BUILD_FAILED',
      'QUESTION_EMBEDDING_INVALID',
      'QUESTION_INDEX_LIMIT',
      'QUESTION_INDEX_ABORTED',
    ].includes(errorCode)
      ? errorCode
      : 'QUESTION_INDEX_BUILD_FAILED';
    await this.pool.query(
      `INSERT INTO question_index_manifests(publication_id,status,embedding_model,source_hash,error_code,started_at,completed_at) VALUES($1,'failed',$2,$3,$4,now(),now()) ON CONFLICT(publication_id) DO UPDATE SET status=CASE WHEN question_index_manifests.status='ready' THEN 'ready' ELSE 'failed' END,error_code=EXCLUDED.error_code,completed_at=now()`,
      [publicationId, embeddingModel, sourceHash, safeCode],
    );
  }

  async clearIndexFailure(publicationId) {
    await this.pool.query(
      "UPDATE question_index_manifests SET error_code=NULL WHERE publication_id=$1 AND status='ready'",
      [publicationId],
    );
  }

  async replacePublicationIndex({ publicationId, documents, embeddingModel, sourceHash }) {
    if (embeddingModel !== QUESTION_EMBEDDING_MODEL || !documents.length)
      throw Object.assign(new Error('Invalid question index.'), {
        code: 'QUESTION_EMBEDDING_INVALID',
      });
    const ids = new Set();
    for (const document of documents) {
      validateEmbedding(document.embedding);
      if (
        document.embedding_model !== embeddingModel ||
        document.publicationId !== publicationId ||
        document.metadata?.publicationId !== publicationId ||
        ids.has(document.document_id)
      )
        throw Object.assign(new Error('Invalid question index document.'), {
          code: 'QUESTION_EMBEDDING_INVALID',
        });
      ids.add(document.document_id);
    }
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO question_index_manifests(publication_id,status,document_count,embedding_model,source_hash,started_at)
         VALUES($1,'building',0,$2,$3,now())
         ON CONFLICT(publication_id) DO UPDATE SET status='building',document_count=0,
           embedding_model=EXCLUDED.embedding_model,source_hash=EXCLUDED.source_hash,
           error_code=NULL,started_at=now(),completed_at=NULL`,
        [publicationId, embeddingModel, sourceHash],
      );
      await client.query('DELETE FROM question_documents WHERE publication_id=$1', [publicationId]);
      for (let i = 0; i < documents.length; i += 100) {
        const batch = documents.slice(i, i + 100);
        await client.query(
          `INSERT INTO question_documents(
             publication_id,document_id,entity_type,entity_id,dataset_key,title,content,metadata,
             embedding,content_hash,embedding_model
           )
           SELECT $1,x.document_id,x.entity_type,x.entity_id,x.dataset_key,x.title,x.content,
             x.metadata,x.embedding::text::vector,x.content_hash,x.embedding_model
           FROM jsonb_to_recordset($2::jsonb) AS x(
             document_id text,entity_type text,entity_id text,dataset_key text,title text,
             content text,metadata jsonb,embedding jsonb,content_hash text,embedding_model text
           )`,
          [publicationId, JSON.stringify(batch)],
        );
        await client.query(
          'UPDATE question_index_manifests SET document_count=$2 WHERE publication_id=$1',
          [publicationId, i + batch.length],
        );
      }
      await client.query(
        `UPDATE question_index_manifests
         SET status='ready',document_count=$2,completed_at=now()
         WHERE publication_id=$1`,
        [publicationId, documents.length],
      );
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }
}
