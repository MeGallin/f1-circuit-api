import { loadConfig } from './config/env.js';
import { createPool } from './config/database.js';
import { createLogger } from './observability/logger.js';
import { PublicationRepository } from './repositories/publication.repository.js';
import { createApp } from './app.js';
import { createRouter } from './routes/index.js';
const config = loadConfig();
const logger = createLogger(config.logLevel);
const pool = createPool(config);
pool.on('error', () => logger.error('Idle database connection failed.'));
const repository = new PublicationRepository(pool);
const app = createApp({ repository, config, logger, router: createRouter(repository) });
const server = app.listen(config.port, () => logger.info({ port: config.port }, 'API listening'));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 10000);
  timeout.unref();
  server.close(async () => {
    await pool.end();
    clearTimeout(timeout);
    process.exit(0);
  });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
