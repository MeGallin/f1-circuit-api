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
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/db', NODE_ENV: 'test' });
  assert.equal(config.port, 3001);
  assert.equal(config.autoSyncEnabled, false);
  assert.equal(config.autoSyncIntervalMs, 900000);
  assert.equal(config.autoSyncGraceMs, 21600000);
  assert.equal(config.autoSyncWindowMs, 86400000);
  assert.equal(config.autoSyncRescanMs, 21600000);
  assert.equal(
    loadConfig({
      DATABASE_URL: 'postgres://localhost/db',
      AUTO_SYNC_ENABLED: 'true',
      AUTO_SYNC_INTERVAL_MS: '1000',
      AUTO_SYNC_GRACE_MS: '21600000',
      AUTO_SYNC_WINDOW_MS: '86400000',
    }).autoSyncEnabled,
    true,
  );
  assert.throws(
    () => loadConfig({ DATABASE_URL: 'postgres://localhost/db', AUTO_SYNC_INTERVAL_MS: '999' }),
    /AUTO_SYNC_INTERVAL_MS/,
  );
  assert.throws(
    () => loadConfig({ DATABASE_URL: 'postgres://localhost/db', AUTO_SYNC_GRACE_MS: '-1' }),
    /AUTO_SYNC_GRACE_MS/,
  );
  assert.throws(
    () => loadConfig({ DATABASE_URL: 'postgres://localhost/db', AUTO_SYNC_WINDOW_MS: '999' }),
    /AUTO_SYNC_WINDOW_MS/,
  );
  assert.throws(
    () => loadConfig({ DATABASE_URL: 'postgres://localhost/db', AUTO_SYNC_RESCAN_MS: '999' }),
    /AUTO_SYNC_RESCAN_MS/,
  );
});

test('public publication configuration exposes timing only, not secrets or a health heartbeat', async () => {
  const app = createApp({
    config: {
      ...config,
      autoSyncEnabled: false,
      autoSyncIntervalMs: 600000,
      autoSyncGraceMs: 7200000,
      autoSyncWindowMs: 28800000,
      autoSyncRescanMs: 21600000,
      databaseUrl: 'postgres://private:secret@host/database',
      openaiApiKey: 'private-key',
    },
    logger,
    repository: { async ready() {} },
  });

  const response = await request(app).get('/api/v1/publication-config').expect(200);
  assert.deepEqual(response.body, {
    automaticRaceResults: {
      enabled: false,
      intervalMs: 600000,
      graceMs: 7200000,
      windowMs: 28800000,
      rescanMs: 21600000,
      anchor: 'scheduled-race-start',
      dateOnlyRacesMonitored: false,
    },
  });
  assert.equal(response.headers['cache-control'], 'public, max-age=60, must-revalidate');
  assert.ok(!response.text.includes('private-key'));
  assert.ok(!response.text.includes('secret'));
  assert.ok(!response.text.includes('healthy'));
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
