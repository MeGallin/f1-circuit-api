import path from 'node:path';
import { EnrichmentRepository } from '../src/repositories/enrichment.repository.js';
import { BoundedRawStore } from '../src/storage/bounded-raw-store.js';
import fs from 'node:fs/promises';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';
import { PublicationRepository } from '../src/repositories/publication.repository.js';
import { SyncService } from '../src/services/sync.service.js';
import { Jolpica } from '../src/providers/jolpica/client.js';
import { readF1db, f1dbWeekend } from '../src/providers/f1db/importer.js';
import { OpenF1 } from '../src/providers/openf1/client.js';
import { reviewedSessionMapping } from '../src/providers/openf1/session-mapping.js';
import { runSync } from '../src/jobs/run-sync.js';
const [provider, ...args] = process.argv.slice(2);
const config = loadConfig();
const pool = createPool(config);
let repository = new PublicationRepository(pool);
let service = new SyncService(repository);
try {
  const result = await runSync(
    pool,
    provider,
    provider === 'f1db' ? 'pinned-archive' : args.slice(0, 2).join(':'),
    async () => {
      let publication;
      if (provider === 'jolpica') {
        if (args[0] === 'seasons')
          publication = await service.publishSeasonCatalogue(await new Jolpica().seasons());
        else {
          const [year, round] = args.map(Number);
          publication = await service.publish(await new Jolpica().weekend(year, round), 'jolpica');
        }
      } else if (provider === 'f1db') {
        const [file, checksum, version, year, round, mappingFile] = args;
        const source = await readF1db(file, checksum, version);
        const mapping = mappingFile ? JSON.parse(await fs.readFile(mappingFile, 'utf8')) : {};
        const bundle = f1dbWeekend(source.payload, Number(year), Number(round), mapping);
        bundle.observations = [source];
        publication = await service.publish(bundle, 'f1db', version);
      } else if (provider === 'openf1') {
        if (!config.openf1Enabled) throw new Error('OpenF1 is disabled.');
        repository = new EnrichmentRepository(
          pool,
          new BoundedRawStore(path.resolve('.cache/openf1-raw')),
        );
        await repository.open({ basePublication: args[2] });
        service = new SyncService(repository);
        const [canonicalId, key] = args;
        const snapshot = await repository.snapshot();
        if (!snapshot) throw new Error('Import the backbone before OpenF1.');
        let session;
        for (const name of await repository.keys('sessions:', snapshot.id)) {
          const d = await repository.get(name, snapshot.id);
          session = d.items.find((x) => x.id === canonicalId);
          if (session) break;
        }
        if (!session) throw new Error('Canonical session is unknown.');
        const mapping = reviewedSessionMapping(canonicalId, Number(key));
        const event = mapping
          ? (await repository.get(`event:${session.eventId}`, snapshot.id))?.items?.[0]?.event
          : null;
        const results = await repository.get(`results:${canonicalId}`, snapshot.id);
        const normalized = await new OpenF1().detail(
          Number(key),
          session,
          (results?.items || []).map((r) => r.entry),
          {
            retrievedAt: new Date().toISOString(),
            sources: [
              {
                id: 'openf1',
                name: 'OpenF1',
                url: 'https://openf1.org',
                attribution: 'OpenF1 contributors',
                version: null,
              },
            ],
          },
          { event, mapping },
        );
        publication = await service.publishSets(normalized, normalized.observations, 'openf1');
      } else throw new Error('Expected jolpica, f1db or openf1.');
      return publication;
    },
  );
  console.log(
    JSON.stringify({
      status: provider === 'openf1' ? 'staged-held' : 'published',
      publication: result,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'failed',
      type: error.name,
      message:
        'Sync failed; no partial publication is activated. Check documented arguments, provider coverage and database configuration.',
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
