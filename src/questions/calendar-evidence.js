import { hash } from '../models/dataset.js';

export function calendarContentHash(events) {
  return hash(
    events
      .map((event) => ({
        id: event.id,
        year: event.year,
        round: event.round,
        name: event.name,
        date: event.schedule?.date,
        circuitId: event.circuit?.id,
      }))
      .sort((a, b) => a.round - b.round),
  );
}

// Explicit links are preferred. Legacy proof corroborates identical published
// content; it does not recover or invent the original observation reference.
export function completeCalendarObservation(year, calendar, observation, options = {}) {
  const references = calendar?.provenance?.observationIds;
  const linked = Array.isArray(references) && references.includes(observation?.id);
  if (!Number.isInteger(year) || (!linked && (!options.allowContentMatch || references?.length)))
    return false;
  const retrievedAt = Date.parse(observation.retrieved_at);
  if (
    observation.provider !== 'jolpica' ||
    !Number.isFinite(retrievedAt) ||
    retrievedAt < Date.UTC(year + 1, 0, 1)
  )
    return false;
  const data = observation.payload?.MRData;
  const races = data?.RaceTable?.Races;
  const events = calendar.items;
  const total = Number(data?.total);
  const limit = Number(data?.limit);
  if (
    !/^\d+$/.test(String(data?.offset)) ||
    Number(data.offset) !== 0 ||
    !Number.isSafeInteger(total) ||
    total < 1 ||
    total > 64 ||
    !Number.isSafeInteger(limit) ||
    limit < total ||
    Number(data.RaceTable?.season) !== year ||
    !Array.isArray(races) ||
    !Array.isArray(events) ||
    races.length !== total ||
    events.length !== total
  )
    return false;
  if (
    new Set(races.map((race) => Number(race.round))).size !== total ||
    new Set(events.map((event) => event.round)).size !== total
  )
    return false;
  const matching = races.every((race) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(race.date || '')
      ? new Date(`${race.date}T00:00:00Z`)
      : null;
    if (
      !date ||
      !Number.isFinite(date.valueOf()) ||
      date.toISOString().slice(0, 10) !== race.date ||
      date.valueOf() > retrievedAt
    )
      return false;
    return (
      Number(race.season) === year &&
      events.some(
        (event) =>
          event.year === year &&
          event.round === Number(race.round) &&
          event.name === race.raceName &&
          event.circuit?.id === `circuit:${race.Circuit?.circuitId}` &&
          event.schedule?.date === race.date,
      )
    );
  });
  if (!matching) return false;
  if (linked) return true;
  const publicationTime = Date.parse(options.publicationCreatedAt);
  if (
    !Number.isFinite(publicationTime) ||
    retrievedAt > publicationTime ||
    options.allCompletedResultsPublished !== true ||
    !calendar.provenance?.sources?.some((source) => source.id === 'jolpica')
  )
    return false;
  try {
    const url = new URL(observation.source_url);
    if (url.origin !== 'https://api.jolpi.ca' || url.pathname !== `/ergast/f1/${year}.json`)
      return false;
  } catch {
    return false;
  }
  if (
    !/^[a-f0-9]{64}$/.test(options.calendarHash || '') ||
    calendarContentHash(events) !== options.calendarHash
  )
    return false;
  const canonicalRaw = races.map((race) => ({
    id: options.aliases?.get(`race:${year}:${Number(race.round)}`),
    year: Number(race.season),
    round: Number(race.round),
    name: race.raceName,
    schedule: { date: race.date },
    circuit: { id: `circuit:${race.Circuit.circuitId}` },
  }));
  return (
    canonicalRaw.every((event) => typeof event.id === 'string' && event.id.length > 0) &&
    calendarContentHash(canonicalRaw) === options.calendarHash
  );
}
