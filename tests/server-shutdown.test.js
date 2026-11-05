import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the actual shutdown function without importing server startup, which
// would connect to the factual DB/start provider jobs. Native signal delivery
// and hosting termination limits are deliberately outside this fixture.
const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const shutdownSource = source.slice(
  source.indexOf('let stopping = false;'),
  source.indexOf("process.on('SIGTERM'"),
);
function fixture({ job = async () => {}, end = async () => {} } = {}) {
  const calls = [];
  let grace;
  const stop = vm.runInNewContext(`${shutdownSource}\nstop`, {
    server: {
      close(callback) {
        calls.push('close');
        queueMicrotask(() => callback());
      },
    },
    scheduler: {
      async stop() {
        calls.push('scheduler');
        await job();
      },
    },
    questionIndexMaintainer: {
      async stop() {
        calls.push('index');
      },
    },
    pool: {
      async end() {
        calls.push('pool');
        await end();
      },
    },
    logger: {
      error() {
        calls.push('error');
      },
    },
    process: {
      exit(code) {
        calls.push(`exit:${code}`);
      },
    },
    setTimeout(_callback, delay) {
      grace = delay;
      return { unref() {} };
    },
    clearTimeout() {},
  });
  return { stop, calls, grace: () => grace };
}

test('shutdown stops accepting requests before waiting for background jobs and drains before pool end', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const runtime = fixture({ job: () => pending });
  const stopped = runtime.stop();
  try {
    assert.equal(runtime.calls[0], 'close');
    assert.ok(!runtime.calls.includes('pool'));
    assert.ok(runtime.grace() >= 35000, '30s Ask plus bounded pool cleanup must fit');
  } finally {
    release();
    await stopped;
    await new Promise(setImmediate);
  }
  assert.equal(runtime.calls.at(-1), 'exit:0');
  assert.ok(runtime.calls.indexOf('pool') > runtime.calls.indexOf('index'));
});

test('a background stop failure still drains the HTTP server and closes the pool', async () => {
  const runtime = fixture({
    job: async () => {
      throw new Error('private job failure');
    },
  });
  await assert.doesNotReject(runtime.stop());
  assert.ok(runtime.calls.includes('close'));
  assert.ok(runtime.calls.includes('pool'));
  assert.equal(runtime.calls.at(-1), 'exit:1');
});
