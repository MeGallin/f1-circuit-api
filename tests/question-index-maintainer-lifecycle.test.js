import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuestionIndexMaintainer } from '../src/jobs/question-index-maintainer.js';

for (const disabled of ['openaiEnabled', 'questionRagEnabled'])
  test(`maintainer honors ${disabled}=false`, async () => {
    const job = createQuestionIndexMaintainer({
      config: {
        openaiEnabled: true,
        questionRagEnabled: true,
        [disabled]: false,
        openaiApiKey: 'fixture',
        openaiEmbeddingModel: 'text-embedding-3-small',
      },
      repository: { snapshot: () => assert.fail('disabled job must not poll or embed') },
    });
    assert.equal((await job.check()).status, 'disabled');
    await job.stop();
  });

test('maintainer discovers new publication and skips ready publication without provider work', async () => {
  let publication = 'old';
  let builds = 0;
  const maintainer = createQuestionIndexMaintainer({
    repository: { snapshot: async () => ({ id: publication }) },
    config: { openaiApiKey: 'fixture', openaiEmbeddingModel: 'text-embedding-3-small' },
    questionRepository: {
      integrity: async () => ({ valid: true }),
      manifest: async (id) =>
        id === 'old' ? { status: 'ready', embedding_model: 'text-embedding-3-small' } : null,
    },
    indexer: {
      build: async ({ publicationId }) => {
        builds++;
        assert.equal(publicationId, 'new');
        return { status: 'ready' };
      },
    },
  });
  assert.equal((await maintainer.check()).status, 'ready');
  assert.equal(builds, 0);
  publication = 'new';
  assert.equal((await maintainer.check()).status, 'ready');
  assert.equal(builds, 1);
  await maintainer.stop();
});
test('failed manifests back off across independent maintainer instances', async () => {
  const options = {
    repository: { snapshot: async () => ({ id: 'p' }) },
    config: { openaiApiKey: 'fixture', openaiEmbeddingModel: 'text-embedding-3-small' },
    questionRepository: {
      manifest: async () => ({
        status: 'failed',
        error_code: 'QUESTION_INDEX_BUILD_FAILED',
        completed_at: new Date().toISOString(),
      }),
    },
    indexer: { build: () => assert.fail('must not retry before durable backoff') },
  };
  for (let i = 0; i < 2; i++) {
    const job = createQuestionIndexMaintainer(options);
    assert.equal((await job.check()).status, 'backoff');
    await job.stop();
  }
});
test('maintainer stop aborts ongoing provider work', async () => {
  let aborted = false;
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const job = createQuestionIndexMaintainer({
    repository: { snapshot: async () => ({ id: 'p' }) },
    config: { openaiApiKey: 'fixture', openaiEmbeddingModel: 'text-embedding-3-small' },
    questionRepository: { manifest: async () => null },
    indexer: {
      build: async ({ signal }) => {
        entered();
        await new Promise((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
        return { status: 'aborted' };
      },
    },
  });
  const pending = job.check();
  await ready;
  await job.stop();
  await pending;
  assert.equal(aborted, true);
});

test('ready manifest with missing physical documents is repaired without trusting status alone', async () => {
  let builds = 0;
  const job = createQuestionIndexMaintainer({
    repository: { snapshot: async () => ({ id: 'p' }) },
    config: { openaiApiKey: 'fixture', openaiEmbeddingModel: 'text-embedding-3-small' },
    questionRepository: {
      manifest: async () => ({ status: 'ready', embedding_model: 'text-embedding-3-small' }),
      integrity: async () => ({ valid: false }),
    },
    indexer: {
      build: async () => {
        builds++;
        return { status: 'ready' };
      },
    },
  });
  await job.check();
  assert.equal(builds, 1);
  await job.stop();
});
