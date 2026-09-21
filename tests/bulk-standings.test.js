import test from 'node:test';
import assert from 'node:assert/strict';
import { BulkStandings, zipTables } from '../src/providers/jolpica/bulk-standings.js';
import { SyncService } from '../src/services/sync.service.js';
import { MemoryRepository } from './helpers.js';
import { syntheticWeekend } from '../fixtures/synthetic-weekend.js';

const metadata = {
  uploaded_at: '2026-08-01T00:00:00Z',
  file_hash: 'a'.repeat(64),
  download_url: 'https://api.jolpi.ca/data/dumps/download/delayed/?dump_type=csv',
};
function source() {
  return new BulkStandings(
    {
      driver: [{ id: 'd', reference: 'sample', forename: 'Sample', surname: 'Driver' }],
      team: [{ id: 't', reference: 'team', name: 'Team' }],
      teamdriver: [{ id: 'td', driver_id: 'd', season_id: 's', team_id: 't' }],
      round: [{ id: 'r', season_id: 's', number: '1' }],
      roundentry: [{ id: 'e', round_id: 'r', team_driver_id: 'td' }],
      driverchampionship: [
        {
          round_id: 'r',
          season_id: '',
          year: '2025',
          round_number: '1',
          position: '1',
          driver_id: 'd',
          points: '12.5',
          win_count: '0',
        },
      ],
      teamchampionship: [],
    },
    metadata,
  );
}
test('bulk standings use explicit references and round season identity with fractional points', () => {
  const bulk = source();
  const result = bulk.get(2025, 1, 'drivers');
  assert.equal(result.records[0].Driver.driverId, 'sample');
  assert.equal(result.records[0].Constructors[0].constructorId, 'team');
  assert.equal(result.records[0].points, '12.5');
  assert.equal(result.provenance.sources[0].version, 'sha256:' + metadata.file_hash);
  assert.equal(bulk.get(2026, 1, 'drivers'), null);
  assert.equal(bulk.get(1950, 1, 'constructors'), null);
  bulk.drivers.get('d').reference = '';
  assert.throws(() => bulk.get(2025, 1, 'drivers'), /identity/);
});
test('bulk reader rejects wrong checksums before touching archive contents', () => {
  assert.throws(() => zipTables(Buffer.from('untrusted'), metadata.file_hash, []), /checksum/);
});

test('bulk standing provenance is retained separately from live API race data', async () => {
  const bundle = syntheticWeekend();
  const bulk = source().get(2025, 1, 'drivers');
  bundle.standingProvenance = { drivers: bulk.provenance };
  const repo = new MemoryRepository();
  await new SyncService(repo).publish(bundle, 'jolpica');
  const standing = repo.sets.get(`standings:${bundle.race.season}:drivers`);
  assert.equal(standing.provenance.sources[0].version, 'sha256:' + metadata.file_hash);
  const result = [...repo.sets.values()].find((s) => s.key.startsWith('results:'));
  assert.equal(result.provenance.sources[0].version, null);
});
