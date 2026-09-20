export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be a valid port.');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  let database;
  try {
    database = new URL(env.DATABASE_URL);
  } catch {
    throw new Error('DATABASE_URL is invalid.');
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol))
    throw new Error('A PostgreSQL DATABASE_URL is required.');
  const origins = (
    env.CORS_ALLOWED_ORIGINS ||
    'https://f1.livenotice.co.uk,http://localhost:5173,http://127.0.0.1:5173'
  )
    .split(',')
    .map((s) => s.trim());
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !['https:', 'http:'].includes(url.protocol))
      throw new Error('CORS origins must be exact HTTP origins.');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname))
      throw new Error('Non-local origins require HTTPS.');
  }
  if (env.NODE_ENV === 'production' && env.DATABASE_SSL === 'false')
    throw new Error('Production database connections require TLS.');
  return {
    port,
    databaseUrl: env.DATABASE_URL,
    databaseSsl: env.DATABASE_SSL !== 'false',
    databaseSslCaFile: env.DATABASE_SSL_CA_FILE || null,
    origins,
    logLevel: env.LOG_LEVEL || 'info',
    production: env.NODE_ENV === 'production',
    openf1Enabled: env.OPENF1_ENABLED === 'true',
    openaiEnabled: env.OPENAI_ENABLED === 'true',
    openaiApiKey: env.OPENAI_API_KEY || null,
    openaiModel: env.OPENAI_MODEL || 'gpt-4o-mini',
    openaiTimeoutMs: Number(env.OPENAI_TIMEOUT_MS || 10000),
    poolSize: 5,
  };
}
