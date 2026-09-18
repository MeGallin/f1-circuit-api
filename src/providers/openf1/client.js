import { ProviderHttp } from '../http-client.js';
import { shape } from '../../schemas/contract.js';
import { number } from '../../models/normalization.js';
import { dataset } from '../../models/dataset.js';
import { matchesSessionDate } from './session-mapping.js';
export class OpenF1 {
  constructor(
    http = new ProviderHttp({ baseUrl: 'https://api.openf1.org/v1/', intervalMs: 8000 }),
  ) {
    this.http = http;
  }
  async session(key) {
    if (!Number.isInteger(key) || key < 1)
      throw new Error('Explicit historical session key required.');
    const r = await this.http.get(`sessions?session_key=${key}`);
    const s = r.payload?.[0];
    if (
      !s ||
      s.session_key !== key ||
      !s.date_end ||
      Date.parse(s.date_end) > Date.now() ||
      s.year < 2023
    )
      throw new Error('Session is not a supported completed historical session.');
    return r;
  }
  async detail(key, canonicalSession, entries, provenance, { event, mapping } = {}) {
    const check = await this.session(key);
    const s = check.payload[0];
    if (!matchesSessionDate(canonicalSession, s, event, mapping))
      throw new Error('OpenF1 session date mismatch; reviewed mapping required.');
    const expected = {
      race: 'Race',
      qualifying: 'Qualifying',
      sprint: 'Sprint',
      'sprint-qualifying': 'Sprint Qualifying',
      practice: 'Practice',
    }[canonicalSession.kind];
    if (!expected || !s.session_name.includes(expected))
      throw new Error('OpenF1 session kind mismatch.');
    const sets = [],
      observations = [check];
    const entryByNumber = new Map(
      entries.filter((e) => e.number).map((e) => [Number(e.number), e]),
    );
    for (const [path, schema, datasetKey] of [
      ['laps', 'Lap', 'laps'],
      ['pit', 'PitStop', 'pit-stops'],
      ['stints', 'Stint', 'stints'],
      ['weather', 'Weather', 'weather'],
      ['race_control', 'RaceControl', 'race-control'],
    ]) {
      try {
        const response = await this.http.get(`${path}?session_key=${key}`);
        if (!Array.isArray(response.payload)) throw new Error('OpenF1 schema changed.');
        observations.push(response);
        const records = [];
        for (const [index, r] of response.payload.entries()) {
          const entry = entryByNumber.get(r.driver_number);
          if (['Lap', 'PitStop', 'Stint'].includes(schema) && !entry) continue;
          const base = {
            ...shape(schema),
            id: `openf1:${key}:${path}:${index}`,
            sessionId: canonicalSession.id,
          };
          if (schema === 'Lap')
            Object.assign(base, {
              entryId: entry.id,
              lapNumber: r.lap_number,
              startedAt: r.date_start ? new Date(r.date_start).toISOString() : null,
              durationMs: r.lap_duration == null ? null : Math.round(r.lap_duration * 1000),
              sectors: [1, 2, 3].map((i) => ({
                index: i,
                durationMs:
                  r[`duration_sector_${i}`] == null
                    ? null
                    : Math.round(r[`duration_sector_${i}`] * 1000),
              })),
              speeds: ['i1', 'i2', 'st'].map((k) => ({
                locationLabel: k,
                speedKph: number(r[k + '_speed']),
              })),
              validity: 'unknown',
              isPitInLap: null,
              isPitOutLap: r.is_pit_out_lap ?? null,
            });
          if (schema === 'PitStop')
            Object.assign(base, {
              entryId: entry.id,
              sequence: records.filter((x) => x.entryId === entry.id).length + 1,
              lap: number(r.lap_number),
              timestamp: r.date ? new Date(r.date).toISOString() : null,
              laneDurationMs:
                (r.lane_duration ?? r.pit_duration) == null
                  ? null
                  : Math.round((r.lane_duration ?? r.pit_duration) * 1000),
              stationaryDurationMs:
                r.stop_duration == null ? null : Math.round(r.stop_duration * 1000),
            });
          if (schema === 'Stint') {
            const compound = String(r.compound || 'unknown').toLowerCase();
            Object.assign(base, {
              entryId: entry.id,
              sequence: r.stint_number,
              startLap: number(r.lap_start),
              endLap: number(r.lap_end),
              compoundLabel: r.compound || null,
              compoundClass: ['soft', 'medium', 'hard', 'intermediate', 'wet'].includes(compound)
                ? compound
                : 'unknown',
              tyreAgeAtStart: number(r.tyre_age_at_start),
              tyreState:
                r.tyre_age_at_start == null
                  ? 'unknown'
                  : r.tyre_age_at_start === 0
                    ? 'new'
                    : 'used',
            });
          }
          if (schema === 'Weather')
            Object.assign(base, {
              timestamp: new Date(r.date).toISOString(),
              sourceId: 'openf1',
              observationKind: 'trackside',
              latitude: null,
              longitude: null,
              airTemperatureC: number(r.air_temperature),
              trackTemperatureC: number(r.track_temperature),
              pressureHpa: number(r.pressure),
              windSpeedMs: number(r.wind_speed),
              windDirectionDegrees: number(r.wind_direction),
              humidityPercent: number(r.humidity),
              rainfall: r.rainfall == null ? null : Boolean(r.rainfall),
            });
          if (schema === 'RaceControl')
            Object.assign(base, {
              timestamp: r.date ? new Date(r.date).toISOString() : null,
              lap: number(r.lap_number),
              category: r.category || 'unknown',
              message: r.message || 'No message supplied',
              flag: r.flag || null,
              scope: r.scope || null,
              entryIds: entry ? [entry.id] : [],
            });
          records.push(base);
        }
        sets.push(dataset(`${datasetKey}:${canonicalSession.id}`, schema, records, provenance));
      } catch {
        sets.push(
          dataset(`${datasetKey}:${canonicalSession.id}`, schema, [], provenance, {
            warnings: [
              {
                code: 'PROVIDER_DETAIL_UNAVAILABLE',
                message: 'This detail could not be imported.',
                scope: datasetKey,
              },
            ],
          }),
        );
      }
    }
    return { sets, observations };
  }
}
