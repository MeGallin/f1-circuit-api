import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rootCertificates } from 'node:tls';
import pg from 'pg';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';

for (const query of [
  'ssl=true',
  'ssl=1',
  'ssl=0',
  'ssl=no-verify',
  'ssl=true&ssl=true&sslmode=require&uselibpqcompat=true',
  'sslnegotiation=direct',
  'sslcert=missing&sslkey=missing&sslrootcert=missing&sslmode=no-verify',
]) {
  for (const enabled of [true, false]) {
    test(`effective client TLS follows application config: ${query}, enabled=${enabled}`, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-ca-'));
      const certificate = path.join(directory, 'ca.pem');
      fs.writeFileSync(certificate, rootCertificates[0]);
      let pool;
      try {
        pool = createPool(
          loadConfig({
            DATABASE_URL: `postgres://localhost/postgres?${query}&application_name=tls-regression`,
            DATABASE_SSL: String(enabled),
            DATABASE_SSL_CA_FILE: certificate,
          }),
        );
        // Pool options alone miss the URL parsing performed by pg.Client.
        const client = new pg.Client(pool.options);
        if (enabled) {
          assert.equal(client.connectionParameters.ssl?.rejectUnauthorized, true);
          assert.equal(client.connectionParameters.ssl?.ca === rootCertificates[0], true);
        } else {
          assert.equal(client.connectionParameters.ssl, false);
        }
        assert.equal(client.connectionParameters.application_name, 'tls-regression');
        assert.deepEqual(
          [...new URL(pool.options.connectionString).searchParams.keys()],
          ['application_name'],
        );
      } finally {
        if (pool) await pool.end();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}

test('database CA file preserves verification and rejects URL SSL overrides', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-ca-'));
  const certificate = path.join(directory, 'ca.pem');
  fs.writeFileSync(certificate, rootCertificates[0]);
  let pool;
  try {
    pool = createPool(
      loadConfig({
        DATABASE_URL: 'postgres://localhost/postgres?sslmode=no-verify',
        DATABASE_SSL_CA_FILE: certificate,
      }),
    );
    assert.equal(pool.options.ssl.rejectUnauthorized, true);
    assert.equal(pool.options.ssl.ca, rootCertificates[0]);
    assert.equal(new URL(pool.options.connectionString).searchParams.has('sslmode'), false);
    fs.unlinkSync(certificate);
    assert.throws(
      () =>
        createPool(
          loadConfig({
            DATABASE_URL: 'postgres://localhost/postgres',
            DATABASE_SSL_CA_FILE: certificate,
          }),
        ),
      /Database CA certificate file could not be read/,
    );
  } finally {
    if (pool) await pool.end();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
