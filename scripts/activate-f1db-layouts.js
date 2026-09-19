import fs from 'node:fs/promises';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';
import { readF1db, f1dbLayouts } from '../src/providers/f1db/importer.js';
import { normalizeLayouts } from '../src/models/normalization.js';
import { hash } from '../src/models/dataset.js';

const [file, checksum, version, mappingFile] = process.argv.slice(2);
const sourceFile = file || '.cache/f1db-2026.14.0/expanded/f1db.json';
const sourceChecksum =
  checksum || 'f4872275d077c2d90c753ee8a5bf33b315dd496cd40a5ec1717487fca762ce93';
const sourceVersion = version || '2026.14.0';
const aliasesFile = mappingFile || 'docs/f1db-mapping-2000-2025.json';
const expectedCircuits = 38;
const expectedRows = 60;
const storageLimit = 450 * 1024 * 1024;

const pool = createPool(loadConfig());
try {
  const source = await readF1db(sourceFile, sourceChecksum, sourceVersion);
  const mapping = JSON.parse(await fs.readFile(aliasesFile, 'utf8'));
  const currentRow = (
    await pool.query('SELECT publication_id FROM current_publication WHERE singleton=1')
  ).rows[0];
  if (!currentRow) throw new Error('No active publication is available.');
  const current = currentRow.publication_id;

  const gate = (
    await pool.query(
      `SELECT b.id,b.status,b.publication_id
         FROM archive_batches b
        WHERE b.id='archive-20260918-backbone'
          AND b.phase='backbone'`,
    )
  ).rows[0];
  if (!gate || gate.status !== 'completed' || gate.publication_id !== current)
    throw new Error('The completed scoped archive is not the active publication.');
  if (
    !(
      await pool.query(
        `SELECT 1 FROM archive_steps
          WHERE batch_id='archive-20260918-backbone'
            AND key='scope:2000:coverage-finalized'`,
      )
    ).rows.length
  )
    throw new Error('The 2000-inclusive archive scope has not been finalized.');
  if ((await pool.query("SELECT 1 FROM archive_batches WHERE status='staging'")).rows.length)
    throw new Error('A staging archive is present; layout activation is paused.');
  if (
    (await pool.query('SELECT 1 FROM archive_activation_holds WHERE publication_id=$1', [current]))
      .rows.length
  )
    throw new Error('The active publication is held; layout activation is paused.');

  const canonicalIds = { driver: new Set(), constructor: new Set(), circuit: new Set() };
  const profiles = await pool.query(
    `SELECT n.payload->>'kind' AS kind,n.payload->'entity'->>'id' AS id
       FROM datasets d
       JOIN normalized_records n ON n.publication_id=d.publication_id AND n.dataset_key=d.key
      WHERE d.publication_id=$1 AND d.key LIKE 'profile:%'`,
    [current],
  );
  for (const row of profiles.rows)
    if (canonicalIds[row.kind] && row.id) canonicalIds[row.kind].add(row.id);

  const projection = f1dbLayouts(source.payload, mapping, {
    version: source.version,
    canonicalIds,
    fromYear: 2000,
    toYear: 2025,
    strict: true,
  });
  if (projection.coverage.approvedCircuits !== expectedCircuits)
    throw new Error(`Expected ${expectedCircuits} approved circuits.`);
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
  const rows = sets.reduce((sum, set) => sum + set.items.length, 0);
  if (sets.length !== expectedCircuits || rows !== expectedRows)
    throw new Error(`Expected ${expectedCircuits} layout datasets and ${expectedRows} rows.`);
  for (const set of sets)
    for (const item of set.items) {
      if (set.schema !== 'Layout' || !set.key.startsWith('layouts:'))
        throw new Error('Layout activation contains an unsupported dataset key.');
      if (item.licence !== 'CC BY 4.0' || item.attribution !== 'F1DB contributors — CC BY 4.0')
        throw new Error('Layout attribution or licence is not the reviewed F1DB value.');
      if (
        !item.assetUrl.startsWith(`https://raw.githubusercontent.com/f1db/f1db/v${source.version}/`)
      )
        throw new Error('Layout asset is outside the pinned F1DB release.');
    }

  const existing = await pool.query(
    `SELECT count(*)::int AS datasets,
            coalesce(sum((SELECT count(*) FROM normalized_records n
                           WHERE n.publication_id=d.publication_id AND n.dataset_key=d.key)),0)::int AS records
       FROM datasets d
      WHERE d.publication_id=$1 AND d.schema_name='Layout'`,
    [current],
  );
  if (existing.rows[0].datasets || existing.rows[0].records)
    throw new Error(
      'The active publication already contains Layout rows; refusing a partial replacement.',
    );

  const storage = Number(
    (await pool.query('SELECT pg_database_size(current_database())::text AS bytes')).rows[0].bytes,
  );
  const reserve = Buffer.byteLength(JSON.stringify(sets)) * 4;
  if (storage + reserve >= storageLimit)
    throw new Error('Database storage budget reached before layout activation.');

  const observation = {
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
      activation: 'additive-public-layouts',
    },
  };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7198401)');
    const activeAgain = (
      await client.query('SELECT publication_id FROM current_publication WHERE singleton=1')
    ).rows[0]?.publication_id;
    if (activeAgain !== current)
      throw new Error('The active publication changed during activation.');
    if (
      (
        await client.query('SELECT 1 FROM archive_activation_holds WHERE publication_id=$1', [
          current,
        ])
      ).rows.length
    )
      throw new Error('The active publication became held during activation.');
    if (
      (
        await client.query(
          "SELECT 1 FROM datasets WHERE publication_id=$1 AND schema_name='Layout' LIMIT 1",
          [current],
        )
      ).rows.length
    )
      throw new Error('Layout rows appeared during activation; no changes were committed.');

    await client.query(
      'INSERT INTO source_observations(id,provider,source_version,retrieved_at,checksum,source_url,payload) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
      [
        observation.id,
        observation.provider,
        observation.version,
        observation.retrievedAt,
        observation.checksum,
        observation.url,
        JSON.stringify(observation.payload),
      ],
    );
    for (const set of sets) {
      const { items, ...metadata } = set;
      await client.query(
        'INSERT INTO datasets(publication_id,key,schema_name,coverage,verification,evidence_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          current,
          set.key,
          set.schema,
          set.coverage,
          set.verification,
          set.evidenceId,
          JSON.stringify(metadata),
        ],
      );
      for (let ordinal = 0; ordinal < items.length; ordinal++) {
        const item = items[ordinal];
        await client.query(
          'INSERT INTO normalized_records(publication_id,dataset_key,id,ordinal,payload) VALUES($1,$2,$3,$4,$5)',
          [current, set.key, item.id, ordinal, JSON.stringify(item)],
        );
      }
    }
    const manifests = (
      await client.query(
        'SELECT key,evidence_id FROM datasets WHERE publication_id=$1 ORDER BY key',
        [current],
      )
    ).rows;
    await client.query('UPDATE publications SET content_hash=$2 WHERE id=$1', [
      current,
      hash(manifests),
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  console.log(
    JSON.stringify({
      status: 'layouts-activated',
      activePublication: current,
      source: { version: source.version, checksum: source.checksum },
      coverage: projection.coverage,
      datasets: sets.length,
      rows,
      continuing: false,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({ status: 'activation-failed', type: error.name, message: error.message }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
