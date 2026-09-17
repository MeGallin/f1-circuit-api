import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { operations, validateSchema } from '../src/schemas/contract.js';
import { appFixture, exampleRequest, sessionId } from './helpers.js';
test('every documented operation returns its schema with explicit data/coverage', async () => {
  const { app, repository } = appFixture();
  for (const operation of operations) {
    const e = exampleRequest(operation, repository);
    let r = request(app)[operation.method](e.path).query(e.query);
    if (operation.method === 'post') r = r.send(e.body);
    const result = await r;
    assert.equal(result.status, 200, `${operation.operationId}: ${result.text}`);
    const name = operation.responses['200'].content['application/json'].schema.$ref
      .split('/')
      .at(-1);
    assert.ok(validateSchema(name, result.body).valid, operation.operationId);
  }
});
test('pagination/filtering, snapshots, validation and ETag are consistent', async () => {
  const { app } = appFixture();
  const path = `/api/v1/sessions/${encodeURIComponent(sessionId)}/results`;
  const first = await request(app).get(path).query({ limit: 1 }).expect(200);
  assert.equal(first.body.data.items.length, 1);
  assert.equal(first.body.data.page.hasMore, true);
  const second = await request(app)
    .get(path)
    .query({ limit: 1, cursor: first.body.data.page.nextCursor })
    .expect(200);
  assert.notEqual(first.body.data.items[0].id, second.body.data.items[0].id);
  await request(app)
    .get(path)
    .query({ limit: 2, cursor: first.body.data.page.nextCursor })
    .expect(400);
  const filtered = await request(app)
    .get(path)
    .query({ driverId: 'driver:example-two' })
    .expect(200);
  assert.equal(filtered.body.data.items[0].entry.drivers[0].id, 'driver:example-two');
  await request(app).get(path).query({ snapshotId: 'expired' }).expect(409);
  await request(app).get(path).query({ limit: 'NaN' }).expect(400);
  await request(app).get(path).query({ bad: 'x' }).expect(400);
  await request(app)
    .get(path)
    .query({ limit: 1 })
    .set('If-None-Match', first.headers.etag)
    .expect(304);
  await request(app).get('/api/v1/events/unknown').expect(404);
  await request(app).get('/api/v1/sessions/unknown/laps').expect(404);
});
