import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';
import { EnrichmentRepository } from '../src/repositories/enrichment.repository.js';
import { readF1db, f1dbWeekend } from '../src/providers/f1db/importer.js';
import { normalizeWeekend } from '../src/models/normalization.js';
import { hash } from '../src/models/dataset.js';

const [file, checksum, version, mappingFile, maxArg = '25'] = process.argv.slice(2);
const sourceFile = file || '.cache/f1db-2026.14.0/expanded/f1db.json';
// The release pin covers the downloaded zip; readF1db verifies the extracted
// single-JSON artifact separately so the staged input is still fail-closed.
const sourceChecksum =
  checksum || 'f4872275d077c2d90c753ee8a5bf33b315dd496cd40a5ec1717487fca762ce93';
const sourceVersion = version || '2026.14.0';
const aliasesFile = mappingFile || 'docs/f1db-mapping-2000-2025.json';
const maxRaces = Number(maxArg);
if (!Number.isInteger(maxRaces) || maxRaces < 1 || maxRaces > 50)
  throw new Error('The bounded F1DB batch must contain 1 to 50 races.');

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
  const candidates = source.payload.races
    .filter((race) => race.year >= 2000 && race.year <= 2025)
    .sort((a, b) => a.year - b.year || a.round - b.round);
  const selected = [];
  let skipped = 0;
  for (const race of candidates) {
    const eventId = await repo.resolve(`race:${race.year}:${race.round}`);
    if (!eventId) throw new Error(`Canonical event alias is absent: ${race.year}/${race.round}`);
    const key = `f1db:${race.year}:${race.round}:results:session:${eventId}:race`;
    if (await repo.get(key)) {
      skipped++;
      continue;
    }
    selected.push({ race, eventId });
    if (selected.length >= maxRaces) break;
  }
  const report = {
    provider: 'f1db',
    version: sourceVersion,
    status: 'staged-held',
    selected: 0,
    skipped,
    races: [],
    unresolved: [],
  };
  const batchSets = [];
  for (const { race } of selected) {
    const eventIds = {};
    for (const calendarRace of source.payload.races.filter((x) => x.year === race.year)) {
      const id = await repo.resolve(`race:${race.year}:${calendarRace.round}`);
      if (!id)
        throw new Error(`Canonical event alias is absent: ${race.year}/${calendarRace.round}`);
      eventIds[calendarRace.round] = id;
    }
    const bundle = f1dbWeekend(source.payload, race.year, race.round, mapping, { canonicalIds });
    bundle.eventIds = eventIds;
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
    const normalized = normalizeWeekend(bundle, provenance);
    const namespace = `f1db:${race.year}:${race.round}:`;
    for (const set of normalized.sets) set.key = namespace + set.key;
    batchSets.push(...normalized.sets);
    await repo.observation({
      id: hash(['f1db', source.checksum]),
      provider: 'f1db',
      version: source.version,
      retrievedAt: source.retrievedAt,
      checksum: source.checksum,
      url: source.url,
      payload: {
        artifact: 'f1db-json-single.zip',
        bytes: 6739988,
        checksum: source.checksum,
        releaseAssetChecksum: '4fca2f9d5119a959dd043852b3936fcb452b8eedf50e1c5fa1dc62a2e10a332e',
        release: source.version,
        mappingManifest: aliasesFile,
        scope: { year: race.year, round: race.round },
      },
    });
    const rows = normalized.sets.reduce((sum, set) => sum + set.items.length, 0);
    report.selected++;
    report.races.push({
      year: race.year,
      round: race.round,
      datasets: normalized.sets.length,
      rows,
    });
  }
  const seenDatasetKeys = new Set();
  const seenRecordKeys = new Set();
  for (const set of batchSets) {
    if (seenDatasetKeys.has(set.key))
      throw new Error(`Duplicate F1DB overlay dataset key: ${set.key}`);
    seenDatasetKeys.add(set.key);
    for (const [ordinal, item] of set.items.entries()) {
      const id = item.id || `${set.key}:${ordinal}`;
      const recordKey = `${set.key}:${id}`;
      if (seenRecordKeys.has(recordKey))
        throw new Error(`Duplicate F1DB overlay record key: ${recordKey}`);
      seenRecordKeys.add(recordKey);
    }
  }
  if (batchSets.length)
    await repo.publish(
      batchSets,
      {},
      {
        provider: 'f1db',
        namespace: 'f1db:',
        version: source.version,
        jobId: randomUUID(),
      },
    );
  for (const race of report.races) console.log(JSON.stringify({ status: 'staged-race', ...race }));
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'failed',
      type: error.name,
      message: error.message,
      stack: error.stack,
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
