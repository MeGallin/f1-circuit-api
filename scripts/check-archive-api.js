import assert from 'node:assert/strict';
import request from 'supertest';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';
import { PublicationRepository } from '../src/repositories/publication.repository.js';
import { createApp } from '../src/app.js';
import { createRouter } from '../src/routes/index.js';
import { operations, validateSchema } from '../src/schemas/contract.js';

const config = loadConfig();
const pool = createPool(config);
try {
  const repository = new PublicationRepository(pool);
  const app = createApp({
    repository,
    config,
    logger: { info() {}, error() {} },
    router: createRouter(repository),
  });
  const results = [];
  for (const year of [1950, 2000, 2024, 2025, 2026]) {
    for (const operationId of ['getCalendar', 'getSeasonSummary', 'getStandings']) {
      const operation = operations.find((op) => op.operationId === operationId);
      const route =
        '/api/v1' + operation.path.replace('{year}', String(year)).replace('{kind}', 'drivers');
      const response = await request(app).get(route);
      assert.equal(response.status, 200);
      const schema = operation.responses['200'].content['application/json'].schema.$ref
        .split('/')
        .at(-1);
      assert.ok(validateSchema(schema, response.body).valid);
      results.push({
        year,
        operation: operationId,
        status: response.status,
        coverage: response.body.meta.coverage,
        records: response.body.data.items?.length ?? 1,
      });
    }
  }
  console.log(JSON.stringify({ status: 'passed', scope: 'current-publication', checks: results }));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', type: error.name }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
