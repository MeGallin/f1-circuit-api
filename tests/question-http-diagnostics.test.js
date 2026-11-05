import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Router } from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { readController } from '../src/controllers/read.controller.js';
import { requestLog } from '../src/middleware/http.js';

test('a rejected question response retains safe stage diagnostics without returning invalid content', async () => {
  const errors = [];
  const router = Router();
  router.post(
    '/questions',
    readController(
      {
        async read() {
          return {
            responseSchema: 'askQuestionResponse',
            body: { secretFixture: 'must stay private' },
            questionDiagnostics: {
              operation: 'driver_stat',
              retrievalStatus: 'lexical',
              stages: { executor: 5 },
            },
          };
        },
      },
      {},
    ),
  );
  const app = createApp({
    repository: {},
    config: { origins: [] },
    router,
    logger: {
      info() {},
      error(record) {
        errors.push(record);
      },
    },
  });
  const response = await request(app).post('/api/v1/questions').send({ text: 'fixture' });
  assert.equal(response.status, 500);
  assert.equal(response.headers['x-question-operation'], 'driver_stat');
  assert.match(response.headers['server-timing'], /executor;dur=5/);
  assert.equal(response.body.error.code, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(response.body).includes('must stay private'), false);
  assert.equal(errors[0].failureCode, 'RESPONSE_CONTRACT_INVALID');
  assert.equal(errors[0].responseSchema, 'askQuestionResponse');
});

for (const completed of [false, true])
  test(`request logging records exactly one terminal event (completed=${completed})`, () => {
    const records = [];
    const req = { method: 'POST', route: { path: '/questions' } };
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableFinished: completed,
      setHeader() {},
    });
    requestLog({
      info(record) {
        records.push(record);
      },
    })(req, res, () => {});
    if (completed) res.emit('finish');
    res.emit('close');
    assert.equal(records.length, 1);
    assert.equal(records[0].completed, completed);
    assert.equal(records[0].status, completed ? 200 : null);
    assert.equal(records[0].requestId, req.requestId);
  });
