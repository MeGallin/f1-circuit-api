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

function contextWith(overrides = {}) {
  return { ...emptyContext, ...overrides };
}

function yearRange(text, context) {
  const years = [...String(text).matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
  if (years.length >= 2) return { fromYear: Math.min(...years), toYear: Math.max(...years) };
  if (years.length === 1) return { fromYear: years[0], toYear: years[0] };
  const anchor = Number(context.year) || new Date().getUTCFullYear();
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

export class QuestionService {
  constructor(repository, { config = {} } = {}) {
    this.repository = repository;
    this.interpreter =
      config.openaiEnabled && config.openaiApiKey
        ? new OpenAIQuestionInterpreter({
            apiKey: config.openaiApiKey,
            model: config.openaiModel,
            timeoutMs: config.openaiTimeoutMs,
          })
        : null;
  }

  async answer(body, { snapshot: _snapshot, get, keys }) {
    const text = String(body?.text || '').trim();
    const context = contextWith(body?.context);
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
    const target = normalize(eventName || text);
    const candidates = eventSets
      .flatMap((set) => (set?.items || []).map((event) => ({ event, set })))
      .filter(({ event }) => {
        const value = normalize(`${event.name} ${event.id}`);
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
      return (
        (!range.fromYear || year >= range.fromYear) &&
        (!range.toYear || year <= range.toYear)
      );
    });
    const resultSets = await Promise.all(resultKeys.map(get));
    const matchingEvents = new Map();
    for (const set of resultSets) {
      for (const row of set?.items || []) {
        if (!row.sessionId?.endsWith(':race')) continue;
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
      [...new Set(wins.map((win) => win.eventId))].map((eventId) =>
        get(`event:${eventId}`),
      ),
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
