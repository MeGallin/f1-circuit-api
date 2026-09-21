import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';
import { PublicationRepository } from '../src/repositories/publication.repository.js';
import { QuestionRepository } from '../src/repositories/question.repository.js';
import { buildQuestionDocuments } from '../src/questions/document-builder.js';
import { OpenAIEmbeddingClient } from '../src/providers/openai/embeddings.js';
import { hash } from '../src/models/dataset.js';

const config = loadConfig();
const pool = createPool(config);

const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const batchSize = Math.min(Math.max(Number(process.env.OPENAI_EMBEDDING_BATCH_SIZE || 64), 1), 100);

async function mapLimit(items, limit, handler) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await handler(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  if (!config.openaiApiKey)
    throw new Error('OPENAI_API_KEY is required to build the question index.');
  const repository = new PublicationRepository(pool);
  const questionRepository = new QuestionRepository(pool);
  const snapshot = await repository.snapshot();
  if (!snapshot) throw new Error('No active publication is available to index.');
  const keys = await repository.keys('', snapshot.id);
  const sets = (await mapLimit(keys, 4, (key) => repository.get(key, snapshot.id))).filter(Boolean);
  const baseDocuments = buildQuestionDocuments({ publicationId: snapshot.id, sets });
  console.log(
    `Preparing ${baseDocuments.length} question documents for publication ${snapshot.id}.`,
  );
  const sourceHash = hash(
    baseDocuments.map(({ content_hash: contentHash, document_id: documentId }) => ({
      contentHash,
      documentId,
    })),
  );
  const embedder = new OpenAIEmbeddingClient({
    apiKey: config.openaiApiKey,
    model: embeddingModel,
    timeoutMs: config.openaiTimeoutMs,
  });
  const documents = [];
  for (let i = 0; i < baseDocuments.length; i += batchSize) {
    const batch = baseDocuments.slice(i, i + batchSize);
    const embeddings = await embedder.embed(batch.map((document) => document.content));
    documents.push(
      ...batch.map((document, index) => ({
        ...document,
        embedding: embeddings[index],
        embedding_model: embeddingModel,
      })),
    );
    console.log(`Embedded ${documents.length}/${baseDocuments.length} question documents.`);
  }
  await questionRepository.replacePublicationIndex({
    publicationId: snapshot.id,
    documents,
    embeddingModel,
    sourceHash,
  });
  console.log(
    JSON.stringify({ publicationId: snapshot.id, documentCount: documents.length, embeddingModel }),
  );
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
