import { operations } from '../src/schemas/contract.js';
import { MemoryRepository, exampleRequest, sessionId } from '../tests/helpers.js';
export function collection() {
  const repository = new MemoryRepository();
  const items = [];
  const add = (
    name,
    method,
    path,
    expected,
    { query = {}, body, headers = [], checks = [] } = {},
  ) => {
    const qs = new URLSearchParams(query).toString();
    const raw = '{{baseUrl}}' + path + (qs ? '?' + qs : '');
    items.push({
      name,
      request: {
        method: method.toUpperCase(),
        header: headers,
        url: raw,
        ...(body
          ? {
              body: {
                mode: 'raw',
                raw: JSON.stringify(body),
                options: { raw: { language: 'json' } },
              },
            }
          : {}),
      },
      event: [
        {
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec: [
              `pm.test('HTTP ${expected}', function () { pm.response.to.have.status(${expected}); });`,
              ...checks,
            ],
          },
        },
      ],
    });
  };
  for (const op of operations) {
    const e = exampleRequest(op, repository);
    add(`Success | ${op.operationId}`, op.method, e.path, 200, {
      query: e.query,
      body: op.method === 'post' ? e.body : undefined,
      checks: [
        "pm.test('Contract envelope', function () { const b=pm.response.json(); pm.expect(b).to.have.property('data'); pm.expect(b.meta.snapshotId).to.eql('synthetic-publication'); pm.expect(b.meta.verification).not.to.eql('verified'); });",
      ],
    });
    add(`Validation | ${op.operationId}`, op.method, e.path, 400, {
      query: { ...e.query, unknownParameter: 'invalid' },
      body: op.method === 'post' ? e.body : undefined,
      checks: [
        "pm.test('Safe validation code', function () { pm.expect(pm.response.json().error.code).to.eql('INVALID_REQUEST'); });",
      ],
    });
    if (op.parameters.some((p) => p.in === 'path')) {
      const badPath =
        '/api/v1' +
        op.path.replace(/\{([^}]+)\}/g, (_, key) =>
          key === 'year'
            ? '1949'
            : key === 'round'
              ? '999'
              : key === 'kind'
                ? 'drivers'
                : 'unknown',
        );
      add(
        `Missing resource | ${op.operationId}`,
        op.method,
        badPath,
        badPath.includes('1949') ? 400 : 404,
        { query: e.query },
      );
    }
  }
  add('Health | live', 'get', '/health/live', 200);
  add('Health | ready', 'get', '/health/ready', 200);
  add('CORS | allowed preflight', 'options', '/api/v1/seasons', 204, {
    headers: [
      { key: 'Origin', value: 'https://f1.livenotice.co.uk' },
      { key: 'Access-Control-Request-Method', value: 'GET' },
    ],
    checks: [
      "pm.test('Exact origin and no credentials', function () { pm.expect(pm.response.headers.get('Access-Control-Allow-Origin')).to.eql('https://f1.livenotice.co.uk'); pm.expect(pm.response.headers.has('Access-Control-Allow-Credentials')).to.eql(false); });",
    ],
  });
  add('CORS | denied origin', 'get', '/api/v1/seasons', 403, {
    headers: [{ key: 'Origin', value: 'https://untrusted.invalid' }],
  });
  const path = `/api/v1/sessions/${encodeURIComponent(sessionId)}/results`;
  add('Pagination | first page', 'get', path, 200, {
    query: { limit: 1 },
    checks: [
      "pm.test('First page cursor', function () { const b=pm.response.json(); pm.expect(b.data.items.length).to.eql(1); pm.expect(b.data.page.hasMore).to.eql(true); pm.environment.set('cursor',b.data.page.nextCursor); pm.environment.set('firstId',b.data.items[0].id); });",
    ],
  });
  add('Pagination | next page', 'get', path, 200, {
    query: { limit: 1, cursor: '{{cursor}}' },
    checks: [
      "pm.test('Next page preserves scope', function () { const b=pm.response.json(); pm.expect(b.data.items[0].id).not.to.eql(pm.environment.get('firstId')); pm.expect(b.data.page.hasMore).to.eql(false); });",
    ],
  });
  add('Filtering | driver', 'get', path, 200, {
    query: { driverId: 'driver:example-two' },
    checks: [
      "pm.test('Matching driver only', function () { const rows=pm.response.json().data.items; pm.expect(rows.length).to.eql(1); pm.expect(rows[0].entry.drivers[0].id).to.eql('driver:example-two'); });",
    ],
  });
  add('Snapshot | expired', 'get', path, 409, { query: { snapshotId: 'expired' } });
  add('Validation | invalid limit', 'get', path, 400, { query: { limit: 201 } });
  add(
    'Validation | reversed lap range',
    'get',
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/laps`,
    400,
    { query: { fromLap: 5, toLap: 1 } },
  );
  add('Maintenance | no public sync route', 'post', '/api/v1/sync', 404);
  // Keep Postman variable placeholders unescaped after serializing query strings.
  const result = {
    info: {
      name: 'F1 Circuit API acceptance',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      description:
        'Deterministic fictional fixture acceptance. Run through npm run test:postman; never target production for this collection.',
    },
    item: items,
  };
  return JSON.parse(JSON.stringify(result).replaceAll('%7B%7Bcursor%7D%7D', '{{cursor}}'));
}
