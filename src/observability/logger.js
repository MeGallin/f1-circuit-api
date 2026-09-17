import pino from 'pino';
export const createLogger = (level = 'info') =>
  pino({
    level,
    base: { service: 'f1-circuit-api' },
    redact: ['password', 'token', 'authorization', 'databaseUrl', 'req.headers', 'req.body'],
  });
