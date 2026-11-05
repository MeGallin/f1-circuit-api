import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionService } from '../src/services/question.service.js';
import {
  questionIntentSchema,
  questionSystemPrompt,
} from '../src/providers/openai/question-interpreter.js';
import { appFixture } from './helpers.js';

test('constructor title intent is part of the model contract', () => {
  assert.ok(
    questionIntentSchema.properties.intent.enum.includes('constructor_championship_leaderboard'),
  );
  assert.ok(questionIntentSchema.properties.intent.enum.includes('constructor_rivalry_comparison'));
  assert.ok(questionIntentSchema.properties.metric.anyOf[0].enum.includes('constructors_titles'));
  assert.ok(questionIntentSchema.properties.metric.anyOf[0].enum.includes('constructor_rivalry'));
  assert.match(questionSystemPrompt, /constructor_championship_leaderboard/);
  assert.match(questionSystemPrompt, /constructor_rivalry_comparison/);
});

test('planner suggestions are schema-constrained and cannot add answer prose fields', () => {
  assert.ok(questionIntentSchema.properties.suggestion);
  assert.ok(questionIntentSchema.required.includes('suggestion'));
  assert.equal(questionIntentSchema.additionalProperties, false);
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
    const calendar = structuredClone(repository.sets.get('events:2024'));
    calendar.key = 'events:' + year;
    calendar.coverage = 'complete';
    calendar.items = calendar.items.map((event) => ({
      ...event,
      id: 'event:' + year + ':final',
      year: Number(year),
      round: 1,
      status: 'completed',
    }));
    repository.sets.set(calendar.key, calendar);
    keys.push(key);
  }
  return keys;
}

test('model-shaped intent plans are executed against constructor standings', async () => {
  const { repository } = appFixture();
  const keys = addConstructorStandings(repository);
  const question = 'Which manufacturer has won the most world titles from 2021 to 2025?';
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
