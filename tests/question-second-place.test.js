import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { appFixture } from './helpers.js';

test('second-place leaderboard questions use the published result-position intent', async () => {
  const { app } = appFixture();
  const questions = [
    'Which racing driver has had the most second-place finishes?',
    'Which driver has finished second most often in Formula 1?',
    'Who has the most second places?',
  ];

  for (const text of questions) {
    const response = await request(app).post('/api/v1/questions').send({ text }).expect(200);
    const result = response.body.data.questionResult;
    assert.equal(result.status, 'answered', text);
    assert.equal(result.resolvedIntent, 'driver_second_place_finishes', text);
    assert.equal(result.templateKey, 'driver_second_place_finishes', text);
    assert.equal(result.values.driver, 'Example Two', text);
    assert.equal(result.values.count, 1, text);
    assert.equal(result.values.coverage, 'partial', text);
    assert.ok(result.evidenceIds.length, text);
    assert.equal('matches' in result.values, false, text);
  }
});

test('second-place leaderboard reports unavailable when result positions are not published', async () => {
  const { app, repository } = appFixture();
  for (const key of await repository.keys('results:')) repository.sets.delete(key);

  const response = await request(app)
    .post('/api/v1/questions')
    .send({ text: 'Which driver has the most second-place finishes?' })
    .expect(200);
  const result = response.body.data.questionResult;
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reasonCode, 'SECOND_PLACE_RESULTS_NOT_PUBLISHED');
});
