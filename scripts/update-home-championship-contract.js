// Keyed, idempotent contract extension. No repository or live reads.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('../docs/', import.meta.url);
const file = new URL('openapi.json', root);
const contract = JSON.parse(readFileSync(file, 'utf8'));
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const text = { type: 'string' };
const integer = { type: 'integer', minimum: 1 };
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const decimal = nullable({
  type: 'string',
  pattern: '^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$',
  description: 'Exact published/derived decimal, including legitimate negative points.',
});
const array = (schema) => ({ type: 'array', items: schema });
const object = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const coverage = { type: 'string', enum: ['complete', 'partial', 'unavailable'] };
Object.assign(contract.components.schemas, {
  HomeGraphicsRound: object({ round: integer, eventId: text, name: text }),
  HomeDriverChaseRound: object({
    round: integer,
    points: decimal,
    gap: decimal,
    rank: nullable(integer),
    leaderId: nullable(text),
    leaderName: nullable(text),
    leaderPoints: decimal,
    coverage,
    racePoints: decimal,
    raceCoverage: coverage,
  }),
  HomeDriverChaseSeries: object({
    entityId: text,
    name: text,
    rounds: array(ref('HomeDriverChaseRound')),
  }),
  HomeConstructorChaseRound: object({
    round: integer,
    points: decimal,
    gap: decimal,
    rank: nullable(integer),
    leaderId: nullable(text),
    leaderName: nullable(text),
    leaderPoints: decimal,
    coverage,
  }),
  HomeConstructorChaseSeries: object({
    entityId: text,
    name: text,
    rounds: array(ref('HomeConstructorChaseRound')),
  }),
  HomeChampionshipGraphics: object({
    year: { type: 'integer', minimum: 1950 },
    round: { ...integer, maximum: 64 },
    snapshotId: text,
    standingSnapshotId: text,
    rounds: { ...array(ref('HomeGraphicsRound')), maxItems: 64 },
    drivers: { ...array(ref('HomeDriverChaseSeries')), maxItems: 3 },
    constructors: { ...array(ref('HomeConstructorChaseSeries')), maxItems: 3 },
  }),
  getHomeChampionshipGraphicsResponse: object({
    data: object({ championshipGraphics: ref('HomeChampionshipGraphics') }),
    meta: ref('Meta'),
  }),
});
// These Home-only schemas have no other consumers; remove the superseded mosaic.
for (const key of [
  'HomeClassificationContribution',
  'HomeConstructorContributionRound',
  'HomeConstructorContributionSeries',
]) {
  delete contract.components.schemas[key];
}
const base = contract.paths['/seasons/{year}/summary'].get;
const responses = structuredClone(base.responses);
responses['200'].content['application/json'] = {
  schema: ref('getHomeChampionshipGraphicsResponse'),
};
contract.paths['/seasons/{year}/championship-graphics'] = {
  get: {
    operationId: 'getHomeChampionshipGraphics',
    summary: 'Read bounded Home top-three championship graphics',
    description:
      'Read-only bounded projection at one publication. Server derives each displayed top three from standingSnapshotId. Completed season rounds through that standing round only (maximum 64); three batched dataset stages, no upstream reads. Driver and constructor gaps use each historical round’s published rank-one leader across ALL standings for that kind, including championship sprint scoring. Exact decimal strings and explicit partial/missing coverage are retained; null gaps break lines. Supplementary driver race entry points use Race-only classification, never standings deltas. Aggregate coverage is complete only when calendar scope, all displayed standings cells and supplementary driver race cells are complete; missing supplementary evidence makes the aggregate partial without downgrading valid standings cells. Missing or malformed calendar scope is unavailable. No collection paging is needed: the bounded response contains every eligible round.',
    parameters: [
      base.parameters.find((p) => p.name === 'year'),
      {
        name: 'standingSnapshotId',
        in: 'query',
        required: true,
        schema: { type: 'string', pattern: '^standing:[0-9]+:[1-9][0-9]*$', maxLength: 160 },
      },
      ...base.parameters.filter((p) => ['snapshotId', 'If-None-Match'].includes(p.name)),
    ],
    responses,
    'x-reject-unknown-query-parameters': true,
  },
};
const content = `${JSON.stringify(contract, null, 2)}\n`;
writeFileSync(file, content);
const manifestFile = new URL('contract-manifest.json', root);
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
Object.assign(manifest, {
  openapiSha256: createHash('sha256').update(content).digest('hex'),
  operations: Object.values(contract.paths).reduce(
    (count, value) => count + Object.keys(value).length,
    0,
  ),
  schemas: Object.keys(contract.components.schemas).length,
});
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log('Home graphics OpenAPI extension and pinned checksum regenerated.');
