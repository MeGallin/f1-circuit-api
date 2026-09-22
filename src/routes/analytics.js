import { Router } from 'express';
import { invalid } from '../errors/api-error.js';
import { AnalyticsService } from '../services/analytics.service.js';

const allowedQueryParameters = new Set([
  'season',
  'fromRound',
  'toRound',
  'driverIds',
  'drivers',
  'constructorIds',
  'circuitIds',
  'sessionType',
  'snapshotId',
]);

function validateAnalyticsQuery(req, _res, next) {
  try {
    if (Object.keys(req.query).some((key) => !allowedQueryParameters.has(key)))
      throw invalid('Unknown query parameter.');
    next();
  } catch (error) {
    next(error);
  }
}

const send =
  (service, operation, cache = 'public, max-age=60, must-revalidate') =>
  async (req, res, next) => {
    try {
      const result = await service[operation](req.query);
      const etag = service.etag(result);
      res.set('ETag', etag);
      res.set('Cache-Control', cache);
      if (req.get('If-None-Match') === etag) return res.status(304).end();
      res.json(result.body);
    } catch (error) {
      next(error);
    }
  };

export function createAnalyticsRouter(repository) {
  const router = Router();
  const service = new AnalyticsService(repository);
  router.get('/dashboard', validateAnalyticsQuery, send(service, 'dashboard'));
  router.get('/driver-comparison', validateAnalyticsQuery, send(service, 'driverComparison'));
  return router;
}
