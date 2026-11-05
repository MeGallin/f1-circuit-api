import { capabilities } from './capability-registry.js';
import { validatePlan } from './query-plan-schema.js';
import { questionPeriod, normalizeQuestion } from './period.js';
import { matchingProfiles, resolveEntity } from './entity-resolver.js';
import { requestData, beforeDeadline } from './request-data.js';
import { canonicalPlan } from './canonical-plan.js';
import { recordQuestionTrace } from '../observability/question-trace.js';

const emptyContext = {
  year: null,
  eventId: null,
  sessionId: null,
  driverId: null,
  constructorId: null,
};
const unsupported = (service, reasonCode, message) =>
  service.result({ status: 'unsupported', reasonCode, message }, []);
const clarification = (service, message, choices = []) =>
  service.result({ status: 'clarification', message, choices }, []);
const timed = async (stages, name, run, deadline) => {
  const start = Date.now();
  try {
    return await beforeDeadline(deadline, run);
  } catch (error) {
    stages.failedStage = name;
    throw error;
  } finally {
    stages[name] = Date.now() - start;
  }
};

export async function answerQuestion(service, body, source) {
  const start = Date.now();
  const deadline = start + 30000;
  const stage = (name, run) => timed(stages, name, run, deadline);
  const stages = {};
  let operation = null;
  let retrievalStatus = 'not-needed';
  let providerRequestId = null;
  let providerFailure = null;
  const resolutionDiagnostics = [];
  let outcome;
  const text = String(body?.text || '').trim();
  const now = new Date();
  const context = {
    ...emptyContext,
    ...body?.context,
    currentYear: now.getUTCFullYear(),
    currentDate: now.toISOString(),
    stateless: true,
  };
  const explicit = questionPeriod(text, context);
  if (explicit.inverted)
    return clarification(
      service,
      'The beginning of a period must not follow its end. Correct the year order.',
    );
  if (
    explicit.explicit &&
    context.year &&
    (context.year < explicit.fromYear || context.year > explicit.toYear)
  )
    return clarification(
      service,
      `The question requests ${explicit.fromYear}–${explicit.toYear}, but the optional year is ${context.year}. Clear or correct the optional year.`,
    );
  const period = explicit.explicit ? explicit : { fromYear: context.year, toYear: context.year };
  const helpers = requestData(service.repository, source.snapshot, source, period, deadline);
  const choicesFor = (kind, candidates, slot) =>
    candidates.map((profile) => ({
      label: profile.entity.displayName,
      context: slot
        ? {
            ...emptyContext,
            ...body?.context,
            entitySelections: { ...body?.context?.entitySelections, [slot]: profile.id },
          }
        : { ...emptyContext, ...body?.context, [`${kind}Id`]: profile.id },
    }));
  const finish = (result) => {
    outcome = result;
    return result;
  };
  try {
    if (
      /\b(last|latest|most recent)\s+race\b/i.test(text) &&
      /\bwho\s+won\b/i.test(text) &&
      !context.eventId
    ) {
      const calendars = await Promise.all((await helpers.keys('events:')).map(helpers.get));
      const completed = calendars
        .flatMap((set) => set?.items || [])
        .filter(
          (event) =>
            ['completed', 'finished'].includes(event.status) &&
            Date.parse(event.schedule?.startsAt || event.schedule?.date || '') <= now.valueOf(),
        )
        .sort(
          (a, b) =>
            Date.parse(b.schedule?.startsAt || b.schedule?.date) -
            Date.parse(a.schedule?.startsAt || a.schedule?.date),
        );
      if (completed[0]) {
        context.eventId = completed[0].id;
        context.latestEvent = {
          name: completed[0].name,
          year: completed[0].year,
          round: completed[0].round,
        };
      }
    }
    const { items: profiles } = await stage('entities', () => service.profiles(helpers));
    let canonicalText = text;
    if (!service.interpreter)
      for (const kind of ['driver', 'constructor']) {
        const matches = matchingProfiles(profiles, kind, text);
        if (!matches.length) continue;
        // Multiple fully named drivers/constructors are a comparison, not surname ambiguity.
        const fullNames = matches.filter((profile) =>
          normalizeQuestion(text).includes(normalizeQuestion(profile.entity.displayName)),
        );
        if (fullNames.length === matches.length && matches.length > 1) continue;
        const resolved = await beforeDeadline(deadline, () =>
          resolveEntity({
            profiles,
            kind,
            name: matches.length === 1 ? matches[0].entity.displayName : text,
            selectedId: context[`${kind}Id`],
            period,
            helpers,
            repository: service.repository,
            publicationId: source.snapshot?.id,
          }),
        );
        if (!resolved.profile)
          return finish(
            clarification(service, resolved.reason, choicesFor(kind, resolved.candidates)),
          );
        if (
          !normalizeQuestion(text).includes(normalizeQuestion(resolved.profile.entity.displayName))
        )
          canonicalText += ` ${resolved.profile.entity.displayName}`;
      }
    // Existing recognizers only propose a plan; they cannot execute or stop on a missing-name clarification.
    const proposal = Object.create(service);
    proposal.executeIntent = async (plan) => ({ proposedPlan: plan });
    proposal.result = (result) => ({ proposedFailure: result });
    let proposed = service.interpreter
      ? null
      : await stage('fastPlan', async () => {
          const plan = canonicalPlan(canonicalText, profiles, period);
          return plan
            ? { proposedPlan: plan }
            : proposal.interpretDeterministically(canonicalText, context, helpers);
        });
    let input = proposed?.proposedPlan;
    if (!input && proposed?.proposedFailure && !service.interpreter)
      return finish(service.result(proposed.proposedFailure, []));
    if (input?.invalid)
      return finish(
        unsupported(
          service,
          'FINISHING_POSITION_INVALID',
          'Specify one valid race finishing position.',
        ),
      );
    if (input) {
      input = { ...input };
      delete input.originalText;
      delete input.invalid;
    }
    if (!input) {
      if (!service.interpreter)
        return finish(
          service.result(
            {
              status: 'unavailable',
              reasonCode: 'QUESTION_INTERPRETER_DISABLED',
              message:
                'This wording requires the optional question planner. Ask one complete question with a published entity and metric.',
            },
            [],
          ),
        );
      const retrieval = await stage('retrieval', () =>
        service.retrieveContext(text, source.snapshot?.id, { ...period }, deadline),
      );
      retrievalStatus = retrieval.status;
      const calendar = await helpers.get(`events:${period.fromYear || context.currentYear}`);
      const events = (calendar?.items || [])
        .filter((event) => ['completed', 'finished'].includes(event.status))
        .sort((a, b) => (b.round || 0) - (a.round || 0));
      context.archiveContext = {
        retrievalStatus,
        publicationId: source.snapshot?.id,
        coverage: calendar?.coverage || 'unavailable',
        latestEvent: events[0]
          ? {
              name: events[0].name,
              year: events[0].year,
              round: events[0].round,
              schedule: events[0].schedule,
            }
          : null,
      };
      input = await stage('planner', () =>
        service.interpreter.interpret({
          text,
          context,
          candidates: retrieval.candidates,
          deadline,
        }),
      );
      providerRequestId = input?.providerRequestId || null;
    }
    const session = context.sessionId?.split(':').at(-1);
    const explicitSession = /\bsprint\b/i.test(text)
      ? 'sprint'
      : /\bqualifying\b/i.test(text)
        ? 'qualifying'
        : /\bpractice\b/i.test(text)
          ? 'practice'
          : null;
    const separatePeriods = input.comparisonFromYear != null || input.comparisonToYear != null;
    if (explicit.disjoint && !separatePeriods)
      return finish(
        unsupported(
          service,
          'QUESTION_PERIOD_SET_UNSUPPORTED',
          'Separate non-contiguous years are not supported by this operation. Request one year or an explicit inclusive range.',
        ),
      );
    input = {
      ...input,
      fromYear: separatePeriods
        ? input.fromYear
        : (explicit.fromYear ?? input.fromYear ?? period.fromYear),
      toYear: separatePeriods ? input.toYear : (explicit.toYear ?? input.toYear ?? period.toYear),
      sessionKind: explicitSession || input.sessionKind || session || null,
    };
    if (explicitSession && session && explicitSession !== session)
      return finish(
        clarification(
          service,
          'The requested session conflicts with the optional selected session. Clear or correct the optional selection.',
        ),
      );
    if (input.intent === 'event_pole' && !explicitSession && !session)
      input.sessionKind = 'qualifying';
    const checked = validatePlan(input);
    if (!checked.valid) return finish(unsupported(service, checked.reasonCode, checked.message));
    const plan = checked.plan;
    helpers.setPeriod({
      fromYear:
        plan.comparisonFromYear !== null
          ? Math.min(plan.fromYear ?? plan.comparisonFromYear, plan.comparisonFromYear)
          : plan.fromYear,
      toYear:
        plan.comparisonToYear !== null
          ? Math.max(plan.toYear ?? plan.comparisonToYear, plan.comparisonToYear)
          : plan.toYear,
    });
    operation = plan.intent;
    const namedConstructors = matchingProfiles(profiles, 'constructor', text);
    if (
      namedConstructors.length &&
      plan.intent.startsWith('driver_') &&
      !plan.intent.startsWith('driver_constructor') &&
      !plan.constructorName
    )
      return finish(
        unsupported(
          service,
          'QUESTION_FILTER_UNSUPPORTED',
          'This driver operation cannot preserve a constructor filter. Ask for a driver-constructor comparison or starts metric.',
        ),
      );

    const entityFields = [
      ...new Set([
        ...capabilities[plan.intent].entities,
        ...capabilities[plan.intent].allowedEntities.filter(
          (field) => plan[field] && field !== 'eventName',
        ),
      ]),
    ];
    for (const field of entityFields) {
      if (field === 'countryName') {
        if (!plan[field]) return finish(clarification(service, 'Which country do you mean?'));
        continue;
      }
      const kind = field.toLowerCase().includes('constructor')
        ? 'constructor'
        : field === 'circuitName'
          ? 'circuit'
          : 'driver';
      const wasMissing = !plan[field];
      if (wasMissing && field !== 'constructorNames' && !field.startsWith('comparison')) {
        const sameKindSlots = capabilities[plan.intent].entities.filter((entry) =>
          entry.toLowerCase().includes(kind),
        );
        if (sameKindSlots.length === 1) plan[field] = text;
      }
      const names = field === 'constructorNames' ? plan[field] : [plan[field]];
      const resolvedNames = [];
      for (const [index, name] of names.entries()) {
        const slot = field === 'constructorNames' ? `constructor${index}` : field;
        const selectedId =
          context.entitySelections?.[slot] ||
          (field.startsWith('comparison') || field === 'constructorNames'
            ? null
            : context[`${kind}Id`]);
        const resolved = await beforeDeadline(deadline, () =>
          resolveEntity({
            profiles,
            kind,
            name,
            selectedId,
            period: { fromYear: plan.fromYear, toYear: plan.toYear },
            helpers,
            repository: service.repository,
            publicationId: source.snapshot?.id,
          }),
        );
        resolutionDiagnostics.push({
          slot,
          selectedId: selectedId || null,
          candidateIds: resolved.candidates?.map((profile) => profile.id) || [],
          resolvedId: resolved.profile?.id || null,
        });
        if (!resolved.profile)
          return finish(
            clarification(service, resolved.reason, choicesFor(kind, resolved.candidates, slot)),
          );
        resolvedNames.push(resolved.profile.entity.displayName);
      }
      if (field === 'constructorNames' && resolvedNames.length !== 2)
        return finish(clarification(service, 'Select two published constructors to compare.'));
      plan[field] = field === 'constructorNames' ? resolvedNames : resolvedNames[0];
      // Recover only an exclusively entity-related question. Resolving a name
      // cannot decide whether the user meant wins, titles or another metric.
      const entityQuestion = normalizeQuestion(plan.clarificationMessage);
      const entityNames = [
        kind,
        ...resolvedNames.flatMap((name) => [name, name.split(' ').at(-1)]),
      ];
      const asksOnlyEntity = entityNames.some((name) =>
        [
          `which ${normalizeQuestion(name)}`,
          `which ${normalizeQuestion(name)} do you mean`,
          `which published ${normalizeQuestion(name)} do you mean`,
        ].includes(entityQuestion),
      );
      if (resolvedNames.length && asksOnlyEntity) {
        plan.clarificationNeeded = false;
        plan.clarificationMessage = null;
      }
    }
    if (plan.clarificationNeeded)
      return finish(
        clarification(
          service,
          plan.clarificationMessage || 'Please specify the missing archive constraint.',
        ),
      );
    if (plan.constructorName && !capabilities[plan.intent].entities.includes('constructorName'))
      return finish(
        unsupported(
          service,
          'QUESTION_FILTER_UNSUPPORTED',
          'This operation cannot preserve a constructor filter. Request a driver-constructor comparison or a supported starts metric.',
        ),
      );
    if (plan.fromYear !== null) canonicalText += ` ${plan.fromYear} ${plan.toYear}`;
    plan.originalText = canonicalText;
    outcome = await stage('executor', () =>
      service.executeIntent(plan, context, helpers, canonicalText),
    );
    if (
      outcome.result.status !== 'answered' &&
      !(outcome.result.status === 'clarification' && outcome.result.choices?.length) &&
      plan.suggestion?.endsWith('?')
    ) {
      const years = [...text.matchAll(/\b(?:19\d{2}|20\d{2})\b/g)].map((match) => match[0]);
      const explicitNames = profiles
        .filter((profile) =>
          normalizeQuestion(text).includes(normalizeQuestion(profile.entity.displayName)),
        )
        .map((profile) => profile.entity.displayName);
      if (
        years.every((year) => plan.suggestion.includes(year)) &&
        explicitNames.every((name) =>
          normalizeQuestion(plan.suggestion).includes(normalizeQuestion(name)),
        )
      )
        outcome.result.suggestion = plan.suggestion;
    }
    return outcome;
  } catch (error) {
    providerFailure = {
      type: error.name,
      code: /^[A-Z0-9_]{1,48}$/.test(error.code || '') ? error.code : null,
      status: Number.isInteger(error.status) ? error.status : null,
    };
    const reasonCode =
      error.code === 'QUESTION_DEADLINE_EXCEEDED'
        ? error.code
        : stages.failedStage === 'planner'
          ? 'QUESTION_INTERPRETER_UNAVAILABLE'
          : 'QUESTION_EXECUTOR_UNAVAILABLE';
    return finish(
      service.result(
        {
          status: 'unavailable',
          reasonCode,
          message: 'The archive question could not be completed. Retry this complete question.',
        },
        [],
      ),
    );
  } finally {
    if (outcome)
      Object.defineProperty(outcome, 'diagnostics', {
        value: {
          requestId: source.requestId || null,
          providerRequestId,
          operation,
          retrievalStatus,
          stages: { ...stages },
          resolutions: resolutionDiagnostics,
          failure: providerFailure,
          durationMs: Date.now() - start,
        },
        enumerable: false,
      });
    if (service.questionTraceFile && source.requestId && outcome)
      recordQuestionTrace(
        {
          ...outcome.diagnostics,
          publicationId: source.snapshot?.id,
          status: outcome.result.status,
          reasonCode: outcome.result.reasonCode || null,
        },
        service.questionTraceFile,
      );
    service.logger?.info(
      {
        requestId: source.requestId || null,
        providerRequestId,
        publicationId: source.snapshot?.id,
        operation,
        entityIds: resolutionDiagnostics.map((entry) => entry.resolvedId).filter(Boolean),
        status: outcome?.result?.status || 'unavailable',
        reasonCode: outcome?.result?.reasonCode || null,
        retrievalStatus,
        stages,
        durationMs: Date.now() - start,
      },
      'question',
    );
  }
}
