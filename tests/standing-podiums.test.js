import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { MemoryRepository, appFixture } from './helpers.js';
import { hash } from '../src/models/dataset.js';

function fixture() {
  const repo = new MemoryRepository();
  const template = repo.sets.get('standings:2024:drivers').items[0];
  const raw = [...repo.sets.values()].find((set) => set.schema === 'Classification').items[0];
  const set = (items) => ({ items, coverage: 'partial', verification: 'source-only' });
  const standing = (id, round) => ({
    ...template,
    id: `standing:${id}`,
    entity: { ...template.entity, id },
    standingSnapshotId: `standing:2024:${round}`,
    podiums: null,
  });
  repo.sets = new Map([['seasons', set([{ year: 2024 }])]]);
  for (const kind of ['drivers', 'constructors']) {
    const ids = kind === 'drivers' ? ['A', 'B', 'C', 'D', 'ZERO'] : ['X', 'Y', 'Z', 'ZERO'];
    for (const round of [1, 2, 3])
      repo.sets.set(`standings:2024:${kind}:${round}`, set(ids.map((id) => standing(id, round))));
    repo.sets.set(`standings:2024:${kind}`, repo.sets.get(`standings:2024:${kind}:2`));
  }
  repo.sets.set(
    'events:2024',
    set(
      [1, 2, 3, 4].map((round) => ({
        id: `event:${round}`,
        year: 2024,
        round,
        status: round === 4 ? 'scheduled' : 'completed',
      })),
    ),
  );
  // Independent raw race fixture: R1 C/Y third, A/X first, B/X second.
  // R2 A changes to Y and is second; D/X first; C/Y third.
  const races = [
    [
      ['C', 'Y', 3],
      ['A', 'X', 1],
      ['B', 'X', 2],
    ],
    [
      ['A', 'Y', 2],
      ['D', 'X', 1],
      ['C', 'Y', 3],
    ],
    [
      ['ZERO', 'Z', 1],
      ['B', 'Z', 2],
      ['D', 'Z', 3],
    ],
  ];
  races.forEach((rows, index) => {
    const round = index + 1;
    repo.sets.set(
      `sessions:event:${round}`,
      set(
        ['race', 'sprint', 'qualifying'].map((kind) => ({
          id: `session:${round}:${kind}`,
          eventId: `event:${round}`,
          kind,
          status: 'completed',
        })),
      ),
    );
    for (const kind of ['race', 'sprint', 'qualifying'])
      repo.sets.set(
        `results:session:${round}:${kind}`,
        set(
          rows.map(([driver, team, position]) => ({
            ...raw,
            id: `result:${round}:${driver}`,
            sessionId: `session:${round}:${kind}`,
            position,
            classified: null,
            status: 'finished',
            entry: {
              ...raw.entry,
              id: `entry:${round}:${driver}`,
              drivers: [{ ...raw.entry.drivers[0], id: driver }],
              constructor: { ...raw.entry.constructor, id: team },
            },
          })),
        ),
      );
  });
  const batches = [];
  repo.getMany = async (keys, snapshot) => {
    batches.push({ keys, snapshot });
    return new Map(keys.map((key) => [key, repo.sets.get(key)]));
  };
  return { ...appFixture(repo), batches };
}
const get = async (app, kind = 'drivers', query = {}) =>
  (
    await request(app)
      .get(`/api/v1/seasons/2024/standings/${kind}`)
      .query({ snapshotId: 'synthetic-publication', ...query })
      .expect(200)
  ).body;
const totals = (body) =>
  Object.fromEntries(body.data.items.map((row) => [row.entity.id, row.podiums]));

test('earlier selected round ignores duplicate/foreign later-round calendar assertions', async () => {
  const { app, repository: repo } = fixture();
  repo.sets
    .get('events:2024')
    .items.push({ id: 'event:3', year: 2023, round: 3, status: 'completed' });
  assert.deepEqual(totals(await get(app, 'drivers', { round: 1 })), {
    A: 1,
    B: 1,
    C: 1,
    D: 0,
    ZERO: 0,
  });
});

test('selected podium event identity is invalid when reused by a later calendar row', async () => {
  const { app, repository: repo } = fixture();
  repo.sets.get('events:2024').items[3].id = 'event:1';
  const body = await get(app, 'drivers', { round: 1 });
  assert.equal(body.data.items[0].podiums, null);
  assert.equal(body.data.items[0].podiumCoverage.coverage, 'unavailable');
});

for (const target of [1, 2]) {
  test(`race session identity cannot also identify a Sprint in selected index ${target}`, async () => {
    const { app, repository: repo } = fixture();
    repo.sets.get(`sessions:event:${target}`).items[1].id = 'session:1:race';
    const body = await get(app);
    assert.equal(body.data.items[0].podiums, null);
    assert.equal(body.data.items[0].podiumCoverage.coverage, 'unavailable');
  });
}

test('old null-podium validator cannot return 304 for a derived standings body', async () => {
  const { app } = fixture();
  const query = { limit: 50, snapshotId: 'synthetic-publication' };
  const oldEtag = `"${hash(['synthetic-publication', 'getStandings', { year: 2024, kind: 'drivers' }, query, 'unknown'])}"`;
  const response = await request(app)
    .get('/api/v1/seasons/2024/standings/drivers')
    .query(query)
    .set('If-None-Match', oldEtag)
    .expect(200);
  assert.notEqual(response.headers.etag, oldEtag);
  await request(app)
    .get('/api/v1/seasons/2024/standings/drivers')
    .query(query)
    .set('If-None-Match', response.headers.etag)
    .expect(304);
});

test('standings conditional GET notices coverage-only metadata changes', async () => {
  const { app, repository: repo } = fixture();
  const endpoint = '/api/v1/seasons/2024/standings/drivers';
  const first = await request(app).get(endpoint).expect(200);
  assert.equal(first.body.meta.coverage, 'partial');
  repo.sets.get('standings:2024:drivers').coverage = 'complete';
  const second = await request(app)
    .get(endpoint)
    .set('If-None-Match', first.headers.etag)
    .expect(200);
  assert.equal(second.body.meta.coverage, 'complete');
  assert.deepEqual(second.body.data, first.body.data);
  assert.notEqual(second.headers.etag, first.headers.etag);
  await request(app).get(endpoint).set('If-None-Match', second.headers.etag).expect(304);
});

test('unsorted final race ranks, historical team change, two cars, proven zero and partial source labels', async () => {
  const { app, batches } = fixture();
  const drivers = await get(app);
  assert.deepEqual(totals(drivers), { A: 2, B: 1, C: 2, D: 1, ZERO: 0 });
  assert.deepEqual(totals(await get(app, 'constructors')), { X: 3, Y: 3, Z: 0, ZERO: 0 });
  assert.equal(drivers.meta.coverage, 'partial');
  assert.equal(drivers.data.items[0].podiumCoverage.coverage, 'complete');
  assert.equal(drivers.data.items[0].podiumCoverage.verifiedRaces, 2);
  assert.equal(batches.length, 6);
  assert.ok(batches.every((batch) => batch.snapshot === 'synthetic-publication'));
  assert.ok(
    !batches.flatMap((batch) => batch.keys).some((key) => /sprint|qualifying|session:3/.test(key)),
  );
});

test('selected round and pagination use the same projection and exclude later races', async () => {
  const { app } = fixture();
  const first = await get(app, 'drivers', { round: 1, limit: 1 });
  assert.deepEqual(totals(first), { A: 1 });
  const second = await get(app, 'drivers', {
    round: 1,
    limit: 1,
    cursor: first.data.page.nextCursor,
  });
  assert.deepEqual(totals(second), { B: 1 });
  assert.equal(second.data.items[0].podiumCoverage.throughRound, 1);
  assert.deepEqual(
    totals(await get(app, 'constructors', { standingSnapshotId: 'standing:2024:1' })),
    { X: 2, Y: 1, Z: 0, ZERO: 0 },
  );
});

for (const defect of [
  'missing-race',
  'missing-round',
  'missing-slot',
  'duplicate-position',
  'duplicate-entry',
  'duplicate-row',
  'duplicate-driver',
  'invalid-position',
  'wrong-session',
  'malformed-row',
  'malformed-drivers',
  'disqualified',
  'unavailable',
  'wrong-event',
  'future-session',
]) {
  test(`incomplete evidence is observed partial, never an exact zero: ${defect}`, async () => {
    const { app, repository: repo } = fixture();
    const result = repo.sets.get('results:session:2:race');
    if (defect === 'missing-race') repo.sets.delete('results:session:2:race');
    if (defect === 'missing-round') repo.sets.get('events:2024').items.splice(1, 1);
    if (defect === 'missing-slot') result.items.pop();
    if (defect === 'duplicate-position') result.items[0].position = 1;
    if (defect === 'duplicate-entry') result.items[0].entry.id = result.items[1].entry.id;
    if (defect === 'duplicate-row') result.items.push(result.items[0]);
    if (defect === 'duplicate-driver')
      result.items[0].entry.drivers = result.items[1].entry.drivers;
    if (defect === 'invalid-position') result.items[0].position = '2';
    if (defect === 'wrong-session') result.items[0].sessionId = 'foreign';
    if (defect === 'malformed-row') result.items.push(null);
    if (defect === 'malformed-drivers') result.items[0].entry.drivers = {};
    if (defect === 'disqualified') result.items[0].status = 'disqualified';
    if (defect === 'unavailable') result.coverage = 'unavailable';
    if (defect === 'wrong-event') repo.sets.get('sessions:event:2').items[0].eventId = 'foreign';
    if (defect === 'future-session')
      repo.sets.get('sessions:event:2').items[0].status = 'scheduled';
    const body = await get(app);
    const zero = body.data.items.find((row) => row.entity.id === 'ZERO');
    assert.equal(zero.podiums, 0);
    assert.equal(zero.podiumCoverage.coverage, 'partial');
    assert.equal(zero.podiumCoverage.verifiedRaces, 1);
    assert.equal(zero.podiumCoverage.expectedRaces, 2);
    assert.ok(body.data.items.find((row) => row.entity.id === 'B').podiums >= 1);
  });
}

test('shared car credits each distinct driver once and the constructor only once', async () => {
  const { app, repository: repo } = fixture();
  repo.sets
    .get('results:session:1:race')
    .items[1].entry.drivers.push({ id: 'D', displayName: 'D', clientPath: '/drivers/D' });
  assert.deepEqual(totals(await get(app)), { A: 2, B: 1, C: 2, D: 2, ZERO: 0 });
  assert.deepEqual(totals(await get(app, 'constructors')), { X: 3, Y: 3, Z: 0, ZERO: 0 });
});

test('no usable races and wrong standing context stay unavailable', async () => {
  const { app, repository: repo } = fixture();
  repo.sets.delete('results:session:1:race');
  repo.sets.delete('results:session:2:race');
  const body = await get(app);
  assert.ok(
    body.data.items.every(
      (row) => row.podiums === null && row.podiumCoverage.coverage === 'unavailable',
    ),
  );
  repo.sets.get('standings:2024:drivers').items[0].standingSnapshotId = 'standing:2023:2';
  assert.equal((await get(app)).data.items[0].podiums, null);
});
