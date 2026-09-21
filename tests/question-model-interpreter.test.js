import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionService } from '../src/services/question.service.js';
import {
  OpenAIQuestionInterpreter,
  questionIntentSchema,
  questionRephraseSchema,
  questionRephraseSystemPrompt,
  questionSystemPrompt,
} from '../src/providers/openai/question-interpreter.js';
import { appFixture } from './helpers.js';

test('constructor title intent is part of the model contract', () => {
  assert.ok(questionIntentSchema.properties.intent.enum.includes('constructor_championship_leaderboard'));
  assert.ok(questionIntentSchema.properties.intent.enum.includes('constructor_rivalry_comparison'));
  assert.ok(questionIntentSchema.properties.metric.anyOf[0].enum.includes('constructors_titles'));
  assert.ok(questionIntentSchema.properties.metric.anyOf[0].enum.includes('constructor_rivalry'));
  assert.match(questionSystemPrompt, /constructor_championship_leaderboard/);
  assert.match(questionSystemPrompt, /constructor_rivalry_comparison/);
});

test('model fallback is constrained to a question-only structured response', async () => {
  assert.equal(questionRephraseSchema.properties.suggestion.type, 'string');
  assert.deepEqual(questionRephraseSchema.required, ['suggestion']);
  assert.match(questionRephraseSystemPrompt, /Never answer the question/);
  assert.match(questionRephraseSystemPrompt, /untrusted user text/);

  const interpreter = new OpenAIQuestionInterpreter({ apiKey: 'test-key' });
  const calls = [];
  interpreter.client = {
    responses: {
      async create(request) {
        calls.push(request);
        return {
          output_text: JSON.stringify({
            suggestion: 'Which circuit hosted the 2022 Italian Grand Prix?',
          }),
        };
      },
    },
  };

  const result = await interpreter.rephrase({
    text: 'What is the archive\'s favourite colour?',
    context: { currentYear: 2026 },
    failure: { status: 'unsupported', reasonCode: 'QUESTION_INTENT_UNSUPPORTED' },
  });

  assert.deepEqual(result, {
    suggestion: 'Which circuit hosted the 2022 Italian Grand Prix?',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text.format.type, 'json_schema');
  assert.equal(calls[0].text.format.name, 'f1_archive_question_rephrase');
  assert.equal(calls[0].text.format.strict, true);
  assert.equal(calls[0].text.format.schema, questionRephraseSchema);
  assert.equal(calls[0].reasoning.effort, 'max');
});

function addConstructorStandings(repository) {
  const source = repository.sets.get('standings:2024:constructors');
  const champions = {
    2021: 'Example Team',
    2022: 'Second Team',
    2023: 'Example Team',
    2024: 'Example Team',
    2025: 'Second Team',
  };
  const keys = [];
  for (const [year, constructor] of Object.entries(champions)) {
    const slug = constructor.toLowerCase().replaceAll(' ', '-');
    const key = `standings:${year}:constructors`;
    const set = structuredClone(source);
    set.key = key;
    set.items = [
      {
        ...source.items[0],
        id: `standing:${year}:1:constructor:${slug}`,
        entity: {
          ...source.items[0].entity,
          id: `constructor:${slug}`,
          displayName: constructor,
        },
        rank: 1,
        points: String(100 + Number(year)),
        wins: 1,
        standingSnapshotId: `standing:${year}:1`,
      },
    ];
    repository.sets.set(key, set);
    keys.push(key);
  }
  return keys;
}

test('model-shaped intent plans are executed against constructor standings', async () => {
  const { repository } = appFixture();
  const keys = addConstructorStandings(repository);
  const question = 'Which manufacturer has won the most world titles over the last 20 years?';
  const calls = [];
  const interpreter = {
    async interpret(input) {
      calls.push(input);
      return {
        intent: 'constructor_championship_leaderboard',
        metric: 'constructors_titles',
        scope: 'season',
        fromYear: 2021,
        toYear: 2025,
        clarificationNeeded: false,
      };
    },
  };
  const service = new QuestionService(repository, { interpreter });

  const result = await service.answer(
    { text: question },
    {
      snapshot: { id: repository.id },
      get: repository.get.bind(repository),
      keys: repository.keys.bind(repository),
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, question);
  assert.equal(result.result.status, 'answered');
  assert.equal(result.result.resolvedIntent, 'constructor_championship_leaderboard');
  assert.equal(result.result.values.constructor, 'Example Team');
  assert.equal(result.result.values.titleCount, 3);
  assert.equal(result.result.values.fromYear, 2021);
  assert.equal(result.result.values.toYear, 2025);
  assert.match(result.result.values.answer, /Example Team won 3 constructors' titles/);
  assert.ok(result.result.evidenceIds.length >= 1);

  keys.forEach((key) => repository.sets.delete(key));
});
