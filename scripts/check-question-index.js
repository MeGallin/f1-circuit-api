import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';
import { PublicationRepository } from '../src/repositories/publication.repository.js';
import { QuestionRepository } from '../src/repositories/question.repository.js';
import { OpenAIEmbeddingClient } from '../src/providers/openai/embeddings.js';

const config = loadConfig();
const pool = createPool(config);

async function main() {
  const publicationRepository = new PublicationRepository(pool);
  const questionRepository = new QuestionRepository(pool);
  const snapshot = await publicationRepository.snapshot();
  if (!snapshot) throw new Error('No active publication is available.');
  const manifest = await questionRepository.manifest(snapshot.id);
  const countResult = await pool.query(
    'SELECT count(*)::int AS count FROM question_documents WHERE publication_id=$1',
    [snapshot.id],
  );
  const documentCount = countResult.rows[0]?.count || 0;
  if (!manifest || manifest.status !== 'ready')
    throw new Error(`Question index is not ready: ${manifest?.status || 'missing'}.`);
  if (manifest.document_count !== documentCount)
    throw new Error(
      `Question index manifest count ${manifest.document_count} does not match ${documentCount} documents.`,
    );

  const report = {
    publicationId: snapshot.id,
    status: manifest.status,
    documentCount,
    embeddingModel: manifest.embedding_model,
    semanticSample: null,
  };
  if (config.openaiApiKey) {
    const embedder = new OpenAIEmbeddingClient({
      apiKey: config.openaiApiKey,
      model: config.openaiEmbeddingModel,
      timeoutMs: config.openaiTimeoutMs,
    });
    const query = "What was Michael Schumacher's most recent Grand Prix?";
    const [embedding] = await embedder.embed(query);
    const rows = await questionRepository.search({
      publicationId: snapshot.id,
      query,
      embedding,
      limit: 5,
    });
    report.semanticSample = rows.map((row) => ({
      entityType: row.entity_type,
      entityId: row.entity_id,
      title: row.title,
      score: Number(row.score),
    }));
    if (!rows.length) throw new Error('Question index returned no semantic candidates.');
  }
  console.log(JSON.stringify(report));
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
