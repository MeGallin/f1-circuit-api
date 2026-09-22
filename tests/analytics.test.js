import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { appFixture } from './helpers.js';

test('analytics dashboard is built from the published archive snapshot', async () => {
  const { app } = appFixture();
  const response = await request(app)
    .get('/api/v1/analytics/dashboard')
    .query({ season: 2024, fromRound: 1, toRound: 1 })
    .expect(200);

  const dashboard = response.body.data.analyticsDashboard;
  assert.equal(response.body.meta.snapshotId, 'synthetic-publication');
  assert.equal(dashboard.filters.season, 2024);
  assert.equal(dashboard.quickStats.totalEvents, 1);
  assert.equal(dashboard.quickStats.completedEvents, 1);
  assert.equal(dashboard.pointsProgression.events[0].name, 'Synthetic Grand Prix');
  assert.equal(dashboard.pointsProgression.series[0].points[0], 12.5);
  assert.equal(dashboard.qualifyingVsFinish[0].qualifyingPosition, 1);
  assert.equal(dashboard.qualifyingVsFinish[0].finishPosition, 1);
  assert.equal(dashboard.constructorContribution[0].constructorName, 'Example Team');
  assert.equal(dashboard.circuitPerformance.circuits[0].name, 'Example Circuit');
  assert.ok(dashboard.defaultComparison.drivers.length >= 1);
});

test('analytics dashboard exposes published season intelligence for the overview band', async () => {
  const { app } = appFixture();
  const response = await request(app)
    .get('/api/v1/analytics/dashboard')
    .query({ season: 2024 })
    .expect(200);

  const intelligence = response.body.data.analyticsDashboard.seasonIntelligence;
  assert.equal(intelligence.progress.totalEvents, 1);
  assert.equal(intelligence.progress.completedEvents, 1);
  assert.equal(intelligence.latestRace.name, 'Synthetic Grand Prix');
  assert.equal(intelligence.latestRace.podium[0].position, 1);
  assert.equal(intelligence.latestRace.podium[0].driverName, 'Example One');
  assert.equal(intelligence.latestRace.podium[0].constructorName, 'Example Team');
  assert.equal(intelligence.championshipLeader.driverName, 'Example One');
  assert.equal(intelligence.championshipLeader.points, 12.5);
  assert.equal(intelligence.raceBreakdown.entries, 2);
  assert.equal(intelligence.raceBreakdown.wins, 1);
  assert.equal(intelligence.raceBreakdown.podiums, 2);
  assert.equal(response.body.data.analyticsDashboard.insights.length, 4);
});

test('analytics dashboard respects driver and circuit filters', async () => {
  const { app } = appFixture();
  const response = await request(app)
    .get('/api/v1/analytics/dashboard')
    .query({
      season: 2024,
      driverIds: 'driver:example-one',
      circuitIds: 'circuit:example-circuit',
    })
    .expect(200);

  const dashboard = response.body.data.analyticsDashboard;
  assert.deepEqual(dashboard.filters.driverIds, ['driver:example-one']);
  assert.deepEqual(dashboard.filters.circuitIds, ['circuit:example-circuit']);
  assert.equal(dashboard.pointsProgression.series.length, 1);
  assert.equal(dashboard.pointsProgression.series[0].driverId, 'driver:example-one');
  assert.ok(dashboard.qualifyingVsFinish.every((row) => row.driverId === 'driver:example-one'));
});

test('driver comparison returns the requested metric set from race results', async () => {
  const { app } = appFixture();
  const response = await request(app)
    .get('/api/v1/analytics/driver-comparison')
    .query({
      season: 2024,
      drivers: 'driver:example-one,driver:example-two',
    })
    .expect(200);

  const comparison = response.body.data.driverComparison;
  assert.deepEqual(
    comparison.drivers.map((driver) => driver.id),
    ['driver:example-one', 'driver:example-two'],
  );
  assert.equal(comparison.drivers[0].metrics.wins, 1);
  assert.equal(comparison.drivers[0].metrics.podiums, 1);
  assert.equal(comparison.drivers[0].metrics.positionsGained, 0);
  assert.equal(comparison.drivers[1].metrics.positionsGained, 0);
});

test('analytics rejects malformed filter ranges', async () => {
  const { app } = appFixture();
  await request(app)
    .get('/api/v1/analytics/dashboard')
    .query({ season: 2024, fromRound: 4, toRound: 1 })
    .expect(400);
});
