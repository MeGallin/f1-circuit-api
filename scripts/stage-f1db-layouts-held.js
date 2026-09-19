import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';
import { EnrichmentRepository } from '../src/repositories/enrichment.repository.js';
import { f1dbLayouts, readF1db } from '../src/providers/f1db/importer.js';
import { normalizeLayouts } from '../src/models/normalization.js';
import { hash } from '../src/models/dataset.js';

const [file, checksum, version, mappingFile] = process.argv.slice(2);
const sourceFile = file || '.cache/f1db-2026.14.0/expanded/f1db.json';
const sourceChecksum =
  checksum || 'f4872275d077c2d90c753ee8a5bf33b315dd496cd40a5ec1717487fca762ce93';
const sourceVersion = version || '2026.14.0';
const aliasesFile = mappingFile || 'docs/f1db-mapping-2000-2025.json';

const pool = createPool(loadConfig());
const rawDescriptorStore = { write: async () => ({ storage: 'database-descriptor' }) };
const repo = new EnrichmentRepository(pool, rawDescriptorStore);
try {
  const source = await readF1db(sourceFile, sourceChecksum, sourceVersion);
  const mapping = JSON.parse(await fs.readFile(aliasesFile, 'utf8'));
  await repo.open({ basePublication: '5d98676d-ede1-41f5-9a85-ce96de4cdb29' });
  const snapshot = await repo.snapshot();
  const canonicalIds = { driver: new Set(), constructor: new Set(), circuit: new Set() };
  const profileRows = await pool.query(
    `SELECT n.payload->>'kind' AS kind,n.payload->'entity'->>'id' AS id
       FROM publication_dataset_refs r
       JOIN normalized_records n ON n.publication_id=r.dataset_publication_id AND n.dataset_key=r.key
      WHERE r.publication_id=$1 AND r.key LIKE 'profile:%'`,
    [snapshot.id],
  );
  for (const row of profileRows.rows)
    if (canonicalIds[row.kind] && row.id) canonicalIds[row.kind].add(row.id);

  const projection = f1dbLayouts(source.payload, mapping, {
    version: source.version,
    canonicalIds,
    fromYear: 2000,
    toYear: 2025,
  });
  const provenance = {
    retrievedAt: source.retrievedAt,
    sources: [
      {
        id: 'f1db',
        name: 'F1DB',
        url: source.url,
        attribution: 'F1DB contributors — CC BY 4.0',
        version: source.version,
      },
    ],
  };
  const sets = normalizeLayouts(projection, provenance);
  const existing = new Set();
  for (const set of sets) {
    if (existing.has(set.key)) throw new Error(`Duplicate F1DB layout dataset key: ${set.key}`);
    existing.add(set.key);
  }
  if (sets.length) {
    await repo.observation({
      id: hash(['f1db', source.checksum, 'layouts']),
      provider: 'f1db',
      version: source.version,
      retrievedAt: source.retrievedAt,
      checksum: source.checksum,
      url: source.url,
      payload: {
        artifact: 'f1db-json-single.zip',
        checksum: source.checksum,
        release: source.version,
        mappingManifest: aliasesFile,
        scope: { fromYear: 2000, toYear: 2025 },
        projection: projection.coverage,
        missing: projection.missing,
      },
    });
    await repo.publish(
      sets,
      {},
      {
        provider: 'f1db',
        namespace: 'f1db:',
        version: source.version,
        jobId: randomUUID(),
      },
    );
  }
  console.log(
    JSON.stringify({
      status: 'staged-layouts-held',
      source: { version: source.version, checksum: source.checksum },
      coverage: projection.coverage,
      missing: projection.missing,
      datasets: sets.length,
      continuing: false,
    }),
  );
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', type: error.name, message: error.message }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
