import { PublicationRepository } from '../repositories/publication.repository.js';
import { QuestionRepository } from '../repositories/question.repository.js';
import { QuestionIndexer } from '../questions/question-indexer.js';
import { QUESTION_EMBEDDING_MODEL } from '../providers/openai/embeddings.js';

export function createQuestionIndexMaintainer({
  pool,
  repository = new PublicationRepository(pool),
  config,
  logger,
  intervalMs = 60000,
  indexer,
  questionRepository = new QuestionRepository(pool),
}) {
  const builder =
    indexer ||
    new QuestionIndexer({
      publications: repository,
      repository: questionRepository,
      config,
      logger,
    });
  let timer = null;
  let pending = null;
  let controller = null;
  let stopped = true;
  async function check() {
    if (pending) return pending;
    if (
      config.openaiEnabled === false ||
      config.questionRagEnabled === false ||
      !config.openaiApiKey ||
      config.openaiEmbeddingModel !== QUESTION_EMBEDDING_MODEL
    )
      return { status: 'disabled' };
    controller = new AbortController();
    pending = (async () => {
      try {
        const snapshot = await repository.snapshot();
        if (!snapshot) return { status: 'no-publication' };
        const manifest = await questionRepository.manifest(snapshot.id);
        if (
          manifest?.error_code &&
          Date.now() - new Date(manifest.completed_at || manifest.started_at).getTime() < 900000
        )
          return { status: 'backoff' };
        if (
          manifest?.status === 'ready' &&
          !manifest.error_code &&
          manifest.embedding_model === QUESTION_EMBEDDING_MODEL &&
          (await questionRepository.integrity(snapshot.id)).valid
        )
          return { status: 'ready', publicationId: snapshot.id };
        return await builder.build({ publicationId: snapshot.id, signal: controller.signal });
      } catch {
        logger?.warn?.(
          { code: 'QUESTION_INDEX_BUILD_FAILED' },
          'Question index maintenance deferred',
        );
        return { status: 'failed', reasonCode: 'QUESTION_INDEX_BUILD_FAILED' };
      } finally {
        pending = null;
        controller = null;
      }
    })();
    return pending;
  }
  function schedule() {
    if (stopped) return;
    timer = setTimeout(
      async () => {
        await check();
        schedule();
      },
      Math.max(1000, intervalMs),
    );
    timer.unref?.();
  }
  return {
    check,
    start() {
      if (!stopped) return;
      stopped = false;
      timer = setTimeout(async () => {
        await check();
        schedule();
      }, 0);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      if (pending)
        await Promise.race([
          pending,
          new Promise((resolve) => {
            const timeout = setTimeout(resolve, 5000);
            timeout.unref?.();
          }),
        ]);
    },
  };
}
