import { Router } from 'express';
import { operations, validateSchema } from '../schemas/contract.js';
import { validation } from '../middleware/validate.js';
import { readController } from '../controllers/read.controller.js';
import { ReadService } from '../services/read.service.js';
import { QuestionService } from '../services/question.service.js';
import { QuestionRepository } from '../repositories/question.repository.js';
import { createAnalyticsRouter } from './analytics.js';
import { ApiError } from '../errors/api-error.js';
export function createRouter(repository, { config = {}, manualRefresh = null } = {}) {
  const router = Router();
  router.use('/analytics', createAnalyticsRouter(repository));
  const questionRepository = repository.pool ? new QuestionRepository(repository.pool) : null;
  const service = new ReadService(
    repository,
    new QuestionService(repository, { config, questionRepository }),
  );
  for (const operation of operations) {
    const path = operation.path.replace(/\{([^}]+)\}/g, ':$1');
    if (operation.operationId === 'refreshRaceData') {
      router.post(path, validation(operation), async (req, res, next) => {
        try {
          if (!manualRefresh)
            throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Manual race refresh is unavailable.');
          const result = await manualRefresh.refresh(req.validated.body.season);
          if (!validateSchema('RefreshDataResponse', result).valid)
            throw new Error('Manual race refresh returned an invalid response.');
          res.set('Cache-Control', 'no-store').status(200).json(result);
        } catch (error) {
          next(error);
        }
      });
      continue;
    }
    router[operation.method](path, validation(operation), readController(service, operation));
  }
  return router;
}
