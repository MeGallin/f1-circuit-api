import path from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';
import { migrate } from './migrate.js';
import { runSync } from '../src/jobs/run-sync.js';
import { ArchiveCache } from '../src/jobs/archive-cache.js';
import { archiveJolpica } from '../src/jobs/archive.js';
import { ArchiveRepository } from '../src/repositories/archive.repository.js';
import { SyncService } from '../src/services/sync.service.js';
import { Jolpica } from '../src/providers/jolpica/client.js';
import { ProviderHttp } from '../src/providers/http-client.js';
import { BulkStandings } from '../src/providers/jolpica/bulk-standings.js';

const [phase, runId, bulkDirectory] = process.argv.slice(2);
if (!['backbone', 'laps-pits'].includes(phase) || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(runId || '')) {
  console.error('Usage: node --env-file=.env scripts/archive.js backbone|laps-pits RUN_ID');
  process.exit(1);
}
const pool = createPool(loadConfig());
try {
  await migrate(pool);
  const publication = await runSync(pool, 'archive-jolpica', `${phase}:${runId}`, async () => {
    const repository = new ArchiveRepository(pool);
    await repository.open(`${runId}-${phase}`, phase);
    const bulkStandings = bulkDirectory ? await BulkStandings.load(bulkDirectory) : undefined;
    const provider = new Jolpica(
      new ArchiveCache(
        path.resolve('.cache', 'archive', runId, 'jolpica'),
        new ProviderHttp({ baseUrl: 'https://api.jolpi.ca/ergast/f1/' }),
      ),
    );
    return archiveJolpica({
      provider,
      repository,
      service: new SyncService(repository),
      phase,
      bulkStandings,
      progress: (event) => console.log(JSON.stringify(event)),
    });
  });
  console.log(JSON.stringify({ status: 'published', phase, publication }));
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'paused',
      phase,
      type: error.name,
      code: 'ARCHIVE_RESUMABLE_FAILURE',
      message:
        'No staged partial archive was activated. Re-run the identical command after resolving the failure; completed pages and rounds are retained.',
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
