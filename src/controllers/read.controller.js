import { validateSchema } from '../schemas/contract.js';
export function readController(service, operation) {
  return async (req, res) => {
    const result = await service.read(operation, req.validated);
    if (result.questionDiagnostics) {
      const diagnostics = result.questionDiagnostics;
      res.set(
        'Server-Timing',
        Object.entries(diagnostics.stages)
          .filter(([, value]) => Number.isFinite(value))
          .map(([stage, duration]) => `${stage};dur=${duration}`)
          .join(', '),
      );
      if (diagnostics.operation) res.set('X-Question-Operation', diagnostics.operation);
      res.set('X-Question-Retrieval', diagnostics.retrievalStatus);
      if (diagnostics.providerRequestId)
        res.set('X-Question-Provider-Request-Id', diagnostics.providerRequestId);
    }
    const check = validateSchema(result.responseSchema, result.body);
    if (!check.valid)
      throw Object.assign(new Error('Response failed contract validation.'), {
        code: 'RESPONSE_CONTRACT_INVALID',
        responseSchema: result.responseSchema,
      });
    res.set('ETag', result.etag);
    res.set(
      'Cache-Control',
      req.method === 'POST' ? 'no-store' : 'public, max-age=60, must-revalidate',
    );
    if (req.method === 'GET' && req.get('If-None-Match') === result.etag)
      return res.status(304).end();
    res.json(result.body);
  };
}
