import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyScope } from '../src/jobs/finalize-scope.js';
test('scope finalization requires every 2000-inclusive season and round', () => {
  const seasons = [
      { year: 1999, eventCount: 1 },
      { year: 2000, eventCount: 2 },
      { year: 2001, eventCount: 1 },
    ],
    calendars = new Map([
      [2000, [{ round: 1 }, { round: 2 }]],
      [2001, [{ round: 1 }]],
    ]),
    steps = new Set([
      'jolpica:2000:1:backbone',
      'jolpica:2000:2:backbone',
      'jolpica:2001:1:backbone',
    ]);
  assert.deepEqual(verifyScope(seasons, calendars, steps, 2000, 2001), {
    selected: seasons.slice(1),
    rounds: 3,
  });
  steps.delete('jolpica:2000:2:backbone');
  assert.throws(() => verifyScope(seasons, calendars, steps, 2000, 2001), /checkpoint/);
  steps.add('jolpica:2000:2:backbone');
  steps.add('jolpica:1999:1:backbone');
  assert.throws(() => verifyScope(seasons, calendars, steps, 2000, 2001), /Out-of-scope/);
  assert.throws(() => verifyScope(seasons.slice(1, 2), calendars, steps, 2000, 2001), /catalogue/);
});
