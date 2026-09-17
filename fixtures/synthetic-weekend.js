// Deliberately fictional records for deterministic tests. Never production seed data.
const Driver = {
  driverId: 'example-one',
  givenName: 'Example',
  familyName: 'One',
  dateOfBirth: '1990-01-01',
  nationality: 'Example',
};
const Constructor = { constructorId: 'example-team', name: 'Example Team', nationality: 'Example' };
const Circuit = {
  circuitId: 'example-circuit',
  circuitName: 'Example Circuit',
  Location: { lat: '0', long: '0', country: 'Example' },
};
export function syntheticWeekend() {
  const race = {
    season: '2024',
    round: '1',
    raceName: 'Synthetic Grand Prix',
    date: '2024-01-01',
    time: '12:00:00Z',
    Circuit,
    Qualifying: { date: '2023-12-31', time: '12:00:00Z' },
    Results: [
      {
        Driver,
        Constructor,
        number: '1',
        position: '1',
        points: '12.5',
        grid: '1',
        laps: '10',
        status: 'Finished',
        Time: { millis: '600000', time: '10:00.000' },
      },
      {
        Driver: { ...Driver, driverId: 'example-two', familyName: 'Two' },
        Constructor,
        number: '2',
        position: '2',
        points: '8',
        grid: '2',
        laps: '9',
        status: '+1 Lap',
      },
    ],
    QualifyingResults: [
      {
        Driver,
        Constructor,
        number: '1',
        position: '1',
        Q1: '1:00.000',
        Q2: '59.500',
        Q3: '59.000',
      },
    ],
    PitStops: [{ driverId: Driver.driverId, stop: '1', lap: '5', duration: '20.000' }],
    Laps: [{ number: '1', Timings: [{ driverId: Driver.driverId, time: '1:00.000' }] }],
  };
  return {
    calendar: [race],
    race,
    standings: {
      drivers: [{ Driver, Constructors: [Constructor], position: '1', points: '12.5', wins: '1' }],
      constructors: [{ Constructor, position: '1', points: '20.5', wins: '1' }],
    },
    observations: [],
    failures: [],
  };
}
