import { loadConfig } from './config/env.js';
import { createPool } from './config/database.js';
import { createLogger } from './observability/logger.js';
import { PublicationRepository } from './repositories/publication.repository.js';
import { createApp } from './app.js';
import { createRouter } from './routes/index.js';
import { createJolpicaSeasonScheduler } from './jobs/current-season-scheduler.js';
import { createJolpicaLatestRaceRefresh } from './jobs/latest-race-refresh.js';
import { Jolpica } from './providers/jolpica/client.js';
import { createQuestionIndexMaintainer } from './jobs/question-index-maintainer.js';
const config = loadConfig();
const logger = createLogger(config.logLevel);
const pool = createPool(config);
pool.on('error', () => logger.error('Idle database connection failed.'));
const repository = new PublicationRepository(pool);
const provider = new Jolpica();
const manualRefresh = createJolpicaLatestRaceRefresh({ pool, repository, provider });
const app = createApp({
  repository,
  config,
  logger,
  router: createRouter(repository, { config, manualRefresh, logger }),
});
const server = app.listen(config.port, () => logger.info({ port: config.port }, 'API listening'));
const scheduler = createJolpicaSeasonScheduler({ pool, repository, config, logger, provider });
const questionIndexMaintainer = createQuestionIndexMaintainer({ pool, repository, config, logger });
server.once('listening', () => {
  scheduler.start();
  questionIndexMaintainer.start();
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  // Best-effort grace for the 30s Ask service budget and cleanup. Snapshot reads
  // precede that service budget; hosting termination limits remain external.
  const timeout = setTimeout(() => {
    logger.error({ code: 'SHUTDOWN_TIMEOUT' }, 'Shutdown grace period exceeded.');
    process.exit(1);
  }, 35000);
  timeout.unref();
  // Refuse new connections immediately while existing requests and both jobs
  // drain concurrently. A job failure must not skip HTTP or pool cleanup.
  const results = await Promise.allSettled([
    new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    Promise.resolve().then(() => scheduler.stop()),
    Promise.resolve().then(() => questionIndexMaintainer.stop()),
  ]);
  let failed = results.some((result) => result.status === 'rejected');
  try {
    await pool.end();
  } catch {
    failed = true;
  }
  if (failed) logger.error({ code: 'SHUTDOWN_FAILED' }, 'Shutdown cleanup failed.');
  clearTimeout(timeout);
  process.exit(failed ? 1 : 0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
