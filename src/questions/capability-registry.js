// This catalogue owns model-visible operations, validation and dispatch.
const raceMetrics = [
  'race_starts',
  'race_wins',
  'podiums',
  'poles',
  'fastest_laps',
  'retirements',
  'disqualifications',
  'did_not_start',
  'did_not_qualify',
  'championships',
];
const sessionMetrics = [
  'weather_summary',
  'rainfall',
  'temperatures',
  'tyre_compounds',
  'tyre_stints',
  'tyre_laps',
  'race_control_events',
  'safety_car_events',
  'red_flag_events',
  'overtakes',
  'most_overtakes',
  'fastest_speed',
];
const operation = (executor, description, options = {}) => {
  const entities = options.entities || [];
  const allowedEntities = options.allowedEntities || entities;
  return {
    executor,
    description,
    entities,
    allowedEntities,
    metrics: [],
    sessions: ['race'],
    scopes: ['event', 'season', 'career'],
    years: true,
    partial: true,
    datasets: ['results:'],
    filters: ['fromYear', 'toYear', 'sessionKind', 'scope'],
    ...options,
  };
};
export const capabilities = Object.freeze({
  event_winner: operation('eventWinner', 'Winner of one named Grand Prix.', {
    metrics: ['race_wins'],
    allowedEntities: ['eventName'],
    call: 'event',
  }),
  event_circuit: operation('eventCircuit', 'Circuit which hosted one named Grand Prix.', {
    allowedEntities: ['eventName'],
    call: 'eventPlan',
    datasets: ['events:'],
  }),
  constructor_points_leaderboard: operation(
    'constructorPointsLeaderboard',
    'Constructor with most published championship points for one season, preserving ties.',
    { scopes: ['season'], metrics: ['points'], datasets: ['standings:'] },
  ),
  season_champion: operation(
    'seasonChampion',
    'Published drivers championship outcome or current leader for one season.',
    { metrics: ['championships'], scopes: ['season'], datasets: ['standings:'] },
  ),
  constructor_championship_leaderboard: operation(
    'constructorChampionshipLeaderboard',
    'Most constructors titles across a completed-season period.',
    { metrics: ['constructors_titles'], scopes: ['season'], datasets: ['standings:'] },
  ),
  constructor_rivalry_comparison: operation(
    'constructorRivalryComparison',
    'Closest championship-winning constructors by normalized race-win and title gaps.',
    { metrics: ['constructor_rivalry'], scopes: ['season'], datasets: ['standings:', 'results:'] },
  ),
  driver_constructor_race_starts: operation(
    'driverConstructorStarts',
    'Driver starts or seasons with one constructor.',
    { entities: ['driverName', 'constructorName'], metrics: ['race_starts', 'seasons'] },
  ),
  driver_constructor_count: operation(
    'driverConstructorCount',
    'Number of distinct published constructors for a driver.',
    { entities: ['driverName'] },
  ),
  driver_constructor_breakdown: operation(
    'driverConstructorBreakdown',
    'Driver race starts grouped by constructor.',
    { entities: ['driverName'] },
  ),
  driver_constructor_comparison: operation(
    'driverConstructorComparison',
    'Driver starts, wins, podiums and points for two named constructors.',
    { entities: ['driverName', 'constructorNames'] },
  ),
  driver_first_race: operation('driverRaceBoundary', 'First published race start for a driver.', {
    metrics: ['race_starts'],
    entities: ['driverName'],
    call: 'raceBoundary',
    direction: 'first',
  }),
  driver_last_race: operation('driverRaceBoundary', 'Latest published race start for a driver.', {
    metrics: ['race_starts'],
    entities: ['driverName'],
    call: 'raceBoundary',
    direction: 'last',
  }),
  driver_first_win: operation('driverWinBoundary', 'First published race win for a driver.', {
    metrics: ['race_wins'],
    entities: ['driverName'],
    call: 'winBoundary',
    direction: 'first',
  }),
  driver_last_win: operation('driverWinBoundary', 'Latest published race win for a driver.', {
    metrics: ['race_wins'],
    entities: ['driverName'],
    call: 'winBoundary',
    direction: 'last',
  }),
  driver_race_wins: operation(
    'driverRaceWins',
    'Count a drivers race wins, excluding Sprint wins.',
    { entities: ['driverName'], metrics: ['race_wins'] },
  ),
  driver_race_wins_season: operation(
    'driverRaceWinsSeason',
    'Count driver race wins over an inclusive year or year range.',
    { entities: ['driverName'], metrics: ['race_wins'] },
  ),
  driver_race_wins_comparison: operation(
    'driverRaceWinsComparison',
    'Compare two drivers race wins over the same inclusive period.',
    { entities: ['driverName', 'comparisonDriverName'], metrics: ['race_wins'] },
  ),
  driver_finishing_position: operation(
    'driverFinishingPosition',
    'Drivers with most race finishes at one exact finishing position, preserving ties.',
    { filters: ['fromYear', 'toYear', 'sessionKind', 'scope', 'position'] },
  ),
  driver_stat: operation(
    'driverStat',
    'Count one drivers published metric over an inclusive period.',
    { entities: ['driverName'], metrics: raceMetrics },
  ),
  event_podium: operation('eventPodium', 'Top three finishers in one Grand Prix.', {
    metrics: ['podiums'],
    allowedEntities: ['eventName'],
    call: 'event',
  }),
  event_compound_summary: operation(
    'eventCompoundSummary',
    'One Grand Prix podium, constructors, points and fastest lap.',
    { allowedEntities: ['eventName'], call: 'compound' },
  ),
  fastest_lap_leaderboard: operation(
    'fastestLapLeaderboard',
    'Drivers with most race fastest laps and constructor breakdown, preserving ties.',
    { metrics: ['fastest_laps'], call: 'leaderboard' },
  ),
  podium_leaderboard: operation(
    'podiumLeaderboard',
    'Drivers with most race podiums and constructor breakdown, preserving ties.',
    { metrics: ['podiums'], call: 'leaderboard' },
  ),
  race_win_leaderboard: operation(
    'raceWinLeaderboard',
    'Drivers with most race wins and constructor breakdown, preserving ties.',
    { metrics: ['race_wins'], call: 'leaderboard' },
  ),
  event_pole: operation('eventPole', 'Qualifying pole for one Grand Prix.', {
    metrics: ['poles'],
    allowedEntities: ['eventName'],
    call: 'event',
    sessions: ['qualifying'],
    datasets: ['qualifying:'],
  }),
  event_fastest_lap: operation('eventFastestLap', 'Fastest race lap for one Grand Prix.', {
    metrics: ['fastest_laps'],
    allowedEntities: ['eventName'],
    call: 'event',
  }),
  event_pit_stops: operation(
    'eventPitStops',
    'Published race pit-stop count, most stops or fastest duration.',
    {
      allowedEntities: ['eventName', 'driverName'],
      call: 'eventPlan',
      metrics: ['pit_stops', 'most_pit_stops', 'fastest_pit_stop'],
      datasets: ['pit-stops:'],
    },
  ),
  event_session_metric: operation(
    'eventSessionMetric',
    'Published weather, tyres, race-control, overtakes or bounded speed summary for an event or circuit.',
    {
      allowedEntities: ['eventName', 'circuitName', 'driverName', 'comparisonDriverName'],
      filters: [
        'fromYear',
        'toYear',
        'comparisonFromYear',
        'comparisonToYear',
        'sessionKind',
        'scope',
      ],
      metrics: sessionMetrics,
      scopes: ['event', 'circuit'],
      sessions: ['race', 'qualifying', 'sprint', 'practice'],
      call: 'session',
      datasets: ['weather:', 'stints:', 'race-control:', 'overtakes:', 'telemetry:'],
    },
  ),
  circuit_race_winners: operation(
    'circuitRaceWinners',
    'Latest N published race winners at one circuit.',
    {
      entities: ['circuitName'],
      filters: ['fromYear', 'toYear', 'sessionKind', 'scope', 'limit'],
      scopes: ['circuit'],
      call: 'history',
    },
  ),
  country_race_winners: operation(
    'countryRaceWinners',
    'Latest N published race winners across circuits in a country.',
    {
      entities: ['countryName'],
      filters: ['fromYear', 'toYear', 'sessionKind', 'scope', 'limit'],
      scopes: ['country'],
      call: 'history',
    },
  ),
  unsupported: operation(null, 'Request outside the registered archive capabilities.', {
    sessions: [],
    scopes: [],
    datasets: [],
  }),
});

export function capabilityCatalogue() {
  return Object.entries(capabilities).map(([intent, capability]) => ({
    intent,
    description: capability.description,
    requiredEntities: capability.entities,
    allowedEntities: capability.allowedEntities,
    allowedFilters: capability.filters,
    metrics: capability.metrics,
    sessions: capability.sessions,
    scopes: capability.scopes,
    yearRanges: capability.years,
    datasets: capability.datasets,
  }));
}

export function dispatchPlan(service, plan, context, helpers, text) {
  const capability = capabilities[plan.intent];
  const execute = service[capability.executor]?.bind(service);
  if (!execute)
    return service.result(
      {
        status: 'unsupported',
        message: 'That question is not supported by the archive query layer yet.',
        reasonCode: 'QUESTION_INTENT_UNSUPPORTED',
      },
      [],
    );
  switch (capability.call) {
    case 'event':
      return execute(plan.eventName, context, text, helpers);
    case 'eventPlan':
      return execute(plan, context, text, helpers);
    case 'raceBoundary':
    case 'winBoundary':
      return execute(plan, helpers, capability.direction);
    case 'compound':
    case 'leaderboard':
      return execute(context, text, helpers);
    case 'history':
      return execute(plan, helpers);
    case 'session':
      return plan.scope === 'circuit' || plan.circuitName
        ? service.circuitSessionMetric(plan, context, text, helpers)
        : execute(plan, context, text, helpers);
    default:
      return execute(plan, context, helpers, text);
  }
}
