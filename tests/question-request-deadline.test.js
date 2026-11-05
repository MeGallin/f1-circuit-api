import test from 'node:test';
import assert from 'node:assert/strict';
import { requestData } from '../src/questions/request-data.js';

for (const operation of ['get', 'keys', 'getMany', 'calendarProof'])
  test(`request deadline bounds an in-flight ${operation} read`, async () => {
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const source = {
      get: () => (operation === 'get' ? pending : null),
      keys: () => (operation === 'keys' ? pending : ['results:session:event:2023:test:race']),
    };
    const repository = {
      getMany: () => pending,
      calendarProof: () => pending,
    };
    const helpers = requestData(
      repository,
      { id: 'pinned' },
      source,
      { fromYear: 2023, toYear: 2023 },
      Date.now() + 25,
    );
    // Independent 150ms source delay models a bounded DB read beginning near
    // the budget's end; it must not extend the request's remaining 25ms.
    const timer = setTimeout(() => release(operation === 'getMany' ? new Map() : []), 150);
    try {
      const read =
        operation === 'calendarProof'
          ? helpers.calendarProof(2023, {})
          : operation === 'get'
            ? helpers.get('example')
            : helpers.keys('results:');
      await assert.rejects(read, { code: 'QUESTION_DEADLINE_EXCEEDED' });
    } finally {
      clearTimeout(timer);
      release(operation === 'getMany' ? new Map() : []);
    }
  });
