import test from 'node:test';
import assert from 'node:assert/strict';
import { pipelineCorpus, PIPELINE_CORPUS_VERSION } from './question-contract/pipeline-corpus.js';
import { capabilities } from '../src/questions/capability-registry.js';
import { QuestionService } from '../src/services/question.service.js';
import { MemoryRepository } from './helpers.js';

test('versioned corpus covers every registered capability with at least 100 distinct questions', () => {
  assert.equal(PIPELINE_CORPUS_VERSION, '2026-11-04.1');
  assert.ok(pipelineCorpus.length >= 100);
  assert.equal(
    new Set(pipelineCorpus.map((scenario) => scenario.text)).size,
    pipelineCorpus.length,
  );
  assert.deepEqual(
    [...new Set(pipelineCorpus.map((scenario) => scenario.plan.intent))].sort(),
    Object.keys(capabilities).sort(),
  );
  for (const [intent, capability] of Object.entries(capabilities))
    if (intent !== 'unsupported')
      assert.equal(typeof QuestionService.prototype[capability.executor], 'function', intent);
});

for (const scenario of pipelineCorpus)
  test(`plan/executor corpus ${scenario.id}`, async () => {
    const repository = new MemoryRepository();
    let plannerCalls = 0;
    const service = new QuestionService(repository, {
      interpreter: {
        async interpret(input) {
          plannerCalls++;
          assert.equal(input.text, scenario.text);
          return structuredClone(scenario.plan);
        },
      },
    });
    const actualPlans = [];
    const execute = service.executeIntent.bind(service);
    service.executeIntent = async (plan, ...args) => {
      actualPlans.push(plan);
      return execute(plan, ...args);
    };
    const response = await service.answer(
      { text: scenario.text },
      {
        snapshot: { id: repository.id },
        get: repository.get.bind(repository),
        keys: repository.keys.bind(repository),
      },
    );
    const result = response.result;
    assert.equal(plannerCalls, 1);
    assert.equal(result.status, scenario.status);
    if (actualPlans.length)
      for (const [key, value] of Object.entries(scenario.plan))
        assert.deepEqual(actualPlans[0][key], value, key);
    assert.notEqual(result.resolvedIntent, 'archive_search');
    if (result.status !== 'answered') return;
    assert.equal(result.resolvedIntent, scenario.plan.intent);
    assert.ok(result.evidenceIds.length, 'an answer requires publication evidence');
    const sourceEvidence = new Set([...repository.sets.values()].map((set) => set.evidenceId));
    assert.ok(result.evidenceIds.every((id) => sourceEvidence.has(id)));
    assert.equal(
      response.dataset.coverage,
      'partial',
      'partial source never becomes complete envelope',
    );
    // Independent raw-row oracle: no production parser, predicate or executor imports.
    const rows = [...repository.sets.values()]
      .filter((set) => set.key.startsWith('results:'))
      .flatMap((set) => set.items)
      .filter((row) => row.sessionId.endsWith(':race'));
    const own = rows.filter((row) =>
      row.entry.drivers.some((driver) => driver.displayName === 'Example One'),
    );
    if (['driver_race_wins', 'driver_race_wins_season'].includes(scenario.plan.intent))
      assert.equal(
        result.values.count,
        new Set(own.filter((row) => row.position === 1).map((row) => row.sessionId)).size,
      );
    if (scenario.plan.intent === 'driver_stat')
      assert.equal(
        result.values.count,
        own.filter((row) => row.position >= 1 && row.position <= 3).length,
      );
    if (scenario.plan.intent === 'driver_race_wins_comparison') {
      assert.equal(result.values.count, own.filter((row) => row.position === 1).length);
      assert.equal(
        result.values.comparisonCount,
        rows.filter(
          (row) =>
            row.entry.drivers.some((driver) => driver.displayName === 'Example Two') &&
            row.position === 1,
        ).length,
      );
      assert.match(result.values.answer, /2024/);
    }
    if (scenario.plan.intent === 'constructor_points_leaderboard')
      assert.equal(
        result.values.points,
        Math.max(
          ...repository.sets
            .get('standings:2024:constructors')
            .items.map((row) => Number(row.points)),
        ),
      );
  });
