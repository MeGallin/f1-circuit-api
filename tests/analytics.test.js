import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { appFixture, sessionId } from './helpers.js';

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
  assert.equal(dashboard.quickStats.raceWinnerCount, 1);
  assert.equal(dashboard.quickStats.podiumDriverCount, 2);
  assert.equal(dashboard.quickStats.publishedStarts, 2);
  assert.equal(dashboard.quickStats.fastestLapCount, 0);
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
  assert.equal(intelligence.championshipLeader.position, 1);
  assert.equal(intelligence.championshipLeader.number, '1');
  assert.equal(intelligence.championshipLeader.points, 12.5);
  assert.deepEqual(intelligence.championshipLeader.recentForm, [1]);
  assert.equal(intelligence.raceBreakdown.entries, 2);
  assert.equal(intelligence.raceBreakdown.wins, 1);
  assert.equal(intelligence.raceBreakdown.podiums, 2);
  assert.equal(intelligence.latestRace.results.length, 2);
  assert.equal(intelligence.latestRace.results[0].gridPosition, 1);
  const dashboard = response.body.data.analyticsDashboard;
  assert.equal(dashboard.weekendTimeline.length, 1);
  assert.equal(dashboard.weekendTimeline[0].completed, true);
  assert.equal(dashboard.weekendTimeline[0].winner.driverName, 'Example One');
  assert.equal(response.body.data.analyticsDashboard.quickStats.podiumRate, 100);
  assert.equal(response.body.data.analyticsDashboard.quickStats.dnfRate, 0);
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

test('circuit performance excludes scheduled circuits until published results exist', async () => {
  const { app, repository } = appFixture();
  const events = repository.sets.get('events:2024');
  const completedEvent = events.items[0];
  const futureEventId = 'event:2024:future-grand-prix';
  const futureSessionId = `session:${futureEventId}:race`;
  const sessions = repository.sets.get(`sessions:${completedEvent.id}`);
  const results = repository.sets.get(`results:session:${completedEvent.id}:race`);
  events.items.push({
    ...completedEvent,
    id: futureEventId,
    name: 'Future Grand Prix',
    round: 2,
    status: 'scheduled',
    circuit: {
      ...completedEvent.circuit,
      id: 'circuit:future-circuit',
      displayName: 'Future Circuit',
    },
    schedule: { date: '2024-06-01', startsAt: '2024-06-01T12:00:00Z' },
  });
  repository.sets.set(`sessions:${futureEventId}`, {
    ...sessions,
    key: `sessions:${futureEventId}`,
    items: sessions.items.map((session) => ({
      ...session,
      id: `session:${futureEventId}:${session.kind}`,
      eventId: futureEventId,
      status: 'scheduled',
    })),
  });
  repository.sets.set(`results:${futureSessionId}`, {
    ...results,
    key: `results:${futureSessionId}`,
    items: results.items.map((row) => ({
      ...row,
      id: row.id.replace(completedEvent.id, futureEventId),
      sessionId: futureSessionId,
      position: null,
      publishedOrder: null,
      points: null,
      status: 'not-started',
    })),
  });

  const response = await request(app)
    .get('/api/v1/analytics/dashboard')
    .query({ season: 2024 })
    .expect(200);

  const dashboard = response.body.data.analyticsDashboard;
  assert.deepEqual(
    dashboard.circuitPerformance.circuits.map((circuit) => circuit.id),
    ['circuit:example-circuit'],
  );
  assert.equal(
    dashboard.circuitPerformance.cells.some((cell) => cell.circuitId === 'circuit:future-circuit'),
    false,
  );
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

test('analytics dashboard exposes latest-session evidence when published', async () => {
  const { app, repository } = appFixture();
  const exampleOneEntry = `entry:${sessionId}:example-one`;
  const exampleTwoEntry = `entry:${sessionId}:example-two`;
  repository.sets.set(`weather:${sessionId}`, {
    coverage: 'partial',
    items: [
      { airTemperatureC: 24, trackTemperatureC: 41, humidityPercent: 55, rainfall: false },
      { airTemperatureC: 26, trackTemperatureC: 44, humidityPercent: 51, rainfall: true },
    ],
  });
  repository.sets.set(`stints:${sessionId}`, {
    coverage: 'partial',
    items: [
      {
        entryId: exampleOneEntry,
        sequence: 1,
        startLap: 1,
        endLap: 5,
        compoundLabel: 'Medium',
        compoundClass: 'medium',
      },
      {
        entryId: exampleOneEntry,
        sequence: 2,
        startLap: 6,
        endLap: 10,
        compoundLabel: 'Hard',
        compoundClass: 'hard',
      },
    ],
  });
  repository.sets.set(`pit-stops:${sessionId}`, {
    coverage: 'partial',
    items: [{ entryId: exampleOneEntry, sequence: 1, lap: 5, stationaryDurationMs: 2100 }],
  });
  repository.sets.set(`overtakes:${sessionId}`, {
    coverage: 'partial',
    items: [
      { passingEntryId: exampleOneEntry, passedEntryId: exampleTwoEntry },
      { passingEntryId: exampleOneEntry, passedEntryId: exampleTwoEntry },
    ],
  });
  repository.sets.set(`race-control:${sessionId}`, {
    coverage: 'partial',
    items: [{ category: 'Flag', flag: 'yellow', message: 'Yellow flag' }],
  });

  const response = await request(app)
    .get('/api/v1/analytics/dashboard')
    .query({ season: 2024 })
    .expect(200);

  const highlights = response.body.data.analyticsDashboard.latestSessionHighlights;
  assert.equal(highlights.sessionId, sessionId);
  assert.equal(highlights.weather.observations, 2);
  assert.deepEqual(highlights.weather.airTemperatureC, { min: 24, max: 26, average: 25 });
  assert.equal(highlights.weather.rainfallObservations, 1);
  assert.equal(highlights.tyres.drivers[0].driverName, 'Example One');
  assert.deepEqual(highlights.tyres.drivers[0].compounds, ['Medium', 'Hard']);
  assert.equal(highlights.pitStops.count, 1);
  assert.equal(highlights.overtakes.count, 2);
  assert.equal(highlights.overtakes.leaders[0].driverName, 'Example One');
  assert.equal(highlights.raceControl.flagEvents, 1);
});

test('analytics rejects malformed filter ranges', async () => {
  const { app } = appFixture();
  await request(app)
    .get('/api/v1/analytics/dashboard')
    .query({ season: 2024, fromRound: 4, toRound: 1 })
    .expect(400);
});
