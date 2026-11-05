import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionIndexer } from '../src/questions/question-indexer.js';
import { buildQuestionDocuments } from '../src/questions/document-builder.js';

const set = {
  key: 'profile:driver:fixture',
  evidenceId: 'new-evidence',
  items: [{ id: 'driver:fixture', kind: 'driver', entity: { displayName: 'Fixture' } }],
};
const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
function fixture() {
  const state = { saved: null, failure: null, calls: 0, locked: false };
  const publications = {
    snapshot: async () => ({ id: 'new' }),
    keys: async () => [set.key],
    get: async (key, id) => {
      assert.equal(id, 'new');
      return set;
    },
  };
  const repository = {
    withIndexLock: async (fn) => {
      if (state.locked) return { status: 'busy' };
      state.locked = true;
      try {
        return await fn();
      } finally {
        state.locked = false;
      }
    },
    manifest: async () => null,
    reusableEmbeddings: async () => [],
    replacePublicationIndex: async (value) => {
      state.saved = value;
    },
    recordIndexFailure: async (value) => {
      state.failure = value;
    },
  };
  const embeddingClient = {
    model: 'text-embedding-3-small',
    embed: async (inputs) => {
      state.calls++;
      return inputs.map(() => vector);
    },
  };
  return { state, repository, publications, embeddingClient };
}
test('index is snapshot pinned, atomic, and repeated source is idempotent', async () => {
  const f = fixture();
  const indexer = new QuestionIndexer(f);
  const result = await indexer.build();
  assert.equal(result.status, 'ready');
  assert.equal(f.state.saved.publicationId, 'new');
  f.repository.manifest = async () => ({
    status: 'ready',
    embedding_model: 'text-embedding-3-small',
    source_hash: f.state.saved.sourceHash,
    document_count: 1,
  });
  f.repository.integrity = async () => ({ valid: true });
  assert.equal((await indexer.build()).status, 'unchanged');
  assert.equal(f.state.calls, 1);
});
test('concurrent builds acquire lock before any provider work', async () => {
  const f = fixture();
  let resume;
  f.embeddingClient.embed = async () => {
    f.state.calls++;
    await new Promise((r) => {
      resume = r;
    });
    return [vector];
  };
  const indexer = new QuestionIndexer(f);
  const first = indexer.build();
  while (!resume) await new Promise((r) => setImmediate(r));
  assert.equal((await indexer.build()).status, 'busy');
  resume();
  await first;
  assert.equal(f.state.calls, 1);
});
test('failed embed preserves old index and records only stable failure code', async () => {
  const f = fixture();
  f.embeddingClient.embed = async () => {
    throw new Error('secret fixture payload');
  };
  await assert.rejects(new QuestionIndexer(f).build());
  assert.equal(f.state.saved, null);
  assert.equal(f.state.failure.errorCode, 'QUESTION_INDEX_BUILD_FAILED');
  assert.ok(!JSON.stringify(f.state.failure).includes('secret'));
});
test('cross-publication reuse copies only compatible vectors, rebinding metadata/evidence', async () => {
  const f = fixture();
  const [doc] = buildQuestionDocuments({ publicationId: 'new', sets: [set] });
  f.repository.reusableEmbeddings = async () => [
    {
      content_hash: doc.content_hash,
      embedding_model: 'text-embedding-3-small',
      embedding: vector,
      metadata: { publicationId: 'old', evidenceIds: ['old-evidence'] },
    },
  ];
  await new QuestionIndexer(f).build();
  assert.equal(f.state.calls, 0);
  assert.equal(f.state.saved.documents[0].metadata.publicationId, 'new');
  assert.deepEqual(f.state.saved.documents[0].metadata.evidenceIds, ['new-evidence']);
});
test('wrong-sized cached embeddings cannot poison a replacement index', async () => {
  const f = fixture();
  const [doc] = buildQuestionDocuments({ publicationId: 'new', sets: [set] });
  f.repository.reusableEmbeddings = async () => [
    { content_hash: doc.content_hash, embedding_model: 'text-embedding-3-small', embedding: [1] },
  ];
  await new QuestionIndexer(f).build();
  assert.equal(f.state.calls, 1);
});
test('content hashes cover exactly embedded text, independent of evidence/publication', () => {
  const [a] = buildQuestionDocuments({
    publicationId: 'old',
    sets: [{ ...set, evidenceId: 'old-evidence' }],
  });
  const [b] = buildQuestionDocuments({ publicationId: 'new', sets: [set] });
  assert.equal(a.content_hash, b.content_hash);
  assert.equal(b.metadata.publicationId, 'new');
  const [c] = buildQuestionDocuments({
    publicationId: 'new',
    sets: [{ ...set, items: [{ ...set.items[0], entity: { displayName: 'Changed' } }] }],
  });
  assert.notEqual(a.content_hash, c.content_hash);
});

test('successful unchanged retry clears stale durable failure so polling returns to ready', async () => {
  const f = fixture();
  const indexer = new QuestionIndexer(f);
  await indexer.build();
  let cleared = false;
  f.repository.manifest = async () => ({
    status: 'ready',
    embedding_model: 'text-embedding-3-small',
    source_hash: f.state.saved.sourceHash,
    document_count: 1,
    error_code: 'QUESTION_INDEX_BUILD_FAILED',
    completed_at: '2000-01-01T00:00:00Z',
  });
  f.repository.integrity = async () => ({ valid: true });
  f.repository.clearIndexFailure = async (id) => {
    assert.equal(id, 'new');
    cleared = true;
  };
  assert.equal((await indexer.build()).status, 'unchanged');
  assert.equal(cleared, true);
  assert.equal(f.state.calls, 1);
});
