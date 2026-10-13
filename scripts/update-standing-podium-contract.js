// Keyed, repeatable local contract update; no data/provider operations.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const file = new URL('../docs/openapi.json', import.meta.url);
const contract = JSON.parse(readFileSync(file, 'utf8'));
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const count = { type: 'integer', minimum: 0, maximum: 64 };
const properties = {
  coverage: { type: 'string', enum: ['complete', 'partial', 'unavailable'] },
  throughRound: nullable({ type: 'integer', minimum: 1, maximum: 64 }),
  expectedRaces: nullable(count),
  verifiedRaces: count,
  observedRaces: count,
  snapshotId: { type: 'string', minLength: 1 },
  evidenceIds: {
    type: 'array',
    items: { type: 'string', minLength: 1 },
    maxItems: 64,
    uniqueItems: true,
  },
};
contract.components.schemas.StandingPodiumCoverage = {
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
  description:
    'Stored final race positions 1–3 through the standing row’s season and round, at this publication. Complete proves all podium slots, independently of partial lower classifications. Partial counts are observed only, including observed zero; unavailable is null. Constructor credit is per car; each distinct shared-car driver receives one credit. Conflicting duplicate assertions are excluded, never counted twice.',
};
contract.components.schemas.Standing.properties.podiumCoverage = nullable({
  $ref: '#/components/schemas/StandingPodiumCoverage',
});
contract.components.schemas.Standing.properties.podiums.description =
  'getStandings derives this from stored final race results; interpret with podiumCoverage. Legacy/unprojected standing records may have null coverage.';
const content = JSON.stringify(contract, null, 2) + '\n';
writeFileSync(file, content);
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
const clientFile = new URL('../../client/contracts/openapi.json', import.meta.url);
const clientContract = JSON.parse(readFileSync(clientFile, 'utf8'));
clientContract.components.schemas.StandingPodiumCoverage =
  contract.components.schemas.StandingPodiumCoverage;
clientContract.components.schemas.Standing.properties.podiumCoverage =
  contract.components.schemas.Standing.properties.podiumCoverage;
clientContract.components.schemas.Standing.properties.podiums.description =
  contract.components.schemas.Standing.properties.podiums.description;
writeFileSync(clientFile, JSON.stringify(clientContract, null, 2) + '\n');
