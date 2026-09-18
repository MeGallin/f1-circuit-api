import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rootCertificates } from 'node:tls';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';

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
