import { OpenAIQuestionInterpreter } from '../providers/openai/question-interpreter.js';

const emptyContext = {
  year: null,
  eventId: null,
  sessionId: null,
  driverId: null,
  constructorId: null,
};

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

const numberWords = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function contextWith(overrides = {}) {
  return { ...emptyContext, ...overrides };
}

function yearRange(text, context) {
  const years = [...String(text).matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
  if (years.length >= 2) return { fromYear: Math.min(...years), toYear: Math.max(...years) };
  if (years.length === 1) return { fromYear: years[0], toYear: years[0] };
  const anchor =
    Number(context.year) || Number(context.currentYear) || new Date().getUTCFullYear();
  if (/\bthis\s+(?:year|season)\b/i.test(text)) return { fromYear: anchor, toYear: anchor };
  if (/\blast\s+year\b/i.test(text)) return { fromYear: anchor - 1, toYear: anchor - 1 };
  if (/last\s+(?:four|4)\s+years?/i.test(text)) return { fromYear: anchor - 3, toYear: anchor };
  return { fromYear: null, toYear: null };
}

function sessionEventId(sessionId) {
  if (!sessionId?.startsWith('session:')) return null;
  const last = sessionId.lastIndexOf(':');
  return last > 8 ? sessionId.slice(8, last) : null;
}

function yearFromEventId(eventId) {
  const match = String(eventId || '').match(/^event:(\d{4}):/);
  return match ? Number(match[1]) : null;
}

function raceSessionId(eventId) {
  return eventId ? `session:${eventId}:race` : null;
}

function qualifyingSessionId(eventId) {
  return eventId ? `session:${eventId}:qualifying` : null;
}

function isRaceRow(row) {
  return row?.sessionId?.endsWith(':race');
}

function isRaceStart(row) {
  return isRaceRow(row) && !['not-started', 'not-classified', 'withdrawn'].includes(row.status);
}

function driverNames(row) {
  return row?.entry?.drivers || [];
}

function distinctEventRows(rows, predicate) {
  const events = new Map();
  for (const row of rows) {
    if (!predicate(row)) continue;
    const eventId = sessionEventId(row.sessionId);
    if (eventId && !events.has(eventId)) events.set(eventId, row);
  }
  return events;
}

function formatDate(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(date);
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return 'Not supplied';
  return `${(milliseconds / 1000).toFixed(3)} seconds`;
}

export class QuestionService {
  constructor(repository, { config = {} } = {}) {
    this.repository = repository;
    this.interpreter =
      config.openaiEnabled && config.openaiApiKey
        ? new OpenAIQuestionInterpreter({
            apiKey: config.openaiApiKey,
            model: config.openaiModel,
            reasoningEffort: config.openaiReasoningEffort,
            timeoutMs: config.openaiTimeoutMs,
          })
        : null;
  }

  async answer(body, { snapshot: _snapshot, get, keys }) {
    const text = String(body?.text || '').trim();
    const context = contextWith({
      ...body?.context,
      currentYear: new Date().getUTCFullYear(),
    });
    const deterministic = await this.interpretDeterministically(text, context, { get, keys });
    if (deterministic) return deterministic;

    if (!this.interpreter)
      return this.result(
        {
          status: 'unavailable',
          message:
            'This question needs the optional natural-language interpreter. Direct archive search is still available.',
          reasonCode: 'QUESTION_INTERPRETER_DISABLED',
        },
        [],
      );

    try {
      const intent = await this.interpreter.interpret({ text, context });
      return this.executeIntent(intent, context, { get, keys }, text);
    } catch {
      return this.result(
        {
          status: 'unavailable',
          message: 'The natural-language interpreter is temporarily unavailable.',
          reasonCode: 'QUESTION_INTERPRETER_UNAVAILABLE',
        },
        [],
      );
    }
  }

  async interpretDeterministically(text, context, helpers) {
    if (!text) return null;
    const lower = normalize(text);
    if (/\bwho\s+won\b|\bwinner\b/.test(lower)) {
      const circuitQuestion = await this.detectCircuitWinnerQuestion(text, helpers, context);
      if (circuitQuestion)
        return this.executeIntent(circuitQuestion, context, helpers, text);
      const countryQuestion = await this.detectCountryWinnerQuestion(text, helpers, context);
      if (countryQuestion)
        return this.executeIntent(countryQuestion, context, helpers, text);
      if (context.eventId)
        return this.executeIntent(
          {
            intent: 'event_winner',
            eventName: null,
            clarificationNeeded: false,
          },
          context,
          helpers,
          text,
        );
      const resolvedEvent = await this.resolveEvent(null, context, text, helpers);
      if (resolvedEvent)
        return this.executeIntent(
          {
            intent: 'event_winner',
            eventName: null,
            clarificationNeeded: false,
          },
          context,
          helpers,
          text,
        );
      return null;
    }
    if (/\bhow\s+many\b/.test(lower) && /\bfor\b/.test(lower)) {
      const { items } = await this.profiles(helpers);
      const driver = items.find(
        (profile) =>
          profile.kind === 'driver' && lower.includes(normalize(profile.entity.displayName)),
      );
      const constructor = items.find(
        (profile) =>
          profile.kind === 'constructor' && lower.includes(normalize(profile.entity.displayName)),
      );
      if (driver && constructor) {
        const metric = /\bseason/.test(lower)
          ? 'seasons'
          : /\brace\b|\bstart|\bdrive|\bdrove|\braced|\btimes\b/.test(lower)
            ? 'race_starts'
            : null;
        if (!metric)
          return this.result(
            {
              status: 'clarification',
              message: 'Do you mean race starts or seasons?',
              choices: [
                {
                  label: 'Race starts',
                  context: contextWith({ driverId: driver.id, constructorId: constructor.id }),
                },
                {
                  label: 'Seasons',
                  context: contextWith({ driverId: driver.id, constructorId: constructor.id }),
                },
              ],
            },
            [],
          );
        return this.executeIntent(
          {
            intent: 'driver_constructor_race_starts',
            driverName: driver.entity.displayName,
            constructorName: constructor.entity.displayName,
            metric,
            fromYear: null,
            toYear: null,
            originalText: text,
          },
          context,
          helpers,
          text,
        );
      }
    }
    if (
      /\bwhen\b/.test(lower) &&
      /\b(last|most\s+recent)\b/.test(lower) &&
      /\b(win|won|victory)\b/.test(lower)
    ) {
      const { items } = await this.profiles(helpers);
      const driver = items.find(
        (profile) =>
          profile.kind === 'driver' && lower.includes(normalize(profile.entity.displayName)),
      );
      if (driver)
        return this.executeIntent(
          {
            intent: 'driver_last_win',
            driverName: driver.entity.displayName,
            originalText: text,
          },
          context,
          helpers,
          text,
        );
    }
    if (/\bpit\s+stops?\b/.test(lower)) {
      const metric = /\b(fastest|quickest)\b/.test(lower)
        ? 'fastest_pit_stop'
        : /\b(most|highest|more)\b/.test(lower)
          ? 'most_pit_stops'
          : 'pit_stops';
      const { items } = await this.profiles(helpers);
      const driver = items.find(
        (profile) =>
          profile.kind === 'driver' && lower.includes(normalize(profile.entity.displayName)),
      );
      return this.executeIntent(
        {
          intent: 'event_pit_stops',
          eventName: null,
          driverName: driver?.entity.displayName || null,
          metric,
          originalText: text,
        },
        context,
        helpers,
        text,
      );
    }
    const hasExplicitEventReference =
      /\b(?:grand prix|gp)\b/.test(lower) || /\b(19\d{2}|20\d{2})\b/.test(lower);
    if (
      hasExplicitEventReference &&
      (/\b(weather|rain(?:fall)?|temperature|wind|humidity|track conditions?)\b/.test(lower) ||
        /\b(tyres?|tires?|compound|stints?)\b/.test(lower) ||
        /\b(race control|safety cars?|red flags?|yellow flags?|virtual safety cars?)\b/.test(
          lower,
        ) ||
        /\b(overtakes?|passing|passes)\b/.test(lower) ||
        /\b(telemetry|top speed|fastest speed|maximum speed)\b/.test(lower))
    ) {
      const { items } = await this.profiles(helpers);
      const drivers = items
        .filter(
          (profile) =>
            profile.kind === 'driver' && lower.includes(normalize(profile.entity.displayName)),
        )
        .sort(
          (a, b) =>
            lower.indexOf(normalize(a.entity.displayName)) -
            lower.indexOf(normalize(b.entity.displayName)),
        );
      const metric = /\b(weather|track conditions?)\b/.test(lower)
        ? 'weather_summary'
        : /\brain(?:fall)?\b/.test(lower)
          ? 'rainfall'
          : /\btemperature|wind|humidity\b/.test(lower)
            ? 'temperatures'
            : /\b(tyres?|tires?|compound|stints?)\b/.test(lower)
              ? /\bhow many\b.*\blaps?\b/.test(lower)
                ? 'tyre_laps'
                : /\bhow many\b.*\bstints?\b/.test(lower)
                  ? 'tyre_stints'
                  : 'tyre_compounds'
              : /\bsafety cars?|virtual safety cars?\b/.test(lower)
                ? 'safety_car_events'
                : /\bred flags?\b/.test(lower)
                  ? 'red_flag_events'
                  : /\brace control|yellow flags?\b/.test(lower)
                    ? 'race_control_events'
                    : /\bovertakes?|passing|passes\b/.test(lower)
                      ? /\bmost|highest|more\b/.test(lower)
                        ? 'most_overtakes'
                        : 'overtakes'
                      : 'fastest_speed';
      return this.executeIntent(
        {
          intent: 'event_session_metric',
          driverName: drivers[0]?.entity.displayName || null,
          comparisonDriverName: drivers[1]?.entity.displayName || null,
          metric,
          eventName: null,
          originalText: text,
        },
        context,
        helpers,
        text,
      );
    }
    if (/\b(podium|top\s+(?:three|3))\b/.test(lower) && !/\bhow\s+many\b/.test(lower))
      return this.executeIntent(
        { intent: 'event_podium', eventName: null, originalText: text },
        context,
        helpers,
        text,
      );
    if (/\bfastest\s+lap\b/.test(lower) && !/\bhow\s+many\b/.test(lower))
      return this.executeIntent(
        { intent: 'event_fastest_lap', eventName: null, originalText: text },
        context,
        helpers,
        text,
      );
    if (/\bpole(?:\s+position)?\b/.test(lower) && !/\bhow\s+many\b/.test(lower))
      return this.executeIntent(
        { intent: 'event_pole', eventName: null, originalText: text },
        context,
        helpers,
        text,
      );
    if (/\bdnfs?\b/.test(lower))
      return this.result(
        {
          status: 'clarification',
          message:
            'The archive keeps retirements, disqualifications and non-starts separate. Do you mean retirements, disqualifications or did-not-start entries?',
          choices: [],
        },
        [],
      );
    if (/\b(how many|number of|count of)\b/.test(lower)) {
      const { items } = await this.profiles(helpers);
      const driver = items.find(
        (profile) =>
          profile.kind === 'driver' && lower.includes(normalize(profile.entity.displayName)),
      );
      const metric = /\bpodiums?\b/.test(lower)
        ? 'podiums'
        : /\bpoles?\b|\bpole positions?\b/.test(lower)
          ? 'poles'
          : /\bfastest laps?\b/.test(lower)
            ? 'fastest_laps'
            : /\bretirements?\b|\bretired\b/.test(lower)
              ? 'retirements'
              : /\bdisqualif/.test(lower)
                ? 'disqualifications'
                : /\bdns\b|did not start/.test(lower)
                  ? 'did_not_start'
                  : /\bdnq\b|did not qualify/.test(lower)
                    ? 'did_not_qualify'
                    : /\brace starts?\b|\braces?\s+started\b/.test(lower)
                      ? 'race_starts'
                      : null;
      if (driver && metric)
        return this.executeIntent(
          {
            intent: 'driver_stat',
            driverName: driver.entity.displayName,
            metric,
            originalText: text,
          },
          context,
          helpers,
          text,
        );
    }
    if (/\bhow\s+many\b/.test(lower) && /\b(win|won|victor(?:y|ies))\b/.test(lower)) {
      const { items } = await this.profiles(helpers);
      const drivers = items
        .filter(
          (profile) =>
            profile.kind === 'driver' && lower.includes(normalize(profile.entity.displayName)),
        )
        .sort(
          (a, b) =>
            lower.indexOf(normalize(a.entity.displayName)) -
            lower.indexOf(normalize(b.entity.displayName)),
        );
      if (drivers.length >= 2 && /\b(compared\s+to|versus|vs|than)\b/.test(lower))
        return this.executeIntent(
          {
            intent: 'driver_race_wins_comparison',
            driverName: drivers[0].entity.displayName,
            comparisonDriverName: drivers[1].entity.displayName,
            originalText: text,
          },
          context,
          helpers,
          text,
        );
      const driver = drivers.find((profile) =>
        lower.includes(normalize(profile.entity.displayName)),
      );
      if (driver)
        return this.executeIntent(
          {
            intent: 'driver_race_wins',
            driverName: driver.entity.displayName,
            originalText: text,
          },
          context,
          helpers,
          text,
        );
    }
    if (/^((search|find|show|look up)\b|[a-z0-9]+([ ,+]+[a-z0-9]+){0,3}$)/i.test(text))
      return this.executeIntent({ intent: 'archive_search', searchTerms: text }, context, helpers);
    return null;
  }

  async executeIntent(intent, context, { get, keys }, originalText = '') {
    if (intent?.clarificationNeeded)
      return this.result(
        {
          status: 'clarification',
          message: intent.clarificationMessage || 'Please clarify what you want to find.',
          choices: [
            { label: 'Search archive records', context: contextWith({}) },
            { label: 'Ask a supported archive question', context: contextWith({}) },
          ],
        },
        [],
      );
    if (intent?.intent === 'archive_search')
      return this.archiveSearch(intent.searchTerms || originalText, context, { get, keys });
    if (intent?.intent === 'event_winner')
      return this.eventWinner(intent.eventName, context, originalText, { get, keys });
    if (intent?.intent === 'driver_constructor_race_starts')
      return this.driverConstructorStarts(intent, context, { get, keys });
    if (intent?.intent === 'driver_last_win')
      return this.driverLastWin(intent, context, { get, keys });
    if (intent?.intent === 'driver_race_wins')
      return this.driverRaceWins(intent, context, { get, keys }, originalText);
    if (intent?.intent === 'driver_race_wins_comparison')
      return this.driverRaceWinsComparison(intent, context, { get, keys });
    if (intent?.intent === 'driver_stat')
      return this.driverStat(intent, context, { get, keys }, originalText);
    if (intent?.intent === 'event_podium')
      return this.eventPodium(intent.eventName, context, originalText, { get, keys });
    if (intent?.intent === 'event_pole')
      return this.eventPole(intent.eventName, context, originalText, { get, keys });
    if (intent?.intent === 'event_fastest_lap')
      return this.eventFastestLap(intent.eventName, context, originalText, { get, keys });
    if (intent?.intent === 'event_pit_stops')
      return this.eventPitStops(intent, context, originalText, { get, keys });
    if (intent?.intent === 'event_session_metric')
      return intent.scope === 'circuit' || intent.circuitName
        ? this.circuitSessionMetric(intent, context, originalText, { get, keys })
        : this.eventSessionMetric(intent, context, originalText, { get, keys });
    if (intent?.intent === 'circuit_race_winners')
      return this.circuitRaceWinners(intent, { get, keys });
    if (intent?.intent === 'country_race_winners')
      return this.countryRaceWinners(intent, { get, keys });
    return this.result(
      {
        status: 'unsupported',
        message: 'That question is not supported by the archive query layer yet.',
        reasonCode: 'QUESTION_INTENT_UNSUPPORTED',
      },
      [],
    );
  }

  async profiles({ get, keys }) {
    const sets = await Promise.all((await keys('profile:')).map(get));
    return { sets, items: sets.flatMap((set) => set?.items || []) };
  }

  async detectCircuitWinnerQuestion(text, helpers, context) {
    const location = this.locationPhrase(text, ['at', 'around', 'near', 'on']);
    if (!location) return null;
    const { items } = await this.profiles(helpers);
    const circuit = this.findProfile(items, 'circuit', location);
    if (!circuit) return null;
    const countMatch = String(text).match(
      /\b(?:last|previous|most\s+recent)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:races?|grand\s+prix(?:es)?)\b/i,
    );
    const rawLimit = countMatch?.[1]?.toLowerCase();
    const limit = rawLimit ? Number(rawLimit) || numberWords[rawLimit] : 1;
    return {
      intent: 'circuit_race_winners',
      circuitName: circuit.entity.displayName,
      scope: 'circuit',
      limit: Math.min(Math.max(limit || 1, 1), 10),
      ...yearRange(text, context),
      clarificationNeeded: false,
    };
  }

  async detectCountryWinnerQuestion(text, helpers, context) {
    const location = this.locationPhrase(text, ['in', 'within']);
    if (!location) return null;
    const { items } = await this.profiles(helpers);
    const country = location.trim();
    const circuits = items.filter(
      (profile) =>
        profile.kind === 'circuit' &&
        normalize(profile.country) &&
        (normalize(profile.country) === normalize(country) ||
          normalize(profile.country).includes(normalize(country))),
    );
    if (!circuits.length) return null;
    const countMatch = String(text).match(
      /\b(?:last|previous|most\s+recent)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:races?|grand\s+prix(?:es)?)\b/i,
    );
    const rawLimit = countMatch?.[1]?.toLowerCase();
    const limit = rawLimit ? Number(rawLimit) || numberWords[rawLimit] : 1;
    return {
      intent: 'country_race_winners',
      countryName: circuits[0].country,
      scope: 'country',
      limit: Math.min(Math.max(limit || 1, 1), 10),
      ...yearRange(text, context),
      clarificationNeeded: false,
    };
  }

  locationPhrase(text, prepositions) {
    const alternatives = prepositions.join('|');
    const match = String(text).match(
      new RegExp(
        `\\b(?:${alternatives})\\s+(?:the\\s+)?(.+?)(?=\\s+(?:this|last)\\s+(?:year|season)\\b|\\s+in\\s+(?:19\\d{2}|20\\d{2})\\b|\\s+(?:19\\d{2}|20\\d{2})\\b|[?!.]|$)`,
        'i',
      ),
    );
    return match?.[1]?.trim() || null;
  }

  async circuitRaceWinners(intent, { get, keys }) {
    const { sets: profileSets, items: profiles } = await this.profiles({ get, keys });
    const circuit = this.findProfile(profiles, 'circuit', intent.circuitName);
    if (!circuit)
      return this.result(
        { status: 'clarification', message: 'Which circuit do you mean?', choices: [] },
        profileSets,
      );
    return this.raceWinnersForCircuits({
      intent,
      profileSets,
      circuits: [circuit],
      label: circuit.entity.displayName,
      preposition: 'at',
      get,
      keys,
    });
  }

  async countryRaceWinners(intent, { get, keys }) {
    const { sets: profileSets, items: profiles } = await this.profiles({ get, keys });
    const target = normalize(intent.countryName);
    const circuits = profiles.filter(
      (profile) =>
        profile.kind === 'circuit' &&
        target &&
        (normalize(profile.country) === target || normalize(profile.country).includes(target)),
    );
    if (!circuits.length)
      return this.result(
        { status: 'clarification', message: 'Which country do you mean?', choices: [] },
        profileSets,
      );
    return this.raceWinnersForCircuits({
      intent,
      profileSets,
      circuits,
      label: intent.countryName,
      preposition: 'in',
      get,
      keys,
    });
  }

  async raceWinnersForCircuits({ intent, profileSets, circuits, label, preposition, get, keys }) {
    const countryScope = intent.scope === 'country' || intent.intent === 'country_race_winners';
    const circuitIds = new Set(circuits.map((circuit) => circuit.id));
    const circuitSets = profileSets.filter((set) =>
      (set.items || []).some((profile) => circuitIds.has(profile.id)),
    );
    const eventSets = await Promise.all((await keys('events:')).map(get));
    const circuitTargets = unique(
      circuits.flatMap((circuit) => [
        circuit.entity.displayName,
        circuit.entity.id,
        ...(circuit.aliases || []),
      ]).map(normalize),
    );
    const range =
      Number.isInteger(intent.fromYear) || Number.isInteger(intent.toYear)
        ? {
            fromYear: Number(intent.fromYear ?? intent.toYear),
            toYear: Number(intent.toYear ?? intent.fromYear),
          }
        : { fromYear: null, toYear: null };
    const events = eventSets
      .flatMap((set) => (set?.items || []).map((event) => ({ event, set })))
      .filter(({ event }) => {
        const value = normalize(`${event.circuit?.displayName || ''} ${event.circuit?.id || ''}`);
        const matchesCircuit = circuitTargets.some(
          (target) => value === target || value.includes(target) || target.includes(value),
        );
        const matchesYear =
          (!range.fromYear || Number(event.year) >= range.fromYear) &&
          (!range.toYear || Number(event.year) <= range.toYear);
        return matchesCircuit && matchesYear;
      });
    const records = await Promise.all(
      events.map(async ({ event, set }) => ({
        event,
        set,
        resultSet: await get(`results:${raceSessionId(event.id)}`),
      })),
    );
    const winners = records
      .map(({ event, set, resultSet }) => ({
        event,
        set,
        resultSet,
        row: (resultSet?.items || []).find((entry) => entry.position === 1),
      }))
      .filter(({ row }) => driverNames(row).length)
      .sort((a, b) => {
        const dateA = Date.parse(a.event.schedule?.startsAt || a.event.schedule?.date || '') || 0;
        const dateB = Date.parse(b.event.schedule?.startsAt || b.event.schedule?.date || '') || 0;
        return dateB - dateA || (b.event.year || 0) - (a.event.year || 0) || (b.event.round || 0) - (a.event.round || 0);
      });
    const limit = Math.min(Math.max(Number(intent.limit) || 1, 1), 10);
    const selected = winners.slice(0, limit);
    const evidenceSets = [
      ...circuitSets,
      ...selected.flatMap(({ set, resultSet }) => [set, resultSet].filter(Boolean)),
    ];
    if (!selected.length)
      return this.result(
        {
          status: 'unavailable',
          message: `Published race winners are not available ${preposition} ${label}.`,
          reasonCode: 'WINNERS_NOT_PUBLISHED',
        },
        evidenceSets,
      );
    const lines = selected.map(({ event, row }) => {
      const driver = driverNames(row)[0];
      const constructor = row.entry?.constructor?.displayName;
      return `${event.year} ${event.name} — ${driver.displayName}${constructor ? ` (${constructor})` : ''}`;
    });
    const answer = `The last ${selected.length} published race${selected.length === 1 ? '' : 's'} ${preposition} ${label}: ${lines.join('; ')}.`;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: countryScope ? 'country_race_winners' : 'circuit_race_winners',
        templateKey: countryScope ? 'country_race_winners' : 'circuit_race_winners',
        values: {
          answer,
          ...(countryScope
            ? { country: label }
            : { circuit: circuits[0].entity.displayName }),
          count: selected.length,
          winners: lines.join('; '),
        },
        evidenceIds: unique(evidenceSets.map((set) => set?.evidenceId)),
      },
      evidenceSets,
    );
  }

  findProfile(items, kind, name) {
    const target = normalize(name);
    if (!target) return null;
    const candidates = items.filter((profile) => profile.kind === kind);
    return (
      candidates.find((profile) => normalize(profile.entity.displayName) === target) ||
      candidates.find((profile) => normalize(profile.entity.displayName).includes(target)) ||
      candidates.find((profile) => target.includes(normalize(profile.entity.displayName))) ||
      null
    );
  }

  async archiveSearch(searchTerms, _context, { get, keys }) {
    const terms = normalize(searchTerms)
      .split(/\s+/)
      .filter((term) => term.length >= 2);
    const { sets, items: profiles } = await this.profiles({ get, keys });
    const eventSets = await Promise.all((await keys('events:')).map(get));
    const events = eventSets.flatMap((set) =>
      (set?.items || []).map((event) => ({
        id: event.id,
        kind: 'event',
        displayName: event.name,
        context: String(event.year),
        evidenceId: set.evidenceId,
      })),
    );
    const records = [
      ...profiles.map((profile) => ({
        id: profile.id,
        kind: profile.kind,
        displayName: profile.entity.displayName,
        context: null,
        evidenceId: profile.evidenceId,
      })),
      ...events,
    ];
    const matches = records.filter((record) =>
      terms.some((term) => normalize(`${record.displayName} ${record.id}`).includes(term)),
    );
    const names = unique(matches.map((record) => record.displayName)).slice(0, 5);
    const evidenceIds = unique(matches.map((record) => record.evidenceId));
    const answer = names.length
      ? `I found ${matches.length} matching archive record${matches.length === 1 ? '' : 's'}: ${names.join(', ')}.`
      : 'I could not find a matching published archive record.';
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'archive_search',
        templateKey: 'archive_search_summary',
        values: {
          answer,
          query: String(searchTerms).trim(),
          resultCount: matches.length,
          matches: names.join(', ') || 'None',
        },
        evidenceIds,
      },
      [...sets, ...eventSets],
    );
  }

  async resolveEvent(eventName, context, text, { get, keys }) {
    if (context.eventId) {
      const detail = await get(`event:${context.eventId}`);
      return detail ? { eventId: context.eventId, set: detail } : null;
    }
    const explicitRange = yearRange(text, context);
    const eventYear = explicitRange.fromYear ?? context.year;
    const eventSets = await Promise.all(
      (await keys(eventYear ? `events:${eventYear}` : 'events:')).map(get),
    );
    const target = normalize(eventName || text).replace(/\bg\s+p\b|\bgp\b/g, 'grand prix');
    const candidates = eventSets
      .flatMap((set) => (set?.items || []).map((event) => ({ event, set })))
      .filter(({ event }) => {
        const value = normalize(`${event.name} ${event.id} ${event.circuit?.displayName || ''}`);
        return target && (value.includes(target) || target.includes(normalize(event.name)));
      });
    if (candidates.length === 1) return { eventId: candidates[0].event.id, set: candidates[0].set };
    return null;
  }

  async eventWinner(eventName, context, text, helpers) {
    const resolved = await this.resolveEvent(eventName, context, text, helpers);
    if (!resolved)
      return this.result(
        {
          status: 'clarification',
          message: 'Which Grand Prix do you mean?',
          choices: [],
        },
        [],
      );
    const detail = await helpers.get(`event:${resolved.eventId}`);
    const item = detail?.items?.[0];
    const winner = item?.winner;
    const driver = winner?.drivers?.[0]?.displayName || null;
    const constructor = winner?.constructor?.displayName || null;
    if (!driver)
      return this.result(
        {
          status: 'unavailable',
          message: 'A winner is not published for that event.',
          reasonCode: 'WINNER_NOT_PUBLISHED',
        },
        [resolved.set, detail],
      );
    const event = item.event;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'event_winner',
        templateKey: 'event_winner',
        values: {
          answer: `${driver} won the ${event.name}.`,
          driver,
          constructor: constructor || 'Not supplied',
          event: event.name,
          year: event.year,
          round: event.round,
        },
        evidenceIds: unique([detail.evidenceId, resolved.set.evidenceId]),
      },
      [resolved.set, detail],
    );
  }

  async eventPodium(eventName, context, text, helpers) {
    const resolved = await this.resolveEvent(eventName, context, text, helpers);
    if (!resolved)
      return this.result(
        { status: 'clarification', message: 'Which Grand Prix do you mean?', choices: [] },
        [],
      );
    const resultSet = await helpers.get(`results:${raceSessionId(resolved.eventId)}`);
    const detail = await helpers.get(`event:${resolved.eventId}`);
    const event =
      detail?.items?.[0]?.event || resolved.set.items?.find((item) => item.id === resolved.eventId);
    const rows = (resultSet?.items || [])
      .filter((row) => row.position >= 1 && row.position <= 3)
      .sort((a, b) => a.position - b.position);
    if (!rows.length)
      return this.result(
        {
          status: 'unavailable',
          message: `A published podium is not available for ${event?.name || 'that event'}.`,
          reasonCode: 'PODIUM_NOT_PUBLISHED',
        },
        [resolved.set, resultSet, detail],
      );
    const podium = rows.flatMap((row) =>
      driverNames(row)
        .slice(0, 1)
        .map((driver) => ({
          position: row.position,
          driver: driver.displayName,
          constructor: row.entry?.constructor?.displayName || 'Not supplied',
        })),
    );
    const missingPositions = [1, 2, 3].filter(
      (position) => !podium.some((entry) => entry.position === position),
    );
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'event_podium',
        templateKey: 'event_podium',
        values: {
          answer: `${event?.name || 'The event'} podium: ${podium
            .map((entry) => `P${entry.position} ${entry.driver}`)
            .join(
              ', ',
            )}.${missingPositions.length ? ` Positions not published: ${missingPositions.join(', ')}.` : ''}`,
          event: event?.name || 'Not supplied',
          year: event?.year || null,
          podium: podium.map((entry) => `P${entry.position} ${entry.driver}`).join('; '),
          missingPositions: missingPositions.join(', ') || 'None',
        },
        evidenceIds: unique([resolved.set?.evidenceId, resultSet?.evidenceId, detail?.evidenceId]),
      },
      [resolved.set, resultSet, detail],
    );
  }

  async eventPole(eventName, context, text, helpers) {
    const resolved = await this.resolveEvent(eventName, context, text, helpers);
    if (!resolved)
      return this.result(
        { status: 'clarification', message: 'Which Grand Prix do you mean?', choices: [] },
        [],
      );
    const qualifyingSet = await helpers.get(`qualifying:${qualifyingSessionId(resolved.eventId)}`);
    const detail = await helpers.get(`event:${resolved.eventId}`);
    const event =
      detail?.items?.[0]?.event || resolved.set.items?.find((item) => item.id === resolved.eventId);
    const rows = (qualifyingSet?.items || []).filter((row) => row.position === 1);
    if (!rows.length)
      return this.result(
        {
          status: 'unavailable',
          message: `Qualifying pole is not published for ${event?.name || 'that event'}.`,
          reasonCode: 'QUALIFYING_NOT_PUBLISHED',
        },
        [resolved.set, qualifyingSet, detail],
      );
    const drivers = unique(
      rows.flatMap((row) => driverNames(row).map((driver) => driver.displayName)),
    );
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'event_pole',
        templateKey: 'event_pole',
        values: {
          answer: `${humanList(drivers)} took pole for the ${event?.name || 'event'}.`,
          event: event?.name || 'Not supplied',
          year: event?.year || null,
          drivers: drivers.join(', '),
        },
        evidenceIds: unique([
          resolved.set?.evidenceId,
          qualifyingSet?.evidenceId,
          detail?.evidenceId,
        ]),
      },
      [resolved.set, qualifyingSet, detail],
    );
  }

  async eventFastestLap(eventName, context, text, helpers) {
    const resolved = await this.resolveEvent(eventName, context, text, helpers);
    if (!resolved)
      return this.result(
        { status: 'clarification', message: 'Which Grand Prix do you mean?', choices: [] },
        [],
      );
    const resultSet = await helpers.get(`results:${raceSessionId(resolved.eventId)}`);
    const detail = await helpers.get(`event:${resolved.eventId}`);
    const event =
      detail?.items?.[0]?.event || resolved.set.items?.find((item) => item.id === resolved.eventId);
    const rows = (resultSet?.items || []).filter((row) => row.fastestLap?.rank === 1);
    if (!rows.length)
      return this.result(
        {
          status: 'unavailable',
          message: `A published fastest lap is not available for ${event?.name || 'that event'}.`,
          reasonCode: 'FASTEST_LAP_NOT_PUBLISHED',
        },
        [resolved.set, resultSet, detail],
      );
    const drivers = unique(
      rows.flatMap((row) => driverNames(row).map((driver) => driver.displayName)),
    );
    const lap = rows[0].fastestLap;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'event_fastest_lap',
        templateKey: 'event_fastest_lap',
        values: {
          answer: `${humanList(drivers)} set the fastest lap at the ${event?.name || 'event'}${lap.lapNumber ? ` on lap ${lap.lapNumber}` : ''}.`,
          event: event?.name || 'Not supplied',
          year: event?.year || null,
          drivers: drivers.join(', '),
          lapNumber: lap.lapNumber,
          durationMs: lap.durationMs,
        },
        evidenceIds: unique([resolved.set?.evidenceId, resultSet?.evidenceId, detail?.evidenceId]),
      },
      [resolved.set, resultSet, detail],
    );
  }

  async eventPitStops(intent, context, text, helpers) {
    const resolved = await this.resolveEvent(intent.eventName, context, text, helpers);
    if (!resolved)
      return this.result(
        { status: 'clarification', message: 'Which Grand Prix do you mean?', choices: [] },
        [],
      );
    const pitSet = await helpers.get(`pit-stops:${raceSessionId(resolved.eventId)}`);
    const resultSet = await helpers.get(`results:${raceSessionId(resolved.eventId)}`);
    const detail = await helpers.get(`event:${resolved.eventId}`);
    const event =
      detail?.items?.[0]?.event || resolved.set.items?.find((item) => item.id === resolved.eventId);
    if (!pitSet || !pitSet.items?.length)
      return this.result(
        {
          status: 'unavailable',
          message: `Pit-stop records are not published for ${event?.name || 'that event'}.`,
          reasonCode: 'PIT_STOPS_NOT_PUBLISHED',
        },
        [resolved.set, pitSet, resultSet, detail],
      );
    const driverByEntry = new Map(
      (resultSet?.items || []).flatMap((row) =>
        driverNames(row)
          .slice(0, 1)
          .map((driver) => [row.entry?.id, driver]),
      ),
    );
    const stops = pitSet.items
      .map((stop) => ({ ...stop, driver: driverByEntry.get(stop.entryId) }))
      .filter((stop) => stop.driver);
    if (!stops.length)
      return this.result(
        {
          status: 'unavailable',
          message: `The pit-stop records for ${event?.name || 'that event'} cannot be linked to published drivers.`,
          reasonCode: 'PIT_STOP_ENTRANT_MAPPING_UNAVAILABLE',
        },
        [resolved.set, pitSet, resultSet, detail],
      );
    const metric = intent.metric || 'most_pit_stops';
    if (metric === 'fastest_pit_stop') {
      const stationary = stops.filter((stop) => Number.isFinite(stop.stationaryDurationMs));
      const durationKey = stationary.length ? 'stationaryDurationMs' : 'laneDurationMs';
      const measured = stops.filter((stop) => Number.isFinite(stop[durationKey]));
      if (!measured.length)
        return this.result(
          {
            status: 'unavailable',
            message: `Pit-stop duration is not published for ${event?.name || 'that event'}.`,
            reasonCode: 'PIT_STOP_DURATION_NOT_PUBLISHED',
          },
          [resolved.set, pitSet, resultSet, detail],
        );
      const fastestValue = Math.min(...measured.map((stop) => stop[durationKey]));
      const fastest = measured.filter((stop) => stop[durationKey] === fastestValue);
      return this.result(
        {
          status: 'answered',
          resolvedIntent: 'event_pit_stops',
          templateKey: 'event_fastest_pit_stop',
          values: {
            answer: `The fastest published pit stop at the ${event?.name || 'event'} was ${formatDuration(fastestValue)} (${durationKey === 'stationaryDurationMs' ? 'stationary' : 'lane'} duration), by ${humanList(fastest.map((stop) => stop.driver.displayName))}.`,
            event: event?.name || 'Not supplied',
            drivers: unique(fastest.map((stop) => stop.driver.displayName)).join(', '),
            durationMs: fastestValue,
            durationType: durationKey === 'stationaryDurationMs' ? 'stationary' : 'lane',
          },
          evidenceIds: unique([
            resolved.set?.evidenceId,
            pitSet.evidenceId,
            resultSet?.evidenceId,
            detail?.evidenceId,
          ]),
        },
        [resolved.set, pitSet, resultSet, detail],
      );
    }
    const counts = new Map();
    for (const stop of stops) {
      const current = counts.get(stop.driver.id) || { driver: stop.driver, count: 0 };
      current.count += 1;
      counts.set(stop.driver.id, current);
    }
    const requestedDriver = intent.driverName
      ? [...counts.values()].find(
          (entry) => normalize(entry.driver.displayName) === normalize(intent.driverName),
        )
      : null;
    if (metric === 'pit_stops' && intent.driverName && !requestedDriver)
      return this.result(
        {
          status: 'answered',
          resolvedIntent: 'event_pit_stops',
          templateKey: 'event_pit_stops',
          values: {
            answer: `${intent.driverName} made 0 published pit stops at the ${event?.name || 'event'}.`,
            event: event?.name || 'Not supplied',
            driver: intent.driverName,
            count: 0,
          },
          evidenceIds: unique([
            resolved.set?.evidenceId,
            pitSet.evidenceId,
            resultSet?.evidenceId,
            detail?.evidenceId,
          ]),
        },
        [resolved.set, pitSet, resultSet, detail],
      );
    const highest = Math.max(...[...counts.values()].map((entry) => entry.count));
    const leaders = [...counts.values()].filter((entry) => entry.count === highest);
    const selected = requestedDriver ? [requestedDriver] : leaders;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'event_pit_stops',
        templateKey: requestedDriver ? 'event_pit_stops' : 'event_most_pit_stops',
        values: {
          answer: requestedDriver
            ? `${requestedDriver.driver.displayName} made ${requestedDriver.count} published pit stop${requestedDriver.count === 1 ? '' : 's'} at the ${event?.name || 'event'}.`
            : `${humanList(selected.map((entry) => entry.driver.displayName))} made the most published pit stops at the ${event?.name || 'event'}, with ${highest} each.`,
          event: event?.name || 'Not supplied',
          drivers: selected.map((entry) => entry.driver.displayName).join(', '),
          count: requestedDriver ? requestedDriver.count : highest,
          tied: selected.length > 1,
        },
        evidenceIds: unique([
          resolved.set?.evidenceId,
          pitSet.evidenceId,
          resultSet?.evidenceId,
          detail?.evidenceId,
        ]),
      },
      [resolved.set, pitSet, resultSet, detail],
    );
  }

  async circuitSessionMetric(intent, context, text, helpers) {
    const { get, keys } = helpers;
    const { sets: profileSets, items: profiles } = await this.profiles(helpers);
    const circuit = this.findProfile(profiles, 'circuit', intent.circuitName);
    if (!circuit)
      return this.result(
        {
          status: 'clarification',
          message: 'Which circuit do you mean?',
          choices: [],
        },
        profileSets,
      );
    const circuitSets = profileSets.filter((set) =>
      (set.items || []).some((profile) => profile.id === circuit.id),
    );

    const currentYear = Number(context.currentYear) || new Date().getUTCFullYear();
    const primary =
      Number.isInteger(intent.fromYear) || Number.isInteger(intent.toYear)
        ? {
            fromYear: Number(intent.fromYear ?? intent.toYear),
            toYear: Number(intent.toYear ?? intent.fromYear),
          }
        : yearRange(text, { ...context, year: currentYear });
    const primaryRange = {
      fromYear: primary.fromYear ?? currentYear,
      toYear: primary.toYear ?? primary.fromYear ?? currentYear,
    };
    const comparison =
      Number.isInteger(intent.comparisonFromYear) || Number.isInteger(intent.comparisonToYear)
        ? {
            fromYear: Number(intent.comparisonFromYear ?? intent.comparisonToYear),
            toYear: Number(intent.comparisonToYear ?? intent.comparisonFromYear),
          }
        : null;
    const comparisonRange = comparison
      ? {
          fromYear: comparison.fromYear,
          toYear: comparison.toYear ?? comparison.fromYear,
        }
      : null;
    const yearSet = (range) =>
      Array.from(
        { length: Math.max(0, range.toYear - range.fromYear + 1) },
        (_, index) => range.fromYear + index,
      );
    const years = unique([
      ...yearSet(primaryRange).map(String),
      ...(comparisonRange ? yearSet(comparisonRange).map(String) : []),
    ]).map(Number);
    const eventKeys = unique(
      (await Promise.all(years.map((year) => keys(`events:${year}`)))).flat(),
    );
    const eventSets = await Promise.all(eventKeys.map(get));
    const circuitTargets = unique(
      [circuit.entity.displayName, circuit.entity.id, ...(circuit.aliases || [])].map(normalize),
    );
    const events = eventSets
      .flatMap((set) => (set?.items || []).map((event) => ({ event, set })))
      .filter(({ event }) => {
        const value = normalize(`${event.circuit?.displayName || ''} ${event.circuit?.id || ''}`);
        return circuitTargets.some(
          (target) => value === target || value.includes(target) || target.includes(value),
        );
      });
    const sessionKind =
      intent.sessionKind && intent.sessionKind !== 'weekend' ? intent.sessionKind : 'race';
    const records = await Promise.all(
      events.map(async ({ event, set }) => ({
        event,
        set,
        weather: await get(`weather:session:${event.id}:${sessionKind}`),
      })),
    );
    const summarize = (range) => {
      const selected = records.filter(
        ({ event }) => event.year >= range.fromYear && event.year <= range.toYear,
      );
      const weatherSets = selected.map((record) => record.weather).filter(Boolean);
      const rows = weatherSets.flatMap((set) => set.items || []);
      const values = (field) => rows.map((row) => row[field]).filter(Number.isFinite);
      const rangeFor = (items) =>
        items.length
          ? { min: Math.min(...items), max: Math.max(...items) }
          : { min: null, max: null };
      const air = rangeFor(values('airTemperatureC'));
      const track = rangeFor(values('trackTemperatureC'));
      const rainfall = rows.filter((row) => row.rainfall === true).length;
      return {
        fromYear: range.fromYear,
        toYear: range.toYear,
        events: selected,
        weatherSets,
        observations: rows.length,
        air,
        track,
        rainfall,
      };
    };
    const primarySummary = summarize(primaryRange);
    const comparisonSummary = comparisonRange ? summarize(comparisonRange) : null;
    const missing = [
      primarySummary.observations ? null : `${primaryRange.fromYear}-${primaryRange.toYear}`,
      comparisonSummary?.observations
        ? null
        : comparisonRange
          ? `${comparisonRange.fromYear}-${comparisonRange.toYear}`
          : null,
    ].filter(Boolean);
    const evidenceSets = [
      ...circuitSets,
      ...records.map(({ set }) => set),
      ...records.map(({ weather }) => weather).filter(Boolean),
    ];
    const unavailable = (message, reasonCode) =>
      this.result(
        {
          status: 'unavailable',
          message,
          reasonCode,
        },
        evidenceSets,
      );
    if (missing.length)
      return unavailable(
        `Published weather observations are not available for ${circuit.entity.displayName} for ${missing.join(' and ')}.`,
        comparisonRange ? 'WEATHER_COMPARISON_NOT_PUBLISHED' : 'WEATHER_NOT_PUBLISHED',
      );
    const periodLabel = (summary) =>
      summary.fromYear === summary.toYear
        ? String(summary.fromYear)
        : `${summary.fromYear}-${summary.toYear}`;
    const temperatureText = (summary) =>
      summary.air.min === null
        ? 'air temperature was not supplied'
        : `air temperature ranged from ${summary.air.min}°C to ${summary.air.max}°C`;
    const answer = comparisonSummary
      ? `At ${circuit.entity.displayName}, ${periodLabel(primarySummary)} had ${temperatureText(primarySummary)} and ${primarySummary.rainfall} rainfall observation${primarySummary.rainfall === 1 ? '' : 's'}. In ${periodLabel(comparisonSummary)}, ${temperatureText(comparisonSummary)} and ${comparisonSummary.rainfall} rainfall observation${comparisonSummary.rainfall === 1 ? '' : 's'} were published.`
      : `At ${circuit.entity.displayName}, ${periodLabel(primarySummary)} had ${temperatureText(primarySummary)} and ${primarySummary.rainfall} rainfall observation${primarySummary.rainfall === 1 ? '' : 's'}.`;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'event_session_metric',
        templateKey: 'circuit_weather_comparison',
        values: {
          answer,
          circuit: circuit.entity.displayName,
          period: periodLabel(primarySummary),
          events: primarySummary.events.map(({ event }) => event.name).join(', '),
          observations: primarySummary.observations,
          airTemperatureMinC: primarySummary.air.min,
          airTemperatureMaxC: primarySummary.air.max,
          trackTemperatureMinC: primarySummary.track.min,
          trackTemperatureMaxC: primarySummary.track.max,
          rainfallObservations: primarySummary.rainfall,
          comparisonPeriod: comparisonSummary ? periodLabel(comparisonSummary) : null,
          comparisonEvents: comparisonSummary
            ? comparisonSummary.events.map(({ event }) => event.name).join(', ')
            : null,
          comparisonObservations: comparisonSummary?.observations || null,
          comparisonAirTemperatureMinC: comparisonSummary?.air.min || null,
          comparisonAirTemperatureMaxC: comparisonSummary?.air.max || null,
          comparisonTrackTemperatureMinC: comparisonSummary?.track.min || null,
          comparisonTrackTemperatureMaxC: comparisonSummary?.track.max || null,
          comparisonRainfallObservations: comparisonSummary?.rainfall || 0,
        },
        evidenceIds: unique(evidenceSets.map((set) => set?.evidenceId)),
      },
      evidenceSets,
    );
  }

  async eventSessionMetric(intent, context, text, helpers) {
    const resolved = await this.resolveEvent(intent.eventName, context, text, helpers);
    if (!resolved)
      return this.result(
        { status: 'clarification', message: 'Which Grand Prix do you mean?', choices: [] },
        [],
      );
    const sessionId = raceSessionId(resolved.eventId);
    const detail = await helpers.get(`event:${resolved.eventId}`);
    const event =
      detail?.items?.[0]?.event || resolved.set.items?.find((item) => item.id === resolved.eventId);
    const datasetKey = {
      weather_summary: 'weather',
      rainfall: 'weather',
      temperatures: 'weather',
      tyre_compounds: 'stints',
      tyre_stints: 'stints',
      tyre_laps: 'stints',
      race_control_events: 'race-control',
      safety_car_events: 'race-control',
      red_flag_events: 'race-control',
      overtakes: 'overtakes',
      most_overtakes: 'overtakes',
      fastest_speed: 'telemetry',
    }[intent.metric];
    const dataSet = datasetKey ? await helpers.get(`${datasetKey}:${sessionId}`) : null;
    const unavailable = (message, reasonCode, sets = [resolved.set, dataSet, detail]) =>
      this.result({ status: 'unavailable', message, reasonCode }, sets);
    if (!dataSet || !dataSet.items?.length)
      return unavailable(
        `${datasetKey === 'stints' ? 'Tyre-stint' : datasetKey === 'race-control' ? 'Race-control' : datasetKey === 'overtakes' ? 'Overtake' : datasetKey === 'telemetry' ? 'Telemetry' : 'Weather'} data is not published for ${event?.name || 'that event'}.`,
        `${datasetKey.toUpperCase().replaceAll('-', '_')}_NOT_PUBLISHED`,
      );

    if (datasetKey === 'weather') {
      const rows = dataSet.items;
      const air = rows.map((row) => row.airTemperatureC).filter(Number.isFinite);
      const track = rows.map((row) => row.trackTemperatureC).filter(Number.isFinite);
      const rainfall = rows
        .map((row) => row.rainfall)
        .filter((value) => typeof value === 'boolean');
      const range = (values) =>
        values.length
          ? { min: Math.min(...values), max: Math.max(...values) }
          : { min: null, max: null };
      const airRange = range(air);
      const trackRange = range(track);
      if (intent.metric === 'rainfall' && !rainfall.length)
        return unavailable(
          `Rainfall observations are not published for ${event?.name || 'that event'}.`,
          'WEATHER_RAINFALL_NOT_PUBLISHED',
        );
      if (intent.metric === 'temperatures' && !air.length && !track.length)
        return unavailable(
          `Temperature observations are not published for ${event?.name || 'that event'}.`,
          'WEATHER_TEMPERATURE_NOT_PUBLISHED',
        );
      const rainCount = rainfall.filter(Boolean).length;
      const answer =
        intent.metric === 'rainfall'
          ? `Rainfall was ${rainCount ? 'recorded' : 'not recorded'} in ${rainCount || rainfall.length} published weather observation${(rainCount || rainfall.length) === 1 ? '' : 's'} at the ${event?.name || 'event'}.`
          : `The ${event?.name || 'event'} has ${rows.length} published weather observations${air.length ? `, with air temperature from ${airRange.min}°C to ${airRange.max}°C` : ''}${track.length ? ` and track temperature from ${trackRange.min}°C to ${trackRange.max}°C` : ''}.`;
      return this.result(
        {
          status: 'answered',
          resolvedIntent: 'event_session_metric',
          templateKey: 'event_weather',
          values: {
            answer,
            event: event?.name || 'Not supplied',
            observationCount: rows.length,
            airTemperatureMinC: airRange.min,
            airTemperatureMaxC: airRange.max,
            trackTemperatureMinC: trackRange.min,
            trackTemperatureMaxC: trackRange.max,
            rainfallObservations: rainCount,
          },
          evidenceIds: unique([resolved.set?.evidenceId, dataSet.evidenceId, detail?.evidenceId]),
        },
        [resolved.set, dataSet, detail],
      );
    }

    const resultSet = await helpers.get(`results:${sessionId}`);
    const entryDrivers = new Map(
      (resultSet?.items || []).flatMap((row) =>
        driverNames(row)
          .slice(0, 1)
          .map((driver) => [row.entry?.id, driver]),
      ),
    );
    const { items: profiles } = await this.profiles(helpers);
    const driver = intent.driverName
      ? this.findProfile(profiles, 'driver', intent.driverName)
      : null;
    const comparisonDriver = intent.comparisonDriverName
      ? this.findProfile(profiles, 'driver', intent.comparisonDriverName)
      : null;
    if (intent.driverName && !driver)
      return this.result(
        { status: 'clarification', message: 'Which driver do you mean?', choices: [] },
        [dataSet, resultSet, ...profiles],
      );
    if (intent.comparisonDriverName && !comparisonDriver)
      return this.result(
        { status: 'clarification', message: 'Which comparison driver do you mean?', choices: [] },
        [dataSet, resultSet, ...profiles],
      );
    const entryForDriver = (profile) =>
      profile
        ? [...entryDrivers.entries()].find(([, entryDriver]) => entryDriver.id === profile.id)?.[0]
        : null;
    const driverEntry = entryForDriver(driver);
    const comparisonEntry = entryForDriver(comparisonDriver);
    if ((driver && !driverEntry) || (comparisonDriver && !comparisonEntry))
      return unavailable(
        `The published ${datasetKey} records for ${event?.name || 'that event'} cannot be linked to the requested driver.`,
        `${datasetKey.toUpperCase().replaceAll('-', '_')}_ENTRANT_MAPPING_UNAVAILABLE`,
        [resolved.set, dataSet, resultSet, detail],
      );
    const rowsFor = (entryId) =>
      entryId ? dataSet.items.filter((row) => row.entryId === entryId) : dataSet.items;
    const selectedRows = rowsFor(driverEntry);
    const selectedComparisonRows = rowsFor(comparisonEntry);

    if (datasetKey === 'stints') {
      const compounds = (rows) =>
        unique(
          rows
            .map((row) => row.compoundLabel || row.compoundClass)
            .filter((value) => value && value !== 'unknown'),
        );
      const selectedCompounds = compounds(selectedRows);
      const comparisonCompounds = compounds(selectedComparisonRows);
      const laps = (rows) =>
        rows.reduce(
          (total, row) =>
            total +
            (Number.isFinite(row.startLap) && Number.isFinite(row.endLap)
              ? row.endLap - row.startLap + 1
              : 0),
          0,
        );
      const selectedName = driver?.entity.displayName;
      const answer =
        intent.metric === 'tyre_laps'
          ? `${selectedName || 'The published entries'} covered ${laps(selectedRows)} published tyre laps at the ${event?.name || 'event'}.`
          : intent.metric === 'tyre_stints'
            ? `${selectedName || 'The published entries'} recorded ${selectedRows.length} published tyre stint${selectedRows.length === 1 ? '' : 's'} at the ${event?.name || 'event'}.`
            : driver && comparisonDriver
              ? `${selectedName} used ${humanList(selectedCompounds) || 'no named compounds'}, compared with ${comparisonDriver.entity.displayName}'s ${humanList(comparisonCompounds) || 'no named compounds'} at the ${event?.name || 'event'}.`
              : `${selectedName || 'The published entries'} used ${humanList(selectedCompounds) || 'no named compounds'} at the ${event?.name || 'event'}.`;
      return this.result(
        {
          status: 'answered',
          resolvedIntent: 'event_session_metric',
          templateKey: 'event_tyre_strategy',
          values: {
            answer,
            event: event?.name || 'Not supplied',
            driver: selectedName || 'All linked drivers',
            comparisonDriver: comparisonDriver?.entity.displayName || null,
            compounds: selectedCompounds.join(', ') || 'None published',
            comparisonCompounds: comparisonCompounds.join(', ') || 'None published',
            stintCount: selectedRows.length,
            tyreLaps: laps(selectedRows),
          },
          evidenceIds: unique([
            resolved.set?.evidenceId,
            dataSet.evidenceId,
            resultSet?.evidenceId,
            detail?.evidenceId,
          ]),
        },
        [resolved.set, dataSet, resultSet, detail],
      );
    }

    if (datasetKey === 'race-control') {
      const textFor = (row) => `${row.category || ''} ${row.message || ''} ${row.flag || ''}`;
      const safetyCars = dataSet.items.filter((row) =>
        /safety car|virtual safety car/i.test(textFor(row)),
      );
      const redFlags = dataSet.items.filter((row) => /red flag/i.test(textFor(row)));
      const rows =
        intent.metric === 'safety_car_events'
          ? safetyCars
          : intent.metric === 'red_flag_events'
            ? redFlags
            : dataSet.items;
      const highlights = dataSet.items
        .map((row) => String(row.message || '').trim())
        .filter(Boolean)
        .slice(0, 3);
      return this.result(
        {
          status: 'answered',
          resolvedIntent: 'event_session_metric',
          templateKey: 'event_race_control',
          values: {
            answer:
              intent.metric === 'safety_car_events'
                ? `${safetyCars.length} safety-car event${safetyCars.length === 1 ? '' : 's'} were published for the ${event?.name || 'event'}.`
                : intent.metric === 'red_flag_events'
                  ? `${redFlags.length} red-flag event${redFlags.length === 1 ? '' : 's'} were published for the ${event?.name || 'event'}.`
                  : `${dataSet.items.length} race-control message${dataSet.items.length === 1 ? '' : 's'} were published for the ${event?.name || 'event'}${highlights.length ? `, including: ${highlights.join(' | ')}` : ''}.`,
            event: event?.name || 'Not supplied',
            messageCount: rows.length,
            safetyCarEvents: safetyCars.length,
            redFlagEvents: redFlags.length,
            highlights: highlights.join(' | ') || 'None supplied',
          },
          evidenceIds: unique([resolved.set?.evidenceId, dataSet.evidenceId, detail?.evidenceId]),
        },
        [resolved.set, dataSet, detail],
      );
    }

    if (datasetKey === 'overtakes') {
      const driverOvertakes = driver
        ? dataSet.items.filter((row) => row.passingEntryId === driverEntry)
        : dataSet.items;
      const counts = new Map();
      for (const row of dataSet.items) {
        const name = entryDrivers.get(row.passingEntryId);
        if (!name) continue;
        counts.set(name.id, { driver: name, count: (counts.get(name.id)?.count || 0) + 1 });
      }
      if (driver)
        return this.result(
          {
            status: 'answered',
            resolvedIntent: 'event_session_metric',
            templateKey: 'event_overtakes',
            values: {
              answer: `${driver.entity.displayName} made ${driverOvertakes.length} published overtake${driverOvertakes.length === 1 ? '' : 's'} at the ${event?.name || 'event'}.`,
              event: event?.name || 'Not supplied',
              driver: driver.entity.displayName,
              count: driverOvertakes.length,
            },
            evidenceIds: unique([
              resolved.set?.evidenceId,
              dataSet.evidenceId,
              resultSet?.evidenceId,
              detail?.evidenceId,
            ]),
          },
          [resolved.set, dataSet, resultSet, detail],
        );
      if (!counts.size)
        return unavailable(
          `Published overtake records for ${event?.name || 'that event'} cannot be linked to entrants.`,
          'OVERTAKES_ENTRANT_MAPPING_UNAVAILABLE',
          [resolved.set, dataSet, resultSet, detail],
        );
      const highest = Math.max(...[...counts.values()].map((entry) => entry.count));
      const leaders = [...counts.values()].filter((entry) => entry.count === highest);
      return this.result(
        {
          status: 'answered',
          resolvedIntent: 'event_session_metric',
          templateKey: 'event_most_overtakes',
          values: {
            answer: `${humanList(leaders.map((entry) => entry.driver.displayName))} made the most published overtakes at the ${event?.name || 'event'}, with ${highest} each.`,
            event: event?.name || 'Not supplied',
            drivers: leaders.map((entry) => entry.driver.displayName).join(', '),
            count: highest,
            tied: leaders.length > 1,
          },
          evidenceIds: unique([
            resolved.set?.evidenceId,
            dataSet.evidenceId,
            resultSet?.evidenceId,
            detail?.evidenceId,
          ]),
        },
        [resolved.set, dataSet, resultSet, detail],
      );
    }

    if (datasetKey === 'telemetry') {
      const telemetryRows = driver ? selectedRows : dataSet.items;
      const measured = telemetryRows
        .filter((row) => Number.isFinite(row.speedKph))
        .map((row) => ({ row, driver: entryDrivers.get(row.entryId) }))
        .filter((entry) => entry.driver);
      if (!measured.length)
        return unavailable(
          `Speed telemetry is not published for ${event?.name || 'that event'}.`,
          'TELEMETRY_SPEED_NOT_PUBLISHED',
          [resolved.set, dataSet, resultSet, detail],
        );
      const fastestValue = Math.max(...measured.map((entry) => entry.row.speedKph));
      const fastest = measured.filter((entry) => entry.row.speedKph === fastestValue);
      return this.result(
        {
          status: 'answered',
          resolvedIntent: 'event_session_metric',
          templateKey: 'event_fastest_speed',
          values: {
            answer: `${humanList(fastest.map((entry) => entry.driver.displayName))} recorded the highest published speed of ${fastestValue} km/h at the ${event?.name || 'event'}.`,
            event: event?.name || 'Not supplied',
            drivers: humanList(fastest.map((entry) => entry.driver.displayName)),
            speedKph: fastestValue,
          },
          evidenceIds: unique([
            resolved.set?.evidenceId,
            dataSet.evidenceId,
            resultSet?.evidenceId,
            detail?.evidenceId,
          ]),
        },
        [resolved.set, dataSet, resultSet, detail],
      );
    }
    return unavailable(
      'That session metric is not supported by the archive query layer yet.',
      'SESSION_METRIC_UNSUPPORTED',
    );
  }

  async driverStat(intent, context, { get, keys }, originalText = '') {
    const { sets, items } = await this.profiles({ get, keys });
    const driver = context.driverId
      ? items.find((profile) => profile.id === context.driverId)
      : this.findProfile(items, 'driver', intent.driverName);
    if (!driver)
      return this.result(
        { status: 'clarification', message: 'Which driver do you mean?', choices: [] },
        sets,
      );
    const range =
      intent.fromYear !== null && intent.fromYear !== undefined
        ? { fromYear: intent.fromYear, toYear: intent.toYear ?? intent.fromYear }
        : yearRange(originalText, context);
    const inRange = (row) => {
      const year = yearFromEventId(sessionEventId(row.sessionId));
      return (!range.fromYear || year >= range.fromYear) && (!range.toYear || year <= range.toYear);
    };
    const resultSets = await Promise.all((await keys('results:')).map(get));
    const qualifyingSets = await Promise.all((await keys('qualifying:')).map(get));
    const driverRows = resultSets.flatMap((set) =>
      (set?.items || []).filter((row) => inRange(row)),
    );
    const qualifyingRows = qualifyingSets.flatMap((set) =>
      (set?.items || []).filter((row) => inRange(row)),
    );
    const metric = intent.metric || 'race_starts';
    const rowsForDriver = driverRows.filter((row) =>
      driverNames(row).some((entryDriver) => entryDriver.id === driver.id),
    );
    let events;
    let relevantSets = resultSets;
    if (metric === 'poles') {
      events = distinctEventRows(
        qualifyingRows.filter((row) =>
          driverNames(row).some((entryDriver) => entryDriver.id === driver.id),
        ),
        (row) => row.position === 1,
      );
      relevantSets = qualifyingSets;
    } else {
      const predicates = {
        race_starts: isRaceStart,
        race_wins: (row) => isRaceStart(row) && row.position === 1,
        podiums: (row) => isRaceStart(row) && row.position >= 1 && row.position <= 3,
        fastest_laps: (row) => isRaceRow(row) && row.fastestLap?.rank === 1,
        retirements: (row) => isRaceRow(row) && row.status === 'retired',
        disqualifications: (row) => isRaceRow(row) && row.status === 'disqualified',
        did_not_start: (row) => isRaceRow(row) && row.status === 'not-started',
        did_not_qualify: (row) => isRaceRow(row) && row.status === 'not-classified',
      };
      events = distinctEventRows(rowsForDriver, predicates[metric] || predicates.race_starts);
    }
    if (!relevantSets.length)
      return this.result(
        {
          status: 'unavailable',
          message: `The archive does not publish the ${metric.replaceAll('_', ' ')} data needed for ${driver.entity.displayName}.`,
          reasonCode: 'DRIVER_STAT_NOT_PUBLISHED',
        },
        [...sets, ...relevantSets],
      );
    const labels = {
      race_starts: 'race start',
      race_wins: 'race win',
      podiums: 'podium',
      poles: 'pole position',
      fastest_laps: 'fastest lap',
      retirements: 'retirement',
      disqualifications: 'disqualification',
      did_not_start: 'did-not-start entry',
      did_not_qualify: 'did-not-qualify entry',
    };
    const label = labels[metric] || 'result';
    const count = events.size;
    const scope = range.fromYear
      ? ` from ${range.fromYear}${range.toYear && range.toYear !== range.fromYear ? ` to ${range.toYear}` : ''}`
      : ' in the published archive';
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'driver_stat',
        templateKey: 'driver_stat',
        values: {
          answer: `${driver.entity.displayName} has ${count} ${label}${count === 1 ? '' : 's'}${scope}.`,
          driver: driver.entity.displayName,
          metric,
          count,
          fromYear: range.fromYear,
          toYear: range.toYear,
        },
        evidenceIds: unique([
          ...sets.map((set) => set?.evidenceId),
          ...relevantSets.map((set) => set?.evidenceId),
        ]).slice(0, 12),
      },
      [...sets, ...relevantSets],
    );
  }

  async driverConstructorStarts(intent, context, { get, keys }) {
    const { sets, items } = await this.profiles({ get, keys });
    const driver = context.driverId
      ? items.find((profile) => profile.id === context.driverId)
      : this.findProfile(items, 'driver', intent.driverName);
    const constructor = context.constructorId
      ? items.find((profile) => profile.id === context.constructorId)
      : this.findProfile(items, 'constructor', intent.constructorName);
    if (!driver || !constructor)
      return this.result(
        {
          status: 'clarification',
          message: 'Please identify both the driver and constructor.',
          choices: [],
        },
        sets,
      );
    const range =
      intent.fromYear !== null && intent.fromYear !== undefined
        ? {
            fromYear: intent.fromYear,
            toYear: intent.toYear ?? intent.fromYear,
          }
        : yearRange(intent.originalText || '', context);
    const resultKeys = (await keys('results:')).filter((key) => {
      const yearMatch = String(key).match(/:event:(\d{4}):/);
      if (!yearMatch) return true;
      const year = Number(yearMatch[1]);
      return (!range.fromYear || year >= range.fromYear) && (!range.toYear || year <= range.toYear);
    });
    const resultSets = await Promise.all(resultKeys.map(get));
    const matchingEvents = new Map();
    for (const set of resultSets) {
      for (const row of set?.items || []) {
        if (!isRaceStart(row)) continue;
        const eventId = sessionEventId(row.sessionId);
        const year = yearFromEventId(eventId);
        if (
          !eventId ||
          (range.fromYear && year < range.fromYear) ||
          (range.toYear && year > range.toYear)
        )
          continue;
        if (
          row.entry?.constructor?.id === constructor.id &&
          row.entry.drivers?.some((entryDriver) => entryDriver.id === driver.id)
        )
          matchingEvents.set(eventId, { year, evidenceId: set.evidenceId });
      }
    }
    const count = matchingEvents.size;
    const metric = intent.metric || 'race_starts';
    const answer =
      metric === 'seasons'
        ? `${driver.entity.displayName} raced for ${constructor.entity.displayName} in ${new Set([...matchingEvents.values()].map((event) => event.year)).size} season${count === 1 ? '' : 's'} in the selected period.`
        : `${driver.entity.displayName} made ${count} race start${count === 1 ? '' : 's'} for ${constructor.entity.displayName} in the selected period.`;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'driver_constructor_race_starts',
        templateKey:
          metric === 'seasons' ? 'driver_constructor_seasons' : 'driver_constructor_race_starts',
        values: {
          answer,
          driver: driver.entity.displayName,
          constructor: constructor.entity.displayName,
          metric,
          fromYear: range.fromYear,
          toYear: range.toYear,
          count,
        },
        evidenceIds: unique([
          ...sets.map((set) => set?.evidenceId),
          ...Array.from(matchingEvents.values(), (event) => event.evidenceId),
        ]).slice(0, 12),
      },
      [...sets, ...resultSets],
    );
  }

  async driverLastWin(intent, _context, { get, keys }) {
    const { sets, items } = await this.profiles({ get, keys });
    const driver = this.findProfile(items, 'driver', intent.driverName);
    if (!driver)
      return this.result(
        {
          status: 'clarification',
          message: 'Which driver do you mean?',
          choices: [],
        },
        sets,
      );

    const resultSets = await Promise.all((await keys('results:')).map(get));
    const wins = [];
    for (const set of resultSets) {
      for (const row of set?.items || []) {
        if (
          !row.sessionId?.endsWith(':race') ||
          row.position !== 1 ||
          !row.entry?.drivers?.some((entryDriver) => entryDriver.id === driver.id)
        )
          continue;
        const eventId = sessionEventId(row.sessionId);
        if (eventId) wins.push({ eventId, row, resultSet: set });
      }
    }
    const details = await Promise.all(
      [...new Set(wins.map((win) => win.eventId))].map((eventId) => get(`event:${eventId}`)),
    );
    const detailsByEvent = new Map(
      details
        .map((set) => [set?.items?.[0]?.event?.id, { detail: set, event: set?.items?.[0]?.event }])
        .filter(([eventId, value]) => eventId && value.event),
    );
    const datedWins = wins
      .map((win) => ({ ...win, ...detailsByEvent.get(win.eventId) }))
      .filter((win) => win.event)
      .sort((a, b) => {
        const aDate = Date.parse(a.event.schedule?.startsAt || a.event.schedule?.date || '');
        const bDate = Date.parse(b.event.schedule?.startsAt || b.event.schedule?.date || '');
        return bDate - aDate || (b.event.round || 0) - (a.event.round || 0);
      });
    const latest = datedWins[0];
    if (!latest)
      return this.result(
        {
          status: 'unavailable',
          message: `No published race win was found for ${driver.entity.displayName}.`,
          reasonCode: 'DRIVER_WIN_NOT_PUBLISHED',
        },
        [...sets, ...resultSets, ...details],
      );

    const event = latest.event;
    const date = event.schedule?.date || null;
    const constructor = latest.row.entry?.constructor?.displayName || null;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'driver_last_win',
        templateKey: 'driver_last_win',
        values: {
          answer: `${driver.entity.displayName} last won the ${event.name} on ${formatDate(date) || event.year}.`,
          driver: driver.entity.displayName,
          constructor,
          event: event.name,
          year: event.year,
          date,
          round: event.round,
          circuit: event.circuit?.displayName || null,
        },
        evidenceIds: unique([
          ...sets.map((set) => set?.evidenceId),
          latest.resultSet.evidenceId,
          latest.detail.evidenceId,
        ]).slice(0, 12),
      },
      [...sets, ...resultSets, ...details],
    );
  }

  collectDriverWins(driverId, resultSets) {
    const winsByEvent = new Map();
    for (const set of resultSets) {
      for (const row of set?.items || []) {
        if (
          !row.sessionId?.endsWith(':race') ||
          row.position !== 1 ||
          !row.entry?.drivers?.some((entryDriver) => entryDriver.id === driverId)
        )
          continue;
        const eventId = sessionEventId(row.sessionId);
        if (eventId && !winsByEvent.has(eventId)) winsByEvent.set(eventId, set);
      }
    }
    return winsByEvent;
  }

  async driverRaceWins(intent, _context, { get, keys }, originalText = '') {
    const { sets, items } = await this.profiles({ get, keys });
    const driver = this.findProfile(items, 'driver', intent.driverName);
    if (!driver)
      return this.result(
        {
          status: 'clarification',
          message: 'Which driver do you mean?',
          choices: [],
        },
        sets,
      );

    const resultSets = await Promise.all((await keys('results:')).map(get));
    const winsByEvent = this.collectDriverWins(driver.id, resultSets);

    const count = winsByEvent.size;
    const wantsFirst = /\bfirst\b/.test(normalize(originalText || intent.originalText));
    let firstWin = null;
    let details = [];
    if (wantsFirst && winsByEvent.size) {
      details = await Promise.all(
        [...winsByEvent.keys()].map((eventId) => get(`event:${eventId}`)),
      );
      firstWin =
        details
          .map((set) => ({
            detail: set,
            event: set?.items?.[0]?.event,
          }))
          .filter((entry) => entry.event)
          .sort((a, b) => {
            const aDate = Date.parse(a.event.schedule?.startsAt || a.event.schedule?.date || '');
            const bDate = Date.parse(b.event.schedule?.startsAt || b.event.schedule?.date || '');
            return aDate - bDate || (a.event.round || 0) - (b.event.round || 0);
          })[0] || null;
    }
    const countAnswer = `${driver.entity.displayName} has won ${count} race${count === 1 ? '' : 's'} in their career.`;
    const answer = firstWin
      ? `${countAnswer} Their first win was the ${firstWin.event.name} on ${formatDate(firstWin.event.schedule?.date) || firstWin.event.year}.`
      : countAnswer;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'driver_race_wins',
        templateKey: 'driver_race_wins',
        values: {
          answer,
          driver: driver.entity.displayName,
          count,
          ...(firstWin
            ? {
                firstWinEvent: firstWin.event.name,
                firstWinDate: firstWin.event.schedule?.date || null,
                firstWinYear: firstWin.event.year,
                firstWinRound: firstWin.event.round,
              }
            : {}),
        },
        evidenceIds: unique([
          ...sets.map((set) => set?.evidenceId),
          ...Array.from(winsByEvent.values(), (set) => set?.evidenceId),
          ...details.map((set) => set?.evidenceId),
        ]).slice(0, 12),
      },
      [...sets, ...resultSets, ...details],
    );
  }

  async driverRaceWinsComparison(intent, _context, { get, keys }) {
    const { sets, items } = await this.profiles({ get, keys });
    const driver = this.findProfile(items, 'driver', intent.driverName);
    const comparisonDriver = this.findProfile(items, 'driver', intent.comparisonDriverName);
    if (!driver || !comparisonDriver)
      return this.result(
        {
          status: 'clarification',
          message: 'Please identify both drivers.',
          choices: [],
        },
        sets,
      );

    const resultSets = await Promise.all((await keys('results:')).map(get));
    const driverWins = this.collectDriverWins(driver.id, resultSets);
    const comparisonWins = this.collectDriverWins(comparisonDriver.id, resultSets);
    const driverCount = driverWins.size;
    const comparisonCount = comparisonWins.size;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'driver_race_wins_comparison',
        templateKey: 'driver_race_wins_comparison',
        values: {
          answer: `${driver.entity.displayName} has won ${driverCount} race${driverCount === 1 ? '' : 's'}, compared with ${comparisonDriver.entity.displayName}'s ${comparisonCount}.`,
          driver: driver.entity.displayName,
          count: driverCount,
          comparisonDriver: comparisonDriver.entity.displayName,
          comparisonCount,
        },
        evidenceIds: unique([
          ...sets.map((set) => set?.evidenceId),
          ...Array.from(driverWins.values(), (set) => set?.evidenceId),
          ...Array.from(comparisonWins.values(), (set) => set?.evidenceId),
        ]).slice(0, 12),
      },
      [...sets, ...resultSets],
    );
  }

  result(questionResult, sets) {
    const available = sets.filter(Boolean);
    const first = available[0];
    return {
      result: questionResult,
      dataset: {
        items: [],
        coverage: available.length ? 'partial' : 'unavailable',
        verification: available.some((set) => set.verification === 'conflict')
          ? 'conflict'
          : first?.verification || 'unassessed',
        provenance: first?.provenance || { sources: [] },
        evidenceId: first?.evidenceId || null,
        warnings: available.flatMap((set) => set.warnings || []),
      },
    };
  }
}
