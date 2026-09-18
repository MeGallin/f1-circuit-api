import { validateSchema } from '../schemas/contract.js';
import { finalizeArchiveCoverage } from './archive-coverage.js';
export function verifyScope(
  seasons,
  calendars,
  steps,
  minYear = 2000,
  maxYear = new Date().getUTCFullYear(),
) {
  const selected = seasons.filter((s) => s.year >= minYear && s.year <= maxYear);
  if (selected.length !== maxYear - minYear + 1)
    throw new Error('Incomplete scoped season catalogue.');
  let rounds = 0;
  for (const season of selected) {
    const events = calendars.get(season.year);
    if (!events?.length || events.length !== season.eventCount)
      throw new Error('Scoped calendar incomplete.');
    for (const event of events) {
      if (!steps.has(`jolpica:${season.year}:${event.round}:backbone`))
        throw new Error('Scoped round checkpoint missing.');
      rounds++;
    }
  }
  if (
    [...steps].some(
      (key) => /^jolpica:\d{4}:\d+:backbone$/.test(key) && Number(key.split(':')[1]) < minYear,
    )
  )
    throw new Error('Out-of-scope checkpoints found.');
  return { selected, rounds };
}
export async function finalizeScope(repository) {
  const id = repository.batch.publication_id;
  const hold = (
    await repository.pool.query(
      'SELECT publication_id FROM archive_activation_holds WHERE publication_id=$1',
      [id],
    )
  ).rows.length;
  if (!hold) throw new Error('Activation hold required.');
  const catalogue = await repository.get('seasons'),
    calendars = new Map();
  for (const s of catalogue.items.filter((s) => s.year >= 2000)) {
    calendars.set(s.year, (await repository.get(`events:${s.year}`))?.items);
    repository.cached.clear();
  }
  const scope = verifyScope(catalogue.items, calendars, repository.steps);
  const events = await finalizeArchiveCoverage(repository);
  if (events !== scope.rounds) throw new Error('Event detail reconciliation incomplete.');
  // Enforce scoped catalogue without SyncService merging excluded years back in.
  catalogue.items = scope.selected;
  repository.step = null;
  await repository.publish([catalogue], {});
  repository.cached.clear();
  let offset = 0,
    checked = 0;
  while (true) {
    const rows = (
      await repository.pool.query(
        'SELECT n.payload,d.schema_name FROM normalized_records n JOIN datasets d ON d.publication_id=n.publication_id AND d.key=n.dataset_key WHERE n.publication_id=$1 ORDER BY n.dataset_key,n.ordinal,n.id LIMIT 1000 OFFSET $2',
        [id, offset],
      )
    ).rows;
    if (!rows.length) break;
    for (const row of rows) {
      if (!validateSchema(row.schema_name, row.payload).valid)
        throw new Error('Staged schema validation failed.');
      checked++;
    }
    offset += rows.length;
  }
  repository.step = 'scope:2000:coverage-finalized';
  await repository.publish([], {});
  repository.cached.clear();
  return {
    seasons: scope.selected.length,
    rounds: scope.rounds,
    reconciledEvents: events,
    validatedRows: checked,
  };
}
