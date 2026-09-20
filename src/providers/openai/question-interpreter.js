import OpenAI from 'openai';

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const nullableInteger = { anyOf: [{ type: 'integer' }, { type: 'null' }] };

export const questionIntentSchema = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: ['archive_search', 'event_winner', 'driver_constructor_race_starts', 'unsupported'],
    },
    searchTerms: { type: 'string' },
    driverName: nullableString,
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
  'Use only these intents: archive_search, event_winner, driver_constructor_race_starts, unsupported.',
  'The application will resolve names and query its own database after your response.',
  'Use null when a field is not present. Set clarificationNeeded true when the request is ambiguous.',
  'Do not infer a driver, constructor, event or year that is not stated by the user.',
].join(' ');

export class OpenAIQuestionInterpreter {
  constructor({ apiKey, model = 'gpt-4o-mini', timeoutMs = 10000 }) {
    this.client = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 1 });
    this.model = model;
  }

  async interpret({ text, context }) {
    const response = await this.client.responses.create({
      model: this.model,
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
