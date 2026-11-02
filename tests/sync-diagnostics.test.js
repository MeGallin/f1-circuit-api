import test from 'node:test';
import assert from 'node:assert/strict';
import { safeSyncError, schedulerOutcome } from '../src/observability/sync-error.js';
import { runSync } from '../src/jobs/run-sync.js';
import { ProviderHttp } from '../src/providers/http-client.js';
import { Jolpica } from '../src/providers/jolpica/client.js';

test('sync diagnostics retain bounded context without credentials, controls or arbitrary properties', () => {
  const error = Object.assign(
    new Error(
      'HTTP failure\npostgres://user:secret@host/db?token=hidden Authorization: Bearer private-token password="private value" -----BEGIN PRIVATE KEY-----\nprivatepem\n-----END PRIVATE KEY----- ' +
        'x'.repeat(1000),
    ),
    { code: 'PROVIDER_HTTP_ERROR', stack: 'private-stack', token: 'private-token' },
  );
  const result = schedulerOutcome({ status: 'failed', year: 2026, round: 19, error });
  assert.equal(result.error.code, 'PROVIDER_HTTP_ERROR');
  assert.equal(result.year, 2026);
  assert.equal(result.round, 19);
  assert.ok(result.error.message.length <= 500);
  assert.doesNotMatch(JSON.stringify(result), /secret|hidden|private|[\\]n/);
  assert.equal(safeSyncError({ code: 'bad\nsecret', message: 'failed' }).code, 'SYNC_FAILED');
  assert.equal(safeSyncError({ code: '57014', message: 'statement timeout' }).code, '57014');
  const jsonSecrets = safeSyncError({
    message:
      '{"token":"private-json", "password":"private-password"}\r\napi_key=private-key\u2028failed',
  });
  assert.doesNotMatch(jsonSecrets.message, /private|[\r\n\u2028]/);
});

test('audit retains stable root code and never replaces cause with secondary audit/unlock errors', async () => {
  for (const secondary of ['none', 'audit', 'unlock']) {
    const root = Object.assign(new Error('provider failed'), { code: 'PROVIDER_HTTP_ERROR' });
    const cleanup = new Error('secondary');
    let audit;
    let released;
    const client = {
      async query(sql, values) {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
        if (sql.includes("status='failed'")) {
          audit = values;
          if (secondary === 'audit') throw cleanup;
        }
        if (sql.includes('pg_advisory_unlock') && secondary === 'unlock') throw cleanup;
        return { rows: [] };
      },
      release(error) {
        released = error;
      },
    };
    await assert.rejects(
      runSync({ connect: async () => client }, 'jolpica', '2026:19', async () => {
        throw root;
      }),
      (error) => error === root,
    );
    assert.equal(audit[1], 'PROVIDER_HTTP_ERROR');
    assert.equal(released, secondary === 'unlock' ? cleanup : undefined);
  }
});

test('HTTP failures use stable classes and safe endpoint context without response bodies', async () => {
  for (const [status, code] of [
    [403, 'PROVIDER_HTTP_ERROR'],
    [429, 'PROVIDER_UNAVAILABLE'],
    [503, 'PROVIDER_UNAVAILABLE'],
  ]) {
    const http = new ProviderHttp({
      baseUrl: 'https://example.invalid/',
      intervalMs: 0,
      maxAttempts: 1,
      fetcher: async () => new Response('private-body', { status }),
    });
    await assert.rejects(http.get('2026/19/results.json?token=private-token'), (error) => {
      assert.equal(error.code, code);
      assert.match(error.message, /2026\/19\/results\.json/);
      assert.doesNotMatch(error.message, /private|token|https:/);
      return true;
    });
  }
});

test('provider schema/pagination errors are classified and optional failures retain safe details', async () => {
  const provider = new Jolpica({
    get: async () => ({ payload: { MRData: { total: '1', RaceTable: { Races: [] } } } }),
  });
  await assert.rejects(provider.pages('2026/19/results', 'RaceTable', 'Races', 'Results'), {
    code: 'PROVIDER_PAGINATION_ERROR',
  });
  provider.http.get = async () => ({ payload: {} });
  await assert.rejects(provider.pages('2026/19/results', 'RaceTable', 'Races', 'Results'), {
    code: 'PROVIDER_SCHEMA_ERROR',
  });
  const race = { season: '2026', round: '19' };
  provider.season = async () => ({ records: [race], observations: [] });
  provider.pages = async (path) => {
    if (path.endsWith('/results')) return { records: [{ Results: [{}] }], observations: [] };
    throw Object.assign(new Error('HTTP 503\npassword=private'), { code: 'PROVIDER_UNAVAILABLE' });
  };
  const bundle = await provider.weekend(2026, 19);
  assert.equal(bundle.failureDetails.length, 6);
  assert.equal(bundle.failureDetails[0].endpoint, 'standings:drivers');
  assert.equal(bundle.failureDetails[0].code, 'PROVIDER_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(bundle.failureDetails), /private|[\\]n/);
});
