import fs from 'node:fs/promises';
import newman from 'newman';
import { collection } from './postman-collection.js';
import { appFixture } from '../tests/helpers.js';
const { app } = appFixture();
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const artifact = collection();
await fs.mkdir(new URL('../tests/postman/', import.meta.url), { recursive: true });
await fs.writeFile(
  new URL('../tests/postman/collection.json', import.meta.url),
  JSON.stringify(artifact, null, 2) + '\n',
);
const environment = {
  name: 'F1 Circuit local synthetic tests',
  values: [{ key: 'baseUrl', value: `http://127.0.0.1:${server.address().port}`, enabled: true }],
};
try {
  const summary = await new Promise((resolve, reject) =>
    newman.run(
      { collection: artifact, environment, reporters: [], timeoutRequest: 5000 },
      (error, result) => (error ? reject(error) : resolve(result)),
    ),
  );
  const failures = summary.run.failures.map((f) => ({
    name: f.source?.name,
    message: f.error?.message,
  }));
  const lines = [
    '# Postman / Newman acceptance report',
    '',
    'Environment: loopback-only Express server with a deterministic fictional repository double. No external provider requests, database credentials or production mutations.',
    '',
    '| Request | Status |',
    '|---|---|',
    ...summary.run.executions.map((e) => `| ${e.item.name} | ${e.response?.code || 'failed'} |`),
    '',
    `Requests: ${summary.run.stats.requests.total}. Assertions: ${summary.run.stats.assertions.total}. Failures: ${failures.length}.`,
    '',
    'Coverage: every documented OpenAPI operation, validation, missing resources, pagination, filtering, snapshots, health/readiness and CORS. Unsupported data is explicitly unavailable; a 200 response does not imply every enrichment is implemented. Sync/import are operator CLI commands, not public endpoints.',
    '',
    'Limits: repository double does not verify Supabase connectivity, RLS, PostgreSQL locking, provider availability or container runtime. These require separate integration checks.',
    ...failures.map((f) => `- ${f.name}: ${f.message}`),
  ];
  await fs.writeFile(
    new URL('../docs/POSTMAN-REPORT.md', import.meta.url),
    lines.join('\n') + '\n',
  );
  console.log(
    JSON.stringify({
      runner: 'Newman',
      requests: summary.run.stats.requests.total,
      assertions: summary.run.stats.assertions.total,
      failures,
    }),
  );
  if (failures.length) process.exitCode = 1;
} finally {
  await new Promise((resolve) => server.close(resolve));
}
