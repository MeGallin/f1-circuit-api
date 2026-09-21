const normalize = (value) =>
  String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, ' ')
    .trim();

const unique = (items) => [...new Set(items.filter(Boolean))];

function humanList(items) {
  const values = unique(items);
  if (values.length < 2) return values[0] || 'Not supplied';
  if (values.length === 2) return values.join(' and ');
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}

function eventIdFromSession(sessionId) {
  if (!String(sessionId || '').startsWith('session:')) return null;
  return String(sessionId).slice(8, String(sessionId).lastIndexOf(':'));
}

function yearFromEvent(eventId) {
  const match = String(eventId || '').match(/^event:(\d{4}):/);
  return match ? Number(match[1]) : null;
}

function isRace(row) {
  return row?.sessionId?.endsWith(':race');
}

function isStarted(row) {
  return isRace(row) && !['not-started', 'not-classified', 'withdrawn'].includes(row.status);
}

function driverOf(row) {
  return row?.entry?.drivers?.[0] || null;
}

function constructorOf(row) {
  return row?.entry?.constructor || null;
}

function sourceCoverage(sets) {
  return sets.some((set) => set?.coverage !== 'complete' || set?.warnings?.length)
    ? 'partial'
    : 'complete';
}

function evidenceIds(sets) {
  return unique(sets.map((set) => set?.evidenceId));
}

async function allSets(data, prefix) {
  const keys = await data.keys(prefix);
  return Promise.all(keys.map((key) => data.get(key)));
}

async function profileLookup(data, name) {
  const sets = await allSets(data, 'profile:');
  const target = normalize(name);
  const profiles = sets.flatMap((set) => set?.items || []);
  const profile = profiles.find(
    (item) => item.kind === 'driver' && normalize(item.entity?.displayName) === target,
  );
  return { profile, sets };
}

async function eventLookup(data, year, name) {
  const set = await data.get(`events:${year}`);
  const target = normalize(name);
  const event = (set?.items || []).find((item) => normalize(item.name) === target);
  if (!event)
    return { event: null, eventSet: set, detail: null, resultSet: null, qualifyingSet: null };
  const detail = await data.get(`event:${event.id}`);
  const sessions = detail?.items?.[0]?.sessions || [];
  const race = sessions.find((session) => session.kind === 'race');
  const qualifying = sessions.find((session) => session.kind === 'qualifying');
  return {
    event,
    eventSet: set,
    detail,
    resultSet: race ? await data.get(`results:${race.id}`) : null,
    qualifyingSet: qualifying ? await data.get(`qualifying:${qualifying.id}`) : null,
  };
}

function raceRows(resultSets, range = {}) {
  return resultSets.flatMap((set) =>
    (set?.items || []).filter((row) => {
      if (!isRace(row)) return false;
      const year = yearFromEvent(eventIdFromSession(row.sessionId));
      return (
        (range.fromYear == null || year >= range.fromYear) &&
        (range.toYear == null || year <= range.toYear)
      );
    }),
  );
}

function distinctEventRows(rows, predicate) {
  const byEvent = new Map();
  for (const row of rows) {
    if (!predicate(row)) continue;
    const eventId = eventIdFromSession(row.sessionId);
    if (eventId && !byEvent.has(eventId)) byEvent.set(eventId, row);
  }
  return byEvent;
}

function answered(intent, fields, answerTokens, sets, requiredEvidenceIds = []) {
  return {
    status: 'answered',
    intent,
    fields,
    answerTokens: unique(answerTokens.map(String)),
    sourceCoverage: sourceCoverage(sets),
    evidenceIds: evidenceIds(sets),
    requiredEvidenceIds: unique(requiredEvidenceIds),
    evidenceRequired: true,
  };
}

function unavailable(reasonCode, sets = [], message = null) {
  return {
    status: 'unavailable',
    reasonCode,
    message,
    sourceCoverage: sets.length ? sourceCoverage(sets) : 'unavailable',
    evidenceIds: evidenceIds(sets),
    requiredEvidenceIds: [],
    evidenceRequired: false,
  };
}

async function eventMetric(data, scenario) {
  const lookup = await eventLookup(
    data,
    scenario.year || 2022,
    scenario.event || 'Italian Grand Prix',
  );
  const { event, eventSet, detail, resultSet, qualifyingSet } = lookup;
  if (!event) return unavailable('EVENT_NOT_PUBLISHED', [eventSet]);
  const baseSets = [eventSet, detail];
  if (scenario.derive === 'eventCircuit') {
    if (!event.circuit?.displayName) return unavailable('EVENT_CIRCUIT_NOT_PUBLISHED', baseSets);
    return answered(
      'event_circuit',
      {
        event: event.name,
        year: event.year,
        round: event.round,
        circuit: event.circuit.displayName,
        circuitId: event.circuit.id,
      },
      [event.name, event.year, event.circuit.displayName],
      baseSets,
      evidenceIds(baseSets),
    );
  }
  if (!resultSet?.items?.length) {
    const reason = scenario.unavailableReason || 'WINNER_NOT_PUBLISHED';
    return unavailable(reason, [...baseSets, resultSet]);
  }
  if (scenario.derive === 'eventWinner') {
    const winner = resultSet.items.find((row) => row.position === 1 && isStarted(row));
    if (!winner) return unavailable('WINNER_NOT_PUBLISHED', [...baseSets, resultSet]);
    const driver = driverOf(winner);
    const constructor = constructorOf(winner);
    return answered(
      'event_winner',
      {
        event: event.name,
        year: event.year,
        round: event.round,
        driver: driver?.displayName,
        constructor: constructor?.displayName || 'Not supplied',
      },
      [driver?.displayName, event.name],
      [...baseSets, resultSet],
      evidenceIds([resultSet]),
    );
  }
  if (scenario.derive === 'eventPodium') {
    const rows = resultSet.items
      .filter((row) => row.position >= 1 && row.position <= 3)
      .sort((a, b) => a.position - b.position);
    if (!rows.length) return unavailable('PODIUM_NOT_PUBLISHED', [...baseSets, resultSet]);
    const podium = rows.map(
      (row) => `P${row.position} ${driverOf(row)?.displayName || 'Not supplied'}`,
    );
    return answered(
      'event_podium',
      { event: event.name, year: event.year, podium: podium.join('; ') },
      [event.name, ...podium],
      [...baseSets, resultSet],
      evidenceIds([resultSet]),
    );
  }
  if (scenario.derive === 'eventFastestLap') {
    const rows = resultSet.items.filter((row) => row.fastestLap?.rank === 1);
    if (!rows.length) return unavailable('FASTEST_LAP_NOT_PUBLISHED', [...baseSets, resultSet]);
    const drivers = unique(rows.map((row) => driverOf(row)?.displayName));
    const lapNumber = rows[0].fastestLap?.lapNumber;
    return answered(
      'event_fastest_lap',
      { event: event.name, year: event.year, drivers: drivers.join(', '), lapNumber },
      [event.name, ...drivers, lapNumber],
      [...baseSets, resultSet],
      evidenceIds([resultSet]),
    );
  }
  if (scenario.derive === 'eventPole') {
    if (!qualifyingSet?.items?.length)
      return unavailable('QUALIFYING_NOT_PUBLISHED', [...baseSets, qualifyingSet]);
    const rows = qualifyingSet.items.filter((row) => row.position === 1);
    if (!rows.length) return unavailable('QUALIFYING_NOT_PUBLISHED', [...baseSets, qualifyingSet]);
    const drivers = unique(rows.map((row) => driverOf(row)?.displayName));
    return answered(
      'event_pole',
      { event: event.name, year: event.year, drivers: drivers.join(', ') },
      [event.name, ...drivers],
      [...baseSets, qualifyingSet],
      evidenceIds([qualifyingSet]),
    );
  }
  return unavailable('QUESTION_CONTRACT_DERIVE_UNSUPPORTED', baseSets);
}

async function driverSeasonWins(data, scenario, year) {
  const { profile, sets } = await profileLookup(data, scenario.driver || 'Max Verstappen');
  if (!profile) return { status: 'clarification', evidenceIds: evidenceIds(sets) };
  const resultSets = await allSets(data, 'results:');
  const rows = raceRows(resultSets, { fromYear: year, toYear: year });
  if (!rows.length)
    return unavailable('DRIVER_RACE_WINS_SEASON_NOT_PUBLISHED', [...sets, ...resultSets]);
  const wins = rows.filter(
    (row) => isStarted(row) && row.position === 1 && driverOf(row)?.id === profile.id,
  );
  const relevantSets = resultSets.filter((set) =>
    (set?.items || []).some((row) => rows.includes(row)),
  );
  return answered(
    'driver_race_wins_season',
    {
      driver: profile.entity.displayName,
      metric: 'race_wins',
      season: year,
      count: wins.length,
      fromYear: year,
      toYear: year,
    },
    [profile.entity.displayName, wins.length, year],
    [...sets, ...relevantSets],
    evidenceIds(relevantSets),
  );
}

async function driverMetric(data, scenario) {
  const { profile, sets } = await profileLookup(data, scenario.driver || 'Max Verstappen');
  if (!profile) return { status: 'clarification', evidenceIds: evidenceIds(sets) };
  const resultSets = await allSets(data, 'results:');
  const qualifyingSets = await allSets(data, 'qualifying:');
  const metric = scenario.metric;
  const selectedSets = metric === 'poles' ? qualifyingSets : resultSets;
  if (!selectedSets.length)
    return unavailable('DRIVER_STAT_NOT_PUBLISHED', [...sets, ...selectedSets]);
  const rows = selectedSets.flatMap((set) =>
    (set?.items || []).filter((row) => {
      const drivers = row?.entry?.drivers || [];
      return drivers.some((driver) => driver.id === profile.id);
    }),
  );
  const predicate = {
    race_starts: (row) => isStarted(row),
    podiums: (row) => isStarted(row) && row.position >= 1 && row.position <= 3,
    fastest_laps: (row) => isRace(row) && row.fastestLap?.rank === 1,
    retirements: (row) => isRace(row) && row.status === 'retired',
    disqualifications: (row) => isRace(row) && row.status === 'disqualified',
    did_not_start: (row) => isRace(row) && row.status === 'not-started',
    did_not_qualify: (row) => isRace(row) && row.status === 'not-classified',
    poles: (row) => row.position === 1,
  }[metric];
  const events = distinctEventRows(rows, predicate || (() => false));
  return answered(
    'driver_stat',
    {
      driver: profile.entity.displayName,
      metric,
      count: events.size,
      fromYear: null,
      toYear: null,
    },
    [profile.entity.displayName, events.size],
    [...sets, ...selectedSets],
    evidenceIds(selectedSets),
  );
}

async function driverCareerWins(data, scenario) {
  const { profile, sets } = await profileLookup(data, scenario.driver || 'Max Verstappen');
  if (!profile) return { status: 'clarification', evidenceIds: evidenceIds(sets) };
  const resultSets = await allSets(data, 'results:');
  const rows = raceRows(resultSets).filter(
    (row) => isStarted(row) && row.position === 1 && driverOf(row)?.id === profile.id,
  );
  const wins = new Set(rows.map((row) => eventIdFromSession(row.sessionId)));
  return answered(
    'driver_race_wins',
    { driver: profile.entity.displayName, count: wins.size },
    [profile.entity.displayName, wins.size],
    [...sets, ...resultSets],
    evidenceIds(resultSets),
  );
}

async function finishingPosition(data, scenario) {
  const resultSets = await allSets(data, 'results:');
  const rows = raceRows(resultSets, {
    fromYear: scenario.fromYear,
    toYear: scenario.toYear,
  }).filter((row) => isStarted(row) && row.position === scenario.position);
  if (!rows.length) return unavailable('FINISHING_POSITION_NOT_PUBLISHED', resultSets);
  const counts = new Map();
  for (const row of rows) {
    const driver = driverOf(row);
    if (!driver?.id) continue;
    const current = counts.get(driver.id) || { name: driver.displayName, count: 0 };
    current.count += 1;
    counts.set(driver.id, current);
  }
  if (!counts.size) return unavailable('FINISHING_POSITION_DRIVER_MAPPING_UNAVAILABLE', resultSets);
  const highest = Math.max(...[...counts.values()].map((item) => item.count));
  const leaders = [...counts.values()]
    .filter((item) => item.count === highest)
    .sort((a, b) => a.name.localeCompare(b.name));
  const names = leaders.map((leader) => leader.name);
  return answered(
    'driver_finishing_position',
    {
      driver: humanList(names),
      drivers: humanList(names),
      count: highest,
      position: scenario.position,
      fromYear: scenario.fromYear ?? null,
      toYear: scenario.toYear ?? null,
    },
    [...names, highest],
    resultSets,
    evidenceIds(resultSets),
  );
}

async function driverWinsComparison(data) {
  const profiles = await allSets(data, 'profile:');
  const allProfiles = profiles.flatMap((set) => set?.items || []);
  const driver = allProfiles.find(
    (item) => normalize(item.entity?.displayName) === normalize('Max Verstappen'),
  );
  const comparisonDriver = allProfiles.find(
    (item) => normalize(item.entity?.displayName) === normalize('Lewis Hamilton'),
  );
  if (!driver || !comparisonDriver)
    return { status: 'clarification', evidenceIds: evidenceIds(profiles) };
  const resultSets = await allSets(data, 'results:');
  const rows = raceRows(resultSets).filter((row) => isStarted(row) && row.position === 1);
  const countFor = (id) =>
    new Set(
      rows
        .filter((row) => driverOf(row)?.id === id)
        .map((row) => eventIdFromSession(row.sessionId)),
    ).size;
  const count = countFor(driver.id);
  const comparisonCount = countFor(comparisonDriver.id);
  return answered(
    'driver_race_wins_comparison',
    {
      driver: driver.entity.displayName,
      count,
      comparisonDriver: comparisonDriver.entity.displayName,
      comparisonCount,
    },
    [driver.entity.displayName, count, comparisonDriver.entity.displayName, comparisonCount],
    [...profiles, ...resultSets],
    evidenceIds(resultSets),
  );
}

async function driverChampionships(data, scenario) {
  const { profile, sets } = await profileLookup(data, scenario.driver || 'Max Verstappen');
  if (!profile) return { status: 'clarification', evidenceIds: evidenceIds(sets) };
  const standingsKeys = (await data.keys('standings:')).filter((key) =>
    /^standings:\d{4}:drivers$/.test(key),
  );
  const standings = await Promise.all(standingsKeys.map((key) => data.get(key)));
  if (!standings.length) return unavailable('CHAMPIONSHIPS_NOT_PUBLISHED', [...sets, ...standings]);
  const years = standings.flatMap((set) => {
    const match = String(set.key).match(/^standings:(\d{4}):drivers$/);
    const row = (set.items || []).find((item) => item.entity?.id === profile.id && item.rank === 1);
    return match && row ? [Number(match[1])] : [];
  });
  return answered(
    'driver_stat',
    {
      driver: profile.entity.displayName,
      metric: 'championships',
      count: years.length,
      championshipYears: years.sort((a, b) => a - b).join(', ') || 'None published',
      fromYear: null,
      toYear: null,
    },
    [profile.entity.displayName, ...years],
    [...sets, ...standings],
    evidenceIds(standings),
  );
}

async function driverConstructorStarts(data) {
  const profiles = await allSets(data, 'profile:');
  const items = profiles.flatMap((set) => set?.items || []);
  const driver = items.find(
    (item) =>
      item.kind === 'driver' && normalize(item.entity?.displayName) === normalize('Lewis Hamilton'),
  );
  const constructor = items.find(
    (item) =>
      item.kind === 'constructor' && normalize(item.entity?.displayName) === normalize('Mercedes'),
  );
  if (!driver || !constructor)
    return { status: 'clarification', evidenceIds: evidenceIds(profiles) };
  const resultSets = await allSets(data, 'results:');
  const rows = raceRows(resultSets).filter(
    (row) =>
      isStarted(row) &&
      row.entry?.constructor?.id === constructor.id &&
      (row.entry?.drivers || []).some((entryDriver) => entryDriver.id === driver.id),
  );
  const count = new Set(rows.map((row) => eventIdFromSession(row.sessionId))).size;
  return answered(
    'driver_constructor_race_starts',
    {
      driver: driver.entity.displayName,
      constructor: constructor.entity.displayName,
      metric: 'race_starts',
      count,
      fromYear: null,
      toYear: null,
    },
    [driver.entity.displayName, constructor.entity.displayName, count],
    [...profiles, ...resultSets],
    evidenceIds(resultSets),
  );
}

async function history(data, scenario) {
  const profileSets = await allSets(data, 'profile:');
  const profiles = profileSets.flatMap((set) => set?.items || []);
  const circuits = profiles.filter((profile) => {
    if (profile.kind !== 'circuit') return false;
    if (scenario.derive === 'countryHistory')
      return normalize(profile.country) === normalize(scenario.country);
    return normalize(profile.entity?.displayName).includes(normalize(scenario.circuit));
  });
  const circuitIds = new Set(circuits.map((profile) => profile.id));
  const eventSets = await allSets(data, 'events:');
  const eventRecords = eventSets.flatMap((set) =>
    (set?.items || [])
      .filter((event) => circuitIds.has(event.circuit?.id))
      .map((event) => ({ event, set })),
  );
  const winners = [];
  const usedSets = [...profileSets, ...eventSets];
  for (const record of eventRecords) {
    const detail = await data.get(`event:${record.event.id}`);
    const race = detail?.items?.[0]?.sessions?.find((session) => session.kind === 'race');
    const resultSet = race ? await data.get(`results:${race.id}`) : null;
    const winner = resultSet?.items?.find((row) => isStarted(row) && row.position === 1);
    if (!winner) continue;
    const driver = driverOf(winner);
    if (!driver) continue;
    winners.push({
      event: record.event,
      driver,
      constructor: constructorOf(winner),
      resultSet,
      detail,
      set: record.set,
    });
    usedSets.push(record.set, detail, resultSet);
  }
  winners.sort(
    (a, b) =>
      (Date.parse(b.event.schedule?.startsAt || b.event.schedule?.date || '') || 0) -
        (Date.parse(a.event.schedule?.startsAt || a.event.schedule?.date || '') || 0) ||
      (b.event.year || 0) - (a.event.year || 0) ||
      (b.event.round || 0) - (a.event.round || 0),
  );
  const selected = winners.slice(0, scenario.limit);
  if (!selected.length) return unavailable('RACE_RESULTS_NOT_PUBLISHED', usedSets);
  const lines = selected.map(
    ({ event, driver, constructor }) =>
      `${event.year} ${event.name} — ${driver.displayName}${constructor?.displayName ? ` (${constructor.displayName})` : ''}`,
  );
  const field =
    scenario.derive === 'countryHistory'
      ? { country: scenario.country }
      : { circuit: circuits[0]?.entity?.displayName };
  return answered(
    scenario.intent,
    { ...field, count: selected.length, winners: lines.join('; ') },
    [...lines, selected.length],
    usedSets,
    evidenceIds(selected.flatMap((item) => [item.resultSet, item.set])),
  );
}

async function unavailableDataset(data, scenario) {
  const lookup = await eventLookup(data, scenario.constraints.year, scenario.constraints.event);
  if (!lookup.event) return unavailable('EVENT_NOT_PUBLISHED', [lookup.eventSet]);
  const race = lookup.detail?.items?.[0]?.sessions?.find((session) => session.kind === 'race');
  const dataset = race
    ? await data.get(`${scenario.datasetPrefix}session:${lookup.event.id}:race`)
    : null;
  const usedSets = [lookup.eventSet, lookup.detail, dataset];
  if (dataset?.items?.length)
    return {
      status: 'contract-update-required',
      reasonCode: 'DATASET_NOW_PUBLISHED',
      sourceCoverage: sourceCoverage(usedSets),
      evidenceIds: evidenceIds(usedSets),
      evidenceRequired: true,
    };
  return unavailable(scenario.unavailableReason, usedSets);
}

async function unavailablePitStops(data, scenario) {
  const lookup = await eventLookup(data, scenario.constraints.year, scenario.constraints.event);
  if (!lookup.event) return unavailable('EVENT_NOT_PUBLISHED', [lookup.eventSet]);
  const race = lookup.detail?.items?.[0]?.sessions?.find((session) => session.kind === 'race');
  const dataset = race ? await data.get(`pit-stops:${race.id}`) : null;
  const usedSets = [lookup.eventSet, lookup.detail, dataset];
  if (dataset?.items?.length)
    return {
      status: 'contract-update-required',
      reasonCode: 'DATASET_NOW_PUBLISHED',
      sourceCoverage: sourceCoverage(usedSets),
      evidenceIds: evidenceIds(usedSets),
      evidenceRequired: true,
    };
  return unavailable(scenario.unavailableReason, usedSets);
}

export async function deriveExpected(scenario, data) {
  if (scenario.expectedStatus === 'unavailable' && !scenario.derive)
    return unavailable(scenario.unavailableReason, []);
  if (scenario.expectedStatus === 'unsupported')
    return { status: 'unsupported', reasonCode: scenario.unavailableReason, evidenceIds: [] };
  if (scenario.expectedStatus === 'clarification') {
    if (scenario.derive === 'unknownDriverContext') {
      const profiles = await allSets(data, 'profile:');
      return { status: 'clarification', evidenceIds: evidenceIds(profiles) };
    }
    return { status: 'clarification', evidenceIds: [] };
  }
  switch (scenario.derive) {
    case 'eventWinner':
    case 'eventPodium':
    case 'eventFastestLap':
    case 'eventPole':
    case 'eventCircuit':
      return eventMetric(data, {
        ...scenario,
        year: scenario.constraints.year,
        event: scenario.constraints.event,
      });
    case 'driverSeasonWins':
      return driverSeasonWins(data, scenario, scenario.constraints.year);
    case 'driverRelativeWins':
      return driverSeasonWins(
        data,
        { ...scenario, driver: 'Max Verstappen' },
        new Date().getUTCFullYear() - 1,
      );
    case 'driverCareerWins':
      return driverCareerWins(data, scenario);
    case 'driverMetric':
      return driverMetric(data, { ...scenario, driver: 'Max Verstappen' });
    case 'finishingPosition':
      return finishingPosition(data, scenario);
    case 'driverWinsComparison':
      return driverWinsComparison(data, scenario);
    case 'driverChampionships':
      return driverChampionships(data, scenario);
    case 'driverConstructorStarts':
      return driverConstructorStarts(data, scenario);
    case 'circuitHistory':
    case 'countryHistory':
      return history(data, scenario);
    case 'pitStopsUnavailable':
      return unavailablePitStops(data, scenario);
    case 'unavailableDataset':
      return unavailableDataset(data, scenario);
    case 'unknownDriverContext': {
      const profiles = await allSets(data, 'profile:');
      return { status: 'clarification', evidenceIds: evidenceIds(profiles) };
    }
    case 'unknownEvent':
      return unavailable('EVENT_NOT_PUBLISHED', [await data.get('events:2022')]);
    default:
      return unavailable('QUESTION_CONTRACT_DERIVE_UNSUPPORTED', []);
  }
}

export { normalize };
