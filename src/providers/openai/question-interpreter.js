import OpenAI from 'openai';

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const nullableInteger = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
const nullableScope = {
  anyOf: [
    { type: 'string', enum: ['event', 'circuit', 'season', 'career', 'unknown'] },
    { type: 'null' },
  ],
};
const nullableSessionKind = {
  anyOf: [
    { type: 'string', enum: ['race', 'qualifying', 'sprint', 'practice', 'weekend'] },
    { type: 'null' },
  ],
};

export const questionIntentSchema = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: [
        'archive_search',
        'event_winner',
        'driver_constructor_race_starts',
        'driver_last_win',
        'driver_race_wins',
        'driver_race_wins_comparison',
        'driver_stat',
        'event_podium',
        'event_pole',
        'event_fastest_lap',
        'event_pit_stops',
        'event_session_metric',
        'circuit_race_winners',
        'unsupported',
      ],
    },
    searchTerms: { type: 'string' },
    driverName: nullableString,
    comparisonDriverName: nullableString,
    constructorName: nullableString,
    eventName: nullableString,
    circuitName: nullableString,
    scope: nullableScope,
    sessionKind: nullableSessionKind,
    fromYear: nullableInteger,
    toYear: nullableInteger,
    comparisonFromYear: nullableInteger,
    comparisonToYear: nullableInteger,
    limit: nullableInteger,
    metric: {
      anyOf: [
        {
          type: 'string',
          enum: [
            'race_starts',
            'seasons',
            'results',
            'podiums',
            'poles',
            'fastest_laps',
            'retirements',
            'disqualifications',
            'did_not_start',
            'did_not_qualify',
            'pit_stops',
            'most_pit_stops',
            'fastest_pit_stop',
            'race_wins',
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
          ],
        },
        { type: 'null' },
      ],
    },
    clarificationNeeded: { type: 'boolean' },
    clarificationMessage: nullableString,
  },
  required: [
    'intent',
    'searchTerms',
    'driverName',
    'comparisonDriverName',
    'constructorName',
    'eventName',
    'circuitName',
    'scope',
    'sessionKind',
    'fromYear',
    'toYear',
    'comparisonFromYear',
    'comparisonToYear',
    'limit',
    'metric',
    'clarificationNeeded',
    'clarificationMessage',
  ],
  additionalProperties: false,
};

const systemPrompt = [
  'You interpret questions for a read-only Formula One archive.',
  'Return only the supplied JSON schema. Never provide facts, SQL, IDs, URLs or prose answers.',
  'Use only these intents: archive_search, event_winner, driver_constructor_race_starts, driver_last_win, driver_race_wins, driver_race_wins_comparison, driver_stat, event_podium, event_pole, event_fastest_lap, event_pit_stops, event_session_metric, unsupported.',
  'The application will resolve names and query its own database after your response.',
  'Use null when a field is not present. Set clarificationNeeded true when the request is ambiguous.',
  'Do not infer a driver, constructor, event or year that is not stated by the user.',
  'For a question about a venue or circuit across one or more years, use scope=circuit and circuitName. Use the supplied currentYear to resolve “this year” and “last year”.',
  'For comparisons, populate fromYear/toYear for the first period and comparisonFromYear/comparisonToYear for the second period. Do not answer the question yourself.',
  'For “who won the last N races at [circuit]” or similar circuit-history questions, use intent=circuit_race_winners, scope=circuit, circuitName and limit=N.',
].join(' ');

export class OpenAIQuestionInterpreter {
  constructor({ apiKey, model = 'gpt-5.6-luna', reasoningEffort = 'max', timeoutMs = 10000 }) {
    this.client = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 1 });
    this.model = model;
    this.reasoningEffort = reasoningEffort;
  }

  async interpret({ text, context }) {
    const response = await this.client.responses.create({
      model: this.model,
      reasoning: { effort: this.reasoningEffort },
      input: [
        { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify({ text, context }),
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'f1_archive_question_intent',
          strict: true,
          schema: questionIntentSchema,
        },
      },
    });
    const output = response.output_text?.trim();
    if (!output) throw new Error('The question interpreter returned no structured output.');
    return JSON.parse(output);
  }
}
