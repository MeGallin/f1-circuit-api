import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheSnapshot } from '../src/repositories/snapshot-cache.js';

test('refresh cache batches duplicate keys and never crosses publication boundaries', async () => {
  const calls = [];
  const repository = {
    async getMany(keys, id) {
      calls.push(['batch', keys, id]);
      return new Map([['results', { items: [{ id: 'old-result' }] }]]);
    },
    async get(key, id) {
      calls.push(['get', key, id]);
      return { items: [{ id: `${id}:${key}` }] };
    },
  };
  const cached = await cacheSnapshot(repository, 'old-publication', [
    'results',
    'missing',
    'results',
  ]);
  assert.equal((await cached.get('results', 'old-publication')).items[0].id, 'old-result');
  assert.equal(await cached.get('missing', 'old-publication'), null);
  assert.equal(
    (await cached.get('results', 'new-publication')).items[0].id,
    'new-publication:results',
  );
  await cached.get('extra', 'old-publication');
  await cached.get('extra', 'old-publication');
  assert.deepEqual(calls, [
    ['batch', ['results', 'missing'], 'old-publication'],
    ['get', 'results', 'new-publication'],
    ['get', 'extra', 'old-publication'],
  ]);
});
