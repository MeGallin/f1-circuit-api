import { finalizeArchiveCoverage } from './archive-coverage.js';

// Season-wide queries avoid re-fetching the calendar and result pages for every round.
export async function seasonBackbone(provider, year) {
  const calendar = await provider.season(year);
  const races = new Map(calendar.records.map((r) => [Number(r.round), structuredClone(r)]));
  const observations = [...calendar.observations];
  for (const [category, field] of [
    ['results', 'Results'],
    ['qualifying', 'QualifyingResults'],
    ['sprint', 'SprintResults'],
  ]) {
    const response = await provider.pages(`${year}/${category}`, 'RaceTable', 'Races', field);
    observations.push(...response.observations);
    for (const row of response.records) {
      const race = races.get(Number(row.round));
      if (!race) throw new Error('Results reference a round outside the pinned calendar.');
      race[field] = [...(race[field] || []), ...(row[field] || [])];
    }
  }
  return { calendar: calendar.records, races: [...races.values()], observations };
}

export async function archiveJolpica({
  provider,
  repository,
  service,
  phase,
  progress = () => {},
}) {
  if (repository.batch.status === 'completed') return repository.batch.publication_id;
  const catalogue = await provider.seasons();
  repository.step = 'jolpica:catalogue';
  if (!repository.done(repository.step)) await service.publishSeasonCatalogue(catalogue);
  const years = catalogue.records.map((r) => Number(r.season)).sort((a, b) => b - a);
  for (const year of years) {
    const data = await seasonBackbone(provider, year);
    progress({ phase, year, events: data.races.length, status: 'season-ready' });
    for (const race of data.races) {
      const step = `jolpica:${year}:${race.round}:${phase}`;
      if (repository.done(step)) continue;
      const observations = [...data.observations];
      const standings = {};
      if (phase === 'backbone') {
        for (const [kind, endpoint, field] of [
          ['drivers', 'driverstandings', 'DriverStandings'],
          ['constructors', 'constructorstandings', 'ConstructorStandings'],
        ]) {
          const response = await provider.pages(
            `${year}/${race.round}/${endpoint}`,
            'StandingsTable',
            'StandingsLists',
            field,
          );
          standings[kind] = response.records.flatMap((r) => r[field] || []);
          observations.push(...response.observations);
        }
      } else if (race.Results?.length) {
        for (const [endpoint, field] of [
          ['laps', 'Laps'],
          ['pitstops', 'PitStops'],
        ]) {
          const response = await provider.pages(
            `${year}/${race.round}/${endpoint}`,
            'RaceTable',
            'Races',
            field,
          );
          race[field] = response.records.flatMap((r) => r[field] || []);
          observations.push(...response.observations);
        }
      }
      repository.step = step;
      await service.publish(
        { calendar: data.calendar, race, standings, observations, failures: [] },
        'jolpica',
      );
      progress({
        phase,
        year,
        round: Number(race.round),
        classifications: race.Results?.length || 0,
        laps: (race.Laps || []).reduce((n, l) => n + (l.Timings?.length || 0), 0),
        status: 'checkpointed',
      });
    }
    // Do not keep the full normalized archive resident while processing the next year.
    repository.cached?.clear();
  }
  if (repository.pool) {
    const events = await finalizeArchiveCoverage(repository);
    progress({ phase, status: 'coverage-finalized', events });
  }
  return repository.activate();
}
