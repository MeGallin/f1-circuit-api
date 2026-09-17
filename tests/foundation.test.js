import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
const logger = { info() {}, error() {} };
const config = { origins: ['https://f1.livenotice.co.uk', 'http://localhost:5173'] };
test('configuration requires external postgres and exact safe origins', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'file:/database' }), /PostgreSQL/);
  assert.throws(() =>
    loadConfig({ DATABASE_URL: 'postgres://localhost/db', CORS_ALLOWED_ORIGINS: '*' }),
  );
  assert.equal(loadConfig({ DATABASE_URL: 'postgres://localhost/db' }).port, 3001);
});
test('health, readiness, safe errors and allowed/rejected CORS', async () => {
  const app = createApp({
    config,
    logger,
    repository: {
      async ready() {
        return true;
      },
    },
  });
  await request(app).get('/health/live').expect(200);
  await request(app).get('/health/ready').expect(200);
  const missing = await request(app).get('/unknown?token=not-real').expect(404);
  assert.equal(missing.body.error.code, 'RESOURCE_NOT_FOUND');
  await request(app)
    .options('/api/v1/seasons')
    .set('Origin', 'https://f1.livenotice.co.uk')
    .set('Access-Control-Request-Method', 'GET')
    .expect(204)
    .expect('Access-Control-Allow-Origin', 'https://f1.livenotice.co.uk');
  await request(app).get('/health/live').set('Origin', 'https://untrusted.invalid').expect(403);
  const failed = createApp({
    config,
    logger,
    repository: {
      async ready() {
        throw new Error('secret-value');
      },
    },
  });
  const r = await request(failed).get('/health/ready').expect(503);
  assert.ok(!r.text.includes('secret-value'));
});
