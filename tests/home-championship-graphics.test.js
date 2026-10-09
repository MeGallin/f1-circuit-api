import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { appFixture, MemoryRepository } from './helpers.js';

const entity = (id) => ({ id, displayName: id, clientPath: `/drivers/${id}` });
const set = (items, coverage = 'complete') => ({
  items,
  coverage,
  verification: 'source-only',
  warnings: [],
});
const standing = (id, round, rank, points) => ({
  id: `s:${round}:${id}`,
  entity: entity(id),
  rank,
  points,
  standingSnapshotId: `standing:2024:${round}`,
});
const result = (round, team, driver, points, kind = 'race') => ({
  id: `r:${round}:${kind}:${driver}`,
  sessionId: `session:${round}:${kind}`,
  entry: {
    id: `entry:${round}:${kind}:${driver}`,
    constructor: entity(team),
    drivers: [entity(driver)],
  },
  points,
});
function fixture() {
  const repository = new MemoryRepository();
  repository.sets = new Map([['seasons', set([{ year: 2024 }])]]);
  const events = [1, 2, 3, 4].map((round) => ({
    id: `event:${round}`,
    year: 2024,
    round,
    name: `Round ${round}`,
    status: round === 4 ? 'scheduled' : 'completed',
  }));
  repository.sets.set('events:2024', set(events));
  const driverRounds = [
    [
      ['D', 1, '20.1'],
      ['A', 2, '10.2'],
      ['B', 3, '0'],
      ['C', 4, '-1.25'],
    ],
    [
      ['B', 1, '25'],
      ['A', 2, '24.75'],
      ['C', 3, '10'],
      ['D', 4, '9'],
    ],
    [
      ['A', 1, '40'],
      ['B', 2, '30.25'],
      ['C', 3, '15'],
      ['D', 4, '9'],
    ],
  ];
  driverRounds.forEach((rows, index) =>
    repository.sets.set(
      `standings:2024:drivers:${index + 1}`,
      set(rows.map(([id, rank, points]) => standing(id, index + 1, rank, points))),
    ),
  );
  repository.sets.set(
    'standings:2024:constructors:3',
    set(['X', 'Y', 'Z', 'W'].map((id, index) => standing(id, 3, index + 1, String(999 - index)))),
  );
  repository.sets.set(
    'standings:2024:constructors:1',
    set(
      [
        standing('W', 1, 1, '20.1'),
        standing('X', 1, 2, '10.2'),
        standing('Y', 1, 3, '0'),
        standing('Z', 1, 4, '-1.25'),
      ],
      'partial',
    ),
  );
  repository.sets.set(
    'standings:2024:constructors:2',
    set([
      standing('Y', 2, 1, '25'),
      standing('X', 2, 2, '24.75'),
      standing('Z', 2, 3, '10'),
      standing('W', 2, 4, '9'),
    ]),
  );
  for (const round of [1, 2, 3]) {
    const kinds = round === 3 ? ['race', 'sprint'] : ['race'];
    repository.sets.set(
      `sessions:event:${round}`,
      set(
        kinds.map((kind) => ({
          id: `session:${round}:${kind}`,
          eventId: `event:${round}`,
          kind,
          status: 'completed',
        })),
      ),
    );
  }
  repository.sets.set(
    'results:session:1:race',
    set([result(1, 'X', 'A', '0.1'), result(1, 'X', 'B', '0.2'), result(1, 'Y', 'C', '0')]),
  );
  repository.sets.set(
    'results:session:2:race',
    set([result(2, 'X', 'D', '0'), result(2, 'X', 'C', null)]),
  );
  repository.sets.set('results:session:3:race', set([result(3, 'X', 'A', '5.5')]));
  repository.sets.set('results:session:3:sprint', set([result(3, 'X', 'D', '0.25', 'sprint')]));
  const batches = [];
  repository.getMany = async (keys, snapshot) => {
    batches.push({ keys, snapshot });
    return new Map(keys.map((key) => [key, repository.sets.get(key)]));
  };
  return { ...appFixture(repository), batches };
}
const endpoint = '/api/v1/seasons/2024/championship-graphics';
const query = { standingSnapshotId: 'standing:2024:3', snapshotId: 'synthetic-publication' };
const get = async (app, params = query) =>
  (await request(app).get(endpoint).query(params).expect(200)).body.data.championshipGraphics;

test('constructor gaps use round-owned ALL standings, exact decimals and negative source points, never race accumulation', async () => {
  const { app, batches } = fixture();
  const data = await get(app);
  assert.deepEqual(
    data.constructors.map((row) => row.entityId),
    ['X', 'Y', 'Z'],
  );
  assert.deepEqual(
    data.constructors[0].rounds.map((cell) => cell.gap),
    ['9.9', '0.25', '0'],
  );
  assert.deepEqual(
    data.constructors[0].rounds.map((cell) => cell.leaderId),
    ['W', 'Y', 'X'],
  );
  assert.equal(data.constructors[0].rounds[0].coverage, 'partial');
  assert.equal(data.constructors[2].rounds[0].gap, '21.35');
  assert.equal(data.constructors[0].rounds[2].points, '999');
  assert.equal('contributions' in data.constructors[0].rounds[0], false);
  assert.ok(batches.flatMap((batch) => batch.keys).includes('standings:2024:constructors:1'));
});

for (const kind of ['constructors', 'drivers']) {
  for (const failure of [
    'missing-set',
    'missing-team',
    'null-row',
    'null-points',
    'malformed-points',
    'wrong-round',
    'duplicate-team',
    'duplicate-leader',
    'duplicate-invalid-leader',
    'missing-leader-points',
    'malformed-array',
    'negative-gap',
    'unavailable',
  ]) {
    test(`${kind} ${failure} cannot fabricate a gap or complete zero`, async () => {
      const { app, repository } = fixture();
      const history = repository.sets.get(`standings:2024:${kind}:2`);
      if (failure === 'missing-set') repository.sets.delete(`standings:2024:${kind}:2`);
      if (failure === 'null-row') history.items[0] = null;
      if (failure === 'missing-team')
        history.items = history.items.filter(
          (row) => row.entity.id !== (kind === 'constructors' ? 'X' : 'A'),
        );
      if (failure === 'null-points') history.items[1].points = null;
      if (failure === 'malformed-points') history.items[1].points = 'NaN';
      if (failure === 'wrong-round') history.items[0].standingSnapshotId = 'standing:2023:2';
      if (failure === 'duplicate-team') history.items.push({ ...history.items[1] });
      if (failure === 'duplicate-leader') history.items[1].rank = 1;
      if (failure === 'duplicate-invalid-leader') {
        history.items[3].rank = 1;
        history.items[3].points = null;
      }
      if (failure === 'missing-leader-points') history.items[0].points = null;
      if (failure === 'malformed-array') history.items = null;
      if (failure === 'negative-gap') history.items[1].points = '26';
      if (failure === 'unavailable') history.coverage = 'unavailable';
      const cell = (await get(app))[kind][0].rounds[1];
      assert.equal(cell.gap, null);
      assert.equal(cell.coverage, 'unavailable');
    });
  }
}

test('parent independently derived 2026 sampled scores retain partial zero and exact latest gaps', async () => {
  const { app, repository } = fixture();
  for (const [round, points] of [
    [1, ['43', '27', '10']],
    [3, ['556', '405', '316']],
  ]) {
    repository.sets.set(
      `standings:2024:constructors:${round}`,
      set(
        points.map((value, index) => standing(['X', 'Y', 'Z'][index], round, index + 1, value)),
        'partial',
      ),
    );
  }
  const data = await get(app);
  assert.deepEqual(
    data.constructors.map((row) => row.rounds[0].gap),
    ['0', '16', '33'],
  );
  assert.deepEqual(
    data.constructors.map((row) => row.rounds[2].gap),
    ['0', '151', '240'],
  );
  assert.equal(data.constructors[0].rounds[0].coverage, 'partial');
});

test('server owns exactly the displayed top three, and uses each historical round leader including outside that three', async () => {
  const { app } = fixture();
  const data = await get(app);
  assert.deepEqual(
    data.drivers.map((row) => row.entityId),
    ['A', 'B', 'C'],
  );
  assert.deepEqual(
    data.constructors.map((row) => row.entityId),
    ['X', 'Y', 'Z'],
  );
  assert.deepEqual(
    data.rounds.map((row) => row.round),
    [1, 2, 3],
  );
  const a = data.drivers[0].rounds;
  assert.deepEqual(
    a.map((row) => row.gap),
    ['9.9', '0.25', '0'],
  );
  assert.deepEqual(
    a.map((row) => row.leaderId),
    ['D', 'B', 'A'],
  );
  assert.equal(a[0].racePoints, '0.1');
  assert.equal(data.drivers[2].rounds[0].points, '-1.25');
  assert.equal(data.drivers[2].rounds[0].gap, '21.35');
});
test('partial classification and missing driver standings remain independently unavailable', async () => {
  const { app, repository } = fixture();
  repository.sets.get('results:session:1:race').coverage = 'partial';
  repository.sets.get('standings:2024:drivers:1').items = repository.sets
    .get('standings:2024:drivers:1')
    .items.filter((row) => row.entity.id !== 'B');
  const data = await get(app);
  assert.equal(data.drivers[0].rounds[0].racePoints, '0.1');
  assert.equal(data.drivers[0].rounds[0].raceCoverage, 'partial');
  assert.equal(data.drivers[1].rounds[0].gap, null);
});
test('invalid historical leader or mismatched session rows cannot blend publications or invent gaps', async () => {
  const { app, repository } = fixture();
  repository.sets.get('standings:2024:drivers:1').items[0].standingSnapshotId = 'standing:2023:1';
  repository.sets.get('results:session:1:race').items[0].sessionId = 'foreign-session';
  const data = await get(app);
  assert.equal(data.drivers[0].rounds[0].gap, null);
  assert.equal(data.drivers[0].rounds[0].racePoints, null);
});
test('future rounds are not read; all repository batches pin one publication and use a bounded number of batch calls', async () => {
  const { app, batches } = fixture();
  await get(app);
  assert.equal(batches.length, 3);
  assert.ok(batches.every((batch) => batch.snapshot === 'synthetic-publication'));
  assert.ok(batches.flatMap((batch) => batch.keys).every((key) => !key.includes('event:4')));
  assert.ok(batches.flatMap((batch) => batch.keys).every((key) => !key.includes(':sprint')));
});
test('unknown/unavailable sets cannot contribute unexpected items', async () => {
  const { app, repository } = fixture();
  repository.sets.get('results:session:1:race').coverage = 'unavailable';
  const data = await get(app);
  assert.equal(data.drivers[0].rounds[0].racePoints, null);
  assert.equal(data.constructors[0].rounds[0].gap, '9.9');
});
test('snapshot expiration, input ownership, immutable scope and conditional GET are guarded', async () => {
  const { app } = fixture();
  await request(app)
    .get(endpoint)
    .query({ ...query, snapshotId: 'expired' })
    .expect(409);
  await request(app)
    .get(endpoint)
    .query({ ...query, standingSnapshotId: 'standing:2023:3' })
    .expect(400);
  await request(app)
    .get(endpoint)
    .query({ ...query, driverIds: 'D' })
    .expect(400);
  await request(app)
    .get(endpoint)
    .query({ ...query, standingSnapshotId: 'standing:2024:100' })
    .expect(400);
  const first = await request(app).get(endpoint).query(query).expect(200);
  await request(app)
    .get(endpoint)
    .query(query)
    .set('If-None-Match', first.headers.etag)
    .expect(304);
});

for (const failure of ['duplicate-session-id', 'second-race', 'duplicate-entry']) {
  test(`${failure} is not double-counted or silently called complete`, async () => {
    const { app, repository } = fixture();
    if (failure === 'duplicate-entry') {
      const results = repository.sets.get('results:session:1:race');
      results.items.push({ ...results.items[0], id: 'different-result-same-entry' });
    } else {
      const sessions = repository.sets.get('sessions:event:1');
      sessions.items.push({
        ...sessions.items[0],
        id: failure === 'second-race' ? 'another-race' : sessions.items[0].id,
      });
    }
    const data = await get(app);
    assert.equal(data.drivers[0].rounds[0].racePoints, null);
    assert.equal(data.drivers[0].rounds[0].raceCoverage, 'unavailable');
  });
}
test('malformed calendar arrays remain explicit unavailable rather than throwing', async () => {
  const { app, repository } = fixture();
  repository.sets.get('events:2024').items = null;
  const data = await get(app);
  assert.deepEqual(data.rounds, []);
});
test('malformed complete classification cannot fabricate driver race zero', async () => {
  const { app, repository } = fixture();
  repository.sets.get('results:session:1:race').items = null;
  const data = await get(app);
  assert.equal(data.drivers[0].rounds[0].racePoints, null);
  assert.equal(data.drivers[0].rounds[0].raceCoverage, 'unavailable');
});

for (const failure of ['null-result', 'null-driver', 'nonarray-drivers']) {
  test(`${failure} classification is unavailable rather than throwing or inventing zero`, async () => {
    const { app, repository } = fixture();
    const rows = repository.sets.get('results:session:1:race').items;
    if (failure === 'null-result') rows[0] = null;
    if (failure === 'null-driver') rows[0].entry.drivers = [null];
    if (failure === 'nonarray-drivers') rows[0].entry.drivers = {};
    const data = await get(app);
    assert.equal(data.drivers[0].rounds[0].racePoints, null);
    assert.equal(data.drivers[0].rounds[0].raceCoverage, 'unavailable');
    assert.equal(data.drivers[0].rounds[0].gap, '9.9');
  });
}

test('null calendar row makes the calendar scope unavailable, not a silently complete subset', async () => {
  const { app, repository } = fixture();
  repository.sets.get('events:2024').items.push(null);
  const response = await request(app).get(endpoint).query(query).expect(200);
  assert.deepEqual(response.body.data.championshipGraphics.rounds, []);
  assert.equal(response.body.meta.coverage, 'unavailable');
});

for (const missing of ['none', 'classification', 'calendar']) {
  test(`aggregate coverage accounts for ${missing} missing supplementary evidence`, async () => {
    const { app, repository } = fixture();
    repository.sets.get('standings:2024:constructors:1').coverage = 'complete';
    for (const round of [1, 2, 3])
      repository.sets.set(
        `results:session:${round}:race`,
        set(['A', 'B', 'C'].map((id) => result(round, 'X', id, '0'))),
      );
    if (missing === 'classification') repository.sets.delete('results:session:1:race');
    if (missing === 'calendar') repository.sets.delete('events:2024');
    const response = await request(app).get(endpoint).query(query).expect(200);
    assert.equal(
      response.body.meta.coverage,
      missing === 'none' ? 'complete' : missing === 'calendar' ? 'unavailable' : 'partial',
    );
    if (missing === 'classification') {
      const cell = response.body.data.championshipGraphics.drivers[0].rounds[0];
      assert.equal(cell.coverage, 'complete');
      assert.equal(cell.raceCoverage, 'unavailable');
      assert.equal(cell.racePoints, null);
    }
  });
}

test('partial calendar keeps aggregate scope partial even when every available cell is complete', async () => {
  const { app, repository } = fixture();
  repository.sets.get('events:2024').coverage = 'partial';
  repository.sets.get('standings:2024:constructors:1').coverage = 'complete';
  const response = await request(app).get(endpoint).query(query).expect(200);
  assert.ok(
    [
      ...response.body.data.championshipGraphics.drivers,
      ...response.body.data.championshipGraphics.constructors,
    ].every((row) => row.rounds.every((cell) => cell.coverage === 'complete')),
  );
  assert.equal(response.body.meta.coverage, 'partial');
});
