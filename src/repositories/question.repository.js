const vectorLiteral = (values) => `[${values.join(',')}]`;

function searchClauses(filters = {}) {
  const clauses = [];
  const values = [];
  const add = (sql, value) => {
    values.push(value);
    clauses.push({ sql: sql.replace('$VALUE', `$${values.length + 3}`), value });
  };
  if (filters.entityType) add('d.entity_type = $VALUE', filters.entityType);
  if (filters.season) add("d.metadata->>'season' = $VALUE", String(filters.season));
  if (filters.eventId) add("d.metadata->>'eventId' = $VALUE", filters.eventId);
  if (filters.driverId) add("d.metadata->>'driverId' = $VALUE", filters.driverId);
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

  async search({ publicationId, query, embedding = null, filters = {}, limit = 12 }) {
    const { clauses, values } = searchClauses(filters);
    const embeddingValue = Array.isArray(embedding) ? vectorLiteral(embedding) : null;
    const params = [
      publicationId,
      query,
      embeddingValue,
      ...values,
      Math.min(Math.max(limit, 1), 50),
    ];
    const filterSql = clauses.length ? `AND ${clauses.map((item) => item.sql).join(' AND ')}` : '';
    const result = await this.pool.query(
      `WITH input AS (
         SELECT websearch_to_tsquery('simple', $2) AS query_text
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
           ts_rank_cd(d.search_text, input.query_text) AS lexical_score,
           CASE
             WHEN $3::vector IS NULL THEN 0
             ELSE 1 - (d.embedding <=> $3::vector)
           END AS semantic_score
         FROM question_documents d, input
         WHERE d.publication_id=$1
           AND ($3::vector IS NOT NULL OR d.search_text @@ input.query_text OR d.content ILIKE '%' || $2 || '%')
           ${filterSql}
       )
       SELECT *, (0.55 * lexical_score + 0.45 * semantic_score) AS score
       FROM scored
       ORDER BY score DESC, title, document_id
       LIMIT $${params.length}`,
      params,
    );
    return result.rows;
  }

  async replacePublicationIndex({ publicationId, documents, embeddingModel, sourceHash }) {
    const client = await this.pool.connect();
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
      await client.query('ROLLBACK');
      await this.pool.query(
        `INSERT INTO question_index_manifests(publication_id,status,embedding_model,source_hash,error_code)
         VALUES($1,'failed',$2,$3,$4)
         ON CONFLICT(publication_id) DO UPDATE SET status='failed',error_code=EXCLUDED.error_code`,
        [publicationId, embeddingModel, sourceHash, error.code || error.message.slice(0, 200)],
      );
      throw error;
    } finally {
      client.release();
    }
  }
}
