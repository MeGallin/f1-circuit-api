import pg from 'pg';
import { readFileSync } from 'node:fs';
export function createPool(config) {
  const url = new URL(config.databaseUrl);
  // pg connection-string SSL parameters must not override certificate verification.
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  const ssl = { rejectUnauthorized: true };
  if (config.databaseSsl && config.databaseSslCaFile) {
    try {
      ssl.ca = readFileSync(config.databaseSslCaFile, 'utf8');
    } catch {
      throw new Error('Database CA certificate file could not be read.');
    }
  }
  return new pg.Pool({
    connectionString: url.toString(),
    max: config.poolSize,
    ssl: config.databaseSsl ? ssl : false,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
  });
}
