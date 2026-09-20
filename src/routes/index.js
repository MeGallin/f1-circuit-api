import { Router } from 'express';
import { operations } from '../schemas/contract.js';
import { validation } from '../middleware/validate.js';
import { readController } from '../controllers/read.controller.js';
import { ReadService } from '../services/read.service.js';
import { QuestionService } from '../services/question.service.js';
export function createRouter(repository, { config = {} } = {}) {
  const router = Router();
  const service = new ReadService(repository, new QuestionService(repository, { config }));
  for (const operation of operations) {
    const path = operation.path.replace(/\{([^}]+)\}/g, ':$1');
    router[operation.method](path, validation(operation), readController(service, operation));
  }
  return router;
}
