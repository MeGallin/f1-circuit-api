import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';
import { EnrichmentRepository } from '../src/repositories/enrichment.repository.js';
import { BoundedRawStore } from '../src/storage/bounded-raw-store.js';
import { OpenF1 } from '../src/providers/openf1/client.js';
import { reviewedSessionMapping } from '../src/providers/openf1/session-mapping.js';
import { hash } from '../src/models/dataset.js';

const maxSessions = Number(process.argv[2] || 5);
if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 10)
  throw new Error('The bounded OpenF1 batch must contain 1 to 10 sessions.');

const pool = createPool(loadConfig());
const repo = new EnrichmentRepository(pool, new BoundedRawStore(path.resolve('.cache/openf1-raw')));
try {
  await repo.open({ basePublication: '5d98676d-ede1-41f5-9a85-ce96de4cdb29' });
  const snapshot = await repo.snapshot();
  const sessions = new Map();
  for (const key of await repo.keys('sessions:', snapshot.id))
    for (const session of (await repo.get(key, snapshot.id))?.items || [])
      sessions.set(session.id, session);
  const manifest = JSON.parse(
    await fs.readFile(new URL('../src/providers/openf1/session-mapping.json', import.meta.url)),
  );
  const candidates = Object.values(manifest)
    .sort(
      (a, b) =>
        a.canonicalYear - b.canonicalYear ||
        a.canonicalRound - b.canonicalRound ||
        a.canonicalSessionId.localeCompare(b.canonicalSessionId),
    )
    .filter((mapping) => sessions.has(mapping.canonicalSessionId));
  const selected = [];
  for (const mapping of candidates) {
    if (await repo.get(`laps:${mapping.canonicalSessionId}`)) continue;
    selected.push(mapping);
    if (selected.length >= maxSessions) break;
  }
  const provider = new OpenF1();
  const report = {
    provider: 'openf1',
    status: 'staged-held',
    selected: 0,
    skipped: candidates.length - selected.length,
    sessions: [],
  };
  for (const mapping of selected) {
    const canonical = sessions.get(mapping.canonicalSessionId);
    const event =
      (await repo.get(`event:${canonical.eventId}`, snapshot.id))?.items?.[0]?.event || null;
    const results = await repo.get(`results:${canonical.id}`, snapshot.id);
    const normalized = await provider.detail(
      mapping.openf1SessionKey,
      canonical,
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
      {
        event,
        mapping: reviewedSessionMapping(mapping.canonicalSessionId, mapping.openf1SessionKey),
      },
    );
    for (const observation of normalized.observations)
      await repo.observation({
        id: hash(['openf1', observation.url, observation.payload]),
        provider: 'openf1',
        version: null,
        retrievedAt: observation.retrievedAt,
        checksum: observation.checksum || hash(observation.payload),
        url: observation.url,
        payload: observation.payload,
      });
    await repo.publish(
      normalized.sets,
      {},
      { provider: 'openf1', version: null, jobId: randomUUID() },
    );
    const counts = {};
    for (const set of normalized.sets)
      counts[set.schema] = (counts[set.schema] || 0) + set.items.length;
    report.selected++;
    report.sessions.push({
      canonicalSessionId: mapping.canonicalSessionId,
      openf1SessionKey: mapping.openf1SessionKey,
      datasets: normalized.sets.length,
      counts,
    });
    console.log(
      JSON.stringify({
        status: 'staged-session',
        canonicalSessionId: mapping.canonicalSessionId,
        openf1SessionKey: mapping.openf1SessionKey,
        datasets: normalized.sets.length,
        rows: normalized.sets.reduce((n, set) => n + set.items.length, 0),
      }),
    );
  }
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', type: error.name, message: error.message }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
