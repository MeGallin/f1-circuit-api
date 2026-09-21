import { OpenAIQuestionInterpreter } from '../providers/openai/question-interpreter.js';
import { OpenAIEmbeddingClient } from '../providers/openai/embeddings.js';

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

function fallbackSuggestion({ status, reasonCode }) {
  if (status === 'clarification')
    return 'Try adding a year, event, driver, constructor or specific metric to the question.';

  if (reasonCode === 'QUESTION_INTERPRETER_UNAVAILABLE')
    return 'Try again or reword it as: “Which circuit hosted the 2022 Italian Grand Prix?”';

  if (reasonCode === 'QUESTION_INTERPRETER_DISABLED')
    return 'Try rewording it as: “Who won the 2022 Italian Grand Prix?”';

  if (reasonCode === 'QUESTION_INTENT_UNSUPPORTED')
    return 'Try rewording it as: “Which circuit hosted the 2022 Italian Grand Prix?”';

  if (reasonCode && /NOT_PUBLISHED|SOURCE_COVERAGE|UNAVAILABLE/.test(reasonCode))
    return 'Try a published season from 2000 onward, such as: “Who won the 2022 Italian Grand Prix?”';

  if (status === 'unsupported' || status === 'unavailable')
    return 'Try rewording it as one specific archive question, such as: “Who won the 2022 Italian Grand Prix?”';

  return null;
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
  const anchor = Number(context.year) || Number(context.currentYear) || new Date().getUTCFullYear();
  if (/\bthis\s+(?:year|season)\b/i.test(text)) return { fromYear: anchor, toYear: anchor };
  if (/\blast\s+year\b/i.test(text)) return { fromYear: anchor - 1, toYear: anchor - 1 };
  if (/last\s+(?:four|4)\s+years?/i.test(text)) return { fromYear: anchor - 3, toYear: anchor };
  return { fromYear: null, toYear: null };
}

function parseHostedCircuitQuestion(text, context) {
  const lower = normalize(text);
  const asksCircuit =
    /\b(?:which|what)\s+(?:circuit|track|venue)\s+(?:hosted|held|used)\b/.test(lower) ||
    /\bwhere\s+was\b.*\b(?:held|hosted|run)\b/.test(lower);
  if (!asksCircuit) return null;
  const range = yearRange(text, context);
  const eventMatch = lower.match(
    /\b(?:19\d{2}|20\d{2})\s+([a-z0-9]+(?:\s+[a-z0-9]+){0,4})\s+(?:grand\s+prix|gp)\b/,
  );
  return {
    intent: 'event_circuit',
    eventName: eventMatch ? `${eventMatch[1]} Grand Prix` : null,
    fromYear: range.fromYear,
    toYear: range.toYear,
    clarificationNeeded: false,
  };
}

function parseCompoundEventQuestion(lower) {
  const asksForPodium = /\b(?:top\s+three|podium|finishers?)\b/.test(lower);
  const asksForConstructors = /\b(?:constructors?|manufacturers?|teams?)\b/.test(lower);
  const asksForPoints = /\bpoints?\b/.test(lower);
  const asksForFastestLap = /\bfastest\s+lap\b/.test(lower);
  if (!asksForPodium || !asksForConstructors || !asksForPoints || !asksForFastestLap)
    return null;
  return { intent: 'event_compound_summary' };
}

function parseFastestLapLeaderboardQuestion(lower) {
  const asksForDriver = /\bwho\b|\bwhich\s+driver\b/.test(lower);
  const asksForMost = /\b(?:most|highest|greatest)\b/.test(lower);
  if (!asksForDriver || !asksForMost || !/\bfastest\s+laps?\b/.test(lower)) return null;
  return { intent: 'fastest_lap_leaderboard' };
}

function parsePodiumLeaderboardQuestion(lower) {
  const asksForDriver = /\bwho\b|\bwhich\s+driver\b/.test(lower);
  const asksForMost = /\b(?:most|highest|greatest)\b/.test(lower);
  const asksForPodiums = /\bpodiums?\b|\bpodium\s+finishes?\b/.test(lower);
  if (!asksForDriver || !asksForMost || !asksForPodiums || /\bposition\b/.test(lower))
    return null;
  return { intent: 'podium_leaderboard' };
}

function parseRaceWinLeaderboardQuestion(lower) {
  const asksForDriver = /\bwho\b|\bwhich\s+driver\b/.test(lower);
  const asksForMost = /\b(?:most|highest|greatest)\b/.test(lower);
  const asksForWins = /\b(?:won|wins?|victories|race\s+wins?)\b/.test(lower);
  if (!asksForDriver || !asksForMost || !asksForWins) return null;
  return { intent: 'race_win_leaderboard' };
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

const finishingPositionWords = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
};

const finishingPositionWordPattern = Object.keys(finishingPositionWords).join('|');

function parseFinishingPositionQuestion(lower) {
  const asksForMost = /\b(?:most|highest|more\s+often)\b/.test(lower);
  const hasNonFinishPosition =
    /\b(?:pole|qualifying|grid|starting)\s+position(?:s)?\b/.test(lower) ||
    /\bpole\s+positions?\b/.test(lower);
  const hasFinishingContext =
    /\bfinish(?:es|ed)?\b|\bplace(?:s)?\b|\bpodium\b|\brunner\s+up\b/.test(lower);
  if (asksForMost && hasNonFinishPosition) return { invalid: true };
  if (!asksForMost || !hasFinishingContext) return null;

  const candidates = [];
  for (const match of lower.matchAll(new RegExp(`\\b(${finishingPositionWordPattern})\\b`, 'g')))
    candidates.push(finishingPositionWords[match[1]]);
  for (const match of lower.matchAll(/\b(\d{1,3})(?:st|nd|rd|th)\b/g))
    candidates.push(Number(match[1]));
  for (const match of lower.matchAll(/\b(?:position|place)\s+(\d{1,3})\b/g))
    candidates.push(Number(match[1]));
  if (/\brunner\s+up\b/.test(lower)) candidates.push(2);

  if (candidates.length !== 1 || candidates[0] < 1 || candidates[0] > 99) return { invalid: true };
  return { position: candidates[0], invalid: false };
}

function finishingPositionLabel(position) {
  const word = Object.entries(finishingPositionWords).find(([, value]) => value === position)?.[0];
  return word ? `${word}-place` : `P${position}`;
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
  constructor(repository, { config = {}, questionRepository = null, interpreter = null } = {}) {
    this.repository = repository;
    this.questionRepository = questionRepository;
    this.interpreter =
      interpreter ||
      (config.openaiEnabled && config.openaiApiKey
        ? new OpenAIQuestionInterpreter({
            apiKey: config.openaiApiKey,
            model: config.openaiModel,
            reasoningEffort: config.openaiReasoningEffort,
            timeoutMs: config.openaiTimeoutMs,
          })
        : null);
    this.embeddingClient =
      config.questionRagEnabled !== false &&
      config.openaiEnabled &&
      config.openaiApiKey &&
      questionRepository
        ? new OpenAIEmbeddingClient({
            apiKey: config.openaiApiKey,
            model: config.openaiEmbeddingModel,
            timeoutMs: config.openaiTimeoutMs,
          })
        : null;
  }

  async answer(body, { snapshot, get, keys }) {
    const text = String(body?.text || '').trim();
    const context = contextWith({
      ...body?.context,
      currentYear: new Date().getUTCFullYear(),
    });
    const deterministic = await this.interpretDeterministically(text, context, { get, keys });
    if (deterministic) return this.withModelSuggestion(deterministic, { text, context });

    if (!this.interpreter)
      return this.result(
        {
          status: 'unavailable',
          message:
            'This question could not be mapped to a supported archive operation. Use Explore for record search.',
          reasonCode: 'QUESTION_INTERPRETER_DISABLED',
        },
        [],
      );

    try {
      const candidates = await this.retrieveCandidates(text, snapshot?.id);
      const intent = await this.interpreter.interpret({ text, context, candidates });
      const result = await this.executeIntent(intent, context, { get, keys }, text);
      return this.withModelSuggestion(result, { text, context });
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

  async retrieveCandidates(text, publicationId) {
    if (!this.questionRepository || !this.embeddingClient || !publicationId) return [];
    try {
      const manifest = await this.questionRepository.manifest(publicationId);
      if (manifest?.status !== 'ready') return [];
      const [embedding] = await this.embeddingClient.embed(text);
      return await this.questionRepository.search({
        publicationId,
        query: text,
        embedding,
        limit: 16,
      });
    } catch {
      return [];
    }
  }

  async withModelSuggestion(result, { text, context }) {
    if (result?.result?.status === 'answered' || typeof this.interpreter?.rephrase !== 'function')
      return result;

    try {
      const generated = await this.interpreter.rephrase({
        text,
        context,
        failure: {
          status: result.result.status,
          message: result.result.message,
          reasonCode: result.result.reasonCode || null,
        },
      });
      const suggestion = String(generated?.suggestion || '').trim();
      if (!suggestion || suggestion.length > 300 || !suggestion.endsWith('?')) return result;
      return {
        ...result,
        result: { ...result.result, suggestion },
      };
    } catch {
      return result;
    }
  }

  async interpretDeterministically(text, context, helpers) {
    if (!text) return null;
    const lower = normalize(text);
    const hostedCircuit = parseHostedCircuitQuestion(text, context);
    if (hostedCircuit) return this.executeIntent(hostedCircuit, context, helpers, text);
    const compoundEvent = parseCompoundEventQuestion(lower);
    if (compoundEvent) return this.executeIntent(compoundEvent, context, helpers, text);
    const fastestLapLeaderboard = parseFastestLapLeaderboardQuestion(lower);
    if (fastestLapLeaderboard)
      return this.executeIntent(fastestLapLeaderboard, context, helpers, text);
    const podiumLeaderboard = parsePodiumLeaderboardQuestion(lower);
    if (podiumLeaderboard)
      return this.executeIntent(podiumLeaderboard, context, helpers, text);
    const raceWinLeaderboard = parseRaceWinLeaderboardQuestion(lower);
    if (raceWinLeaderboard)
      return this.executeIntent(raceWinLeaderboard, context, helpers, text);
    const finishingPosition = parseFinishingPositionQuestion(lower);
    if (finishingPosition)
      return this.executeIntent(
        {
          intent: 'driver_finishing_position',
          ...finishingPosition,
          ...yearRange(text, context),
          originalText: text,
        },
        context,
        helpers,
        text,
      );
    if (/\bwho\s+won\b/.test(lower) && /\b(?:world|drivers?)\s+championship\b/.test(lower)) {
      const range = yearRange(text, context);
      return this.executeIntent(
        {
          intent: 'season_champion',
          fromYear: range.fromYear,
          toYear: range.toYear,
          originalText: text,
        },
        context,
        helpers,
        text,
      );
    }
    if (/\bwho\s+won\b|\bwinner\b/.test(lower)) {
      const circuitQuestion = await this.detectCircuitWinnerQuestion(text, helpers, context);
      if (circuitQuestion) return this.executeIntent(circuitQuestion, context, helpers, text);
      const countryQuestion = await this.detectCountryWinnerQuestion(text, helpers, context);
      if (countryQuestion) return this.executeIntent(countryQuestion, context, helpers, text);
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
      /\b(?:when|what)\b/.test(lower) &&
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
    if (
      /\b(?:when|what)\b/.test(lower) &&
      /\b(last|most\s+recent|latest|final)\b/.test(lower) &&
      /\b(race|grand\s+prix|start|drove|competed)\b/.test(lower)
    ) {
      const { items } = await this.profiles(helpers);
      const driver = items.find(
        (profile) =>
          profile.kind === 'driver' && lower.includes(normalize(profile.entity.displayName)),
      );
      if (driver)
        return this.executeIntent(
          {
            intent: 'driver_last_race',
            driverName: driver.entity.displayName,
            originalText: text,
          },
          context,
          helpers,
          text,
        );
    }
    if (
      /\bhow\s+many\b/.test(lower) &&
      /\b(?:manufacturers?|constructors?)\b/.test(lower) &&
      /\b(?:race|raced|drive|drove|under|for)\b/.test(lower)
    ) {
      const { items } = await this.profiles(helpers);
      const driver = items.find(
        (profile) =>
          profile.kind === 'driver' && lower.includes(normalize(profile.entity.displayName)),
      );
      if (driver)
        return this.executeIntent(
          {
            intent: 'driver_constructor_count',
            driverName: driver.entity.displayName,
            fromYear: null,
            toYear: null,
            originalText: text,
          },
          context,
          helpers,
        text,
      );
    }
    const constructorQuestion = await this.detectDriverConstructorQuestion(
      text,
      context,
      helpers,
    );
    if (constructorQuestion)
      return this.executeIntent(constructorQuestion, context, helpers, text);
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
    if (/\b(world\s+)?champion(ship)?\b|\bdrivers?'?\s+title\b|\bworld\s+title\b/.test(lower)) {
      const { items } = await this.profiles(helpers);
      const driver = items.find(
        (profile) =>
          profile.kind === 'driver' && lower.includes(normalize(profile.entity.displayName)),
      );
      if (driver)
        return this.executeIntent(
          {
            intent: 'driver_stat',
            driverName: driver.entity.displayName,
            metric: 'championships',
            originalText: text,
          },
          context,
          helpers,
          text,
        );
    }
    if (/\bhow\s+many\b/.test(lower) && /\b(win|wins|won|victor(?:y|ies))\b/.test(lower)) {
      const { sets, items } = await this.profiles(helpers);
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
      const range = yearRange(text, context);
      if (range.fromYear !== null) {
        if (drivers.length >= 2 && /\b(compared\s+to|versus|vs|than)\b/.test(lower))
          return this.result(
            {
              status: 'unsupported',
              message: 'Season-specific driver win comparisons are not supported yet.',
              reasonCode: 'DRIVER_RACE_WINS_SEASON_COMPARISON_UNSUPPORTED',
            },
            sets,
          );
        const driver = drivers[0];
        if (driver)
          return this.executeIntent(
            {
              intent: 'driver_race_wins_season',
              driverName: driver.entity.displayName,
              fromYear: range.fromYear,
              toYear: range.toYear,
              originalText: text,
            },
            context,
            helpers,
            text,
          );
        return this.result(
          {
            status: 'clarification',
            message: 'Which driver do you mean?',
            choices: [],
          },
          sets,
        );
      }
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
    return null;
  }

  async executeIntent(intent, context, { get, keys }, originalText = '') {
    if (intent?.clarificationNeeded)
      return this.result(
        {
          status: 'clarification',
          message: intent.clarificationMessage || 'Please clarify what you want to find.',
          choices: [{ label: 'Ask a supported archive question', context: contextWith({}) }],
        },
        [],
      );
    if (intent?.intent === 'event_winner')
      return this.eventWinner(intent.eventName, context, originalText, { get, keys });
    if (intent?.intent === 'event_circuit')
      return this.eventCircuit(intent, context, originalText, { get, keys });
    if (intent?.intent === 'season_champion')
      return this.seasonChampion(intent, context, { get, keys }, originalText);
    if (intent?.intent === 'constructor_championship_leaderboard')
      return this.constructorChampionshipLeaderboard(intent, context, { get, keys }, originalText);
    if (intent?.intent === 'constructor_rivalry_comparison')
      return this.constructorRivalryComparison(intent, context, { get, keys }, originalText);
    if (intent?.intent === 'driver_constructor_race_starts')
      return this.driverConstructorStarts(intent, context, { get, keys });
    if (intent?.intent === 'driver_constructor_count')
      return this.driverConstructorCount(intent, context, { get, keys });
    if (intent?.intent === 'driver_constructor_breakdown')
      return this.driverConstructorBreakdown(intent, context, { get, keys });
    if (intent?.intent === 'driver_constructor_comparison')
      return this.driverConstructorComparison(intent, context, { get, keys });
    if (intent?.intent === 'driver_last_win')
      return this.driverLastWin(intent, context, { get, keys });
    if (intent?.intent === 'driver_last_race')
      return this.driverRaceBoundary(intent, { get, keys }, 'last');
    if (intent?.intent === 'driver_first_race')
      return this.driverRaceBoundary(intent, { get, keys }, 'first');
    if (intent?.intent === 'driver_first_win')
      return this.driverWinBoundary(intent, { get, keys }, 'first');
    if (intent?.intent === 'driver_race_wins')
      return this.driverRaceWins(intent, context, { get, keys }, originalText);
    if (intent?.intent === 'driver_race_wins_season')
      return this.driverRaceWinsSeason(intent, context, { get, keys });
    if (intent?.intent === 'driver_race_wins_comparison')
      return this.driverRaceWinsComparison(intent, context, { get, keys });
    if (intent?.intent === 'driver_finishing_position')
      return this.driverFinishingPosition(intent, context, { get, keys });
    if (intent?.intent === 'driver_stat')
      return this.driverStat(intent, context, { get, keys }, originalText);
    if (intent?.intent === 'event_podium')
      return this.eventPodium(intent.eventName, context, originalText, { get, keys });
    if (intent?.intent === 'event_compound_summary')
      return this.eventCompoundSummary(context, originalText, { get, keys });
    if (intent?.intent === 'fastest_lap_leaderboard')
      return this.fastestLapLeaderboard(context, originalText, { get, keys });
    if (intent?.intent === 'podium_leaderboard')
      return this.podiumLeaderboard(context, originalText, { get, keys });
    if (intent?.intent === 'race_win_leaderboard')
      return this.raceWinLeaderboard(context, originalText, { get, keys });
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

  async detectDriverConstructorQuestion(text, context, helpers) {
    const lower = normalize(text);
    const asksComparison =
      /\b(?:compare|comparison|differ|between|versus|vs)\b/.test(lower) &&
      /\b(?:race|races|raced|statistics|stats|results|starts|wins|podiums|points)\b/.test(
        lower,
      );
    const asksBreakdown =
      /\b(?:each|every|all)\b/.test(lower) &&
      /\b(?:manufacturers?|constructors?|teams?)\b/.test(lower) &&
      /\b(?:race|races|raced|participate|participated|drive|drove|under|for)\b/.test(lower);
    if (!asksComparison && !asksBreakdown) return null;

    const { items } = await this.profiles(helpers);
    const driver = context.driverId
      ? items.find((profile) => profile.id === context.driverId)
      : items.find(
          (profile) =>
            profile.kind === 'driver' && lower.includes(normalize(profile.entity.displayName)),
        );
    if (!driver) return null;

    const constructors = items.filter(
      (profile) =>
        profile.kind === 'constructor' && lower.includes(normalize(profile.entity.displayName)),
    );
    if (asksComparison && constructors.length >= 2)
      return {
        intent: 'driver_constructor_comparison',
        driverName: driver.entity.displayName,
        constructorNames: unique(constructors.map((profile) => profile.entity.displayName)),
        ...yearRange(text, context),
        originalText: text,
      };

    if (asksBreakdown)
      return {
        intent: 'driver_constructor_breakdown',
        driverName: driver.entity.displayName,
        ...yearRange(text, context),
        originalText: text,
      };
    return null;
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
      circuits
        .flatMap((circuit) => [
          circuit.entity.displayName,
          circuit.entity.id,
          ...(circuit.aliases || []),
        ])
        .map(normalize),
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
        return (
          dateB - dateA ||
          (b.event.year || 0) - (a.event.year || 0) ||
          (b.event.round || 0) - (a.event.round || 0)
        );
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
          ...(countryScope ? { country: label } : { circuit: circuits[0].entity.displayName }),
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

  async eventCircuit(intent, context, text, { get, keys }) {
    const rawYear = intent.fromYear ?? intent.toYear ?? context.year;
    const year = rawYear == null ? null : Number(rawYear);
    if (!Number.isInteger(year))
      return this.result(
        {
          status: 'clarification',
          message: 'Which season do you mean?',
          choices: [],
        },
        [],
      );

    const resolved = await this.resolveEvent(
      intent.eventName,
      { ...context, eventId: null },
      text,
      { get, keys },
    );
    if (!resolved) {
      const eventSets = await Promise.all((await keys(`events:${year}`)).map(get));
      const target = normalize(intent.eventName);
      const candidates = eventSets
        .flatMap((set) => (set?.items || []).map((event) => ({ event, set })))
        .filter(({ event }) => {
          const value = normalize(`${event.name} ${event.id} ${event.circuit?.displayName || ''}`);
          return target && (value.includes(target) || target.includes(normalize(event.name)));
        });
      if (!eventSets.length || !candidates.length)
        return this.result(
          {
            status: 'unavailable',
            message: `The ${intent.eventName || 'requested event'} is not published for ${year}.`,
            reasonCode: 'EVENT_NOT_PUBLISHED',
          },
          eventSets,
        );
      return this.result(
        {
          status: 'clarification',
          message: 'Which Grand Prix do you mean?',
          choices: [],
        },
        eventSets,
      );
    }

    const detail = await get(`event:${resolved.eventId}`);
    const event =
      detail?.items?.[0]?.event ||
      resolved.set?.items?.find((item) => item.id === resolved.eventId);
    const circuit = event?.circuit;
    if (!event || !circuit?.displayName)
      return this.result(
        {
          status: 'unavailable',
          message: `A circuit is not published for the ${intent.eventName || 'requested event'}.`,
          reasonCode: 'EVENT_CIRCUIT_NOT_PUBLISHED',
        },
        [resolved.set, detail],
      );

    const coverage = [resolved.set, detail].some(
      (set) => set?.coverage !== 'complete' || set?.warnings?.length,
    )
      ? 'partial'
      : 'complete';
    const eventLabel = event.year ? `${event.year} ${event.name}` : event.name;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'event_circuit',
        templateKey: 'event_circuit',
        values: {
          answer: `The ${eventLabel} was held at ${circuit.displayName}.`,
          event: event.name,
          year: event.year,
          round: event.round,
          circuit: circuit.displayName,
          circuitId: circuit.id,
          coverage,
          ...(coverage === 'partial'
            ? { coverageNote: 'The answer uses the published event and circuit association.' }
            : {}),
        },
        evidenceIds: unique([resolved.set?.evidenceId, detail?.evidenceId]),
      },
      [resolved.set, detail],
    );
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
    const resultSet = await helpers.get(`results:${raceSessionId(resolved.eventId)}`);
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
        [resolved.set, resultSet, detail],
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
        evidenceIds: unique([resultSet?.evidenceId, detail.evidenceId, resolved.set.evidenceId]),
      },
      [resolved.set, resultSet, detail],
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

  async eventCompoundSummary(context, text, helpers) {
    const resolved = await this.resolveEvent(null, context, text, helpers);
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
      .filter((row) => Number.isInteger(row.position) && row.position >= 1 && row.position <= 3)
      .sort((a, b) => a.position - b.position);
    const podium = rows.flatMap((row) => {
      const driver = driverNames(row)[0];
      if (!driver) return [];
      const numericPoints = Number(row.points);
      return [
        {
          position: row.position,
          driver: driver.displayName,
          constructor: row.entry?.constructor?.displayName || 'Not supplied',
          points: Number.isFinite(numericPoints) ? numericPoints : null,
        },
      ];
    });
    const fastestRows = (resultSet?.items || []).filter((row) => row.fastestLap?.rank === 1);
    const fastestDrivers = unique(
      fastestRows.flatMap((row) => driverNames(row).map((driver) => driver.displayName)),
    );
    const fastestLap = fastestRows[0]?.fastestLap || null;
    if (!podium.length && !fastestDrivers.length)
      return this.result(
        {
          status: 'unavailable',
          message: `The requested race details are not published for ${event?.name || 'that event'}.`,
          reasonCode: 'EVENT_DETAILS_NOT_PUBLISHED',
        },
        [resolved.set, resultSet, detail],
      );

    const missingPositions = [1, 2, 3].filter(
      (position) => !podium.some((entry) => entry.position === position),
    );
    const eventLabel = event?.year ? `${event.year} ${event.name}` : event?.name || 'The event';
    const podiumAnswer = podium.length
      ? podium
          .map(
            (entry) =>
              `P${entry.position} ${entry.driver} (${entry.constructor}, ${entry.points == null ? 'points not published' : `${entry.points} points`})`,
          )
          .join('; ')
      : 'not published';
    const fastestAnswer = fastestDrivers.length
      ? `${humanList(fastestDrivers)}${fastestLap?.lapNumber ? ` on lap ${fastestLap.lapNumber}` : ''}`
      : 'not published';
    const coverage = [resolved.set, resultSet, detail].some(
      (set) => set?.coverage !== 'complete' || set?.warnings?.length,
    )
      ? 'partial'
      : 'complete';

    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'event_compound_summary',
        templateKey: 'event_compound_summary',
        values: {
          answer: `${eventLabel} — podium: ${podiumAnswer}. Fastest lap: ${fastestAnswer}.`,
          event: event?.name || 'Not supplied',
          year: event?.year || null,
          podium,
          missingPositions: missingPositions.join(', ') || 'None',
          fastestLapDrivers: fastestDrivers.join(', ') || 'Not supplied',
          fastestLapNumber: fastestLap?.lapNumber ?? null,
          fastestLapDurationMs: fastestLap?.durationMs ?? null,
          coverage,
          ...(coverage === 'partial'
            ? { coverageNote: 'The answer uses the published race-result and event-detail rows.' }
            : {}),
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

  rankDriverResultRows(rows) {
    const drivers = new Map();
    for (const row of rows) {
      const eventId = sessionEventId(row.sessionId);
      if (!eventId) continue;
      const constructor = row.entry?.constructor;
      for (const driver of driverNames(row)) {
        const record =
          drivers.get(driver.id) || {
            driver: driver.displayName,
            events: new Set(),
            constructors: new Map(),
          };
        if (record.events.has(eventId)) continue;
        record.events.add(eventId);
        const constructorId = constructor?.id || constructor?.displayName || 'unknown';
        const constructorRecord =
          record.constructors.get(constructorId) || {
            constructor: constructor?.displayName || 'Not supplied',
            events: new Set(),
          };
        constructorRecord.events.add(eventId);
        record.constructors.set(constructorId, constructorRecord);
        drivers.set(driver.id, record);
      }
    }

    return [...drivers.values()]
      .map((record) => ({
        driver: record.driver,
        count: record.events.size,
        constructors: [...record.constructors.values()]
          .map((entry) => ({ constructor: entry.constructor, count: entry.events.size }))
          .sort((a, b) => b.count - a.count || a.constructor.localeCompare(b.constructor))
          .map((entry) => `${entry.constructor}: ${entry.count}`)
          .join('; '),
      }))
      .sort((a, b) => b.count - a.count || a.driver.localeCompare(b.driver));
  }

  async fastestLapLeaderboard(_context, originalText, { get, keys }) {
    const range = yearRange(originalText, contextWith({ currentYear: new Date().getUTCFullYear() }));
    const resultSets = await Promise.all((await keys('results:')).map(get));
    const rows = resultSets.flatMap((set) =>
      (set?.items || []).filter((row) => {
        const year = yearFromEventId(sessionEventId(row.sessionId));
        return (
          isRaceRow(row) &&
          row.fastestLap?.rank === 1 &&
          (!range.fromYear || year >= range.fromYear) &&
          (!range.toYear || year <= range.toYear)
        );
      }),
    );
    const ranked = this.rankDriverResultRows(rows);
    const highest = ranked[0]?.count || 0;
    const leaders = ranked.filter((entry) => entry.count === highest);
    if (!leaders.length)
      return this.result(
        {
          status: 'unavailable',
          message: 'Fastest-lap results are not published for the requested period.',
          reasonCode: 'FASTEST_LAPS_NOT_PUBLISHED',
        },
        resultSets,
      );

    const period = range.fromYear
      ? ` from ${range.fromYear}${range.toYear && range.toYear !== range.fromYear ? ` to ${range.toYear}` : ''}`
      : ' in the published archive';
    const leaderAnswer = leaders
      .map(
        (leader) =>
          `${leader.driver} recorded ${leader.count} fastest lap${leader.count === 1 ? '' : 's'}${leader.constructors ? ` (${leader.constructors})` : ''}`,
      )
      .join('; ');
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'fastest_lap_leaderboard',
        templateKey: 'fastest_lap_leaderboard',
        values: {
          answer: `${leaderAnswer}${period}.`,
          metric: 'fastest_laps',
          leaders,
          count: highest,
          fromYear: range.fromYear,
          toYear: range.toYear,
          tied: leaders.length > 1,
        },
        evidenceIds: unique(resultSets.map((set) => set?.evidenceId)).slice(0, 12),
      },
      resultSets,
    );
  }

  async podiumLeaderboard(_context, originalText, { get, keys }) {
    const range = yearRange(originalText, contextWith({ currentYear: new Date().getUTCFullYear() }));
    const resultSets = await Promise.all((await keys('results:')).map(get));
    const rows = resultSets.flatMap((set) =>
      (set?.items || []).filter((row) => {
        const year = yearFromEventId(sessionEventId(row.sessionId));
        return (
          isRaceStart(row) &&
          row.position >= 1 &&
          row.position <= 3 &&
          (!range.fromYear || year >= range.fromYear) &&
          (!range.toYear || year <= range.toYear)
        );
      }),
    );
    const ranked = this.rankDriverResultRows(rows);
    const highest = ranked[0]?.count || 0;
    const leaders = ranked.filter((entry) => entry.count === highest);
    if (!leaders.length)
      return this.result(
        {
          status: 'unavailable',
          message: 'Podium results are not published for the requested period.',
          reasonCode: 'PODIUMS_NOT_PUBLISHED',
        },
        resultSets,
      );

    const period = range.fromYear
      ? ` from ${range.fromYear}${range.toYear && range.toYear !== range.fromYear ? ` to ${range.toYear}` : ''}`
      : ' in the published archive';
    const leaderAnswer = leaders
      .map(
        (leader) =>
          `${leader.driver} recorded ${leader.count} podium finish${leader.count === 1 ? '' : 'es'}${leader.constructors ? ` (${leader.constructors})` : ''}`,
      )
      .join('; ');
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'podium_leaderboard',
        templateKey: 'podium_leaderboard',
        values: {
          answer: `${leaderAnswer}${period}.`,
          metric: 'podiums',
          leaders,
          count: highest,
          fromYear: range.fromYear,
          toYear: range.toYear,
          tied: leaders.length > 1,
        },
        evidenceIds: unique(resultSets.map((set) => set?.evidenceId)).slice(0, 12),
      },
      resultSets,
    );
  }

  async raceWinLeaderboard(_context, originalText, { get, keys }) {
    const range = yearRange(originalText, contextWith({ currentYear: new Date().getUTCFullYear() }));
    const resultSets = await Promise.all((await keys('results:')).map(get));
    const rows = resultSets.flatMap((set) =>
      (set?.items || []).filter((row) => {
        const year = yearFromEventId(sessionEventId(row.sessionId));
        return (
          isRaceStart(row) &&
          row.position === 1 &&
          (!range.fromYear || year >= range.fromYear) &&
          (!range.toYear || year <= range.toYear)
        );
      }),
    );
    const ranked = this.rankDriverResultRows(rows);
    const highest = ranked[0]?.count || 0;
    const leaders = ranked.filter((entry) => entry.count === highest);
    if (!leaders.length)
      return this.result(
        {
          status: 'unavailable',
          message: 'Race-win results are not published for the requested period.',
          reasonCode: 'RACE_WINS_NOT_PUBLISHED',
        },
        resultSets,
      );

    const period = range.fromYear
      ? ` from ${range.fromYear}${range.toYear && range.toYear !== range.fromYear ? ` to ${range.toYear}` : ''}`
      : ' in the published archive';
    const leaderAnswer = leaders
      .map(
        (leader) =>
          `${leader.driver} won ${leader.count} race${leader.count === 1 ? '' : 's'}${leader.constructors ? ` (${leader.constructors})` : ''}`,
      )
      .join('; ');
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'race_win_leaderboard',
        templateKey: 'race_win_leaderboard',
        values: {
          answer: `${leaderAnswer}${period}.`,
          metric: 'race_wins',
          leaders,
          count: highest,
          fromYear: range.fromYear,
          toYear: range.toYear,
          tied: leaders.length > 1,
        },
        evidenceIds: unique(resultSets.map((set) => set?.evidenceId)).slice(0, 12),
      },
      resultSets,
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
    if (intent.metric === 'championships') {
      const standingsKeys = (await keys('standings:')).filter((key) =>
        /^standings:\d{4}:drivers$/.test(key),
      );
      const standingsSets = await Promise.all(standingsKeys.map(get));
      const inRangeYear = (year) =>
        (!range.fromYear || year >= range.fromYear) && (!range.toYear || year <= range.toYear);
      const driverStandingSets = standingsSets.filter((set) =>
        (set?.items || []).some((row) => row.entity?.id === driver.id),
      );
      const championships = standingsSets.flatMap((set) => {
        const match = String(set?.key || '').match(/^standings:(\d{4}):drivers$/);
        const year = match ? Number(match[1]) : null;
        if (!year || !inRangeYear(year)) return [];
        return (set?.items || [])
          .filter((row) => row.entity?.id === driver.id && row.rank === 1)
          .map((row) => ({ row, set, year }));
      });
      if (!standingsSets.length)
        return this.result(
          {
            status: 'unavailable',
            message: `The archive does not publish championship standings for ${driver.entity.displayName}.`,
            reasonCode: 'CHAMPIONSHIPS_NOT_PUBLISHED',
          },
          sets,
        );
      const years = championships.map(({ year }) => year).sort((a, b) => a - b);
      const scope = range.fromYear
        ? ` from ${range.fromYear}${range.toYear && range.toYear !== range.fromYear ? ` to ${range.toYear}` : ''}`
        : '';
      const answer = years.length
        ? `Yes. ${driver.entity.displayName} was Formula One World Champion in ${years.join(', ')}.`
        : `No. ${driver.entity.displayName} was not Formula One World Champion in the published archive${scope}.`;
      return this.result(
        {
          status: 'answered',
          resolvedIntent: 'driver_stat',
          templateKey: 'driver_championships',
          values: {
            answer,
            driver: driver.entity.displayName,
            metric: intent.metric,
            count: years.length,
            championshipYears: years.join(', ') || 'None published',
            fromYear: range.fromYear,
            toYear: range.toYear,
          },
          evidenceIds: unique([
            ...driverStandingSets.map((set) => set?.evidenceId),
            ...championships.map(({ set }) => set?.evidenceId),
            ...sets.map((set) => set?.evidenceId),
          ]).slice(0, 12),
        },
        [...sets, ...driverStandingSets, ...championships.map(({ set }) => set)],
      );
    }
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
          ...relevantSets.map((set) => set?.evidenceId),
          ...sets.map((set) => set?.evidenceId),
        ]).slice(0, 12),
      },
      [...sets, ...relevantSets],
    );
  }

  async seasonChampion(intent, context, { get, keys }, originalText = '') {
    const range =
      intent.fromYear !== null && intent.fromYear !== undefined
        ? { fromYear: intent.fromYear, toYear: intent.toYear ?? intent.fromYear }
        : yearRange(originalText, context);
    if (!Number.isInteger(range.fromYear) || range.fromYear !== range.toYear)
      return this.result(
        {
          status: 'clarification',
          message: 'Which championship season do you mean?',
          choices: [],
        },
        [],
      );
    const sets = await Promise.all((await keys(`standings:${range.fromYear}:drivers`)).map(get));
    const standingSet = sets.find((set) => (set?.items || []).length);
    const champion = standingSet?.items?.find((row) => row.rank === 1 && row.entity);
    if (!champion)
      return this.result(
        {
          status: 'unavailable',
          message: `The archive does not publish the ${range.fromYear} drivers' championship result.`,
          reasonCode: 'CHAMPIONSHIP_NOT_PUBLISHED',
        },
        sets,
      );
    const name = champion.entity.displayName;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'season_champion',
        templateKey: 'season_champion',
        values: {
          answer: `${name} won the ${range.fromYear} Formula One World Championship.`,
          champion: name,
          driver: name,
          year: range.fromYear,
          metric: 'world_championship',
        },
        evidenceIds: unique(sets.map((set) => set?.evidenceId)),
      },
      sets,
    );
  }

  async constructorChampionshipLeaderboard(intent, context, { get }, originalText = '') {
    const range =
      Number.isInteger(intent.fromYear) && Number.isInteger(intent.toYear)
        ? { fromYear: intent.fromYear, toYear: intent.toYear }
        : yearRange(originalText, context);
    if (
      !Number.isInteger(range.fromYear) ||
      !Number.isInteger(range.toYear) ||
      range.fromYear > range.toYear
    )
      return this.result(
        {
          status: 'clarification',
          message: 'Which completed seasons should be included?',
          choices: [],
        },
        [],
      );

    const sets = [];
    const champions = new Map();
    for (let year = range.fromYear; year <= range.toYear; year += 1) {
      const set = await get(`standings:${year}:constructors`);
      if (!set) continue;
      sets.push(set);
      const champion = set.items?.find((row) => row.rank === 1 && row.entity?.id);
      if (!champion) continue;
      const entry = champions.get(champion.entity.id) || {
        id: champion.entity.id,
        name: champion.entity.displayName,
        seasons: [],
      };
      entry.seasons.push(year);
      champions.set(champion.entity.id, entry);
    }

    const leaders = [...champions.values()]
      .map((entry) => ({ ...entry, titleCount: entry.seasons.length }))
      .sort((a, b) => b.titleCount - a.titleCount || a.name.localeCompare(b.name));
    const titleCount = leaders[0]?.titleCount || 0;
    const topLeaders = leaders.filter((entry) => entry.titleCount === titleCount);
    if (!topLeaders.length)
      return this.result(
        {
          status: 'unavailable',
          message: `The archive does not publish constructors' championship standings from ${range.fromYear} to ${range.toYear}.`,
          reasonCode: 'CONSTRUCTOR_CHAMPIONSHIP_NOT_PUBLISHED',
        },
        sets,
      );

    const names = topLeaders.map((entry) => entry.name);
    const answer =
      topLeaders.length === 1
        ? `${names[0]} won ${titleCount} constructors' title${titleCount === 1 ? '' : 's'} from ${range.fromYear} to ${range.toYear}.`
        : `${humanList(names)} each won ${titleCount} constructors' titles from ${range.fromYear} to ${range.toYear}.`;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'constructor_championship_leaderboard',
        templateKey: 'constructor_championship_leaderboard',
        values: {
          answer,
          constructor: names.join(', '),
          constructors: names.join(', '),
          metric: 'constructors_titles',
          titleCount,
          leaders: topLeaders.map((entry) => ({
            constructor: entry.name,
            titleCount: entry.titleCount,
            seasons: entry.seasons.join(', '),
          })),
          fromYear: range.fromYear,
          toYear: range.toYear,
        },
        evidenceIds: unique(sets.map((set) => set?.evidenceId)),
      },
      sets,
    );
  }

  async constructorRivalryComparison(intent, context, { get, keys }, originalText = '') {
    const range =
      Number.isInteger(intent.fromYear) && Number.isInteger(intent.toYear)
        ? { fromYear: intent.fromYear, toYear: intent.toYear }
        : yearRange(originalText, context);
    if (
      !Number.isInteger(range.fromYear) ||
      !Number.isInteger(range.toYear) ||
      range.fromYear > range.toYear
    )
      return this.result(
        {
          status: 'clarification',
          message: 'Which completed seasons should be included?',
          choices: [],
        },
        [],
      );

    const standingsSets = [];
    const titleCounts = new Map();
    for (let year = range.fromYear; year <= range.toYear; year += 1) {
      const set = await get(`standings:${year}:constructors`);
      if (!set) continue;
      standingsSets.push(set);
      const champion = set.items?.find((row) => row.rank === 1 && row.entity?.id);
      if (!champion) continue;
      const entry = titleCounts.get(champion.entity.id) || {
        id: champion.entity.id,
        name: champion.entity.displayName,
        titles: 0,
      };
      entry.titles += 1;
      titleCounts.set(champion.entity.id, entry);
    }

    const resultSets = await Promise.all((await keys('results:')).map(get));
    const inRange = (row) => {
      if (!isRaceRow(row)) return false;
      const year = yearFromEventId(sessionEventId(row.sessionId));
      return Number.isInteger(year) && year >= range.fromYear && year <= range.toYear;
    };
    const relevantResultSets = resultSets.filter((set) => (set?.items || []).some(inRange));
    const wins = new Map();
    for (const row of relevantResultSets.flatMap((set) => (set?.items || []).filter(inRange))) {
      if (!isRaceStart(row) || row.position !== 1 || !row.entry?.constructor?.id) continue;
      const constructor = row.entry.constructor;
      const entry = wins.get(constructor.id) || {
        id: constructor.id,
        name: constructor.displayName,
        wins: 0,
      };
      entry.wins += 1;
      wins.set(constructor.id, entry);
    }

    if (!standingsSets.length || !relevantResultSets.length)
      return this.result(
        {
          status: 'unavailable',
          message: `The archive does not publish both constructor wins and championship standings from ${range.fromYear} to ${range.toYear}.`,
          reasonCode: 'CONSTRUCTOR_RIVALRY_NOT_PUBLISHED',
        },
        [...standingsSets, ...relevantResultSets],
      );

    const stats = [...new Set([...wins.keys(), ...titleCounts.keys()])]
      .map((id) => {
        const winEntry = wins.get(id);
        const titleEntry = titleCounts.get(id);
        return {
          id,
          constructor: winEntry?.name || titleEntry?.name || 'Not supplied',
          wins: winEntry?.wins || 0,
          titles: titleEntry?.titles || 0,
        };
      })
      // A “world titles” rivalry must involve constructors that actually won a
      // title in the period; otherwise two low-volume teams with matching
      // zero-title totals would beat the championship contenders.
      .filter((entry) => entry.titles > 0);
    if (stats.length < 2)
      return this.result(
        {
          status: 'unavailable',
          message: `The archive does not publish enough championship-winning constructor data to compare rivals from ${range.fromYear} to ${range.toYear}.`,
          reasonCode: 'CONSTRUCTOR_RIVALRY_NOT_PUBLISHED',
        },
        [...standingsSets, ...relevantResultSets],
      );

    const maxWins = Math.max(1, ...stats.map((entry) => entry.wins));
    const maxTitles = Math.max(1, ...stats.map((entry) => entry.titles));
    const pairs = [];
    for (let leftIndex = 0; leftIndex < stats.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < stats.length; rightIndex += 1) {
        const left = stats[leftIndex];
        const right = stats[rightIndex];
        const winsGap = Math.abs(left.wins - right.wins);
        const titlesGap = Math.abs(left.titles - right.titles);
        pairs.push({
          left,
          right,
          winsGap,
          titlesGap,
          distance: winsGap / maxWins + titlesGap / maxTitles,
          combinedAchievement: left.wins + right.wins + left.titles + right.titles,
        });
      }
    }
    pairs.sort(
      (a, b) =>
        a.distance - b.distance ||
        b.combinedAchievement - a.combinedAchievement ||
        `${a.left.constructor}:${a.right.constructor}`.localeCompare(
          `${b.left.constructor}:${b.right.constructor}`,
        ),
    );
    const closest = pairs[0];
    const competitors = [closest.left, closest.right].sort((a, b) =>
      a.constructor.localeCompare(b.constructor),
    );
    const answer = `${competitors[0].constructor} and ${competitors[1].constructor} were the closest constructor rivals from ${range.fromYear} to ${range.toYear}, with ${competitors[0].wins} and ${competitors[1].wins} race wins and ${competitors[0].titles} and ${competitors[1].titles} constructors' titles respectively. Their gaps were ${closest.winsGap} race win${closest.winsGap === 1 ? '' : 's'} and ${closest.titlesGap} title${closest.titlesGap === 1 ? '' : 's'}.`;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'constructor_rivalry_comparison',
        templateKey: 'constructor_rivalry_comparison',
        values: {
          answer,
          metric: 'constructor_rivalry',
          competitors,
          comparison: {
            winsGap: closest.winsGap,
            titlesGap: closest.titlesGap,
          },
          fromYear: range.fromYear,
          toYear: range.toYear,
        },
        evidenceIds: unique([
          ...standingsSets.map((set) => set?.evidenceId),
          ...relevantResultSets.map((set) => set?.evidenceId),
        ]).slice(0, 24),
      },
      [...standingsSets, ...relevantResultSets],
    );
  }

  async driverFinishingPosition(intent, context, { get, keys }) {
    if (intent.invalid || !Number.isInteger(intent.position))
      return this.result(
        {
          status: 'unsupported',
          message: 'Specify one valid race finishing position, such as first, 2nd or position 5.',
          reasonCode: 'FINISHING_POSITION_INVALID',
        },
        [],
      );
    const range =
      intent.fromYear !== null && intent.fromYear !== undefined
        ? { fromYear: intent.fromYear, toYear: intent.toYear ?? intent.fromYear }
        : yearRange(intent.originalText || '', context);
    const resultSets = await Promise.all((await keys('results:')).map(get));
    const inRange = (row) => {
      if (!isRaceRow(row)) return false;
      const year = yearFromEventId(sessionEventId(row.sessionId));
      return (!range.fromYear || year >= range.fromYear) && (!range.toYear || year <= range.toYear);
    };
    const relevantSets = resultSets.filter((set) => (set?.items || []).some(inRange));
    const raceRows = relevantSets.flatMap((set) => (set?.items || []).filter(inRange));
    const positionedRows = raceRows.filter((row) => Number.isInteger(row.position));
    const evidenceSets = relevantSets.length ? relevantSets : resultSets;
    const unavailable = (message, reasonCode) =>
      this.result({ status: 'unavailable', message, reasonCode }, evidenceSets);

    if (!resultSets.length || !raceRows.length)
      return unavailable(
        'Published race-result positions are not available for the selected period.',
        'FINISHING_POSITION_RESULTS_NOT_PUBLISHED',
      );
    if (!positionedRows.length)
      return unavailable(
        'Published race results do not include usable finishing positions for the selected period.',
        'FINISHING_POSITION_DATA_NOT_PUBLISHED',
      );
    const positionRows = positionedRows.filter(
      (row) => isRaceStart(row) && row.position === intent.position,
    );
    if (!positionRows.length)
      return unavailable(
        `No published ${finishingPositionLabel(intent.position)} finishes are available for the selected period.`,
        'FINISHING_POSITION_NOT_PUBLISHED',
      );

    const counts = new Map();
    let unmappedRows = 0;
    for (const row of positionRows) {
      const driver = driverNames(row)[0];
      if (!driver?.id || !driver.displayName) {
        unmappedRows += 1;
        continue;
      }
      const entry = counts.get(driver.id) || { driver: driver.displayName, count: 0 };
      entry.count += 1;
      counts.set(driver.id, entry);
    }
    if (!counts.size)
      return unavailable(
        `Published ${finishingPositionLabel(intent.position)} finishes cannot be linked to a driver.`,
        'FINISHING_POSITION_DRIVER_MAPPING_UNAVAILABLE',
      );

    const highest = Math.max(...[...counts.values()].map((entry) => entry.count));
    const leaders = [...counts.values()]
      .filter((entry) => entry.count === highest)
      .sort((a, b) => a.driver.localeCompare(b.driver));
    const leaderNames = leaders.map((entry) => entry.driver);
    const period = range.fromYear
      ? ` from ${range.fromYear}${range.toYear !== range.fromYear ? ` to ${range.toYear}` : ''}`
      : ' in the published archive';
    const coverage =
      raceRows.length !== positionedRows.length ||
      unmappedRows > 0 ||
      evidenceSets.some((set) => set?.coverage !== 'complete' || set?.warnings?.length)
        ? 'partial'
        : 'complete';
    const answer =
      leaders.length > 1
        ? `${humanList(leaderNames)} are tied for the most published ${finishingPositionLabel(intent.position)} finishes, with ${highest} each${period}.`
        : `${leaderNames[0]} has the most published ${finishingPositionLabel(intent.position)} finishes, with ${highest}${period}.`;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'driver_finishing_position',
        templateKey: 'driver_finishing_position',
        values: {
          answer,
          driver: humanList(leaderNames),
          drivers: humanList(leaderNames),
          count: highest,
          position: intent.position,
          positionLabel: finishingPositionLabel(intent.position),
          tied: leaders.length > 1,
          fromYear: range.fromYear,
          toYear: range.toYear,
          coverage,
          ...(coverage === 'partial'
            ? {
                coverageNote:
                  'The count uses published race-result rows only; some rows or finishing positions are incomplete.',
              }
            : {}),
          excludedRows: unmappedRows,
        },
        evidenceIds: unique(evidenceSets.map((set) => set?.evidenceId)).slice(0, 12),
      },
      evidenceSets,
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
          ...Array.from(matchingEvents.values(), (event) => event.evidenceId),
          ...sets.map((set) => set?.evidenceId),
        ]).slice(0, 12),
      },
      [...sets, ...resultSets],
    );
  }

  async driverConstructorCount(intent, context, { get, keys }) {
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
        : yearRange(intent.originalText || '', context);
    const resultKeys = (await keys('results:')).filter((key) => {
      const yearMatch = String(key).match(/:event:(\d{4}):/);
      if (!yearMatch) return true;
      const year = Number(yearMatch[1]);
      return (!range.fromYear || year >= range.fromYear) && (!range.toYear || year <= range.toYear);
    });
    const resultSets = await Promise.all(resultKeys.map(get));
    const constructors = new Map();
    for (const set of resultSets) {
      for (const row of set?.items || []) {
        if (
          !isRaceStart(row) ||
          !row.entry?.constructor?.id ||
          !row.entry.drivers?.some((entryDriver) => entryDriver.id === driver.id)
        )
          continue;
        const constructor = row.entry.constructor;
        constructors.set(constructor.id, constructor.displayName);
      }
    }
    const names = [...constructors.values()].sort((a, b) => a.localeCompare(b));
    const count = names.length;
    const period = range.fromYear
      ? ` from ${range.fromYear}${range.toYear !== range.fromYear ? ` to ${range.toYear}` : ''}`
      : '';
    const answer = count
      ? `Within the published archive${period || ' from 2000 onward'}, ${driver.entity.displayName} raced under ${count} constructor${count === 1 ? '' : 's'}: ${names.join(', ')}.`
      : `${driver.entity.displayName} has no published constructor participation${period}.`;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'driver_constructor_count',
        templateKey: 'driver_constructor_count',
        values: {
          answer,
          driver: driver.entity.displayName,
          driverId: driver.id,
          metric: 'constructors',
          constructors: names.join(', ') || 'None published',
          count,
          fromYear: range.fromYear,
          toYear: range.toYear,
        },
        evidenceIds: unique([
          ...resultSets.map((set) => set?.evidenceId),
          ...sets.map((set) => set?.evidenceId),
        ]).slice(0, 12),
      },
      [...sets, ...resultSets],
    );
  }

  async driverConstructorBreakdown(intent, context, { get, keys }) {
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
        : yearRange(intent.originalText || '', context);
    const resultKeys = (await keys('results:')).filter((key) => {
      const yearMatch = String(key).match(/:event:(\d{4}):/);
      if (!yearMatch) return true;
      const year = Number(yearMatch[1]);
      return (!range.fromYear || year >= range.fromYear) && (!range.toYear || year <= range.toYear);
    });
    const resultSets = await Promise.all(resultKeys.map(get));
    const stats = this.collectDriverConstructorStats(driver.id, resultSets);
    const breakdown = [...stats.values()]
      .map((entry) => ({
        constructor: entry.name,
        raceStarts: entry.events.size,
        wins: entry.wins,
        podiums: entry.podiums,
        points: entry.pointsAvailable ? entry.points : null,
      }))
      .sort((a, b) => a.constructor.localeCompare(b.constructor));
    const period = range.fromYear
      ? ` from ${range.fromYear}${range.toYear !== range.fromYear ? ` to ${range.toYear}` : ''}`
      : ' from 2000 onward';
    const answer = breakdown.length
      ? `Within the published archive${period}, ${driver.entity.displayName} made ${humanList(
          breakdown.map(
            (entry) =>
              `${entry.raceStarts} race start${entry.raceStarts === 1 ? '' : 's'} for ${entry.constructor}`,
          ),
        )}.`
      : `${driver.entity.displayName} has no published constructor participation${period}.`;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'driver_constructor_breakdown',
        templateKey: 'driver_constructor_breakdown',
        values: {
          answer,
          driver: driver.entity.displayName,
          driverId: driver.id,
          metric: 'race_starts_by_constructor',
          breakdown,
          fromYear: range.fromYear,
          toYear: range.toYear,
        },
        evidenceIds: unique([
          ...resultSets.map((set) => set?.evidenceId),
          ...sets.map((set) => set?.evidenceId),
        ]).slice(0, 12),
      },
      [...sets, ...resultSets],
    );
  }

  async driverConstructorComparison(intent, context, { get, keys }) {
    const { sets, items } = await this.profiles({ get, keys });
    const driver = context.driverId
      ? items.find((profile) => profile.id === context.driverId)
      : this.findProfile(items, 'driver', intent.driverName);
    const constructorNames = unique(intent.constructorNames || []);
    const constructors = constructorNames
      .map((name) => this.findProfile(items, 'constructor', name))
      .filter(Boolean);
    if (!driver || constructors.length < 2)
      return this.result(
        {
          status: 'clarification',
          message: !driver
            ? 'Which driver do you mean?'
            : 'Please identify the two constructors to compare.',
          choices: [],
        },
        sets,
      );

    const range =
      intent.fromYear !== null && intent.fromYear !== undefined
        ? { fromYear: intent.fromYear, toYear: intent.toYear ?? intent.fromYear }
        : yearRange(intent.originalText || '', context);
    const resultKeys = (await keys('results:')).filter((key) => {
      const yearMatch = String(key).match(/:event:(\d{4}):/);
      if (!yearMatch) return true;
      const year = Number(yearMatch[1]);
      return (!range.fromYear || year >= range.fromYear) && (!range.toYear || year <= range.toYear);
    });
    const resultSets = await Promise.all(resultKeys.map(get));
    const allStats = this.collectDriverConstructorStats(driver.id, resultSets);
    const comparisons = constructors.map((constructor) => {
      const entry = allStats.get(constructor.id) || {
        name: constructor.entity.displayName,
        events: new Set(),
        wins: 0,
        podiums: 0,
        points: 0,
        pointsAvailable: false,
      };
      return {
        constructor: entry.name,
        constructorId: constructor.id,
        raceStarts: entry.events.size,
        wins: entry.wins,
        podiums: entry.podiums,
        points: entry.pointsAvailable ? entry.points : null,
      };
    });
    const period = range.fromYear
      ? ` from ${range.fromYear}${range.toYear !== range.fromYear ? ` to ${range.toYear}` : ''}`
      : ' from 2000 onward';
    const lines = comparisons.map((entry) => {
      const points = entry.points === null ? 'points not published' : `${entry.points} points`;
      return `${entry.constructor}: ${entry.raceStarts} race starts, ${entry.wins} win${entry.wins === 1 ? '' : 's'}, ${entry.podiums} podium${entry.podiums === 1 ? '' : 's'}, ${points}`;
    });
    const answer = `Within the published archive${period}, ${driver.entity.displayName}'s race results compare as follows: ${lines.join('; ')}.`;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'driver_constructor_comparison',
        templateKey: 'driver_constructor_comparison',
        values: {
          answer,
          driver: driver.entity.displayName,
          driverId: driver.id,
          metric: 'race_statistics',
          comparisons,
          fromYear: range.fromYear,
          toYear: range.toYear,
        },
        evidenceIds: unique([
          ...resultSets.map((set) => set?.evidenceId),
          ...sets.map((set) => set?.evidenceId),
        ]).slice(0, 12),
      },
      [...sets, ...resultSets],
    );
  }

  collectDriverConstructorStats(driverId, resultSets) {
    const stats = new Map();
    for (const set of resultSets) {
      for (const row of set?.items || []) {
        if (
          !isRaceStart(row) ||
          !row.entry?.constructor?.id ||
          !row.entry.drivers?.some((entryDriver) => entryDriver.id === driverId)
        )
          continue;
        const constructor = row.entry.constructor;
        const eventId = sessionEventId(row.sessionId);
        if (!eventId) continue;
        if (!stats.has(constructor.id))
          stats.set(constructor.id, {
            name: constructor.displayName,
            events: new Set(),
            wins: 0,
            podiums: 0,
            points: 0,
            pointsAvailable: false,
          });
        const entry = stats.get(constructor.id);
        if (entry.events.has(eventId)) continue;
        entry.events.add(eventId);
        if (row.position === 1) entry.wins += 1;
        if (row.position >= 1 && row.position <= 3) entry.podiums += 1;
        if (row.points !== null && row.points !== undefined && row.points !== '') {
          const points = Number(row.points);
          if (Number.isFinite(points)) {
            entry.points += points;
            entry.pointsAvailable = true;
          }
        }
      }
    }
    return stats;
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
          latest.resultSet.evidenceId,
          latest.detail.evidenceId,
          ...sets.map((set) => set?.evidenceId),
        ]).slice(0, 12),
      },
      [...sets, ...resultSets, ...details],
    );
  }

  async driverRaceBoundary(intent, { get, keys }, direction = 'last') {
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
    const races = [];
    for (const set of resultSets) {
      for (const row of set?.items || []) {
        if (
          !isRaceStart(row) ||
          !row.entry?.drivers?.some((entryDriver) => entryDriver.id === driver.id)
        )
          continue;
        const eventId = sessionEventId(row.sessionId);
        if (eventId) races.push({ eventId, row, resultSet: set });
      }
    }
    const details = await Promise.all(
      [...new Set(races.map((race) => race.eventId))].map((eventId) => get(`event:${eventId}`)),
    );
    const detailsByEvent = new Map(
      details
        .map((set) => [set?.items?.[0]?.event?.id, { detail: set, event: set?.items?.[0]?.event }])
        .filter(([eventId, value]) => eventId && value.event),
    );
    const datedRaces = races
      .map((race) => ({ ...race, ...detailsByEvent.get(race.eventId) }))
      .filter((race) => race.event)
      .sort((a, b) => {
        const aDate = Date.parse(a.event.schedule?.startsAt || a.event.schedule?.date || '') || 0;
        const bDate = Date.parse(b.event.schedule?.startsAt || b.event.schedule?.date || '') || 0;
        return (
          (direction === 'first' ? aDate - bDate : bDate - aDate) ||
          (direction === 'first' ? 1 : -1) * ((a.event.round || 0) - (b.event.round || 0))
        );
      });
    const selected = datedRaces[0];
    const label = direction === 'first' ? 'first' : 'last';
    if (!selected)
      return this.result(
        {
          status: 'unavailable',
          message: `No published race was found for ${driver.entity.displayName}.`,
          reasonCode: 'DRIVER_RACE_NOT_PUBLISHED',
        },
        [...sets, ...resultSets, ...details],
      );
    const event = selected.event;
    const date = event.schedule?.date || null;
    const constructor = selected.row.entry?.constructor?.displayName || null;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: direction === 'first' ? 'driver_first_race' : 'driver_last_race',
        templateKey: direction === 'first' ? 'driver_first_race' : 'driver_last_race',
        values: {
          answer: `${driver.entity.displayName}'s ${label} published race was the ${event.name} on ${formatDate(date) || event.year}.`,
          driver: driver.entity.displayName,
          constructor,
          event: event.name,
          year: event.year,
          date,
          round: event.round,
          circuit: event.circuit?.displayName || null,
          scope: 'published archive',
        },
        evidenceIds: unique([
          selected.resultSet.evidenceId,
          selected.detail.evidenceId,
          ...sets.map((set) => set?.evidenceId),
        ]).slice(0, 12),
      },
      [...sets, ...resultSets, ...details],
    );
  }

  async driverWinBoundary(intent, { get, keys }, direction = 'first') {
    if (direction === 'last') return this.driverLastWin(intent, {}, { get, keys });
    const { sets, items } = await this.profiles({ get, keys });
    const driver = this.findProfile(items, 'driver', intent.driverName);
    if (!driver)
      return this.result(
        { status: 'clarification', message: 'Which driver do you mean?', choices: [] },
        sets,
      );
    const resultSets = await Promise.all((await keys('results:')).map(get));
    const wins = [];
    for (const set of resultSets) {
      for (const row of set?.items || []) {
        if (
          !isRaceStart(row) ||
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
        const aDate = Date.parse(a.event.schedule?.startsAt || a.event.schedule?.date || '') || 0;
        const bDate = Date.parse(b.event.schedule?.startsAt || b.event.schedule?.date || '') || 0;
        return aDate - bDate || (a.event.round || 0) - (b.event.round || 0);
      });
    const selected = datedWins[0];
    if (!selected)
      return this.result(
        {
          status: 'unavailable',
          message: `No published race win was found for ${driver.entity.displayName}.`,
          reasonCode: 'DRIVER_WIN_NOT_PUBLISHED',
        },
        [...sets, ...resultSets, ...details],
      );
    const event = selected.event;
    const date = event.schedule?.date || null;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'driver_first_win',
        templateKey: 'driver_first_win',
        values: {
          answer: `${driver.entity.displayName}'s first published win was the ${event.name} on ${formatDate(date) || event.year}.`,
          driver: driver.entity.displayName,
          event: event.name,
          year: event.year,
          date,
          round: event.round,
          circuit: event.circuit?.displayName || null,
        },
        evidenceIds: unique([
          selected.resultSet.evidenceId,
          selected.detail.evidenceId,
          ...sets.map((set) => set?.evidenceId),
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

  async driverRaceWinsSeason(intent, context, { get, keys }) {
    const { sets, items } = await this.profiles({ get, keys });
    const driver = context.driverId
      ? items.find((profile) => profile.id === context.driverId)
      : this.findProfile(items, 'driver', intent.driverName);
    if (!driver)
      return this.result(
        {
          status: 'clarification',
          message: 'Which driver do you mean?',
          choices: [],
        },
        sets,
      );

    const season = Number(intent.fromYear ?? intent.toYear);
    const resultSets = await Promise.all((await keys('results:')).map(get));
    const inSeason = (row) =>
      isRaceRow(row) && yearFromEventId(sessionEventId(row.sessionId)) === season;
    const relevantSets = resultSets.filter((set) => (set?.items || []).some(inSeason));
    const raceRows = relevantSets.flatMap((set) => (set?.items || []).filter(inSeason));
    const evidenceSets = relevantSets.length ? relevantSets : resultSets;
    if (!resultSets.length || !raceRows.length)
      return this.result(
        {
          status: 'unavailable',
          message: `Published race results are not available for ${season}.`,
          reasonCode: 'DRIVER_RACE_WINS_SEASON_NOT_PUBLISHED',
        },
        [...sets, ...evidenceSets],
      );

    const wins = raceRows.filter(
      (row) =>
        isRaceStart(row) &&
        row.position === 1 &&
        driverNames(row).some((entryDriver) => entryDriver.id === driver.id),
    );
    const coverage = evidenceSets.some(
      (set) => set?.coverage !== 'complete' || set?.warnings?.length,
    )
      ? 'partial'
      : 'complete';
    const count = wins.length;
    return this.result(
      {
        status: 'answered',
        resolvedIntent: 'driver_race_wins_season',
        templateKey: 'driver_race_wins_season',
        values: {
          answer: `${driver.entity.displayName} won ${count} race${count === 1 ? '' : 's'} in ${season}.`,
          driver: driver.entity.displayName,
          metric: 'race_wins',
          season,
          count,
          fromYear: season,
          toYear: season,
          coverage,
          ...(coverage === 'partial'
            ? {
                coverageNote:
                  'The count uses published race-result rows from the selected season only.',
              }
            : {}),
        },
        evidenceIds: unique([
          ...evidenceSets.map((set) => set?.evidenceId),
          ...sets.map((set) => set?.evidenceId),
        ]).slice(0, 12),
      },
      [...sets, ...evidenceSets],
    );
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
          ...Array.from(winsByEvent.values(), (set) => set?.evidenceId),
          ...details.map((set) => set?.evidenceId),
          ...sets.map((set) => set?.evidenceId),
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
          ...Array.from(driverWins.values(), (set) => set?.evidenceId),
          ...Array.from(comparisonWins.values(), (set) => set?.evidenceId),
          ...sets.map((set) => set?.evidenceId),
        ]).slice(0, 12),
      },
      [...sets, ...resultSets],
    );
  }

  result(questionResult, sets) {
    const available = sets.filter(Boolean);
    const first = available[0];
    const suggestion =
      questionResult.suggestion || fallbackSuggestion(questionResult);
    return {
      result: suggestion ? { ...questionResult, suggestion } : questionResult,
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
