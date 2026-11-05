import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionService } from '../src/services/question.service.js';
import { questionIntentSchema } from '../src/providers/openai/question-interpreter.js';
import { MemoryRepository } from './helpers.js';
import { validatePlan } from '../src/questions/query-plan-schema.js';
import { StandingOutlookService } from '../src/services/standing-outlook.service.js';
import { validateSchema } from '../src/schemas/contract.js';

function fixture() {
  const repository = new MemoryRepository();
  const base = repository.sets.get('profile:driver:example-one');
  for (const [id, name] of [
    ['max', 'Max Verstappen'],
    ['jos', 'Jos Verstappen'],
    ['michael', 'Michael Schumacher'],
    ['ralf', 'Ralf Schumacher'],
  ]) {
    repository.sets.set(`profile:driver:${id}`, {
      ...base,
      key: `profile:driver:${id}`,
      items: [
        {
          ...base.items[0],
          id: `driver:${id}`,
          entity: { ...base.items[0].entity, id: `driver:${id}`, displayName: name },
          aliases: [name.split(' ').at(-1)],
        },
      ],
    });
  }
  const source = [...repository.sets.values()].find((set) => set.key.startsWith('results:'));
  for (const [year, driver, position] of [
    [2022, 'max', 1],
    [2023, 'max', 1],
    [2000, 'jos', 2],
  ]) {
    const sessionId = `session:event:${year}:example:race`;
    repository.sets.set(`results:${sessionId}`, {
      ...source,
      key: `results:${sessionId}`,
      evidenceId: `evidence:${year}`,
      items: [
        {
          ...source.items[0],
          id: `result:${year}`,
          sessionId,
          position,
          entry: {
            ...source.items[0].entry,
            drivers: [
              {
                id: `driver:${driver}`,
                displayName: driver === 'max' ? 'Max Verstappen' : 'Jos Verstappen',
              },
            ],
          },
        },
      ],
    });
    if (year === 2023)
      repository.sets.get(`results:${sessionId}`).items.push({
        ...source.items[1],
        sessionId,
        position: 2,
        entry: {
          ...source.items[1].entry,
          drivers: [{ id: 'driver:example-one', displayName: 'Example One' }],
        },
      });
  }
  return repository;
}

async function ask(text, { repository = fixture(), interpreter, context = {} } = {}) {
  const service = new QuestionService(repository, { interpreter });
  return service.answer(
    { text, context },
    {
      snapshot: { id: repository.id },
      get: repository.get.bind(repository),
      keys: repository.keys.bind(repository),
    },
  );
}

test('resolving a named driver does not discard a real metric clarification', async () => {
  const message = 'Do you mean race wins or championships?';
  const answer = await ask('How successful was Max Verstappen in 2023?', {
    interpreter: {
      async interpret() {
        return {
          intent: 'driver_stat',
          driverName: 'Max Verstappen',
          metric: 'race_wins',
          clarificationNeeded: true,
          clarificationMessage: message,
        };
      },
    },
  });
  assert.equal(answer.result.status, 'clarification');
  assert.equal(answer.result.message, message);
});

test('a supplied ambiguous entity is recoverable when its clarification is exclusively about that entity', async () => {
  const answer = await ask('How many victories did Verstappen take in 2023?', {
    interpreter: {
      async interpret() {
        return {
          intent: 'driver_race_wins_season',
          driverName: 'Verstappen',
          clarificationNeeded: true,
          clarificationMessage: 'Which Verstappen?',
        };
      },
    },
  });
  assert.equal(answer.result.status, 'answered');
  assert.equal(answer.result.values.count, 1);
});

test('an inverted directional question is not silently answered over the sorted range', async () => {
  const answer = await ask('How many races did Max Verstappen win from 2023 to 2022?');
  assert.equal(answer.result.status, 'clarification');
  assert.match(answer.result.message, /beginning|start|order/i);
});

test('unordered between endpoints retain the inclusive range', async () => {
  const answer = await ask('How many races did Max Verstappen win between 2023 and 2022?');
  assert.equal(answer.result.status, 'answered');
  assert.equal(answer.result.values.count, 2);
});

test('driver title counts disclose missing requested seasons instead of implying a complete zero', async () => {
  const repository = fixture();
  const service = new QuestionService(repository, {
    interpreter: {
      async interpret() {
        return { intent: 'driver_stat', driverName: 'Example One', metric: 'championships' };
      },
    },
  });
  // The fixture publishes only 2024 standings; the independent requested set is
  // [2023, 2024]. Isolate finality, already covered by dedicated calendar tests.
  service.championshipStatus = async () => 'final';
  const response = await service.answer(
    { text: 'How many championships did Example One win from 2023 to 2024?' },
    {
      snapshot: { id: repository.id },
      get: repository.get.bind(repository),
      keys: repository.keys.bind(repository),
    },
  );
  assert.equal(response.result.status, 'answered');
  assert.equal(response.result.values.coverage, 'partial');
  assert.deepEqual(response.result.values.missingYears, [{ year: 2023 }]);
  assert.match(response.result.values.answer, /missing|unfinished/i);
});

test('driver absent from every finalized standing is unavailable rather than a zero title count', async () => {
  const repository = fixture();
  const service = new QuestionService(repository, {
    interpreter: {
      async interpret() {
        return { intent: 'driver_stat', driverName: 'Max Verstappen', metric: 'championships' };
      },
    },
  });
  service.championshipStatus = async () => 'final';
  const response = await service.answer(
    { text: 'How many championships did Max Verstappen win in 2024?' },
    {
      snapshot: { id: repository.id },
      get: repository.get.bind(repository),
      keys: repository.keys.bind(repository),
    },
  );
  assert.equal(response.result.status, 'unavailable');
  assert.equal(response.result.values?.count, undefined);
});

test('the no-model fast path never substitutes race wins for championship wins', async () => {
  const response = await ask('How many championships did Max Verstappen win in 2023?');
  assert.notEqual(response.result.resolvedIntent, 'driver_race_wins_season');
  assert.notEqual(response.result.resolvedIntent, 'driver_race_wins');
});

test('session weather cannot discard a driver filter', async () => {
  const response = await ask(
    'What was the weather for Example One at the 2024 Synthetic Grand Prix?',
    {
      interpreter: {
        async interpret() {
          return {
            intent: 'event_session_metric',
            eventName: 'Synthetic Grand Prix',
            driverName: 'Example One',
            metric: 'weather_summary',
            scope: 'event',
          };
        },
      },
    },
  );
  assert.equal(response.result.status, 'unsupported');
  assert.equal(response.result.reasonCode, 'QUESTION_PLAN_ENTITY_FILTER_UNSUPPORTED');
});

test('surname and year resolve against published participation without a model or empty choices', async () => {
  const answer = await ask('How many victories did Verstappen take during the 2023 season?');
  assert.equal(answer.result.status, 'answered');
  assert.equal(answer.result.values.driver, 'Max Verstappen');
  assert.equal(answer.result.values.count, 1);
  assert.ok(answer.result.evidenceIds.includes('evidence:2023'));
});

test('ambiguous surname offers canonical choices and does not call a rephraser', async () => {
  let rephrases = 0;
  const answer = await ask('When was Schumacher last race?', {
    interpreter: {
      async interpret() {
        return { intent: 'driver_last_race', driverName: 'Schumacher' };
      },
      async rephrase() {
        rephrases++;
      },
    },
  });
  assert.equal(answer.result.status, 'clarification');
  assert.deepEqual(answer.result.choices.map((choice) => choice.label).sort(), [
    'Michael Schumacher',
    'Ralf Schumacher',
  ]);
  assert.equal(rephrases, 0);
});

test('a year interval counts wins from every requested year using raw-row oracle', async () => {
  const repository = fixture();
  const expected = [...repository.sets.values()]
    .flatMap((set) => (set.key.startsWith('results:') ? set.items : []))
    .filter(
      (row) =>
        /event:202[23]:/.test(row.sessionId) &&
        row.position === 1 &&
        row.entry.drivers.some((driver) => driver.id === 'driver:max'),
    ).length;
  const answer = await ask('How many races did Max Verstappen win between 2022 and 2023?', {
    repository,
  });
  assert.equal(answer.result.values.count, expected);
  assert.equal(answer.result.values.fromYear, 2022);
  assert.equal(answer.result.values.toYear, 2023);
});

test('seasonal query never loads unrelated season results', async () => {
  const repository = fixture();
  const loaded = [];
  const get = repository.get.bind(repository);
  repository.get = async (key) => {
    loaded.push(key);
    return get(key);
  };
  await ask('How many races did Max Verstappen win in 2023?', { repository });
  assert.equal(
    loaded.some((key) => key.startsWith('results:') && !key.includes(':2023:')),
    false,
  );
});

test('model catalogue includes every existing leaderboard and compound executor', () => {
  for (const operation of [
    'event_compound_summary',
    'fastest_lap_leaderboard',
    'podium_leaderboard',
    'race_win_leaderboard',
  ])
    assert.ok(questionIntentSchema.properties.intent.enum.includes(operation), operation);
});

for (const [name, plan] of [
  [
    'invalid metric',
    { intent: 'driver_stat', driverName: 'Max Verstappen', metric: 'weather_summary' },
  ],
  [
    'inverted period',
    {
      intent: 'driver_stat',
      driverName: 'Max Verstappen',
      metric: 'race_starts',
      fromYear: 2023,
      toYear: 2022,
    },
  ],
  [
    'injected field',
    {
      intent: 'driver_stat',
      driverName: 'Max Verstappen',
      metric: 'race_starts',
      sql: 'SELECT invented',
    },
  ],
  [
    'unsupported session',
    {
      intent: 'driver_race_wins_season',
      driverName: 'Max Verstappen',
      fromYear: 2023,
      toYear: 2023,
      sessionKind: 'sprint',
    },
  ],
])
  test(`plan rejects ${name} before executor`, async () => {
    const answer = await ask('Please calculate my archive statistic', {
      interpreter: {
        async interpret() {
          return plan;
        },
      },
    });
    assert.equal(answer.result.status, 'unsupported');
    assert.match(answer.result.reasonCode, /PLAN|FILTER|SESSION/);
  });

test('explicit season conflicting with optional year requests clarification', async () => {
  const answer = await ask('How many races did Max Verstappen win in 2023?', {
    context: { year: 2022 },
  });
  assert.equal(answer.result.status, 'clarification');
  assert.match(answer.result.message, /2022.*2023|2023.*2022/);
});

test('an unfinished current season leader is never announced as champion', async () => {
  const repository = fixture();
  const year = new Date().getUTCFullYear();
  const base = repository.sets.get('standings:2024:drivers');
  repository.sets.set(`standings:${year}:drivers`, { ...base, key: `standings:${year}:drivers` });
  const answer = await ask(`Who won the ${year} World Championship?`, { repository });
  assert.doesNotMatch(answer.result.values?.answer || '', /won.*World Championship/);
  assert.ok(
    answer.result.status !== 'answered' || answer.result.values.championshipStatus === 'leader',
  );
});

test('constructor points leaderboard uses published standings and retains genuine zero', async () => {
  const repository = fixture();
  const standings = repository.sets.get('standings:2024:constructors');
  const expected = standings.items.reduce((best, row) =>
    Number(row.points) > Number(best.points) ? row : best,
  );
  const answer = await ask('Which constructor scored the most points in 2024?', { repository });
  assert.equal(answer.result.status, 'answered');
  assert.equal(answer.result.values.constructor, expected.entity.displayName);
  assert.equal(Number(answer.result.values.points), Number(expected.points));
  assert.ok(answer.result.evidenceIds.includes(standings.evidenceId));
});

test('registry rejects ignored optional entity filters, not just unknown metrics', () => {
  for (const plan of [
    {
      intent: 'driver_stat',
      driverName: 'Max Verstappen',
      metric: 'race_wins',
      constructorName: 'Example Team',
    },
    {
      intent: 'driver_stat',
      driverName: 'Max Verstappen',
      metric: 'race_wins',
      comparisonDriverName: 'Jos Verstappen',
    },
    { intent: 'event_winner', circuitName: 'Monza' },
    { intent: 'driver_last_race', driverName: 'Max Verstappen', limit: 3 },
  ])
    assert.equal(validatePlan(plan).valid, false, JSON.stringify(plan));
});

test('a constructor filter which changes the win count is not silently discarded', async () => {
  const repository = fixture();
  const extra = structuredClone(repository.sets.get('results:session:event:2023:example:race'));
  extra.key = 'results:session:event:2023:other:race';
  extra.items[0].sessionId = 'session:event:2023:other:race';
  extra.items[0].entry.constructor = { id: 'constructor:second-team', displayName: 'Second Team' };
  repository.sets.set(extra.key, extra);
  const answer = await ask('How many races did Max Verstappen win for Example Team in 2023?', {
    repository,
  });
  assert.equal(answer.result.status, 'unsupported');
  assert.equal(answer.result.reasonCode, 'QUESTION_FILTER_UNSUPPORTED');
});

test('last race resolves a completed publication event with no invented names', async () => {
  const repository = fixture();
  const calendar = repository.sets.get('events:2024');
  calendar.items[0].status = 'completed';
  const answer = await ask('Who won the last race?', { repository });
  assert.equal(answer.result.status, 'answered');
  assert.equal(answer.result.resolvedIntent, 'event_winner');
  assert.equal(answer.result.values.driver, 'Example One');
});

for (const text of [
  'Compare Verstappen and Example One on race wins in 2023',
  'Compare Max Verstappen and One on race wins in 2023',
])
  test(`configured planner owns each comparison slot: ${text}`, async () => {
    let calls = 0;
    const answer = await ask(text, {
      interpreter: {
        async interpret() {
          calls++;
          return {
            intent: 'driver_race_wins_comparison',
            driverName: 'Verstappen',
            comparisonDriverName: 'Example One',
            fromYear: 2023,
            toYear: 2023,
          };
        },
      },
    });
    assert.equal(calls, 1);
    assert.equal(answer.result.status, 'answered');
    assert.equal(answer.result.resolvedIntent, 'driver_race_wins_comparison');
    assert.equal(answer.result.values.driver, 'Max Verstappen');
    assert.equal(answer.result.values.comparisonDriver, 'Example One');
  });

for (const complete of [false, true])
  test(`historical championship requires final evidence: complete=${complete}`, async () => {
    const repository = fixture();
    const standing = structuredClone(repository.sets.get('standings:2024:drivers'));
    standing.key = 'standings:2000:drivers';
    standing.items.forEach((row) => {
      row.standingSnapshotId = `standing:2000:${complete ? 2 : 1}`;
    });
    repository.sets.set(standing.key, standing);
    const calendar = structuredClone(repository.sets.get('events:2024'));
    calendar.key = 'events:2000';
    calendar.coverage = complete ? 'complete' : 'partial';
    calendar.items = [1, 2].map((round) => ({
      ...calendar.items[0],
      id: `event:2000:round-${round}`,
      year: 2000,
      round,
      status: complete || round === 1 ? 'completed' : 'scheduled',
    }));
    repository.sets.set(calendar.key, calendar);
    const answer = await ask('Who won the 2000 World Championship?', { repository });
    assert.equal(answer.result.values.championshipStatus, complete ? 'final' : 'leader');
  });

test('missing requested years prevent complete win coverage and comparison states its period', async () => {
  const repository = fixture();
  for (const set of repository.sets.values())
    if (set.key.startsWith('results:')) {
      set.coverage = 'complete';
      set.warnings = [];
    }
  const answer = await ask('How many races did Max Verstappen win between 2021 and 2023?', {
    repository,
  });
  assert.equal(answer.result.values.coverage, 'partial');
  assert.deepEqual(answer.result.values.missingYears, [{ year: 2021 }]);
  const comparison = await ask('Compare Max Verstappen and Example One on race wins in 2023', {
    repository,
  });
  assert.match(comparison.result.values.answer, /2023/);
  assert.equal(comparison.result.values.comparisonCount, 0);
});

test('non-contiguous explicit years never silently include the intervening season', async () => {
  const answer = await ask('How many races did Max Verstappen win in 2021 and 2023?');
  assert.equal(answer.result.status, 'unsupported');
  assert.equal(answer.result.reasonCode, 'QUESTION_PERIOD_SET_UNSUPPORTED');
});

test('optional driver on event metric is resolved before execution', async () => {
  const answer = await ask('Find the published stop total', {
    interpreter: {
      async interpret() {
        return {
          intent: 'event_pit_stops',
          eventName: 'Synthetic Grand Prix',
          driverName: 'Missing Driver',
          metric: 'pit_stops',
          fromYear: 2024,
          toYear: 2024,
        };
      },
    },
  });
  assert.equal(answer.result.status, 'clarification');
  assert.match(answer.result.message, /driver/);
});

test('multi-metric operations require a metric and circuit scope cannot substitute weather', () => {
  for (const plan of [
    { intent: 'driver_stat', driverName: 'Max Verstappen' },
    { intent: 'event_session_metric', eventName: 'Synthetic Grand Prix' },
    {
      intent: 'event_session_metric',
      scope: 'circuit',
      circuitName: 'Example Circuit',
      metric: 'tyre_laps',
    },
  ])
    assert.equal(validatePlan(plan).valid, false, JSON.stringify(plan));
});

test('a second-driver ambiguity choice resolves that slot without replacing the primary driver', async () => {
  const interpreter = {
    async interpret() {
      return {
        intent: 'driver_race_wins_comparison',
        driverName: 'Max Verstappen',
        comparisonDriverName: 'Schumacher',
      };
    },
  };
  const repository = fixture();
  const answer = await ask('Compare Max Verstappen and Schumacher race wins', {
    repository,
    interpreter,
  });
  assert.equal(answer.result.suggestion, undefined);
  const choice = answer.result.choices.find((item) => item.label === 'Ralf Schumacher');
  assert.equal(choice.context.driverId, null);
  assert.equal(choice.context.entitySelections.comparisonDriverName, 'driver:ralf');
  const retry = await ask('Compare Max Verstappen and Schumacher race wins', {
    repository,
    interpreter,
    context: choice.context,
  });
  assert.notEqual(retry.result.status, 'clarification');
});

test('historical midseason leaders never become career championship titles', async () => {
  const answer = await ask('Was Example One ever a world champion?');
  assert.notEqual(answer.result.status, 'answered');
  assert.equal(answer.result.reasonCode, 'FINAL_CHAMPIONSHIPS_NOT_PUBLISHED');
});

test('fastest pit stop applies the driver filter before finding the minimum', async () => {
  const repository = fixture();
  const results = repository.sets.get('results:session:event:2024:synthetic-grand-prix:race');
  const pits = repository.sets.get('pit-stops:session:event:2024:synthetic-grand-prix:race');
  pits.items = results.items.map((row, index) => ({
    ...pits.items[0],
    id: `pit:${index}`,
    entryId: row.entry.id,
    stationaryDurationMs: index ? 2000 : 3000,
  }));
  const answer = await ask('Find the published fastest stop', {
    repository,
    interpreter: {
      async interpret() {
        return {
          intent: 'event_pit_stops',
          eventName: 'Synthetic Grand Prix',
          driverName: 'Example One',
          metric: 'fastest_pit_stop',
          fromYear: 2024,
          toYear: 2024,
        };
      },
    },
  });
  assert.equal(answer.result.values.drivers, 'Example One');
  assert.equal(answer.result.values.durationMs, 3000);
});

test('event pit-stop total is a total, not the largest per-driver count', async () => {
  const repository = fixture();
  const results = repository.sets.get('results:session:event:2024:synthetic-grand-prix:race');
  const pits = repository.sets.get('pit-stops:session:event:2024:synthetic-grand-prix:race');
  pits.items = results.items.map((row, index) => ({
    ...pits.items[0],
    id: `pit:${index}`,
    entryId: row.entry.id,
  }));
  const answer = await ask('Find the published stop total', {
    repository,
    interpreter: {
      async interpret() {
        return {
          intent: 'event_pit_stops',
          eventName: 'Synthetic Grand Prix',
          metric: 'pit_stops',
          fromYear: 2024,
          toYear: 2024,
        };
      },
    },
  });
  assert.equal(answer.result.values.count, pits.items.length);
});

test('planner can supply a meaningful constraint-preserving retry question without a second call', async () => {
  let rephrases = 0;
  const suggestion = 'Which published metric should be compared for Max Verstappen in 2023?';
  const answer = await ask('Explain everything about Max Verstappen in 2023', {
    interpreter: {
      async interpret() {
        return { intent: 'unsupported', suggestion };
      },
      async rephrase() {
        rephrases++;
      },
    },
  });
  assert.equal(answer.result.suggestion, suggestion);
  assert.equal(rephrases, 0);
});

test('a planner may leave an ambiguous surface name unresolved; canonical resolution still uses the question and year', async () => {
  const answer = await ask('How many victories did Verstappen take during the 2023 season?', {
    interpreter: {
      async interpret() {
        return {
          intent: 'driver_race_wins_season',
          driverName: null,
          fromYear: 2023,
          toYear: 2023,
          clarificationNeeded: true,
          clarificationMessage: 'Which Verstappen?',
        };
      },
    },
  });
  assert.equal(answer.result.status, 'answered');
  assert.equal(answer.result.values.driver, 'Max Verstappen');
  assert.equal(answer.result.values.count, 1);
});

for (const kind of ['drivers', 'constructors'])
  test(`secured championship uses the existing titleOutlook projection for ${kind}`, async () => {
    const repository = fixture();
    const service = new QuestionService(repository);
    const original = StandingOutlookService.prototype.project;
    let projectedKind;
    StandingOutlookService.prototype.project = async (_set, options) => {
      projectedKind = options.kind;
      return { titleOutlook: { sufficientAdditional: '0', coverage: 'partial' } };
    };
    try {
      const standing = repository.sets.get(`standings:2024:${kind}`);
      const status = await service.championshipStatus(new Date().getUTCFullYear(), standing, {
        get: repository.get.bind(repository),
      });
      assert.equal(status, 'secured');
      assert.equal(projectedKind, kind);
    } finally {
      StandingOutlookService.prototype.project = original;
    }
  });

test('canonical choice selections roundtrip through both public contract shapes', () => {
  const context = {
    year: null,
    eventId: null,
    sessionId: null,
    driverId: null,
    constructorId: null,
    entitySelections: {
      comparisonDriverName: 'driver:ralf',
      constructor1: 'constructor:example-team',
    },
  };
  assert.equal(
    validateSchema('QuestionRequest', { text: 'Compare the named drivers', context }).valid,
    true,
  );
  assert.equal(
    validateSchema('QuestionResult', {
      status: 'clarification',
      message: 'Which driver?',
      choices: [{ label: 'Ralf Schumacher', context }],
    }).valid,
    true,
  );
  assert.equal(
    validateSchema('QuestionRequest', {
      text: 'Compare',
      context: { ...context, entitySelections: { sql: 'SELECT invented' } },
    }).valid,
    false,
  );
});

test('fixed-metric operations accept their own metric and reject a different one', () => {
  for (const [intent, metric] of [
    ['event_winner', 'race_wins'],
    ['event_podium', 'podiums'],
    ['event_pole', 'poles'],
    ['event_fastest_lap', 'fastest_laps'],
  ])
    assert.equal(validatePlan({ intent, metric }).valid, true, intent);
  assert.equal(validatePlan({ intent: 'event_winner', metric: 'podiums' }).valid, false);
});

test('a history count cannot become a surname match from an implicit numeric alias', async () => {
  const repository = fixture();
  repository.sets.get('profile:circuit:example-circuit').items[0].country = 'Italy';
  const answer = await ask('Who won the last two races in Italy?', { repository });
  assert.equal(answer.result.status, 'answered');
  assert.equal(answer.result.resolvedIntent, 'country_race_winners');
});

test('partial field coverage can still establish finality with a matching exhaustive provider calendar', async () => {
  const repository = fixture();
  repository.calendarProof = async () => ({
    complete: true,
    observationId: 'observation:published-complete-calendar',
  });
  const answer = await ask('Who won the 2024 World Championship?', { repository });
  assert.equal(answer.result.values.championshipStatus, 'final');
});

test('a standing round beyond the published calendar is not matching final-round evidence', async () => {
  const repository = fixture();
  repository.sets.get('events:2024').coverage = 'complete';
  repository.sets.get('standings:2024:drivers').items[0].standingSnapshotId = 'standing:2024:2';
  const answer = await ask('Who won the 2024 World Championship?', { repository });
  assert.equal(answer.result.values.championshipStatus, 'leader');
});

for (const surface of ['Monza', 'Temple of Speed'])
  test(`published circuit slug or normalized alias resolves ${surface}`, async () => {
    const repository = fixture();
    const profile = repository.sets.get('profile:circuit:example-circuit');
    const circuit = {
      ...profile.items[0].entity,
      id: 'circuit:monza',
      displayName: 'Autodromo Nazionale di Monza',
    };
    profile.items[0] = { ...profile.items[0], id: circuit.id, entity: circuit, aliases: [] };
    repository.aliases['temple of speed'] = circuit.id;
    repository.sets.get('events:2024').items[0].circuit = circuit;
    const interpreter = {
      async interpret() {
        return { intent: 'circuit_race_winners', circuitName: surface, scope: 'circuit', limit: 3 };
      },
    };
    const answer = await ask(`Who won the last three races at ${surface}?`, {
      repository,
      interpreter,
    });
    assert.equal(answer.result.status, 'answered');
    assert.equal(answer.result.values.circuit, circuit.displayName);
    assert.ok(answer.result.evidenceIds.length);
  });
