import { buildQuestionDocuments } from './document-builder.js';
import { hash } from '../models/dataset.js';
import {
  OpenAIEmbeddingClient,
  QUESTION_EMBEDDING_MODEL,
  validateEmbedding,
} from '../providers/openai/embeddings.js';

const failure = (code) => Object.assign(new Error('Question index build stopped.'), { code });
const semanticKey = (key) => /^(profile|event|events):/.test(key);

export class QuestionIndexer {
  constructor({
    publications,
    repository,
    embeddingClient,
    config = {},
    batchSize = 64,
    maxDocuments = 10000,
    maxCharacters = 4000000,
    timeoutMs = 240000,
    logger,
  }) {
    this.publications = publications;
    this.repository = repository;
    this.embeddingClient = embeddingClient;
    this.config = config;
    this.batchSize = Math.min(100, Math.max(1, Number.isInteger(batchSize) ? batchSize : 64));
    this.maxDocuments = maxDocuments;
    this.maxCharacters = maxCharacters;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
  }

  async prepare(publicationId, signal) {
    const snapshot = await this.publications.snapshot(publicationId);
    if (!snapshot) throw failure('QUESTION_INDEX_PUBLICATION_MISSING');
    const sets = [];
    if (this.publications.pool) {
      // Read compact dataset metadata/counts in SQL. Never fetch million-row lap
      // datasets into Node merely to construct one coverage document.
      const { rows } = await this.publications.pool.query(
        `SELECT d.*, (SELECT count(*)::int FROM normalized_records r WHERE r.publication_id=d.publication_id AND r.dataset_key=d.key) AS record_count FROM datasets d WHERE d.publication_id=$1 ORDER BY d.key`,
        [snapshot.id],
      );
      for (const row of rows) {
        if (signal?.aborted) throw failure('QUESTION_INDEX_ABORTED');
        if (semanticKey(row.key)) sets.push(await this.publications.get(row.key, snapshot.id));
        else
          sets.push({
            ...row.metadata,
            key: row.key,
            schema: row.schema_name,
            coverage: row.coverage,
            verification: row.verification,
            evidenceId: row.evidence_id,
            recordCount: row.record_count,
            items: [],
          });
      }
    } else {
      const keys = await this.publications.keys('', snapshot.id);
      for (const key of keys) {
        if (signal?.aborted) throw failure('QUESTION_INDEX_ABORTED');
        sets.push(await this.publications.get(key, snapshot.id));
      }
    }
    const documents = buildQuestionDocuments({
      publicationId: snapshot.id,
      sets: sets.filter(Boolean),
    }).sort((a, b) => a.document_id.localeCompare(b.document_id));
    const characters = documents.reduce((sum, doc) => sum + doc.content.length, 0);
    if (
      !documents.length ||
      documents.length > this.maxDocuments ||
      characters > this.maxCharacters
    )
      throw failure('QUESTION_INDEX_LIMIT');
    return {
      publicationId: snapshot.id,
      documents,
      sourceHash: hash(documents.map((doc) => [doc.document_id, doc.content_hash, doc.metadata])),
      documentCount: documents.length,
      characters,
      estimatedTokens: Math.ceil(characters / 3),
    };
  }

  async build({ publicationId, signal, force = false } = {}) {
    return this.repository.withIndexLock(async () => {
      const started = Date.now();
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let prepared;
      let pinnedId = publicationId;
      try {
        // Pin once before reading any dataset. Changes to current_publication
        // during the build never alter the source or destination.
        const snapshot = await this.publications.snapshot(publicationId);
        if (!snapshot) throw failure('QUESTION_INDEX_PUBLICATION_MISSING');
        pinnedId = snapshot.id;
        const manifest = await this.repository.manifest(pinnedId);
        if (
          !force &&
          manifest?.error_code &&
          Date.now() - new Date(manifest.completed_at || manifest.started_at).getTime() < 900000
        )
          return { status: 'backoff', publicationId: pinnedId };
        prepared = await this.prepare(pinnedId, combined);
        if (
          !force &&
          manifest?.status === 'ready' &&
          manifest.embedding_model === QUESTION_EMBEDDING_MODEL &&
          manifest.source_hash === prepared.sourceHash &&
          manifest.document_count === prepared.documents.length &&
          (await this.repository.integrity(pinnedId)).valid
        ) {
          if (manifest.error_code) await this.repository.clearIndexFailure(pinnedId);
          return {
            status: 'unchanged',
            publicationId: pinnedId,
            documentCount: prepared.documentCount,
          };
        }
        const embedder =
          this.embeddingClient ||
          new OpenAIEmbeddingClient({
            apiKey: this.config.openaiApiKey,
            model: this.config.openaiEmbeddingModel,
            timeoutMs: this.config.openaiTimeoutMs,
          });
        if (embedder.model !== QUESTION_EMBEDDING_MODEL)
          throw failure('QUESTION_EMBEDDING_INVALID');
        const reusable = await this.repository.reusableEmbeddings([
          ...new Set(prepared.documents.map((doc) => doc.content_hash)),
        ]);
        const cache = new Map();
        for (const row of reusable) {
          try {
            if (row.embedding_model === QUESTION_EMBEDDING_MODEL)
              cache.set(row.content_hash, validateEmbedding(row.embedding));
          } catch {
            /* Invalid legacy vectors are replaced, never reused. */
          }
        }
        const missing = [
          ...new Map(
            prepared.documents
              .filter((doc) => !cache.has(doc.content_hash))
              .map((doc) => [doc.content_hash, doc]),
          ).values(),
        ];
        let billedTokens = 0;
        this.logger?.info?.(
          {
            publicationId: pinnedId,
            documentCount: prepared.documentCount,
            estimatedTokens: prepared.estimatedTokens,
            missingCount: missing.length,
          },
          'Question index prepared',
        );
        for (let i = 0; i < missing.length; i += this.batchSize) {
          if (combined.aborted) throw failure('QUESTION_INDEX_ABORTED');
          const batch = missing.slice(i, i + this.batchSize);
          const embeddings = await embedder.embed(
            batch.map((doc) => doc.content),
            { signal: combined },
          );
          if (!Array.isArray(embeddings) || embeddings.length !== batch.length)
            throw failure('QUESTION_EMBEDDING_INVALID');
          batch.forEach((doc, index) =>
            cache.set(doc.content_hash, validateEmbedding(embeddings[index])),
          );
          billedTokens += embedder.lastUsage || 0;
        }
        if (combined.aborted) throw failure('QUESTION_INDEX_ABORTED');
        const documents = prepared.documents.map((doc) => ({
          ...doc,
          embedding: cache.get(doc.content_hash),
          embedding_model: QUESTION_EMBEDDING_MODEL,
        }));
        await this.repository.replacePublicationIndex({
          publicationId: pinnedId,
          documents,
          embeddingModel: QUESTION_EMBEDDING_MODEL,
          sourceHash: prepared.sourceHash,
        });
        return {
          status: 'ready',
          publicationId: pinnedId,
          documentCount: documents.length,
          embeddedCount: missing.length,
          reusedCount: documents.length - missing.length,
          embeddingModel: QUESTION_EMBEDDING_MODEL,
          dimensions: 1536,
          estimatedTokens: prepared.estimatedTokens,
          billedTokens,
          durationMs: Date.now() - started,
        };
      } catch (error) {
        if (pinnedId)
          await this.repository.recordIndexFailure({
            publicationId: pinnedId,
            embeddingModel: QUESTION_EMBEDDING_MODEL,
            sourceHash: prepared?.sourceHash || '',
            errorCode: error.code || 'QUESTION_INDEX_BUILD_FAILED',
          });
        throw failure(
          ['QUESTION_EMBEDDING_INVALID', 'QUESTION_INDEX_LIMIT', 'QUESTION_INDEX_ABORTED'].includes(
            error.code,
          )
            ? error.code
            : 'QUESTION_INDEX_BUILD_FAILED',
        );
      }
    });
  }
}
