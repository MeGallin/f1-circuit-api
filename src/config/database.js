import pg from 'pg';
export function createPool(config) {
  const url = new URL(config.databaseUrl);
  // pg connection-string SSL parameters must not override certificate verification.
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  return new pg.Pool({
    connectionString: url.toString(),
    max: config.poolSize,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
  });
}
