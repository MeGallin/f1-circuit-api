import fs from 'node:fs/promises';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';
import { runSync } from '../src/jobs/run-sync.js';
import { ArchiveRepository } from '../src/repositories/archive.repository.js';
import { finalizeScope } from '../src/jobs/finalize-scope.js';
const runId = process.argv[2];
if (runId !== 'archive-20260918') throw new Error('Expected existing scoped archive run.');
const pool = createPool(loadConfig());
try {
  await runSync(pool, 'scope-review', '2000:' + runId, async () => {
    for (const file of await fs.readdir('.cache/archive/' + runId + '/jolpica')) {
      if (!file.endsWith('.json')) continue;
      const saved = JSON.parse(
        await fs.readFile('.cache/archive/' + runId + '/jolpica/' + file, 'utf8'),
      );
      const year = saved.key.match(/^(\d{4})\//);
      if (year && Number(year[1]) < 2000)
        throw new Error('Out-of-scope retrieval requires review.');
    }
    const repository = new ArchiveRepository(pool);
    await repository.open(runId + '-backbone', 'backbone');
    const report = await finalizeScope(repository);
    console.log(JSON.stringify({ status: 'scoped-finalized-held', ...report }));
    return repository.batch.publication_id;
  });
} catch (error) {
  console.log(JSON.stringify({ status: 'scope-review-failed', type: error.name }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
