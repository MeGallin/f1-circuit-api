import { ProviderHttp } from '../http-client.js';
export const DEFAULT_WEEKEND_TIMEOUT_MS = 4 * 60 * 1000;
export class Jolpica {
  constructor(http = new ProviderHttp({ baseUrl: 'https://api.jolpi.ca/ergast/f1/' })) {
    this.http = http;
  }
  async pages(path, table, field, nested, options = {}) {
    const observations = [];
    let offset = 0,
      total = Infinity;
    const records = [];
    while (offset < total) {
      if (offset > 100000) throw new Error('Provider pagination exceeded safety bound.');
      const result = await this.http.get(`${path}.json?limit=100&offset=${offset}`, options);
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
  async season(year, options = {}) {
    if (!Number.isInteger(year) || year < 1950 || year > new Date().getUTCFullYear())
      throw new Error('Invalid season.');
    return this.pages(String(year), 'RaceTable', 'Races', undefined, options);
  }
  async seasons() {
    const result = await this.pages('seasons', 'SeasonTable', 'Seasons');
    if (
      !result.records.length ||
      result.records.some((row) => !/^\d{4}$/.test(row.season) || Number(row.season) < 1950)
    )
      throw new Error('Jolpica season catalogue is invalid.');
    return result;
  }
  async weekend(year, round, { totalTimeoutMs = DEFAULT_WEEKEND_TIMEOUT_MS } = {}) {
    if (!Number.isInteger(round) || round < 1 || round > 100) throw new Error('Invalid round.');
    if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1)
      throw new Error('Invalid weekend time budget.');
    const options = { signal: AbortSignal.timeout(totalTimeoutMs) };
    const calendar = await this.season(year, options);
    const race = calendar.records.find((x) => Number(x.round) === round);
    if (!race) throw new Error('Round not present in provider calendar.');
    const observations = [...calendar.observations];
    const failures = [];
    const fetchRaceField = async (suffix, field, required = false) => {
      try {
        const r = await this.pages(
          `${year}/${round}/${suffix}`,
          'RaceTable',
          'Races',
          field === 'Laps' ? 'Laps' : field,
          options,
        );
        observations.push(...r.observations);
        race[field] = r.records.flatMap((x) => x[field] || []);
      } catch (error) {
        if (required) throw error;
        failures.push(suffix);
      }
    };
    await fetchRaceField('results', 'Results', true);
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
          options,
        );
        observations.push(...r.observations);
        standings[kind] = r.records.flatMap((x) => x[field] || []);
      } catch {
        failures.push('standings:' + kind);
      }
    }
    // Required championship coverage gets the budget before the large enrichment pages.
    for (const [suffix, field] of [
      ['qualifying', 'QualifyingResults'],
      ['sprint', 'SprintResults'],
      ['pitstops', 'PitStops'],
      ['laps', 'Laps'],
    ])
      await fetchRaceField(suffix, field);
    return { calendar: calendar.records, race, standings, observations, failures };
  }

  async refreshWeekend(year, round, { calendar = null, totalTimeoutMs = 29000 } = {}) {
    if (!Number.isInteger(year) || year < 1950 || year > new Date().getUTCFullYear())
      throw new Error('Invalid season.');
    if (!Number.isInteger(round) || round < 1 || round > 100) throw new Error('Invalid round.');
    if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1)
      throw new Error('Invalid refresh time budget.');

    const deadline = AbortSignal.timeout(totalTimeoutMs);
    const requestOptions = { signal: deadline, timeoutMs: 4000, maxAttempts: 1 };
    const fullCalendar = calendar || (await this.season(year, requestOptions)).records;
    if (
      !Array.isArray(fullCalendar) ||
      !fullCalendar.some((item) => Number(item.season) === year && Number(item.round) === round)
    )
      throw new Error('A complete season calendar containing the requested round is required.');

    const observations = [];
    const failures = [];
    const calendarRace = fullCalendar.find((item) => Number(item.round) === round);
    let resultPage;
    try {
      resultPage = await this.pages(
        `${year}/${round}/results`,
        'RaceTable',
        'Races',
        'Results',
        requestOptions,
      );
      observations.push(...resultPage.observations);
    } catch (error) {
      error.code ||= 'UPSTREAM_UNAVAILABLE';
      throw error;
    }

    const sourceRace = resultPage.records.find(
      (item) => Number(item.season) === year && Number(item.round) === round,
    );
    const race = { ...calendarRace, ...(sourceRace || {}), Results: sourceRace?.Results || [] };
    if (!race.Results.length) {
      const error = new Error(`Jolpica has not published results for ${year} round ${round}.`);
      error.code = 'RACE_RESULTS_NOT_PUBLISHED';
      throw error;
    }

    const optional = async (key, path, table, field, nested) => {
      try {
        const page = await this.pages(path, table, field, nested, requestOptions);
        observations.push(...page.observations);
        return page.records.flatMap((item) => item[nested] || []);
      } catch {
        failures.push(key);
        return [];
      }
    };
    const [qualifying, drivers, constructors] = await Promise.all([
      optional(
        'qualifying',
        `${year}/${round}/qualifying`,
        'RaceTable',
        'Races',
        'QualifyingResults',
      ),
      optional(
        'standings:drivers',
        `${year}/${round}/driverstandings`,
        'StandingsTable',
        'StandingsLists',
        'DriverStandings',
      ),
      optional(
        'standings:constructors',
        `${year}/${round}/constructorstandings`,
        'StandingsTable',
        'StandingsLists',
        'ConstructorStandings',
      ),
    ]);
    race.QualifyingResults = qualifying;
    return {
      calendar: fullCalendar,
      race,
      standings: { drivers, constructors },
      observations,
      failures,
    };
  }
}
