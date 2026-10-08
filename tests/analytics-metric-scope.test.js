import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalyticsService } from '../src/services/analytics.service.js';
import { MemoryRepository, eventId, sessionId } from './helpers.js';

// Independent arithmetic: race 25 + sprint 8 = published championship 33.
// Only the race result is in the selected result slice; the season is partial.
function fixture() {
  const repository = new MemoryRepository();
  const results = repository.sets.get(`results:${sessionId}`);
  results.items[0].points = '25';
  results.items[1].points = '0';
  results.items.forEach((row) => {
    row.classified = true;
  });
  const sessions = repository.sets.get(`sessions:${eventId}`);
  const sprint = { ...sessions.items[0], id: `${sessionId}:sprint`, kind: 'sprint' };
  sessions.items.push(sprint);
  repository.sets.get(`event:${eventId}`).items[0].sessions.push(sprint);
  repository.sets.set(`results:${sprint.id}`, {
    ...results,
    key: `results:${sprint.id}`,
    items: [{ ...results.items[0], sessionId: sprint.id, points: '8' }],
  });
  for (const key of ['standings:2024:drivers', 'standings:2024:drivers:1']) {
    repository.sets.get(key).items[0].points = '33';
    repository.sets.get(key).items.push({
      ...repository.sets.get(key).items[0],
      id: 'standing:2024:1:driver:example-two',
      entity: results.items[1].entry.drivers[0],
      rank: 2,
      points: '0',
    });
  }
  for (const key of ['standings:2024:constructors', 'standings:2024:constructors:1']) {
    repository.sets.get(key).items[0].points = '33';
  }
  repository.sets.set('profile:driver:archive-only', {
    items: [
      {
        kind: 'driver',
        id: 'driver:archive-only',
        entity: { id: 'driver:archive-only', displayName: 'Archive Only' },
      },
    ],
  });
  const reads = [];
  const get = repository.get.bind(repository);
  repository.get = (key, snapshot) => {
    reads.push({ key, snapshot });
    return get(key);
  };
  return { repository, reads, service: new AnalyticsService(repository) };
}
const dashboard = async (service, query = {}) =>
  (await service.dashboard({ season: 2024, snapshotId: 'synthetic-publication', ...query })).body
    .data.analyticsDashboard;

test('review: disqualified ranking is not a win or podium in comparison metrics', async () => {
  const { service, repository } = fixture();
  const row = repository.sets.get(`results:${sessionId}`).items[0];
  row.status = 'disqualified';
  row.position = 1;
  row.lapsCompleted = 50;
  row.points = '0';
  const nonStart = repository.sets.get(`results:${sessionId}`).items[1];
  nonStart.status = 'not-started';
  nonStart.position = 2;
  nonStart.lapsCompleted = 0;
  const data = await dashboard(service);
  const metrics = data.defaultComparison.drivers[0].metrics;
  assert.equal(data.seasonIntelligence.raceBreakdown.wins, 0);
  assert.equal(metrics.wins, 0);
  assert.equal(metrics.podiums, 0);
  assert.equal(metrics.averageFinish, null);
  assert.deepEqual(metrics.recentForm, []);
  assert.equal(metrics.races, 1); // Published laps still establish a start.
  const dnsMetrics = data.defaultComparison.drivers[1].metrics;
  assert.equal(dnsMetrics.podiums, 0);
  assert.equal(dnsMetrics.races, 0);
});

test('review: rejected standing identities cannot retain a complete coverage claim', async () => {
  const { service, repository } = fixture();
  const set = repository.sets.get('standings:2024:constructors:1');
  set.coverage = 'complete';
  set.items[0].standingSnapshotId = 'standing:2024:2';
  const data = await dashboard(service);
  assert.deepEqual(data.championship.constructors, []);
  assert.equal(data.championship.constructorCoverage, 'unavailable');
});

test('review: unavailable qualifying observations cannot produce paired positions', async () => {
  const { service, repository } = fixture();
  const key = [...repository.sets.keys()].find((key) => key.startsWith('qualifying:'));
  repository.sets.get(key).coverage = 'unavailable';
  const data = await dashboard(service);
  assert.deepEqual(data.qualifyingVsFinish, []);
});

test('UX-01 championship totals come from same-round standings, not race or sprint sums', async () => {
  const { service, reads } = fixture();
  const race = await dashboard(service);
  assert.equal(race.seasonIntelligence.championshipLeader.points, 33);
  assert.equal(race.championship.round, 1);
  assert.equal(race.championship.snapshotId, 'synthetic-publication');
  assert.equal(Number(race.championship.drivers[0].points), 33);
  assert.equal(Number(race.championship.constructors[0].points), 33);
  assert.equal(race.defaultComparison.drivers[0].metrics.points, 25);
  assert.equal(race.pointsProgression.series[0].points[0], 25);
  const sprint = await dashboard(service, { sessionType: 'sprint' });
  assert.equal(sprint.seasonIntelligence.championshipLeader.points, 33);
  assert.equal(sprint.defaultComparison.drivers[0].metrics.points, 8);
  assert.equal(race.analysisScope.coverage, 'partial');
  assert.ok(reads.every((read) => read.snapshot === 'synthetic-publication'));
});

test('UX-01 missing standings never fall back to derived championship totals', async () => {
  const { service, repository } = fixture();
  for (const key of [...repository.sets.keys()])
    if (key.startsWith('standings:')) repository.sets.delete(key);
  const data = await dashboard(service);
  assert.equal(data.seasonIntelligence.championshipLeader, null);
  assert.deepEqual(data.championship.drivers, []);
  assert.equal(data.defaultComparison.drivers[0].metrics.points, 25);
});

test('UX-01 mismatched standing rounds cannot populate a championship panel', async () => {
  const { service, repository } = fixture();
  repository.sets.get('standings:2024:constructors:1').items[0].standingSnapshotId =
    'standing:2024:2';
  const data = await dashboard(service);
  assert.equal(data.championship.round, 1);
  assert.deepEqual(data.championship.constructors, []);
  assert.equal(data.seasonIntelligence.constructorLeader, null);
});

test('UX-02 retirement and classification are independent; DNS DSQ unknown have explicit outcomes', async () => {
  const { service, repository } = fixture();
  const base = repository.sets.get(`results:${sessionId}`).items[0];
  const outcomes = [
    { status: 'finished', position: 1, classified: true, lapsCompleted: 50 },
    { status: 'retired', position: 8, classified: true, lapsCompleted: 46 },
    { status: 'not-started', position: null, classified: false, lapsCompleted: 0 },
    { status: 'disqualified', position: null, classified: false, lapsCompleted: 40 },
    { status: null, position: 9, classified: null, lapsCompleted: null },
    { status: 'withdrawn', position: null, classified: null, lapsCompleted: 0 },
    { status: 'not-classified', position: null, classified: false, lapsCompleted: 12 },
  ];
  repository.sets.get(`results:${sessionId}`).items = outcomes.map((outcome, index) => ({
    ...base,
    ...outcome,
    id: `outcome:${index}`,
    points: '0',
  }));
  const data = await dashboard(service);
  const metrics = data.seasonIntelligence.raceBreakdown;
  assert.equal(metrics.retirements, 1);
  assert.equal(metrics.classified, 2);
  assert.equal(metrics.classificationUnknown, 2);
  assert.equal(metrics.starts, 4);
  assert.equal(metrics.retirementEligibleStarts, 2);
  assert.equal(metrics.nonStarts, 2);
  assert.equal(metrics.disqualified, 1);
  assert.equal(metrics.unknownStatus, 1);
  assert.equal(metrics.otherStatus, 1);
  assert.equal(data.quickStats.retirementRate, 50);
  assert.equal(data.defaultComparison.drivers[0].metrics.retirementRate, 0.5);
  assert.equal(data.defaultComparison.drivers[0].metrics.races, 4);
});

test('UX-02 zero eligible denominator is unavailable, not zero percent', async () => {
  const { service, repository } = fixture();
  repository.sets.get(`results:${sessionId}`).items.forEach((row) => {
    row.status = 'unknown';
    row.lapsCompleted = null;
    row.classified = null;
  });
  const data = await dashboard(service);
  assert.equal(data.quickStats.retirementRate, null);
  assert.equal(data.defaultComparison.drivers[0].metrics.retirementRate, null);
});

test('UX-08 eligible options use published season/session entries, not archive profiles', async () => {
  const { service } = fixture();
  const race = await dashboard(service);
  assert.deepEqual(
    race.filterOptions.drivers.map((row) => row.id),
    ['driver:example-one', 'driver:example-two'],
  );
  const sprint = await dashboard(service, { sessionType: 'sprint' });
  assert.deepEqual(
    sprint.filterOptions.drivers.map((row) => row.id),
    ['driver:example-one'],
  );
});

test('UX-08 invalid slice has no fake series/zero metrics but retains labelled season context', async () => {
  const { service } = fixture();
  const data = await dashboard(service, { driverIds: 'driver:archive-only' });
  assert.equal(data.analysisScope.matchingEntries, 0);
  assert.equal(data.analysisScope.empty, true);
  assert.deepEqual(data.pointsProgression.series, []);
  assert.equal(data.quickStats.totalPoints, null);
  assert.equal(data.quickStats.raceWinnerCount, null);
  assert.equal(data.seasonIntelligence.championshipLeader.points, 33);
  assert.equal(data.seasonIntelligence.latestRace.podium.length, 2);
});

test('UX-08 genuine zero points retain an entry and zero value', async () => {
  const { service } = fixture();
  const data = await dashboard(service, { driverIds: 'driver:example-two' });
  assert.equal(data.analysisScope.empty, false);
  assert.equal(data.quickStats.totalPoints, 0);
  assert.deepEqual(data.pointsProgression.series[0].points, [0]);
});

test('season championship/context stays independent of circuit and round analysis filters', async () => {
  const { service } = fixture();
  const data = await dashboard(service, {
    fromRound: 2,
    toRound: 3,
    circuitIds: 'circuit:missing',
  });
  assert.equal(data.championship.round, 1);
  assert.equal(data.seasonIntelligence.championshipLeader.points, 33);
  assert.equal(data.seasonIntelligence.latestRace.round, 1);
  assert.equal(data.analysisScope.empty, true);
});

test('unavailable result/standing sets cannot publish unexpected items', async () => {
  const { service, repository } = fixture();
  repository.sets.get(`results:${sessionId}`).coverage = 'unavailable';
  repository.sets.get('standings:2024:drivers:1').coverage = 'unavailable';
  const data = await dashboard(service);
  assert.equal(data.analysisScope.empty, true);
  assert.deepEqual(data.championship.drivers, []);
  assert.deepEqual(data.filterOptions.drivers, []);
});

test('missing result points stay null while explicit points do not require a finish position', async () => {
  const { service, repository } = fixture();
  const rows = repository.sets.get(`results:${sessionId}`).items;
  rows.forEach((row) => {
    row.points = null;
  });
  let data = await dashboard(service);
  assert.equal(data.quickStats.totalPoints, null);
  assert.equal(data.defaultComparison.drivers[0].metrics.points, null);
  assert.equal(data.defaultComparison.drivers[0].metrics.pointsPerRace, null);
  assert.equal(data.constructorContribution[0].totalPoints, null);
  rows[0].points = '2.5';
  rows[0].position = null;
  data = await dashboard(service);
  assert.equal(data.defaultComparison.drivers[0].metrics.points, 2.5);
  rows.forEach((row) => {
    row.status = 'not-started';
    row.lapsCompleted = 0;
  });
  data = await dashboard(service);
  assert.equal(data.defaultComparison.drivers[0].metrics.pointsPerRace, null);
});

test('qualifying comparison explicitly counts published entries, not race starts', async () => {
  const { service } = fixture();
  const data = await dashboard(service, { sessionType: 'qualifying' });
  const metrics = data.defaultComparison.drivers[0].metrics;
  assert.equal(metrics.qualifyingEntries, 1);
  assert.equal(metrics.startDefinition, 'published qualifying entries');
  assert.equal(metrics.retirementRate, null);
  assert.equal(metrics.pointsPerRace, null);
});

test('zero constructor result points are a valid total but do not imply a performance lead', async () => {
  const { service } = fixture();
  const data = await dashboard(service, { driverIds: 'driver:example-two' });
  assert.equal(data.constructorContribution[0].totalPoints, 0);
  assert.equal(
    data.insights.some((text) => text.includes('leads the selected')),
    false,
  );
});
