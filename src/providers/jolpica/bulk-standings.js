import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { parse } from 'csv-parse/sync';

// Read only known CSV entries from a checksum-pinned ZIP; never extract paths.
export function zipTables(bytes, checksum, names) {
  if (
    !/^[a-f0-9]{64}$/.test(checksum) ||
    createHash('sha256').update(bytes).digest('hex') !== checksum
  )
    throw new Error('Bulk artifact checksum mismatch.');
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) throw new Error('Invalid ZIP directory.');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const tables = {};
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP entry.');
    const flags = bytes.readUInt16LE(offset + 8),
      method = bytes.readUInt16LE(offset + 10),
      compressed = bytes.readUInt32LE(offset + 20),
      size = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28),
      extra = bytes.readUInt16LE(offset + 30),
      comment = bytes.readUInt16LE(offset + 32),
      local = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameSize);
    offset += 46 + nameSize + extra + comment;
    const table = names.find((n) => name === `formula_one_${n}.csv`);
    if (!table) continue;
    if (
      tables[table] ||
      flags & 1 ||
      size > 100_000_000 ||
      ![0, 8].includes(method) ||
      bytes.readUInt32LE(local) !== 0x04034b50
    )
      throw new Error('Unsupported bulk ZIP entry.');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const source = bytes.subarray(start, start + compressed);
    const data = method === 8 ? inflateRawSync(source, { maxOutputLength: 100_000_000 }) : source;
    if (data.length !== size) throw new Error('Bulk entry length mismatch.');
    tables[table] = parse(data.toString('utf8'), { columns: true, skip_empty_lines: true });
  }
  if (names.some((n) => !tables[n])) throw new Error('Missing bulk table.');
  return tables;
}

export class BulkStandings {
  static async load(directory) {
    const metadata = JSON.parse(await fs.readFile(directory + '/metadata.json', 'utf8'));
    const bytes = await fs.readFile(directory + '/dump.zip');
    if (
      bytes.length !== metadata.file_size ||
      new URL(metadata.download_url).origin !== 'https://api.jolpi.ca'
    )
      throw new Error('Invalid bulk manifest.');
    const tables = zipTables(bytes, metadata.file_hash, [
      'driver',
      'team',
      'teamdriver',
      'roundentry',
      'round',
      'driverchampionship',
      'teamchampionship',
    ]);
    return new BulkStandings(tables, metadata);
  }
  constructor(tables, metadata) {
    this.metadata = metadata;
    this.tables = tables;
    const byId = (name) => new Map(tables[name].map((row) => [row.id, row]));
    this.drivers = byId('driver');
    this.teams = byId('team');
    this.rounds = byId('round');
    const teamdrivers = byId('teamdriver');
    this.constructors = new Map();
    for (const entry of tables.roundentry) {
      const td = teamdrivers.get(entry.team_driver_id),
        round = this.rounds.get(entry.round_id);
      if (!td || !round) throw new Error('Unresolved bulk identity.');
      const key = td.driver_id + ':' + td.season_id;
      const map = this.constructors.get(key) || new Map();
      map.set(td.team_id, Math.min(map.get(td.team_id) || Infinity, Number(round.number)));
      this.constructors.set(key, map);
    }
    this.index = new Map();
    for (const [kind, table] of [
      ['drivers', 'driverchampionship'],
      ['constructors', 'teamchampionship'],
    ])
      for (const row of tables[table]) {
        if (!row.round_id) continue;
        const key = `${row.year}:${row.round_number}:${kind}`;
        const rows = this.index.get(key) || [];
        rows.push(row);
        this.index.set(key, rows);
      }
  }
  get(year, round, kind) {
    // Delayed exports never replace current-season live API responses.
    if (year >= new Date(this.metadata.uploaded_at).getUTCFullYear()) return null;
    const raw = this.index.get(`${year}:${round}:${kind}`);
    if (!raw?.length) return null;
    const driver = (d) => ({
      driverId: d.reference,
      givenName: d.forename,
      familyName: d.surname,
      nationality: d.nationality,
      dateOfBirth: d.date_of_birth,
    });
    const team = (t) => ({ constructorId: t.reference, name: t.name, nationality: t.nationality });
    const records = raw
      .map((row) => {
        const identity =
          kind === 'drivers' ? this.drivers.get(row.driver_id) : this.teams.get(row.team_id);
        if (!identity?.reference) throw new Error('Bulk reference identity unavailable.');
        return {
          position: row.position,
          points: row.points,
          wins: row.win_count,
          ...(kind === 'drivers'
            ? {
                Driver: driver(identity),
                Constructors: [
                  ...(this.constructors.get(
                    row.driver_id + ':' + this.rounds.get(row.round_id).season_id,
                  ) || []),
                ]
                  .filter(([, first]) => first <= round)
                  .sort((a, b) => a[1] - b[1])
                  .map(([id]) => {
                    const value = this.teams.get(id);
                    if (!value?.reference)
                      throw new Error('Bulk constructor identity unavailable.');
                    return team(value);
                  }),
              }
            : { Constructor: team(identity) }),
        };
      })
      .sort(
        (a, b) =>
          (a.position ? Number(a.position) : Infinity) -
          (b.position ? Number(b.position) : Infinity),
      );
    if (
      new Set(records.map((r) => r.Driver?.driverId || r.Constructor.constructorId)).size !==
      records.length
    )
      throw new Error('Ambiguous bulk standing identity.');
    const version = 'sha256:' + this.metadata.file_hash;
    return {
      records,
      observation: {
        payload: { artifact: this.metadata.file_hash, year, round, kind, rows: raw },
        url: this.metadata.download_url,
        retrievedAt: this.metadata.uploaded_at,
      },
      provenance: {
        retrievedAt: this.metadata.uploaded_at,
        sources: [
          {
            id: 'jolpica',
            name: 'Jolpica bulk export',
            url: this.metadata.download_url,
            attribution: 'Jolpica F1 / Ergast contributors',
            version,
          },
        ],
      },
    };
  }
}
