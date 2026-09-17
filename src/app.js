import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { ApiError, missing } from './errors/api-error.js';
import { requestLog, errorHandler } from './middleware/http.js';
export function createApp({ repository, config, logger, router }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestLog(logger));
  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        callback(
          origin && !config.origins.includes(origin)
            ? new ApiError(403, 'INVALID_REQUEST', 'Origin is not allowed.')
            : null,
          true,
        );
      },
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'If-None-Match'],
      exposedHeaders: ['ETag', 'X-Request-Id', 'Retry-After'],
      credentials: false,
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '8kb' }));
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (req, res) => {
    try {
      await repository.ready();
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Database or migrations are unavailable.',
          requestId: req.requestId,
          details: [],
        },
      });
    }
  });
  app.use(
    '/api',
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler(req, res) {
        res.status(429).json({
          error: {
            code: 'RATE_LIMITED',
            message: 'Please retry shortly.',
            requestId: req.requestId,
            details: [],
          },
        });
      },
    }),
  );
  if (router) app.use('/api/v1', router);
  app.use((_req, _res, next) => next(missing()));
  app.use(errorHandler(logger));
  return app;
}
