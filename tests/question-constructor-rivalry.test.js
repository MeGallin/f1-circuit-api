import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionService } from '../src/services/question.service.js';
import { appFixture } from './helpers.js';

const RANGE = { fromYear: 2016, toYear: 2025 };

function addRivalryArchive(repository) {
  const standingSource = repository.sets.get('standings:2024:constructors');
  const resultSource = [...repository.sets.values()].find((set) => set.key.startsWith('results:'));
  for (const key of [...repository.sets.keys()]) {
    if (key.startsWith('results:') || /^standings:\d+:constructors(?::\d+)?$/.test(key))
      repository.sets.delete(key);
  }

  const constructors = ['Alpha', 'Beta', 'Gamma'];
  const constructorIds = Object.fromEntries(
    [...constructors, 'Delta', 'Echo'].map((name) => [name, `constructor:${name.toLowerCase()}`]),
  );
  const champions = {
    2016: 'Alpha',
    2017: 'Beta',
    2018: 'Alpha',
    2019: 'Gamma',
    2020: 'Beta',
    2021: 'Alpha',
    2022: 'Beta',
    2023: 'Alpha',
    2024: 'Beta',
    2025: 'Alpha',
  };

  for (const year of Object.keys(champions).map(Number)) {
    const champion = champions[year];
    const items = [champion, ...constructors.filter((name) => name !== champion)].map(
      (name, index) => ({
        ...standingSource.items[0],
        id: `standing:${year}:${index + 1}:constructor:${constructorIds[name].slice(11)}`,
        entity: {
          ...standingSource.items[0].entity,
          id: constructorIds[name],
          displayName: name,
        },
        rank: index + 1,
        points: String(100 - index * 10),
        wins: index === 0 ? 1 : 0,
        standingSnapshotId: `standing:${year}:1`,
      }),
    );
    repository.sets.set(`standings:${year}:constructors`, {
      ...standingSource,
      key: `standings:${year}:constructors`,
      evidenceId: `evidence:rivalry-standing:${year}`,
      items,
    });
  }

  const winners = [
    ...Array.from({ length: 12 }, () => 'Alpha'),
    ...Array.from({ length: 11 }, () => 'Beta'),
    ...Array.from({ length: 3 }, () => 'Gamma'),
    'Delta',
    'Echo',
  ];
  winners.forEach((name, index) => {
    const year = RANGE.fromYear + (index % 10);
    const eventId = `event:${year}:rivalry-${index + 1}`;
    const sessionId = `session:${eventId}:race`;
    const evidenceId = `evidence:rivalry-result:${index + 1}`;
    repository.sets.set(`results:${sessionId}`, {
      ...resultSource,
      key: `results:${sessionId}`,
      evidenceId,
      items: [
        {
          ...resultSource.items[0],
          id: `result:${sessionId}:${index + 1}`,
          evidenceId,
          sessionId,
          entry: {
            ...resultSource.items[0].entry,
            constructor: {
              id: constructorIds[name],
              displayName: name,
            },
          },
          position: 1,
          status: 'finished',
        },
      ],
    });
  });
}

function rivalryInterpreter(overrides = {}) {
  return {
    async interpret() {
      return {
        intent: 'constructor_rivalry_comparison',
        metric: 'constructor_rivalry',
        scope: 'season',
        ...RANGE,
        clarificationNeeded: false,
        ...overrides,
      };
    },
  };
}

test('constructor rivalry compares aggregate race wins and world titles over the requested period', async () => {
  const { repository } = appFixture();
  addRivalryArchive(repository);
  const service = new QuestionService(repository, { interpreter: rivalryInterpreter() });

  const result = await service.answer(
    {
      text: 'Which two manufacturers have been the closest rivals over the last 10 years?',
    },
    {
      snapshot: { id: repository.id },
      get: repository.get.bind(repository),
      keys: repository.keys.bind(repository),
    },
  );

  assert.equal(result.result.status, 'answered');
  assert.equal(result.result.resolvedIntent, 'constructor_rivalry_comparison');
  assert.deepEqual(result.result.values.competitors.map((entry) => entry.constructor), [
    'Alpha',
    'Beta',
  ]);
  assert.deepEqual(result.result.values.comparison, {
    winsGap: 1,
    titlesGap: 1,
  });
  assert.equal(result.result.values.competitors[0].wins, 12);
  assert.equal(result.result.values.competitors[1].wins, 11);
  assert.ok(result.result.values.competitors.every((entry) => entry.titles > 0));
  assert.equal(result.result.values.fromYear, 2016);
  assert.equal(result.result.values.toYear, 2025);
  assert.match(result.result.values.answer, /Alpha and Beta/);
  assert.ok(result.result.evidenceIds.length >= 2);
});

test('constructor rivalry is unavailable when either metric lacks published coverage', async () => {
  const { repository } = appFixture();
  addRivalryArchive(repository);
  for (const key of [...repository.sets.keys()]) {
    if (key.startsWith('standings:') && key.endsWith(':constructors')) repository.sets.delete(key);
  }
  const service = new QuestionService(repository, { interpreter: rivalryInterpreter() });

  const result = await service.answer(
    { text: 'Which two manufacturers were closest rivals from 2016 to 2025?' },
    {
      snapshot: { id: repository.id },
      get: repository.get.bind(repository),
      keys: repository.keys.bind(repository),
    },
  );

  assert.equal(result.result.status, 'unavailable');
  assert.equal(result.result.reasonCode, 'CONSTRUCTOR_RIVALRY_NOT_PUBLISHED');
});

test('constructor rivalry clarifies when the period is not resolved', async () => {
  const { repository } = appFixture();
  const service = new QuestionService(
    repository,
    {
      interpreter: rivalryInterpreter({ fromYear: null, toYear: null }),
    },
  );

  const result = await service.answer(
    { text: 'Which two manufacturers were the closest rivals?' },
    {
      snapshot: { id: repository.id },
      get: repository.get.bind(repository),
      keys: repository.keys.bind(repository),
    },
  );

  assert.equal(result.result.status, 'clarification');
  assert.match(result.result.message, /completed seasons/i);
});
