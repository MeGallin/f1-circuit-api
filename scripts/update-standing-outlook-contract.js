// Narrow keyed/idempotent local extension; preserve unrelated contract differences.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const text = { type: 'string' };
const nil = { type: 'null' };
const signed = { type: 'string', pattern: '^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$' };
const nonnegative = { type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]+)?$' };
const positive = { type: 'string', pattern: '^([1-9][0-9]*(\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$' };
const countValue = { type: 'integer', minimum: 0, maximum: 64 };
const roundValue = { type: 'integer', minimum: 1, maximum: 64 };
const object = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const statusRule = (statuses, then, otherwise) => ({
  if: { properties: { status: { enum: statuses } }, required: ['status'] },
  then: { properties: then },
  ...(otherwise ? { else: { properties: otherwise } } : {}),
});
const event = object({
  eventId: text,
  name: text,
  round: roundValue,
  kind: { enum: ['race', 'sprint'] },
  date: { type: 'string', format: 'date' },
  maximum: positive,
});
const condition = {
  ...object({
    entityId: nullable(text),
    name: text,
    maximumPoints: nullable(nonnegative),
    finishAtOrBelow: nullable({ type: 'integer', minimum: 1, maximum: 10 }),
    tieResolution: nullable({ enum: ['wins-countback'] }),
  }),
  allOf: [
    {
      if: { properties: { maximumPoints: nil }, required: ['maximumPoints'] },
      then: { properties: { finishAtOrBelow: nil, tieResolution: nil } },
    },
  ],
};
const provenCondition = {
  type: 'object',
  properties: { maximumPoints: nonnegative },
};
const now = {
  ...object({
    status: { enum: ['secured', 'not-secured', 'tie-unresolved'] },
    method: nullable({ enum: ['strict-points', 'wins-countback'] }),
  }),
  allOf: [
    statusRule(
      ['secured'],
      { method: { enum: ['strict-points', 'wins-countback'] } },
      { method: nil },
    ),
  ],
};
const next = {
  ...object({
    status: { enum: ['possible', 'not-proven', 'no-opportunities'] },
    event: nullable(event),
    leaderGain: nullable(nonnegative),
    remainingAfter: nullable(nonnegative),
    conditions: { type: 'array', items: condition, maxItems: 256 },
    unlistedCondition: nullable(condition),
  }),
  allOf: [
    statusRule(
      ['no-opportunities'],
      {
        event: nil,
        leaderGain: nil,
        remainingAfter: nil,
        conditions: { maxItems: 0 },
        unlistedCondition: nil,
      },
      { event: { type: 'object' }, leaderGain: nonnegative, remainingAfter: nonnegative },
    ),
    statusRule(['possible'], {
      conditions: { items: provenCondition },
      unlistedCondition: nullable(provenCondition),
    }),
  ],
};
const path = (statuses, provenStatuses, extra) => ({
  ...object({
    status: { enum: statuses },
    event: nullable(event),
    leaderPoints: nullable(signed),
    strongestRivalCeiling: nullable(signed),
    ...extra,
  }),
  allOf: [
    statusRule(
      provenStatuses,
      { event: { type: 'object' }, leaderPoints: signed, strongestRivalCeiling: signed },
      { event: nil, leaderPoints: nil, strongestRivalCeiling: nil },
    ),
  ],
});
const earliest = path(
  ['possible', 'proven-path', 'already-secured', 'not-proven'],
  ['possible', 'proven-path'],
  { witness: text },
);
const winningPattern = path(
  ['guaranteed-path', 'already-secured', 'not-proven'],
  ['guaranteed-path'],
  { outcome: text },
);
const constantGap = {
  ...object({
    status: { enum: ['hypothetical'] },
    event: nullable(event),
    remainingAfter: nullable(nonnegative),
  }),
  allOf: [
    {
      if: { properties: { event: nil }, required: ['event'] },
      then: { properties: { remainingAfter: nil } },
      else: { properties: { remainingAfter: nonnegative } },
    },
  ],
};
const scenarioFields = { now, next, earliest, constantGap, winningPattern };
const scenarios = {
  ...object({
    snapshotId: text,
    standingSnapshotId: nullable(text),
    coverage: { enum: ['conditional', 'unavailable'] },
    reasonCode: nullable(text),
    ...Object.fromEntries(
      Object.entries(scenarioFields).map(([key, value]) => [key, nullable(value)]),
    ),
  }),
  allOf: [
    {
      if: { properties: { coverage: { const: 'conditional' } }, required: ['coverage'] },
      // Base properties already validate each full child shape; here only exclude null.
      then: {
        properties: {
          ...Object.fromEntries(
            Object.keys(scenarioFields).map((key) => [key, { type: 'object' }]),
          ),
          reasonCode: nil,
        },
      },
      else: {
        properties: {
          ...Object.fromEntries(Object.keys(scenarioFields).map((key) => [key, nil])),
          reasonCode: { type: 'string', minLength: 1 },
        },
      },
    },
    ...['earliest', 'winningPattern'].map((key) => ({
      if: {
        properties: {
          [key]: {
            type: 'object',
            properties: { status: { const: 'already-secured' } },
            required: ['status'],
          },
        },
        required: [key],
      },
      then: { properties: { now: { properties: { status: { const: 'secured' } } } } },
    })),
  ],
};
const properties = {
  year: { type: 'integer', minimum: 1950 },
  round: nullable(roundValue),
  snapshotId: text,
  standingSnapshotId: nullable(text),
  coverage: { type: 'string', enum: ['conditional', 'unavailable'] },
  reasonCode: nullable(text),
  leaderId: nullable(text),
  leaderName: nullable(text),
  remainingMaximum: nullable(nonnegative),
  sufficientAdditional: nullable(nonnegative),
  rivalCeiling: nullable(signed),
  targetWithinAvailablePoints: nullable({ type: 'boolean' }),
  remainingRaces: nullable(countValue),
  remainingSprints: nullable(countValue),
  ruleVersion: nullable(text),
  sourceUrls: { type: 'array', items: { type: 'string', format: 'uri', pattern: '^https://' } },
  assumptions: { type: 'array', items: text },
  scenarios: nullable(scenarios),
};
const schema = {
  type: 'object',
  properties,
  required: Object.keys(properties).filter((key) => key !== 'scenarios'),
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { coverage: { const: 'conditional' } }, required: ['coverage'] },
      then: {
        properties: {
          round: roundValue,
          standingSnapshotId: text,
          leaderId: text,
          leaderName: text,
          remainingMaximum: nonnegative,
          sufficientAdditional: nonnegative,
          rivalCeiling: signed,
          remainingRaces: countValue,
          remainingSprints: countValue,
          ruleVersion: text,
          targetWithinAvailablePoints: { type: 'boolean' },
          reasonCode: nil,
        },
      },
      else: {
        properties: {
          scenarios: nullable({
            type: 'object',
            properties: { coverage: { const: 'unavailable' } },
          }),
        },
      },
    },
  ],
  description:
    'Leader-only conditional sufficient target, not the exact minimum; its one-point safety margin does not resolve countback. Trusts published unique ranks1/2 to bound lower rivals. Approved season rules and affirmative sprint/no-sprint evidence required; unavailable never zero. Oversized target does not mean elimination or inability to secure title. Optional bounded scenarios may prove race-wins-only countback dominance; equal wins and later stages remain unresolved. Pattern rival ceilings are independent upper bounds, not simultaneous finishing allocations.',
};
for (const file of [
  new URL('../docs/openapi.json', import.meta.url),
  new URL('../../client/contracts/openapi.json', import.meta.url),
]) {
  const contract = JSON.parse(readFileSync(file, 'utf8'));
  contract.components.schemas.StandingTitleOutlook = schema;
  contract.components.schemas.Standing.properties.gapToLeader = nullable(nonnegative);
  contract.components.schemas.Standing.properties.gapCoverage = nullable({
    type: 'string',
    enum: ['complete', 'partial', 'unavailable'],
  });
  contract.components.schemas.getStandingsResponse.properties.data.properties.titleOutlook =
    nullable({ $ref: '#/components/schemas/StandingTitleOutlook' });
  const content = JSON.stringify(contract, null, 2) + '\n';
  writeFileSync(file, content);
  if (file.pathname.includes('/api/')) {
    const manifestFile = new URL('../docs/contract-manifest.json', import.meta.url);
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    writeFileSync(
      manifestFile,
      JSON.stringify(
        {
          ...manifest,
          openapiSha256: createHash('sha256').update(content).digest('hex'),
          schemas: Object.keys(contract.components.schemas).length,
        },
        null,
        2,
      ) + '\n',
    );
  }
}
