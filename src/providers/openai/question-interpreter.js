import OpenAI from 'openai';

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const nullableInteger = { anyOf: [{ type: 'integer' }, { type: 'null' }] };

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
        'unsupported',
      ],
    },
    searchTerms: { type: 'string' },
    driverName: nullableString,
    comparisonDriverName: nullableString,
    constructorName: nullableString,
    eventName: nullableString,
    fromYear: nullableInteger,
    toYear: nullableInteger,
    metric: {
      anyOf: [{ type: 'string', enum: ['race_starts', 'seasons', 'results'] }, { type: 'null' }],
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
    'fromYear',
    'toYear',
    'metric',
    'clarificationNeeded',
    'clarificationMessage',
  ],
  additionalProperties: false,
};

const systemPrompt = [
  'You interpret questions for a read-only Formula One archive.',
  'Return only the supplied JSON schema. Never provide facts, SQL, IDs, URLs or prose answers.',
  'Use only these intents: archive_search, event_winner, driver_constructor_race_starts, driver_last_win, driver_race_wins, driver_race_wins_comparison, unsupported.',
  'The application will resolve names and query its own database after your response.',
  'Use null when a field is not present. Set clarificationNeeded true when the request is ambiguous.',
  'Do not infer a driver, constructor, event or year that is not stated by the user.',
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
