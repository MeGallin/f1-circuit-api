import { ProviderHttp } from '../http-client.js';
export class Jolpica {
  constructor(http = new ProviderHttp({ baseUrl: 'https://api.jolpi.ca/ergast/f1/' })) {
    this.http = http;
  }
  async pages(path, table, field, nested) {
    const observations = [];
    let offset = 0,
      total = Infinity;
    const records = [];
    while (offset < total) {
      if (offset > 100000) throw new Error('Provider pagination exceeded safety bound.');
      const result = await this.http.get(`${path}.json?limit=100&offset=${offset}`);
      observations.push(result);
      const data = result.payload.MRData;
      const batch = data?.[table]?.[field];
      if (!Array.isArray(batch) || !/^\d+$/.test(String(data.total)))
        throw new Error('Jolpica schema changed.');
      total = Number(data.total);
      const returned =
        nested === 'Laps'
          ? batch.reduce(
              (n, r) => n + (r.Laps || []).reduce((a, l) => a + (l.Timings?.length || 0), 0),
              0,
            )
          : nested
            ? batch.reduce((n, r) => n + (r[nested]?.length || 0), 0)
            : batch.length;
      records.push(...batch);
      if (!returned && offset < total) throw new Error('Jolpica returned incomplete pagination.');
      offset += returned;
      if (!returned) break;
    }
    return { records, observations };
  }
  async season(year) {
    if (!Number.isInteger(year) || year < 1950 || year > new Date().getUTCFullYear())
      throw new Error('Invalid season.');
    return this.pages(String(year), 'RaceTable', 'Races');
  }
  async weekend(year, round) {
    if (!Number.isInteger(round) || round < 1 || round > 100) throw new Error('Invalid round.');
    const calendar = await this.season(year);
    const race = calendar.records.find((x) => Number(x.round) === round);
    if (!race) throw new Error('Round not present in provider calendar.');
    const observations = [...calendar.observations];
    const failures = [];
    for (const [suffix, field, required] of [
      ['results', 'Results', true],
      ['qualifying', 'QualifyingResults', false],
      ['sprint', 'SprintResults', false],
      ['pitstops', 'PitStops', false],
      ['laps', 'Laps', false],
    ]) {
      try {
        const r = await this.pages(
          `${year}/${round}/${suffix}`,
          'RaceTable',
          'Races',
          field === 'Laps' ? 'Laps' : field,
        );
        observations.push(...r.observations);
        race[field] = r.records.flatMap((x) => x[field] || []);
      } catch (error) {
        if (required) throw error;
        failures.push(suffix);
      }
    }
    const standings = {};
    for (const [kind, endpoint, field] of [
      ['drivers', 'driverstandings', 'DriverStandings'],
      ['constructors', 'constructorstandings', 'ConstructorStandings'],
    ]) {
      try {
        const r = await this.pages(
          `${year}/${round}/${endpoint}`,
          'StandingsTable',
          'StandingsLists',
          field,
        );
        observations.push(...r.observations);
        standings[kind] = r.records.flatMap((x) => x[field] || []);
      } catch {
        failures.push('standings:' + kind);
      }
    }
    return { calendar: calendar.records, race, standings, observations, failures };
  }
}
