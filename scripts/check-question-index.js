import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';
import { PublicationRepository } from '../src/repositories/publication.repository.js';
import { QuestionRepository } from '../src/repositories/question.repository.js';
import {
  OpenAIEmbeddingClient,
  QUESTION_EMBEDDING_DIMENSIONS,
  QUESTION_EMBEDDING_MODEL,
} from '../src/providers/openai/embeddings.js';

const config = loadConfig();
const pool = createPool(config);
try {
  const publications = new PublicationRepository(pool);
  const repository = new QuestionRepository(pool);
  const snapshot = await publications.snapshot();
  if (!snapshot) throw new Error('No publication.');
  const integrity = await repository.integrity(snapshot.id);
  if (!integrity.valid) throw new Error('Question index integrity failed.');
  const { rows: groups } = await pool.query(
    `SELECT embedding_model,vector_dims(embedding) AS dimensions,count(*)::int AS count,min(vector_norm(embedding)) AS minimum_norm,max(vector_norm(embedding)) AS maximum_norm FROM question_documents WHERE publication_id=$1 GROUP BY embedding_model,vector_dims(embedding)`,
    [snapshot.id],
  );
  const { rows: metadata } = await pool.query(
    `SELECT count(*) FILTER(WHERE metadata->>'publicationId' IS DISTINCT FROM publication_id)::int AS wrong_publication FROM question_documents WHERE publication_id=$1`,
    [snapshot.id],
  );
  if (
    groups.some(
      (row) =>
        row.embedding_model !== QUESTION_EMBEDDING_MODEL ||
        row.dimensions !== QUESTION_EMBEDDING_DIMENSIONS ||
        !(Number(row.minimum_norm) > 0),
    ) ||
    metadata[0].wrong_publication !== 0
  )
    throw new Error('Incompatible embeddings.');
  if (!config.openaiApiKey) throw new Error('Semantic verification requires configured key.');
  const embedder = new OpenAIEmbeddingClient({
    apiKey: config.openaiApiKey,
    model: config.openaiEmbeddingModel,
    timeoutMs: config.openaiTimeoutMs,
  });
  const samples = [];
  for (const [text, filters] of [
    ["What was Michael Schumacher's most recent Grand Prix?", {}],
    ['Max Verstappen wins in 2023', { season: 2023 }],
    ['Where did the Italian Grand Prix take place in 2022?', { season: 2022 }],
  ]) {
    const result = await repository.retrieve({
      publicationId: snapshot.id,
      text,
      filters,
      embeddingClient: embedder,
      limit: 5,
    });
    if (
      result.status !== 'semantic' ||
      !result.candidates.length ||
      result.candidates.some(
        (row) => row.publication_id !== snapshot.id || !Number.isFinite(Number(row.semantic_score)),
      )
    )
      throw new Error('Semantic verification failed.');
    const expectedId = text.startsWith('What was Michael')
      ? 'driver:michael_schumacher'
      : text.startsWith('Max')
        ? 'driver:max_verstappen'
        : 'event:2022:italian-grand-prix';
    const expectedRank = result.candidates.findIndex((row) => row.entity_id === expectedId) + 1;
    if (
      expectedRank < 1 ||
      (expectedId.startsWith('driver:') ? expectedRank !== 1 : expectedRank > 3)
    )
      throw Object.assign(
        new Error('Expected named entity did not rank in the required candidates.'),
        { code: 'QUESTION_RELEVANCE_FAILED' },
      );
    if (
      filters.season &&
      result.candidates.some(
        (row) => row.metadata.season !== null && Number(row.metadata.season) !== filters.season,
      )
    )
      throw new Error('Season leakage.');
    samples.push({
      text,
      filters,
      status: result.status,
      expectedId,
      expectedRank,
      candidates: result.candidates.map((row) => ({
        publicationId: row.publication_id,
        entityType: row.entity_type,
        entityId: row.entity_id,
        title: row.title,
        season: row.metadata.season,
        lexicalScore: Number(row.lexical_score),
        semanticScore: Number(row.semantic_score),
        score: Number(row.score),
      })),
    });
  }
  const latest = await publications.snapshot();
  console.log(
    JSON.stringify({
      publicationId: snapshot.id,
      currentPublicationId: latest?.id,
      currentUnchanged: latest?.id === snapshot.id,
      status: 'ready',
      documentCount: integrity.documentCount,
      manifest: integrity.manifest,
      groups,
      metadata: metadata[0],
      queryModel: embedder.model,
      queryDimensions: embedder.dimensions,
      samples,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'failed',
      code:
        error.code === 'QUESTION_RELEVANCE_FAILED'
          ? error.code
          : 'QUESTION_INDEX_VERIFICATION_FAILED',
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
