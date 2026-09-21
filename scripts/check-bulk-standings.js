import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { BulkStandings } from '../src/providers/jolpica/bulk-standings.js';

const [directory, cacheDirectory] = process.argv.slice(2);
try {
  const bulk = await BulkStandings.load(directory);
  const groups = new Map();
  for (const name of await fs.readdir(cacheDirectory)) {
    if (!name.endsWith('.json')) continue;
    const saved = JSON.parse(await fs.readFile(path.join(cacheDirectory, name), 'utf8'));
    const match = saved.key.match(/^(\d{4})\/(\d+)\/(driverstandings|constructorstandings)\.json/);
    if (!match || Number(match[1]) >= new Date(bulk.metadata.uploaded_at).getUTCFullYear())
      continue;
    const kind = match[3] === 'driverstandings' ? 'drivers' : 'constructors';
    const key = `${match[1]}:${match[2]}:${kind}`;
    const group = groups.get(key) || {
      year: Number(match[1]),
      round: Number(match[2]),
      kind,
      rows: [],
      total: Number(saved.response.payload.MRData.total),
    };
    const field = kind === 'drivers' ? 'DriverStandings' : 'ConstructorStandings';
    group.rows.push(
      ...saved.response.payload.MRData.StandingsTable.StandingsLists.flatMap((r) => r[field] || []),
    );
    groups.set(key, group);
  }
  const shape = (rows) =>
    rows
      .map((r) => ({
        id: r.Driver?.driverId || r.Constructor?.constructorId,
        position: r.position || null,
        points: String(Number(r.points)),
        wins: String(r.wins),
        constructors: r.Constructors?.map((c) => c.constructorId) || [],
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  let matched = 0,
    fallback = 0,
    incompleteCache = 0;
  const mismatches = [];
  for (const group of groups.values()) {
    if (group.rows.length !== group.total) {
      incompleteCache++;
      continue;
    }
    const result = bulk.get(group.year, group.round, group.kind);
    if (!result) {
      fallback++;
      continue;
    }
    if (isDeepStrictEqual(shape(group.rows), shape(result.records))) matched++;
    else mismatches.push({ year: group.year, round: group.round, kind: group.kind });
  }
  if (!matched || mismatches.length) process.exitCode = 1;
  console.log(
    JSON.stringify({
      status: process.exitCode ? 'failed' : 'passed',
      matched,
      mismatches,
      fallback,
      incompleteCache,
    }),
  );
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', type: error.name }));
  process.exitCode = 1;
}
