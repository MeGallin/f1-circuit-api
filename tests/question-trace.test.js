import test from 'node:test';
import assert from 'node:assert/strict';
import { recordQuestionTrace } from '../src/observability/question-trace.js';

test('file tracing is off without an explicit local QA path', async () => {
  let writes = 0;
  assert.equal(
    await recordQuestionTrace({}, null, async () => {
      writes++;
    }),
    false,
  );
  assert.equal(writes, 0);
});

test('opted-in tracing writes only a bounded diagnostic record', async () => {
  let record;
  const path = 'C:/local-qa/question-trace.jsonl';
  assert.equal(
    await recordQuestionTrace(
      {
        requestId: 'request:one',
        text: 'must not be logged',
        apiKey: 'must not be logged',
        operation: 'event_winner',
      },
      path,
      async (_path, value) => {
        record = JSON.parse(value);
      },
    ),
    true,
  );
  assert.equal(record.requestId, 'request:one');
  assert.equal(record.operation, 'event_winner');
  assert.equal('text' in record, false);
  assert.equal('apiKey' in record, false);
});
