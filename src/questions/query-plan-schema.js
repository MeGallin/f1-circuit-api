import Ajv from 'ajv';
import { capabilities } from './capability-registry.js';

const string = { anyOf: [{ type: 'string', minLength: 1, maxLength: 300 }, { type: 'null' }] };
const integer = (minimum, maximum) => ({
  anyOf: [{ type: 'integer', minimum, maximum }, { type: 'null' }],
});
const enumeration = (values) => ({ anyOf: [{ type: 'string', enum: values }, { type: 'null' }] });
const properties = {
  intent: { type: 'string', enum: Object.keys(capabilities) },
  driverName: string,
  comparisonDriverName: string,
  constructorName: string,
  constructorNames: {
    type: 'array',
    maxItems: 2,
    items: { type: 'string', minLength: 1, maxLength: 160 },
  },
  eventName: string,
  circuitName: string,
  countryName: string,
  scope: enumeration(['event', 'circuit', 'country', 'season', 'career', 'unknown']),
  sessionKind: enumeration(['race', 'qualifying', 'sprint', 'practice', 'weekend']),
  fromYear: integer(1950, 2100),
  toYear: integer(1950, 2100),
  comparisonFromYear: integer(1950, 2100),
  comparisonToYear: integer(1950, 2100),
  limit: integer(1, 10),
  position: integer(1, 99),
  metric: enumeration([...new Set(Object.values(capabilities).flatMap((entry) => entry.metrics))]),
  clarificationNeeded: { type: 'boolean' },
  clarificationMessage: string,
  suggestion: string,
};
export const questionIntentSchema = {
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
};
const validate = new Ajv({ allErrors: true }).compile(questionIntentSchema);
export const emptyPlan = () =>
  Object.fromEntries(
    Object.keys(properties).map((key) => [
      key,
      key === 'constructorNames' ? [] : key === 'clarificationNeeded' ? false : null,
    ]),
  );

export function validatePlan(input) {
  const plan = { ...emptyPlan(), ...input };
  if (!validate(plan))
    return {
      valid: false,
      reasonCode: 'QUESTION_PLAN_INVALID',
      message: 'The question plan contains an invalid or unsupported constraint.',
    };
  const capability = capabilities[plan.intent];
  if (
    plan.intent === 'event_session_metric' &&
    (plan.driverName || plan.comparisonDriverName) &&
    (plan.circuitName ||
      plan.scope === 'circuit' ||
      ['weather_summary', 'rainfall', 'temperatures'].includes(plan.metric))
  )
    return {
      valid: false,
      reasonCode: 'QUESTION_PLAN_ENTITY_FILTER_UNSUPPORTED',
      message: 'This session aggregation cannot preserve a driver filter or comparison.',
    };
  if (
    ['driver_stat', 'event_session_metric', 'event_pit_stops'].includes(plan.intent) &&
    plan.metric === null
  )
    return {
      valid: false,
      reasonCode: 'QUESTION_PLAN_METRIC_REQUIRED',
      message: 'Specify which published metric you want; no default statistic was substituted.',
    };
  if (
    plan.intent === 'event_session_metric' &&
    (plan.scope === 'circuit' || plan.circuitName) &&
    !['weather_summary', 'rainfall', 'temperatures'].includes(plan.metric)
  )
    return {
      valid: false,
      reasonCode: 'QUESTION_PLAN_CIRCUIT_METRIC_UNSUPPORTED',
      message:
        'Circuit-wide session aggregation currently supports weather, rainfall and temperatures only.',
    };
  for (const field of [
    'driverName',
    'comparisonDriverName',
    'constructorName',
    'constructorNames',
    'eventName',
    'circuitName',
    'countryName',
  ])
    if (
      (Array.isArray(plan[field]) ? plan[field].length : plan[field]) &&
      !capability.allowedEntities.includes(field)
    )
      return {
        valid: false,
        reasonCode: 'QUESTION_PLAN_ENTITY_FILTER_UNSUPPORTED',
        message: `This operation cannot preserve the ${field} constraint.`,
      };
  for (const field of ['limit', 'position', 'comparisonFromYear', 'comparisonToYear'])
    if (plan[field] !== null && !capability.filters.includes(field))
      return {
        valid: false,
        reasonCode: 'QUESTION_PLAN_FILTER_UNSUPPORTED',
        message: `This operation cannot preserve the ${field} filter.`,
      };
  for (const [from, to] of [
    ['fromYear', 'toYear'],
    ['comparisonFromYear', 'comparisonToYear'],
  ]) {
    if (plan[from] !== null && plan[to] !== null && plan[from] > plan[to])
      return {
        valid: false,
        reasonCode: 'QUESTION_PLAN_PERIOD_INVALID',
        message: 'The beginning of a period must not follow its end.',
      };
    if (plan[from] === null && plan[to] !== null) plan[from] = plan[to];
    if (plan[to] === null && plan[from] !== null) plan[to] = plan[from];
  }
  if (plan.metric && !capability.metrics.includes(plan.metric))
    return {
      valid: false,
      reasonCode: 'QUESTION_PLAN_METRIC_UNSUPPORTED',
      message: 'This operation does not support the requested metric.',
    };
  if (plan.sessionKind && !capability.sessions.includes(plan.sessionKind))
    return {
      valid: false,
      reasonCode: 'QUESTION_SESSION_UNSUPPORTED',
      message: `This operation supports ${capability.sessions.join(', ') || 'no'} sessions; the requested session was not substituted.`,
    };
  if (plan.scope && plan.scope !== 'unknown' && !capability.scopes.includes(plan.scope))
    return {
      valid: false,
      reasonCode: 'QUESTION_PLAN_SCOPE_UNSUPPORTED',
      message: 'This operation does not support the requested scope.',
    };
  if (
    plan.intent.startsWith('event_') &&
    plan.intent !== 'event_session_metric' &&
    plan.fromYear !== plan.toYear
  )
    return {
      valid: false,
      reasonCode: 'QUESTION_PLAN_PERIOD_UNSUPPORTED',
      message: 'Choose one season for this single-event question.',
    };
  if (
    plan.intent === 'event_session_metric' &&
    !plan.circuitName &&
    (plan.fromYear !== plan.toYear || plan.comparisonFromYear !== null)
  )
    return {
      valid: false,
      reasonCode: 'QUESTION_PLAN_PERIOD_UNSUPPORTED',
      message: 'Separate periods require a circuit-scoped session metric.',
    };
  if (
    (plan.comparisonFromYear !== null || plan.comparisonToYear !== null) &&
    plan.intent !== 'event_session_metric'
  )
    return {
      valid: false,
      reasonCode: 'QUESTION_PLAN_COMPARISON_UNSUPPORTED',
      message: 'Separate comparison periods are not supported for this operation.',
    };
  return { valid: true, plan, capability };
}
