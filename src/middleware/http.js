import { randomUUID } from 'node:crypto';
import { ApiError } from '../errors/api-error.js';
export function requestLog(logger) {
  return (req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    const start = Date.now();
    let logged = false;
    const log = (completed) => {
      if (logged) return;
      logged = true;
      logger.info(
        {
          requestId: req.requestId,
          method: req.method,
          route: req.route?.path || 'unmatched',
          status: completed ? res.statusCode : null,
          completed,
          durationMs: Date.now() - start,
        },
        'request',
      );
    };
    res.once('finish', () => log(true));
    res.once('close', () => log(res.writableFinished === true));
    next();
  };
}
export function errorHandler(logger) {
  return (err, req, res, _next) => {
    const known = err instanceof ApiError;
    const status = known
      ? err.status
      : err.type === 'entity.parse.failed'
        ? 400
        : err.type === 'entity.too.large'
          ? 400
          : 500;
    if (status >= 500)
      logger.error(
        {
          requestId: req.requestId,
          errorType: err.name,
          ...(err.code === 'RESPONSE_CONTRACT_INVALID'
            ? {
                failureCode: err.code,
                responseSchema: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(err.responseSchema || '')
                  ? err.responseSchema
                  : null,
              }
            : {}),
        },
        'request failed',
      );
    res.status(status).json({
      error: {
        code: known ? err.code : status === 400 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',
        message: known
          ? err.message
          : status === 400
            ? 'Invalid JSON request body.'
            : 'The request could not be completed.',
        requestId: req.requestId,
        details: known ? err.details : [],
      },
    });
  };
}
