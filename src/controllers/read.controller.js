import { validateSchema } from '../schemas/contract.js';
export function readController(service, operation) {
  return async (req, res) => {
    const result = await service.read(operation, req.validated);
    const check = validateSchema(result.responseSchema, result.body);
    if (!check.valid) throw new Error('Response failed contract validation.');
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
