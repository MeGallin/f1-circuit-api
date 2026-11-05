// Versioned planner/executor contract corpus. These are realistic question
// variants paired with independently specified plans, NOT a live LLM benchmark.
export const PIPELINE_CORPUS_VERSION = '2026-11-04.1';
const eventName = 'Synthetic Grand Prix';
const driverName = 'Example One';
const constructorName = 'Example Team';
const families = [
  [
    'event_winner',
    { eventName },
    'answered',
    [
      'Who won the 2024 Synthetic Grand Prix?',
      'Who was the winner of the Synthetic Grand Prix in 2024?',
      'Name the driver who won the 2024 Synthetic GP.',
      'Which driver took victory at the Synthetic Grand Prix in 2024?',
    ],
  ],
  [
    'event_circuit',
    { eventName },
    'answered',
    [
      'Which circuit hosted the 2024 Synthetic Grand Prix?',
      'Where was the Synthetic Grand Prix held in 2024?',
      'Name the venue for the Synthetic GP in 2024.',
      'What track hosted the 2024 Synthetic Grand Prix?',
    ],
  ],
  [
    'season_champion',
    {},
    'answered',
    [
      'Who won the 2024 World Championship?',
      'Who led the published drivers standings for 2024?',
      'What is the published drivers championship outcome for 2024?',
      'Name the driver ranked first in the 2024 championship standings.',
    ],
  ],
  [
    'constructor_points_leaderboard',
    { metric: 'points' },
    'answered',
    [
      'Which constructor scored the most points in 2024?',
      'Who led the 2024 constructor points table?',
      'Which manufacturer had the highest championship points in 2024?',
      'Name the team with the largest published points total in 2024.',
    ],
  ],
  [
    'constructor_championship_leaderboard',
    { metric: 'constructors_titles' },
    'unavailable',
    [
      'Which constructor won the most titles in 2024?',
      'Which manufacturer has the most world championships for 2024?',
      'Rank teams by final championship wins in 2024.',
      'Who topped the constructor title count in 2024?',
    ],
  ],
  [
    'constructor_rivalry_comparison',
    { metric: 'constructor_rivalry' },
    'unavailable',
    [
      'Which two constructors were closest in wins and titles in 2024?',
      'Compare the closest championship rivals by race victories and titles for 2024.',
      'What was the closest two-team rivalry in wins and championships in 2024?',
      'Find the smallest combined gap in constructor wins and titles in 2024.',
    ],
  ],
  [
    'driver_constructor_race_starts',
    { driverName, constructorName, metric: 'race_starts' },
    'answered',
    [
      'How many races did Example One start for Example Team in 2024?',
      'Count Example One race starts with Example Team in 2024.',
      'How often did Example One race for Example Team during 2024?',
      'What is Example One published participation count for Example Team in 2024?',
    ],
  ],
  [
    'driver_constructor_count',
    { driverName },
    'answered',
    [
      'How many constructors did Example One race for in 2024?',
      'How many distinct teams did Example One represent during 2024?',
      'Count the manufacturers Example One drove for in 2024.',
      'How many different constructors appear for Example One in 2024?',
    ],
  ],
  [
    'driver_constructor_breakdown',
    { driverName },
    'answered',
    [
      'How many races did Example One start for each constructor in 2024?',
      'Break down Example One race starts by team in 2024.',
      'Show Example One participation under every manufacturer in 2024.',
      'Group Example One race starts by constructor for 2024.',
    ],
  ],
  [
    'driver_constructor_comparison',
    { driverName, constructorNames: ['Example Team', 'Unknown Team'] },
    'clarification',
    [
      'Compare Example One at Example Team and Unknown Team in 2024.',
      'How did Example One race statistics differ for Example Team versus Unknown Team in 2024?',
      'Compare starts, wins and points for Example One with Example Team and Unknown Team in 2024.',
      'Show Example One statistics between Example Team and Unknown Team during 2024.',
    ],
  ],
  [
    'driver_first_race',
    { driverName },
    'answered',
    [
      'When was Example One first race in 2024?',
      'What was Example One earliest published start of 2024?',
      'Which event was Example One debut within 2024?',
      'Name Example One first Grand Prix start in 2024.',
    ],
  ],
  [
    'driver_last_race',
    { driverName },
    'answered',
    [
      'When was Example One last race in 2024?',
      'What was Example One most recent Grand Prix of 2024?',
      'Which race was Example One final published start in 2024?',
      'Name the latest 2024 event Example One started.',
    ],
  ],
  [
    'driver_first_win',
    { driverName },
    'answered',
    [
      'When was Example One first win in 2024?',
      'Which race gave Example One the earliest 2024 victory?',
      'Name Example One first winning Grand Prix of 2024.',
      'What was the first published 2024 victory for Example One?',
    ],
  ],
  [
    'driver_last_win',
    { driverName },
    'answered',
    [
      'When was Example One last win in 2024?',
      'What was Example One latest victory of 2024?',
      'Which Grand Prix was Example One most recent 2024 win?',
      'Name Example One final published winning race in 2024.',
    ],
  ],
  [
    'driver_race_wins',
    { driverName, metric: 'race_wins' },
    'answered',
    [
      'How many wins does Example One have in the 2024 archive?',
      'Count Example One race victories for 2024.',
      'What is Example One published race win tally in 2024?',
      'How often did Example One win a race during 2024?',
    ],
  ],
  [
    'driver_race_wins_season',
    { driverName, metric: 'race_wins' },
    'answered',
    [
      'How many races did Example One win in 2024?',
      'How many victories did Example One take during the 2024 season?',
      'What was Example One race victory total for 2024?',
      'Count the Grand Prix wins credited to Example One in 2024.',
    ],
  ],
  [
    'driver_race_wins_comparison',
    { driverName, comparisonDriverName: 'Example Two', metric: 'race_wins' },
    'answered',
    [
      'Compare Example One and Example Two on race wins in 2024.',
      'How many 2024 victories did Example One have versus Example Two?',
      'Compare the 2024 race win totals of Example One and Example Two.',
      'Did Example One win more races than Example Two in 2024?',
    ],
  ],
  [
    'driver_finishing_position',
    { position: 2 },
    'answered',
    [
      'Which driver has the most second-place finishes in 2024?',
      'Who finished second most often in 2024?',
      'Which driver recorded the highest count of position 2 finishes in 2024?',
      'Who had the most runner-up race results in 2024?',
    ],
  ],
  [
    'driver_stat',
    { driverName, metric: 'podiums' },
    'answered',
    [
      'How many podiums did Example One take in 2024?',
      'Count Example One top-three race finishes in 2024.',
      'What was Example One podium total for 2024?',
      'How often did Example One finish on the podium during 2024?',
    ],
  ],
  [
    'event_podium',
    { eventName },
    'answered',
    [
      'Who was on the podium at the 2024 Synthetic Grand Prix?',
      'Name the top three finishers at the Synthetic GP in 2024.',
      'Which drivers finished first, second and third at the 2024 Synthetic Grand Prix?',
      'Show the 2024 Synthetic Grand Prix podium.',
    ],
  ],
  [
    'event_compound_summary',
    { eventName },
    'answered',
    [
      'Show the podium, constructors, points and fastest lap for the 2024 Synthetic Grand Prix.',
      'Who finished top three, with teams and points, and set the fastest lap at the 2024 Synthetic GP?',
      'Summarize the 2024 Synthetic GP podium with manufacturer, points and fastest lap.',
      'Give the top-three drivers, their constructors and points plus fastest lap at the Synthetic Grand Prix in 2024.',
    ],
  ],
  [
    'fastest_lap_leaderboard',
    {},
    'unavailable',
    [
      'Who set the most fastest laps in 2024?',
      'Which driver led the race fastest-lap count in 2024?',
      'Rank the 2024 drivers by published race fastest laps.',
      'Who recorded the greatest number of fastest race laps during 2024?',
    ],
  ],
  [
    'podium_leaderboard',
    {},
    'answered',
    [
      'Which driver had the most podiums in 2024?',
      'Who led the top-three finish count for 2024?',
      'Rank drivers by podium finishes in 2024.',
      'Who finished on the race podium most often in 2024?',
    ],
  ],
  [
    'race_win_leaderboard',
    {},
    'answered',
    [
      'Which driver won the most races in 2024?',
      'Who had the highest race victory count for 2024?',
      'Rank drivers by Grand Prix wins in 2024.',
      'Who recorded the most race victories during 2024?',
    ],
  ],
  [
    'event_pole',
    { eventName, sessionKind: 'qualifying' },
    'answered',
    [
      'Who took pole at the 2024 Synthetic Grand Prix?',
      'Who qualified first for the Synthetic GP in 2024?',
      'Name the polesitter at the 2024 Synthetic Grand Prix.',
      'Which driver led qualifying for the Synthetic Grand Prix in 2024?',
    ],
  ],
  [
    'event_fastest_lap',
    { eventName },
    'unavailable',
    [
      'Who set the fastest lap at the 2024 Synthetic Grand Prix?',
      'Which driver had the fastest race lap in the Synthetic GP in 2024?',
      'Name the fastest lap driver at the Synthetic Grand Prix of 2024.',
      'What is the published fastest race lap for the 2024 Synthetic Grand Prix?',
    ],
  ],
  [
    'event_pit_stops',
    { eventName, metric: 'pit_stops' },
    'answered',
    [
      'How many pit stops were recorded at the 2024 Synthetic Grand Prix?',
      'Count the published pit stops for the Synthetic GP in 2024.',
      'What is the total number of stops at the 2024 Synthetic Grand Prix?',
      'Show the published pit-stop total for the Synthetic Grand Prix in 2024.',
    ],
  ],
  [
    'event_session_metric',
    { eventName, metric: 'weather_summary' },
    'unavailable',
    [
      'What was the weather at the 2024 Synthetic Grand Prix?',
      'Summarize published weather observations at the Synthetic GP in 2024.',
      'What conditions were recorded during the 2024 Synthetic Grand Prix race?',
      'Show the weather summary for the Synthetic Grand Prix in 2024.',
    ],
  ],
  [
    'circuit_race_winners',
    { circuitName: 'Example Circuit', scope: 'circuit', limit: 3 },
    'answered',
    [
      'Who won the last three races at Example Circuit in 2024?',
      'List the three latest 2024 race winners at Example Circuit.',
      'Which drivers won the most recent three Grands Prix at Example Circuit in 2024?',
      'Show up to three published winners at Example Circuit for 2024.',
    ],
  ],
  [
    'country_race_winners',
    { countryName: 'Example', scope: 'country', limit: 3 },
    'answered',
    [
      'Who won the last three races in Example in 2024?',
      'List up to three latest 2024 Grand Prix winners in Example.',
      'Which drivers won the most recent races across Example in 2024?',
      'Show the latest three published race winners in the country Example for 2024.',
    ],
  ],
  [
    'unsupported',
    {},
    'unsupported',
    [
      'What is the best racing game in 2024?',
      'Predict every race winner for 2024.',
      'Who deserved to win the 2024 championship?',
      'Explain the private team strategy discussions from 2024.',
    ],
  ],
];

export const pipelineCorpus = families.flatMap(([intent, fields, status, questions]) =>
  questions.map((text, index) => ({
    id: `${intent}-${index + 1}`,
    text,
    plan: { intent, fromYear: 2024, toYear: 2024, ...fields },
    status,
  })),
);
