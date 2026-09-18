// Weekend normalization produces a full calendar on each round. Rebuild its feature
// flags from staged detail datasets once, so later rounds cannot erase earlier flags.
export async function finalizeArchiveCoverage(repository) {
  const snapshot = await repository.snapshot();
  const coverage = new Map(
    (
      await repository.pool.query('SELECT key,coverage FROM datasets WHERE publication_id=$1', [
        snapshot.id,
      ])
    ).rows.map((row) => [row.key, row.coverage]),
  );
  repository.step = null;
  let events = 0;
  for (const key of await repository.keys('events:', snapshot.id)) {
    const calendar = await repository.get(key, snapshot.id);
    const changed = [];
    for (const event of calendar.items) {
      const detail = await repository.get(`event:${event.id}`, snapshot.id);
      if (!detail?.items.length) continue;
      const race = detail.items[0].sessions.find((session) => session.kind === 'race');
      if (!race) continue;
      const features = ['results', 'laps', 'pit-stops', 'stints', 'weather', 'race-control'].map(
        (category) => ({
          key: category,
          coverage: coverage.get(`${category}:${race.id}`) || 'unavailable',
          reasonCode: 'SOURCE_COVERAGE',
          endpoint: `/api/v1/sessions/${encodeURIComponent(race.id)}/${category}`,
        }),
      );
      event.features = features;
      detail.items[0].event.features = features;
      changed.push(detail);
      events++;
    }
    await repository.publish([calendar, ...changed], {});
    repository.cached?.clear();
  }
  return events;
}
