import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionService } from '../src/services/question.service.js';
import { appFixture } from './helpers.js';

async function answerWith(interpreter, text) {
  const { repository } = appFixture();
  const service = new QuestionService(repository, { interpreter });
  return service.answer(
    { text },
    {
      snapshot: { id: repository.id },
      get: repository.get.bind(repository),
      keys: repository.keys.bind(repository),
    },
  );
}

test('unsupported questions include a concrete rewording suggestion', async () => {
  const result = await answerWith(
    { interpret: async () => ({ intent: 'unsupported', clarificationNeeded: false }) },
    "What is the archive's favourite colour?",
  );

  assert.equal(result.result.status, 'unsupported');
  assert.equal(result.result.reasonCode, 'QUESTION_INTENT_UNSUPPORTED');
  assert.match(result.result.suggestion, /Try rewording it as:/i);
  assert.match(result.result.suggestion, /which circuit hosted the 2022 italian grand prix/i);
});

test('interpreter failures include a safe retry suggestion', async () => {
  const result = await answerWith(
    { interpret: async () => { throw new Error('test interpreter failure'); } },
    'Who won the archive?',
  );

  assert.equal(result.result.status, 'unavailable');
  assert.equal(result.result.reasonCode, 'QUESTION_INTERPRETER_UNAVAILABLE');
  assert.match(result.result.suggestion, /Try again or reword it as:/i);
  assert.match(result.result.suggestion, /which circuit hosted the 2022 italian grand prix/i);
});

test('clarification responses tell the user which constraints to add', async () => {
  const result = await answerWith(
    {
      interpret: async () => ({
        intent: 'unsupported',
        clarificationNeeded: true,
        clarificationMessage: 'Which Grand Prix do you mean?',
      }),
    },
    'Which circuit hosted the Grand Prix?',
  );

  assert.equal(result.result.status, 'clarification');
  assert.equal(
    result.result.suggestion,
    'Try adding a year, event, driver, constructor or specific metric to the question.',
  );
});

test('failed answers use the model only to improve the rewording suggestion', async () => {
  const calls = [];
  const result = await answerWith(
    {
      async interpret() {
        return { intent: 'unsupported', clarificationNeeded: false };
      },
      async rephrase(input) {
        calls.push(input);
        return {
          suggestion: 'Which circuit hosted the 2022 Italian Grand Prix?',
        };
      },
    },
    'What is the archive\'s favourite colour?',
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "What is the archive's favourite colour?");
  assert.equal(calls[0].failure.reasonCode, 'QUESTION_INTENT_UNSUPPORTED');
  assert.equal(
    result.result.suggestion,
    'Which circuit hosted the 2022 Italian Grand Prix?',
  );
});

test('deterministic guidance remains when the model cannot rephrase', async () => {
  const result = await answerWith(
    {
      async interpret() {
        return { intent: 'unsupported', clarificationNeeded: false };
      },
      async rephrase() {
        throw new Error('test rephrase failure');
      },
    },
    'What is the archive\'s favourite colour?',
  );

  assert.equal(result.result.status, 'unsupported');
  assert.equal(
    result.result.suggestion,
    'Try rewording it as: “Which circuit hosted the 2022 Italian Grand Prix?”',
  );
});
