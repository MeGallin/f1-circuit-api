import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIEmbeddingClient } from '../src/providers/openai/embeddings.js';

const vector = () => Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
function client(response) {
  const instance = new OpenAIEmbeddingClient({ apiKey: 'fixture' });
  instance.client = {
    embeddings: {
      create: async (request) => {
        assert.equal(request.dimensions, 1536);
        assert.equal(request.model, 'text-embedding-3-small');
        return response;
      },
    },
  };
  return instance;
}
for (const [name, response] of [
  ['partial response', { model: 'text-embedding-3-small', data: [] }],
  ['missing index', { model: 'text-embedding-3-small', data: [{ embedding: vector() }] }],
  ['wrong dimensions', { model: 'text-embedding-3-small', data: [{ index: 0, embedding: [1] }] }],
  [
    'nonfinite vector',
    {
      model: 'text-embedding-3-small',
      data: [{ index: 0, embedding: vector().map(() => Infinity) }],
    },
  ],
  [
    'zero vector',
    { model: 'text-embedding-3-small', data: [{ index: 0, embedding: vector().fill(0) }] },
  ],
  ['wrong model', { model: 'other', data: [{ index: 0, embedding: vector() }] }],
])
  test(`embedding rejects ${name}`, async () => {
    await assert.rejects(client(response).embed('fixture'), { code: 'QUESTION_EMBEDDING_INVALID' });
  });
test('embedding validates unique indices then restores input order', async () => {
  const a = vector();
  const b = vector().map((x) => -x);
  assert.deepEqual(
    await client({
      model: 'text-embedding-3-small',
      data: [
        { index: 1, embedding: b },
        { index: 0, embedding: a },
      ],
    }).embed(['one', 'two']),
    [a, b],
  );
  await assert.rejects(
    client({
      model: 'text-embedding-3-small',
      data: [
        { index: 0, embedding: a },
        { index: 0, embedding: b },
      ],
    }).embed(['one', 'two']),
    { code: 'QUESTION_EMBEDDING_INVALID' },
  );
});
test('embedding refuses incompatible configured model before calling provider', () => {
  assert.throws(
    () => new OpenAIEmbeddingClient({ apiKey: 'fixture', model: 'text-embedding-3-large' }),
    { code: 'QUESTION_EMBEDDING_INVALID' },
  );
});
