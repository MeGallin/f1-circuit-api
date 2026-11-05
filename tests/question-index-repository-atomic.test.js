import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionRepository } from '../src/repositories/question.repository.js';

const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
const document = {
  publicationId: 'new',
  document_id: 'doc',
  embedding_model: 'text-embedding-3-small',
  embedding: vector,
  metadata: { publicationId: 'new' },
};

test('failed rollback discards connection and preserves the original index write failure', async () => {
  const original = new Error('original insert failure');
  let discarded;
  const repo = new QuestionRepository({
    connect: async () => ({
      query: async (sql) => {
        if (sql.includes('INSERT INTO question_documents')) throw original;
        if (sql === 'ROLLBACK') throw new Error('connection lost during rollback');
        return { rows: [] };
      },
      release: (discard) => {
        discarded = discard;
      },
    }),
  });
  await assert.rejects(
    repo.replacePublicationIndex({
      publicationId: 'new',
      documents: [document],
      embeddingModel: 'text-embedding-3-small',
      sourceHash: 'hash',
    }),
    (error) => error === original,
  );
  assert.equal(discarded, true);
});
test('replacement SQL failure rolls back deletion and never publishes ready', async () => {
  const calls = [];
  let released = false;
  const repo = new QuestionRepository({
    connect: async () => ({
      query: async (sql, args) => {
        calls.push({ sql, args });
        if (sql.includes('INSERT INTO question_documents')) throw new Error('fixture SQL failure');
        return { rows: [] };
      },
      release: () => {
        released = true;
      },
    }),
  });
  await assert.rejects(
    repo.replacePublicationIndex({
      publicationId: 'new',
      documents: [document],
      embeddingModel: 'text-embedding-3-small',
      sourceHash: 'hash',
    }),
  );
  assert.equal(calls[0].sql, 'BEGIN');
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
  assert.ok(!calls.some((x) => x.sql === 'COMMIT'));
  assert.equal(released, true);
  assert.deepEqual(calls.find((x) => x.sql.startsWith('DELETE')).args, ['new']);
});
test('cross-publication document is rejected before any SQL mutation', async () => {
  const repo = new QuestionRepository({
    connect: () => assert.fail('must reject wrong publication before transaction'),
  });
  await assert.rejects(
    repo.replacePublicationIndex({
      publicationId: 'new',
      documents: [{ ...document, metadata: { publicationId: 'old' } }],
      embeddingModel: 'text-embedding-3-small',
      sourceHash: 'hash',
    }),
    { code: 'QUESTION_EMBEDDING_INVALID' },
  );
});
test('durable failure manifest uses stable code and retains old ready status', async () => {
  let observed;
  const repo = new QuestionRepository({
    query: async (sql, args) => {
      observed = { sql, args };
      return { rows: [] };
    },
  });
  await repo.recordIndexFailure({ publicationId: 'new', errorCode: 'private payload fixture' });
  assert.equal(observed.args[3], 'QUESTION_INDEX_BUILD_FAILED');
  assert.match(observed.sql, /WHEN question_index_manifests.status='ready' THEN 'ready'/);
  assert.match(observed.sql, /completed_at=now\(\)/);
});
test('advisory lock releases after failed provider work', async () => {
  const calls = [];
  let released;
  const repo = new QuestionRepository({
    connect: async () => ({
      query: async (sql) => {
        calls.push(sql);
        return { rows: [{ locked: true }] };
      },
      release: (discard) => {
        released = discard;
      },
    }),
  });
  await assert.rejects(
    repo.withIndexLock(async () => {
      throw new Error('fixture');
    }),
  );
  assert.match(calls[0], /pg_try_advisory_lock/);
  assert.match(calls[1], /pg_advisory_unlock/);
  assert.equal(released, false);
});
test('advisory unlock failure discards connection without repeating provider work', async () => {
  let discarded = false;
  const repo = new QuestionRepository({
    connect: async () => ({
      query: async (sql) => {
        if (sql.includes('unlock')) throw new Error('fixture');
        return { rows: [{ locked: true }] };
      },
      release: (discard) => {
        discarded = discard;
      },
    }),
  });
  assert.equal(await repo.withIndexLock(async () => 42), 42);
  assert.equal(discarded, true);
});
