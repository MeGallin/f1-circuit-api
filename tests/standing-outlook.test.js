import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { appFixture, MemoryRepository } from './helpers.js';
import { validateSchema } from '../src/schemas/contract.js';

// Independent calendar identity fixture, not imported from the rule registry.
const venues = [
  ['australian', 'albert_park'],
  ['chinese', 'shanghai'],
  ['japanese', 'suzuka'],
  ['miami', 'miami'],
  ['canadian', 'villeneuve'],
  ['monaco', 'monaco'],
  ['barcelona', 'catalunya'],
  ['austrian', 'red_bull_ring'],
  ['british', 'silverstone'],
  ['belgian', 'spa'],
  ['hungarian', 'hungaroring'],
  ['dutch', 'zandvoort'],
  ['italian', 'monza'],
  ['spanish', 'madring'],
  ['azerbaijan', 'baku'],
  ['bahrain-grand-prix-in-malaysia', 'sepang'],
  ['singapore', 'marina_bay'],
  ['united-states', 'americas'],
  ['mexico-city', 'rodriguez'],
  ['brazilian', 'interlagos'],
  ['las-vegas', 'vegas'],
  ['qatar', 'losail'],
  ['abu-dhabi', 'yas_marina'],
];
function fixture(year = 2026, round = 17) {
  const repository = new MemoryRepository();
  const template = repository.sets.get('standings:2024:drivers').items[0];
  const set = (items) => ({ items, coverage: 'partial', verification: 'source-only' });
  const events = venues.map(([name, circuit], i) => ({
    id: `event:${year}:${name.includes('grand-prix') ? name : name + '-grand-prix'}`,
    year,
    round: i + 1,
    status: i < round ? 'completed' : 'scheduled',
    circuit: { id: `circuit:${circuit}` },
    schedule: { date: '2026-12-06', startsAt: null },
  }));
  repository.sets = new Map([
    ['seasons', set([{ year }])],
    [`events:${year}`, set(events)],
  ]);
  for (const kind of ['drivers', 'constructors']) {
    const points = kind === 'drivers' ? ['340', '238', '200'] : ['578', '444', '300'];
    const rows = points.map((points, i) => ({
      ...template,
      id: `row:${i}`,
      entity: { ...template.entity, id: `entity:${i}` },
      rank: i + 1,
      points,
      standingSnapshotId: `standing:${year}:${round}`,
    }));
    repository.sets.set(`standings:${year}:${kind}`, set(rows));
    repository.sets.set(`standings:${year}:${kind}:${round}`, set(rows));
  }
  for (const event of events)
    repository.sets.set(
      `sessions:${event.id}`,
      set([
        {
          id: `session:${event.id}:race`,
          eventId: event.id,
          kind: 'race',
          status: event.status === 'completed' ? 'completed' : 'unknown',
          schedule: event.schedule,
        },
      ]),
    );
  const batches = [];
  repository.getMany = async (keys, snapshot) => {
    batches.push({ keys, snapshot });
    return new Map(keys.map((key) => [key, repository.sets.get(key)]));
  };
  return { ...appFixture(repository), events, batches, year };
}
const get = async ({ app, year }, kind = 'drivers', query = {}) =>
  (
    await request(app)
      .get(`/api/v1/seasons/${year}/standings/${kind}`)
      .query({ snapshotId: 'synthetic-publication', ...query })
      .expect(200)
  ).body;

function scenarioFixture(round = 17) {
  const f = fixture(2026, round);
  const dates = [
    '03-08',
    '03-15',
    '03-29',
    '05-03',
    '05-24',
    '06-07',
    '06-14',
    '06-28',
    '07-05',
    '07-19',
    '07-26',
    '08-23',
    '09-06',
    '09-13',
    '09-26',
    '10-04',
    '10-11',
    '10-25',
    '11-01',
    '11-08',
    '11-22',
    '11-29',
    '12-06',
  ];
  f.events.forEach((event, i) => {
    event.name = `Fixture round ${i + 1}`;
    event.schedule.date = `2026-${dates[i]}`;
  });
  const rows = f.repository.sets.get(`standings:2026:drivers:${round}`).items;
  rows[0].wins = 8;
  rows[1].wins = 3;
  rows[2].points = '229';
  rows[2].wins = 1;
  rows.push({
    ...rows[2],
    id: 'fourth',
    entity: { ...rows[2].entity, id: 'entity:3' },
    rank: 4,
    points: '221',
    wins: 2,
  });
  return f;
}
const scenarios = async (f, kind = 'drivers', query) =>
  (await get(f, kind, query)).data.titleOutlook.scenarios;

for (const date of ['2026-01-01', '2026-10-11']) {
  test(`scenario opportunity must be strictly after selected cutoff: ${date}`, async () => {
    const f = scenarioFixture();
    f.events[17].schedule.date = date;
    assert.equal((await scenarios(f)).coverage, 'unavailable');
  });
}
for (const date of ['2026-02-30', '2025-10-11', null]) {
  test(`scenario cutoff must itself have a validated owned date: ${date}`, async () => {
    const f = scenarioFixture();
    f.events[16].schedule.date = date;
    assert.equal((await scenarios(f)).coverage, 'unavailable');
  });
}
test('registry Sprint must be strictly after selected cutoff, not merely before its race', async () => {
  const f = scenarioFixture(16);
  f.events[15].schedule.date = '2026-10-10';
  assert.equal((await scenarios(f)).coverage, 'unavailable');
});

for (const points of ['0200', '00.5', 200, 0.5]) {
  test(`standing omits noncanonical published score without500: ${JSON.stringify(points)}`, async () => {
    const f = fixture();
    f.repository.sets.get('standings:2026:drivers').coverage = 'complete';
    f.repository.sets.get('standings:2026:drivers').items[2].points = points;
    const body = await get(f);
    assert.equal(body.data.items.length, 2);
    assert.equal(body.meta.coverage, 'partial');
    assert.equal(body.data.titleOutlook.coverage, 'unavailable');
  });
}

const invalidContractCases = [
  [
    'outer unavailable with conditional scenarios',
    (o) => {
      o.coverage = 'unavailable';
    },
  ],
  [
    'remaining maximum',
    (o) => {
      o.remainingMaximum = '-1';
    },
  ],
  [
    'sufficient addition',
    (o) => {
      o.sufficientAdditional = '-1';
    },
  ],
  [
    'next leader gain',
    (o) => {
      o.scenarios.next.leaderGain = '-1';
    },
  ],
  [
    'next remaining budget',
    (o) => {
      o.scenarios.next.remainingAfter = '-1';
    },
  ],
  [
    'rival condition budget',
    (o) => {
      o.scenarios.next.conditions[0].maximumPoints = '-1';
    },
  ],
  [
    'null opportunity maximum',
    (o) => {
      o.scenarios.next.event.maximum = null;
    },
  ],
  [
    'zero opportunity maximum',
    (o) => {
      o.scenarios.next.event.maximum = '0';
    },
  ],
  [
    'earliest status',
    (o) => {
      o.scenarios.earliest.status = 'invented';
    },
  ],
  [
    'winning status',
    (o) => {
      o.scenarios.winningPattern.status = 'invented';
    },
  ],
  [
    'round zero',
    (o) => {
      o.round = 0;
    },
  ],
  [
    'non-HTTPS source',
    (o) => {
      o.sourceUrls = ['http://example.com/rules'];
    },
  ],
  [
    'possible without gain',
    (o) => {
      o.scenarios.next.leaderGain = null;
    },
  ],
  [
    'possible with unproven rival',
    (o) => {
      o.scenarios.next.conditions[0].maximumPoints = null;
    },
  ],
  [
    'secured without method',
    (o) => {
      o.scenarios.now = { status: 'secured', method: null };
    },
  ],
  [
    'guaranteed without proof',
    (o) => {
      o.scenarios.winningPattern.leaderPoints = null;
    },
  ],
  [
    'no opportunities with event',
    (o) => {
      o.scenarios.next.status = 'no-opportunities';
    },
  ],
];
for (const [name, mutate] of invalidContractCases) {
  test(`standings contract rejects ${name}`, async () => {
    const o = (await get(scenarioFixture())).data.titleOutlook;
    assert.equal(validateSchema('StandingTitleOutlook', o).valid, true);
    mutate(o);
    assert.equal(validateSchema('StandingTitleOutlook', o).valid, false);
  });
}
test('contract rejects negative leader gap but preserves legitimate signed penalty ceilings/proof scores', async () => {
  const body = await get(scenarioFixture());
  assert.equal(
    validateSchema('Standing', { ...body.data.items[0], gapToLeader: '-1' }).valid,
    false,
  );
  body.data.titleOutlook.rivalCeiling = '-5';
  body.data.titleOutlook.scenarios.earliest.leaderPoints = '-10';
  body.data.titleOutlook.scenarios.winningPattern.strongestRivalCeiling = '-15';
  assert.equal(validateSchema('StandingTitleOutlook', body.data.titleOutlook).valid, true);
});

test('scenario current oracle: next win conditions include every alive rival and proven wins-countback at2 points', async () => {
  const f = scenarioFixture();
  const s = await scenarios(f);
  assert.equal(s.now.status, 'not-secured');
  assert.equal(s.next.status, 'possible');
  assert.equal(s.next.leaderGain, '25');
  assert.equal(s.next.remainingAfter, '125');
  assert.deepEqual(
    s.next.conditions.map((r) => [r.entityId, r.maximumPoints, r.finishAtOrBelow, r.tieResolution]),
    [
      ['entity:1', '2', 9, 'wins-countback'],
      ['entity:2', '10', 5, null],
      ['entity:3', '18', 2, null],
    ],
  );
  assert.equal(s.earliest.event.round, 18);
  assert.equal(s.earliest.status, 'possible');
  assert.equal(s.earliest.witness, 'Leader wins; all other competitors score zero.');
  assert.equal(s.winningPattern.event.round, 19);
  assert.equal(s.winningPattern.leaderPoints, '390');
  assert.equal(s.winningPattern.strongestRivalCeiling, '374');
  assert.equal(s.constantGap.event.round, 19);
  assert.equal(s.constantGap.remainingAfter, '100');
});

test('without valid season-win evidence next Russell limit stays1 and ties are unresolved', async () => {
  const f = scenarioFixture();
  f.repository.sets.get('standings:2026:drivers').items[0].wins = null;
  const s = await scenarios(f);
  assert.equal(s.next.conditions[0].maximumPoints, '1');
  assert.equal(s.next.conditions[0].finishAtOrBelow, 10);
  assert.equal(s.next.conditions[0].tieResolution, null);
});

test('constructor oracle uses two-car joint allocations43/27, never driver25/18', async () => {
  const s = await scenarios(scenarioFixture(), 'constructors');
  assert.equal(s.next.status, 'not-proven');
  assert.equal(s.next.leaderGain, '43');
  assert.equal(s.next.remainingAfter, '215');
  assert.equal(s.earliest.event.round, 19);
  assert.equal(s.earliest.leaderPoints, '664');
  assert.equal(s.earliest.strongestRivalCeiling, '616');
  assert.equal(s.winningPattern.event.round, 20);
  assert.equal(s.winningPattern.leaderPoints, '707');
  assert.equal(s.winningPattern.strongestRivalCeiling, '654');
  assert.equal(s.constantGap.event.round, 20);
  assert.equal(s.constantGap.remainingAfter, '129');
});

test('strict current gap greater than remaining secures; equality without dominant wins is unresolved', async () => {
  const f = scenarioFixture();
  const rows = f.repository.sets.get('standings:2026:drivers').items;
  rows[0].points = '389';
  assert.equal((await scenarios(f)).now.status, 'secured');
  rows[0].points = '388';
  rows[0].wins = null;
  assert.equal((await scenarios(f)).now.status, 'tie-unresolved');
  rows[0].wins = 10;
  rows[1].wins = 3;
  assert.equal((await scenarios(f)).now.status, 'secured'); //10 >3+6
  rows[0].wins = 9;
  assert.equal((await scenarios(f)).now.status, 'tie-unresolved'); //equal potential wins, no seconds proof
});

test('no remaining opportunities does not award an unproven tied title', async () => {
  const f = scenarioFixture(23);
  const rows = f.repository.sets.get('standings:2026:drivers').items;
  rows[0].points = rows[1].points;
  rows[0].wins = null;
  const s = await scenarios(f);
  assert.equal(s.now.status, 'tie-unresolved');
  assert.equal(s.next.status, 'no-opportunities');
  assert.equal(s.earliest.event, null);
});

test('all other rivals constrain the winning pattern, not only the nearest', async () => {
  const f = scenarioFixture();
  const rows = f.repository.sets.get('standings:2026:drivers').items;
  rows[0].points = '300';
  rows[1].points = '290';
  rows[2].points = '289';
  rows[3].points = '280';
  const s = await scenarios(f);
  // After three:375 vs nearest344+75=419, not clinched. After five425 vs380+25=405.
  assert.equal(s.winningPattern.event.round, 22);
  assert.equal(s.winningPattern.leaderPoints, '425');
  assert.equal(s.winningPattern.strongestRivalCeiling, '405');
});

test('a third rival winning cannot be ignored in next-win conditions; no two winners assigned', async () => {
  const s = await scenarios(scenarioFixture());
  assert.ok(s.next.conditions.every((r) => Number(r.maximumPoints) <= 18));
  assert.equal(s.next.conditions.length, 3);
  assert.equal(s.next.conditions[2].maximumPoints, '18'); //third rival may be second, not also win25
});

test('Sprint chronology precedes its race and uses8/7, excluding cancelled events', async () => {
  const f = scenarioFixture(16);
  const s = await scenarios(f);
  assert.equal(s.next.event.kind, 'sprint');
  assert.equal(s.next.event.round, 17);
  assert.equal(s.next.event.date, '2026-10-10');
  assert.equal(s.next.leaderGain, '8');
  assert.equal(s.next.remainingAfter, '175'); //Singapore race25+six remaining races150
  f.events[16].status = 'cancelled';
  assert.equal((await scenarios(f)).next.event.round, 18);
});

test('scenario chronology rejects ambiguous or contradictory session dates without guessing', async () => {
  const f = scenarioFixture();
  f.events[18].schedule.date = f.events[17].schedule.date;
  assert.equal((await scenarios(f)).coverage, 'unavailable');
});

test('historical unsupported/missing evidence scenarios are explicit, never fabricated', async () => {
  const f = fixture(2000, 1);
  assert.equal((await scenarios(f)).coverage, 'unavailable');
  assert.equal((await scenarios(f)).reasonCode, 'SCORING_PROFILE_UNAVAILABLE');
  const g = scenarioFixture();
  g.repository.sets.delete(`sessions:${g.events[17].id}`);
  assert.equal((await scenarios(g)).coverage, 'unavailable');
});

test('winning pattern describes independent rival upper bounds, not a joint finishing allocation', async () => {
  for (const kind of ['drivers', 'constructors']) {
    const s = await scenarios(scenarioFixture(), kind);
    assert.match(s.winningPattern.outcome, /independent upper bounds/);
    assert.match(s.winningPattern.outcome, /not simultaneous/);
  }
});

test('scenario payload is identical across pinned pages and selected standing identities', async () => {
  const f = scenarioFixture();
  const first = await get(f, 'drivers', { limit: 1, round: 17 });
  const second = await get(f, 'drivers', {
    limit: 1,
    round: 17,
    cursor: first.data.page.nextCursor,
  });
  assert.deepEqual(first.data.titleOutlook.scenarios, second.data.titleOutlook.scenarios);
  assert.equal(first.data.titleOutlook.scenarios.snapshotId, 'synthetic-publication');
  assert.deepEqual(
    await scenarios(f, 'drivers', { standingSnapshotId: 'standing:2026:17' }),
    first.data.titleOutlook.scenarios,
  );
});

test('R17 independent arithmetic: six races, no sprints, driver150/49 and team258/125; gap excludes pagination', async () => {
  const f = fixture();
  const drivers = await get(f, 'drivers', { limit: 1 });
  assert.equal(drivers.data.items[0].gapToLeader, '0');
  assert.equal(drivers.data.titleOutlook.remainingMaximum, '150');
  assert.equal(drivers.data.titleOutlook.sufficientAdditional, '49');
  assert.equal(drivers.data.titleOutlook.rivalCeiling, '388');
  assert.equal(drivers.data.titleOutlook.coverage, 'conditional');
  assert.equal(drivers.meta.coverage, 'partial');
  const page2 = await get(f, 'drivers', { limit: 1, cursor: drivers.data.page.nextCursor });
  assert.equal(page2.data.items[0].gapToLeader, '102');
  assert.deepEqual(page2.data.titleOutlook, drivers.data.titleOutlook);
  const teams = await get(f, 'constructors');
  assert.equal(teams.data.titleOutlook.remainingMaximum, '258');
  assert.equal(teams.data.titleOutlook.sufficientAdditional, '125');
  assert.equal(teams.data.items[1].gapToLeader, '134');
  for (let i = 0; i < f.batches.length; i++)
    assert.equal(f.batches[i].snapshot, 'synthetic-publication');
  const calendarReads = f.batches.flatMap((b) => b.keys).filter((k) => k === 'events:2026');
  assert.equal(calendarReads.length, 3); // once per request, shared with podiums
});

test('R1 affirmative sprint schedule counts all six even without imported sprint sessions', async () => {
  const f = fixture(2026, 1);
  const driver = (await get(f)).data.titleOutlook;
  assert.equal(driver.remainingRaces, 22);
  assert.equal(driver.remainingSprints, 6);
  assert.equal(driver.remainingMaximum, '598'); // 22*25 + 6*8
  assert.equal((await get(f, 'constructors')).data.titleOutlook.remainingMaximum, '1036'); //22*43 +6*15
});

test('a cancelled scheduled race removes its budget; no bonus is invented', async () => {
  const f = fixture();
  f.events[17].status = 'cancelled';
  assert.equal((await get(f)).data.titleOutlook.remainingMaximum, '125');
});

for (const date of ['2026-02-30', '2025-12-06', '2026-13-01']) {
  test(`remaining schedule rejects impossible or foreign-season date: ${date}`, async () => {
    const f = fixture();
    f.events[17].schedule.date = date;
    const body = await get(f);
    assert.equal(body.data.titleOutlook.coverage, 'unavailable');
    assert.equal(body.data.titleOutlook.remainingMaximum, null);
  });
}

for (const defect of [
  'missing-calendar-round',
  'foreign-circuit',
  'unknown-venue',
  'duplicate-calendar',
  'missing-session',
  'unknown-session-context',
  'unexpected-sprint',
  'duplicate-race',
  'missing-leader',
  'missing-second',
  'duplicate-rank',
  'contradictory-score',
  'malformed-score',
  'wrong-standing',
]) {
  test(`ambiguous title inputs are unavailable: ${defect}`, async () => {
    const f = fixture();
    const rows = f.repository.sets.get('standings:2026:drivers').items;
    const sessions = f.repository.sets.get(`sessions:${f.events[17].id}`);
    if (defect === 'missing-calendar-round') f.events.splice(18, 1);
    if (defect === 'foreign-circuit') f.events[17].circuit.id = 'circuit:foreign';
    if (defect === 'unknown-venue') f.events[17].id = 'event:2026:unreviewed';
    if (defect === 'duplicate-calendar') f.events.push(f.events[17]);
    if (defect === 'missing-session') f.repository.sets.delete(`sessions:${f.events[17].id}`);
    if (defect === 'unknown-session-context') sessions.items[0].eventId = 'foreign';
    if (defect === 'unexpected-sprint')
      sessions.items.push({ ...sessions.items[0], id: 'unexpected-sprint', kind: 'sprint' });
    if (defect === 'duplicate-race') sessions.items.push(sessions.items[0]);
    if (defect === 'missing-leader') rows.shift();
    if (defect === 'missing-second') rows.splice(1, 1);
    if (defect === 'duplicate-rank') rows[2].rank = 2;
    if (defect === 'contradictory-score') rows[2].points = '900';
    if (defect === 'malformed-score') rows[1].points = 'NaN';
    if (defect === 'wrong-standing') rows[2].standingSnapshotId = 'standing:2025:17';
    assert.equal((await get(f)).data.titleOutlook.coverage, 'unavailable');
    assert.equal((await get(f)).data.titleOutlook.sufficientAdditional, null);
  });
}

test('strict lead beyond rival ceiling needs zero; target above available is only conservative target status', async () => {
  const f = fixture();
  const rows = f.repository.sets.get('standings:2026:drivers').items;
  rows[0].points = '389';
  assert.equal((await get(f)).data.titleOutlook.sufficientAdditional, '0');
  rows[0].points = '238'; // tied on points, retain unique source ranks, no countback claim
  const outlook = (await get(f)).data.titleOutlook;
  assert.equal(outlook.sufficientAdditional, '151');
  assert.equal(outlook.targetWithinAvailablePoints, false);
});

test('historical decimals retain exact gaps; no2026 rates, final published calendar can establish zero opportunities', async () => {
  const f = fixture(2000, 17);
  const rows = f.repository.sets.get('standings:2000:drivers').items;
  rows[0].points = '340.10';
  rows[1].points = '238.05';
  let body = await get(f);
  assert.equal(body.data.items[1].gapToLeader, '102.05');
  assert.equal(body.data.titleOutlook.reasonCode, 'SCORING_PROFILE_UNAVAILABLE');
  assert.equal(body.data.titleOutlook.remainingMaximum, null);
  f.events.splice(17);
  f.repository.sets.get('events:2000').coverage = 'complete';
  body = await get(f);
  assert.equal(body.data.titleOutlook.remainingMaximum, '0');
  assert.equal(body.data.titleOutlook.sufficientAdditional, null);
});

test('historical tied lower ranks with equal published points preserve all leader gaps', async () => {
  const f = fixture(2000, 1);
  const rows = f.repository.sets.get('standings:2000:drivers').items;
  rows[0].points = '10';
  rows[1].points = '6';
  rows[2].points = '0';
  rows.push({ ...rows[2], id: 'tied-zero', entity: { ...rows[2].entity, id: 'tied-zero' } });
  const body = await get(f);
  assert.deepEqual(
    body.data.items.map((row) => row.gapToLeader),
    ['0', '4', '10', '10'],
  );
  assert.equal(body.data.titleOutlook.reasonCode, 'SCORING_PROFILE_UNAVAILABLE');
});

test('unranked historical zero-point drivers do not invalidate known leader gaps', async () => {
  const f = fixture(2000, 1);
  const rows = f.repository.sets.get('standings:2000:drivers').items;
  rows[0].points = '10';
  rows[1].points = '6';
  rows[2].points = '0';
  rows[2].rank = null;
  assert.deepEqual(
    (await get(f)).data.items.map((row) => row.gapToLeader),
    ['0', '4', '10'],
  );
});

test('title outlook changes validator; equivalent conditional request remains304', async () => {
  const f = fixture();
  const endpoint = '/api/v1/seasons/2026/standings/drivers';
  const first = await request(f.app).get(endpoint).expect(200);
  f.events[17].status = 'cancelled';
  const second = await request(f.app)
    .get(endpoint)
    .set('If-None-Match', first.headers.etag)
    .expect(200);
  assert.notEqual(second.headers.etag, first.headers.etag);
  await request(f.app).get(endpoint).set('If-None-Match', second.headers.etag).expect(304);
});
