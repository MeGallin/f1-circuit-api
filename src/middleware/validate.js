import { invalid } from '../errors/api-error.js';
import { validateParameter, validateSchema } from '../schemas/contract.js';
export function validation(operation) {
  const querySpecs = operation.parameters.filter((p) => p.in === 'query');
  const pathSpecs = operation.parameters.filter((p) => p.in === 'path');
  const checks = new Map(
    [...querySpecs, ...pathSpecs].map((p) => [p.name, validateParameter(p.schema)]),
  );
  return (req, _res, next) => {
    try {
      if (Object.keys(req.query).some((k) => !querySpecs.some((p) => p.name === k)))
        throw invalid('Unknown query parameter.');
      const query = {};
      const params = {};
      for (const [specs, input, target] of [
        [querySpecs, req.query, query],
        [pathSpecs, req.params, params],
      ])
        for (const spec of specs) {
          let value = input[spec.name];
          if (value === undefined) value = spec.schema.default;
          if (value === undefined) {
            if (spec.required) throw invalid(`Missing ${spec.name}.`);
            continue;
          }
          if (typeof value !== 'string' && typeof value !== 'number')
            throw invalid(`Invalid ${spec.name}.`);
          if (spec.schema.type === 'integer') {
            if (!/^\d+$/.test(String(value))) throw invalid(`Invalid ${spec.name}.`);
            value = Number(value);
          }
          if (spec.name === 'q') value = value.trim();
          if (!checks.get(spec.name)(value)) throw invalid(`Invalid ${spec.name}.`);
          target[spec.name] = value;
        }
      for (const [a, b] of [
        ['from', 'to'],
        ['fromLap', 'toLap'],
        ['fromRound', 'toRound'],
        ['fromYear', 'toYear'],
      ])
        if (query[a] !== undefined && query[b] !== undefined && query[a] > query[b])
          throw invalid(`${a} must not exceed ${b}.`);
      if (query.round !== undefined && query.standingSnapshotId)
        throw invalid('Choose round or standingSnapshotId, not both.');
      if (query.leftId && query.leftId === query.rightId)
        throw invalid('Select two distinct entities.');
      if (
        ['getTelemetry', 'getLocation'].includes(operation.operationId) &&
        Date.parse(query.to) - Date.parse(query.from) > 120000
      )
        throw invalid('Series window must not exceed 120 seconds.');
      if (
        operation.operationId === 'getRecords' &&
        ((query.scope === 'season' && !query.year) || (query.scope !== 'season' && !query.entityId))
      )
        throw invalid('Supply the required entity or year scope.');
      if (operation.method === 'post' && !validateSchema('QuestionRequest', req.body).valid)
        throw invalid('Invalid question request.');
      req.validated = { query, params, body: req.body };
      next();
    } catch (error) {
      next(error);
    }
  };
}
