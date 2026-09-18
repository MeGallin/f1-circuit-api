import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArchiveCache } from '../src/jobs/archive-cache.js';
import { ProviderHttp } from '../src/providers/http-client.js';
import { ArchiveRepository } from '../src/repositories/archive.repository.js';
import { archiveJolpica } from '../src/jobs/archive.js';
import { syntheticWeekend } from '../fixtures/synthetic-weekend.js';
import { hash } from '../src/models/dataset.js';

test('durable page checkpoints survive restart and failed downloads are retried', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'f1-archive-'));
  let calls = 0;
  const upstream = {
    async get(key) {
      calls++;
      if (key === 'bad' && calls === 2) throw new Error('network');
      return { payload: { key }, retrievedAt: '2024-01-01', url: key };
    },
  };
  try {
    const cache = new ArchiveCache(directory, upstream);
    await cache.get('page1');
    await assert.rejects(cache.get('bad'));
    const resumed = new ArchiveCache(directory, upstream);
    assert.equal((await resumed.get('page1')).payload.key, 'page1');
    await resumed.get('bad');
    assert.equal(calls, 3);
    await fs.writeFile(path.join(directory, hash('page1') + '.json'), '{}');
    await assert.rejects(resumed.get('page1'), /checksum/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('provider retries network failures and honours Retry-After without publishing errors', async () => {
  let calls = 0;
  const waits = [];
  const http = new ProviderHttp({
    baseUrl: 'https://example.invalid/',
    intervalMs: 1,
    wait: async (ms) => waits.push(ms),
    fetcher: async () => {
      calls++;
      if (calls === 1) throw new Error('network');
      if (calls === 2) return new Response('', { status: 429, headers: { 'Retry-After': '120' } });
      return new Response('{"ok":true}');
    },
  });
  assert.equal((await http.get('page')).payload.ok, true);
  assert.equal(calls, 3);
  assert.ok(waits.some((ms) => ms > 119000));
  await assert.rejects(http.get('https://other.invalid/'));
});

test('archive resumes completed rounds and completed batches are idempotent', async () => {
  const fixture = syntheticWeekend();
  const year = Number(fixture.race.season);
  const races = [
    { ...fixture.race, round: '1' },
    { ...fixture.race, round: '2' },
  ];
  let writes = 0,
    fail = true,
    activated = false;
  const repository = {
    batch: { status: 'staging', publication_id: 'stage' },
    steps: new Set(),
    done(key) {
      return this.steps.has(key);
    },
    async activate() {
      activated = true;
      this.batch.status = 'completed';
      return 'stage';
    },
  };
  const provider = {
    async seasons() {
      return { records: [{ season: String(year) }], observations: [] };
    },
    async season() {
      return { records: races, observations: [] };
    },
    async pages() {
      return { records: [], observations: [] };
    },
  };
  const service = {
    async publishSeasonCatalogue() {
      repository.steps.add(repository.step);
    },
    async publish() {
      if (repository.step.includes(':2:') && fail) throw new Error('interruption');
      writes++;
      repository.steps.add(repository.step);
    },
  };
  const args = { provider, repository, service, phase: 'backbone' };
  await assert.rejects(archiveJolpica(args));
  assert.equal(writes, 1);
  assert.equal(activated, false);
  fail = false;
  await archiveJolpica(args);
  assert.equal(writes, 2);
  assert.equal(activated, true);
  await archiveJolpica(args);
  assert.equal(writes, 2);
});

test('staging failure rolls back without checkpoint or public activation', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('INSERT INTO normalized_records')) throw new Error('write failure');
      return { rows: [] };
    },
    release() {
      calls.push('released');
    },
  };
  const repo = new ArchiveRepository({
    async connect() {
      return client;
    },
  });
  Object.assign(repo, {
    batch: { status: 'staging', publication_id: 'stage' },
    batchId: 'batch',
    step: 'round',
    cached: new Map(),
    aliases: new Map(),
    steps: new Set(),
    pendingObservations: new Map(),
    observed: new Set(),
  });
  await assert.rejects(
    repo.publish([{ key: 'test', schema: 'Season', items: [{ id: 'one' }] }], {}),
  );
  assert.ok(calls.includes('ROLLBACK'));
  assert.equal(calls.at(-1), 'released');
  assert.equal(repo.done('round'), false);
  assert.equal(repo.cached.size, 0);
  assert.ok(!calls.some((s) => s.includes('current_publication')));
});
