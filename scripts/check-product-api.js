import request from 'supertest';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';
import { PublicationRepository } from '../src/repositories/publication.repository.js';
import { createApp } from '../src/app.js';
import { createRouter } from '../src/routes/index.js';
import { operations, validateSchema } from '../src/schemas/contract.js';

const config = loadConfig(),
  pool = createPool(config);
const scope = process.argv[2] || 'public';
const deadline = setTimeout(() => {
  console.log(JSON.stringify({ status: 'verification-timeout', scope }));
  process.exit(1);
}, 120000);
try {
  if (!['public', 'staged'].includes(scope)) throw new Error('Unknown verification scope.');
  const repository = new PublicationRepository(pool);
  if (scope === 'staged') {
    // Private, in-process read-only harness. This does not switch the public pointer
    // or make the unpublished snapshot available through the normal API repository.
    const staged = (
      await pool.query('SELECT publication_id FROM archive_batches WHERE id=$1', [
        'archive-20260918-backbone',
      ])
    ).rows[0];
    if (!staged) throw new Error('No staged archive to inspect.');
    repository.snapshot = async (id) =>
      !id || id === staged.publication_id ? { id: staged.publication_id } : null;
  }
  const snapshot = await repository.snapshot();
  const eventId = await repository.resolve('race:2024:12', snapshot.id);
  const detail = (await repository.get(`event:${eventId}`, snapshot.id)).items[0];
  const race = detail.sessions.find((s) => s.kind === 'race');
  const qualifying = detail.sessions.find((s) => s.kind === 'qualifying');
  const results = (await repository.get(`results:${race.id}`, snapshot.id)).items;
  const driverId = results[0].entry.drivers[0].id;
  const constructorId = results[0].entry.constructor.id;
  const circuitId = detail.event.circuit.id;
  const evidenceId = (await repository.get(`profile:${driverId}`, snapshot.id)).evidenceId;
  const app = createApp({
    repository,
    config,
    logger: { info() {}, error() {} },
    router: createRouter(repository),
  });
  const report = [];
  for (const operation of operations) {
    const ids = {
      year: 2024,
      round: 12,
      kind: 'drivers',
      eventId,
      sessionId: operation.operationId === 'getQualifying' ? qualifying.id : race.id,
      id: operation.path.startsWith('/constructors')
        ? constructorId
        : operation.path.startsWith('/circuits')
          ? circuitId
          : driverId,
      evidenceId,
    };
    const values = {
      q: 'Hamilton',
      entityId: driverId,
      driverId,
      leftId: driverId,
      rightId: results[1].entry.drivers[0].id,
      fromYear: 2024,
      toYear: 2024,
      from: '2024-07-07T14:00:00Z',
      to: '2024-07-07T14:01:00Z',
      scope: 'driver',
      kind: 'driver',
      metric: 'wins',
    };
    const query = { snapshotId: snapshot.id };
    for (const spec of operation.parameters.filter((p) => p.in === 'query' && p.required))
      query[spec.name] = values[spec.name] ?? spec.schema.enum?.[0];
    if (operation.operationId === 'getRecords') query.entityId = driverId;
    if (!operation.parameters.some((p) => p.name === 'snapshotId')) delete query.snapshotId;
    const agent = request(app);
    let req = agent[operation.method](
      '/api/v1' + operation.path.replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(ids[key])),
    ).query(query);
    if (operation.method === 'post')
      req = req.send({
        text: 'Who won?',
        context: { year: 2024, eventId, sessionId: race.id, driverId: null, constructorId: null },
      });
    const response = await req.timeout({ response: 10000, deadline: 15000 });
    const schema = operation.responses['200'].content['application/json'].schema.$ref
      .split('/')
      .at(-1);
    const valid = response.status === 200 && validateSchema(schema, response.body).valid;
    report.push({
      operation: operation.operationId,
      status: response.status,
      valid,
      coverage: response.body.meta?.coverage || null,
      rows: response.body.data?.items?.length ?? null,
    });
  }
  const knownYears = new Set(
    (await repository.get('seasons', snapshot.id)).items.map((s) => s.year),
  );
  const seasons = [];
  for (const year of [1950, 2000, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]) {
    const response = await request(app)
      .get(`/api/v1/seasons/${year}/summary`)
      .timeout({ response: 10000, deadline: 15000 });
    const expectedStatus = knownYears.has(year) ? 200 : 404;
    const valid =
      response.status === expectedStatus &&
      (expectedStatus === 404 || validateSchema('getSeasonSummaryResponse', response.body).valid);
    seasons.push({
      year,
      status: response.status,
      valid,
      completed: response.body.data?.seasonSummary?.season?.completedCount ?? null,
      events: response.body.data?.seasonSummary?.season?.eventCount ?? null,
    });
  }
  console.log(
    JSON.stringify({
      scope: scope === 'staged' ? 'private-staged-read-only-harness' : 'public-snapshot',
      operationsChecked: report.length,
      failedOperations: report.filter((r) => !r.valid),
      seasons,
      failures: [...report, ...seasons].filter((r) => !r.valid).length,
    }),
  );
  if ([...report, ...seasons].some((r) => !r.valid)) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ status: 'verification-failed', type: error.name }));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await pool.end();
}
