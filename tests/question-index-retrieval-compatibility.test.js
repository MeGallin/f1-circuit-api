import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionRepository } from '../src/repositories/question.repository.js';
import { buildQuestionDocuments } from '../src/questions/document-builder.js';

test('hybrid ranking excludes question/domain boilerplate and boosts named identities', async () => {
  let observed;
  const repo = new QuestionRepository({
    query: async (sql, args) => {
      observed = { sql, args };
      return { rows: [] };
    },
  });
  const question = "What was Michael Schumacher's most recent Grand Prix?";
  await repo.search({
    publicationId: 'p',
    query: question,
    embedding: Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)),
  });
  assert.ok(!observed.args[1].includes('Grand'));
  assert.ok(!observed.args[1].includes('most'));
  assert.ok(observed.args.includes(question));
  assert.match(observed.sql, /name_score/);
  assert.match(observed.sql, /entity_aliases/);
});

test('lexical fallback tokenizes ordinary question text into candidate alternatives', async () => {
  let observed;
  const repo = new QuestionRepository({
    query: async (sql, args) => {
      observed = { sql, args };
      return { rows: [] };
    },
  });
  await repo.lexicalRecords({
    publicationId: 'p',
    query: 'When was Michael Schumacher last race?',
  });
  assert.match(observed.args[1], /Michael OR Schumacher/);
  assert.equal(observed.args[0], 'p');
});

test('dated dataset summaries own their season and warning changes invalidate vectors', () => {
  const dataset = {
    key: 'results:2023',
    coverage: 'partial',
    items: [],
    warnings: [{ message: 'First warning' }],
  };
  const [a] = buildQuestionDocuments({ publicationId: 'p', sets: [dataset] });
  const [b] = buildQuestionDocuments({
    publicationId: 'p',
    sets: [{ ...dataset, warnings: [{ message: 'Changed warning' }] }],
  });
  assert.equal(a.metadata.season, 2023);
  assert.notEqual(a.content_hash, b.content_hash);
});
test('season SQL preserves timeless identities but never dated rows from another year', async () => {
  let observed;
  const repo = new QuestionRepository({
    query: async (sql, args) => {
      observed = { sql, args };
      return { rows: [] };
    },
  });
  await repo.search({ publicationId: 'p', query: 'Max Verstappen', filters: { season: 2023 } });
  assert.match(
    observed.sql,
    /entity_type IN \('driver','constructor','circuit'\).*season' IS NULL/s,
  );
  assert.match(observed.sql, /metadata->>'season' = \$4/);
  assert.equal(observed.args[3], '2023');
});
test('event and profile metadata support canonical filter ids', () => {
  const docs = buildQuestionDocuments({
    publicationId: 'p',
    sets: [
      { key: 'events:2023', items: [{ id: 'event:2023:test', year: 2023 }] },
      { key: 'profile:driver:fixture', items: [{ id: 'driver:fixture', kind: 'driver' }] },
    ],
  });
  assert.equal(docs[0].metadata.eventId, 'event:2023:test');
  assert.equal(docs[1].metadata.driverId, 'driver:fixture');
});

test('missing index falls back to publication-pinned lexical records without provider call', async () => {
  const calls = [];
  const repo = new QuestionRepository({
    query: async (sql, args) => {
      calls.push({ sql, args });
      if (sql.includes('question_index_manifests')) return { rows: [] };
      if (sql.includes('question_documents')) return { rows: [] };
      return {
        rows: [{ publication_id: 'active', entity_id: 'driver:fixture', title: 'Fixture' }],
      };
    },
  });
  const result = await repo.retrieve({
    publicationId: 'active',
    text: 'Fixture',
    embeddingClient: { embed: () => assert.fail('must not embed missing index') },
  });
  assert.equal(result.status, 'lexical');
  assert.equal(result.reasonCode, 'QUESTION_INDEX_MISSING');
  assert.equal(result.candidates[0].publication_id, 'active');
  assert.ok(calls.find((x) => x.sql.includes('normalized_records') && x.args[0] === 'active'));
});
test('unsupported retrieval filters fail closed', async () => {
  const repo = new QuestionRepository({ query: () => assert.fail('must not run unscoped SQL') });
  await assert.rejects(
    repo.search({ publicationId: 'active', query: 'x', filters: { invented: 'bad' } }),
    { code: 'QUESTION_FILTER_UNSUPPORTED' },
  );
});
test('query rejects malformed vector before SQL', async () => {
  const repo = new QuestionRepository({ query: () => assert.fail('must not send invalid vector') });
  await assert.rejects(repo.search({ publicationId: 'active', query: 'x', embedding: [NaN] }), {
    code: 'QUESTION_EMBEDDING_INVALID',
  });
});
test('model mismatch retrieval uses lexical path without embedding', async () => {
  const repo = new QuestionRepository({
    query: async (sql) => ({
      rows: sql.includes('question_index_manifests')
        ? [{ status: 'ready', embedding_model: 'other' }]
        : [],
    }),
  });
  const result = await repo.retrieve({
    publicationId: 'p',
    text: 'x',
    embeddingClient: { model: 'other', embed: () => assert.fail('incompatible index') },
  });
  assert.equal(result.status, 'lexical');
  assert.equal(result.reasonCode, 'QUESTION_INDEX_INCOMPATIBLE');
});
