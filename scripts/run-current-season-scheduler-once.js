import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';
import { PublicationRepository } from '../src/repositories/publication.repository.js';
import { Jolpica } from '../src/providers/jolpica/client.js';
import { createJolpicaSeasonScheduler } from '../src/jobs/current-season-scheduler.js';

const config = loadConfig();
if (!config.autoSyncEnabled)
  throw new Error('The one-shot updater requires AUTO_SYNC_ENABLED=true.');

const pool = createPool(config);
const repository = new PublicationRepository(pool);
const provider = new Jolpica();
const scheduler = createJolpicaSeasonScheduler({ pool, repository, config, provider });

try {
  await repository.ready();
  const result = await scheduler.poll();
  if (result.status === 'failed')
    throw new Error(`The one-shot updater failed (${result.error?.code || 'AUTO_SYNC_FAILED'}).`);
  console.log(`One-shot current-season check finished: ${result.status}.`);
} finally {
  await scheduler.stop();
  await pool.end();
}
