import { schedulerOutcome, safeSyncError } from '../observability/sync-error.js';

export async function runCurrentSeasonCheck({ repository, scheduler, pool, output = console }) {
  let exitCode = 0;
  try {
    await repository.ready();
    const result = await scheduler.poll();
    if (result.status === 'failed') {
      output.error(JSON.stringify({ event: 'scheduler.poll', ...schedulerOutcome(result) }));
      exitCode = 1;
    } else output.log(`One-shot current-season check finished: ${result.status}.`);
  } catch (error) {
    output.error(JSON.stringify({ event: 'scheduler.run', error: safeSyncError(error) }));
    exitCode = 1;
  } finally {
    for (const [phase, close] of [
      ['stop', () => scheduler.stop()],
      ['pool.end', () => pool.end()],
    ]) {
      try {
        await close();
      } catch (error) {
        output.error(
          JSON.stringify({ event: 'scheduler.shutdown', phase, error: safeSyncError(error) }),
        );
        exitCode = 1;
      }
    }
  }
  return exitCode;
}
