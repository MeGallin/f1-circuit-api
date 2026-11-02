import test from 'node:test';
import assert from 'node:assert/strict';
import { runCurrentSeasonCheck } from '../src/jobs/run-current-season-check.js';

test('one-shot keeps primary structured failure and attempts both independent cleanup steps', async () => {
  const errors = [];
  const calls = [];
  const exitCode = await runCurrentSeasonCheck({
    repository: {
      async ready() {
        calls.push('ready');
      },
    },
    scheduler: {
      async poll() {
        return {
          status: 'failed',
          year: 2026,
          round: 19,
          error: Object.assign(new Error('Standing failed\npassword=private'), {
            code: 'NORMALIZED_SCHEMA_INVALID',
          }),
        };
      },
      async stop() {
        calls.push('stop');
        throw new Error('stop failed token=private');
      },
    },
    pool: {
      async end() {
        calls.push('end');
        throw new Error('end failed postgres://user:private@host/db');
      },
    },
    output: {
      error(value) {
        errors.push(JSON.parse(value));
      },
      log() {
        assert.fail('failed run logged success');
      },
    },
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(calls, ['ready', 'stop', 'end']);
  assert.equal(errors.length, 3);
  assert.deepEqual(errors[0], {
    event: 'scheduler.poll',
    status: 'failed',
    year: 2026,
    round: 19,
    error: { code: 'NORMALIZED_SCHEMA_INVALID', message: 'Standing failed password=[REDACTED]' },
  });
  assert.doesNotMatch(JSON.stringify(errors), /private|[\\]n/);
});

test('one-shot success/read failure both close resources with correct exit status', async () => {
  for (const failRead of [false, true]) {
    let closed = false;
    let polls = 0;
    const errors = [];
    const logs = [];
    const exitCode = await runCurrentSeasonCheck({
      repository: {
        async ready() {
          if (failRead) throw new Error('read failed token=private');
        },
      },
      scheduler: {
        async poll() {
          polls++;
          return { status: 'scheduled' };
        },
        async stop() {},
      },
      pool: {
        async end() {
          closed = true;
        },
      },
      output: {
        error(value) {
          errors.push(JSON.parse(value));
        },
        log(value) {
          logs.push(value);
        },
      },
    });
    assert.equal(exitCode, failRead ? 1 : 0);
    assert.equal(closed, true);
    assert.equal(polls, failRead ? 0 : 1);
    assert.equal(errors.length, failRead ? 1 : 0);
    assert.equal(logs.length, failRead ? 0 : 1);
    assert.doesNotMatch(JSON.stringify(errors), /private/);
  }
});
