import request from 'supertest';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';
import { PublicationRepository } from '../src/repositories/publication.repository.js';
import { createApp } from '../src/app.js';
import { createRouter } from '../src/routes/index.js';
import {
  questionContractScenarios,
  QUESTION_CONTRACT_VERSION,
} from '../tests/question-contract/corpus.js';
import { deriveExpected } from '../tests/question-contract/expected.js';

const config = loadConfig();
const pool = createPool(config);
const sourceRepository = new PublicationRepository(pool);
const GLOBAL_TIMEOUT_MS = 120000;
const PUBLICATION_TIMEOUT_MS = 10000;
const SCENARIO_TIMEOUT_MS = 20000;
const DERIVATION_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 10000;

function timeoutError(code, milliseconds) {
  const error = new Error(`${code} after ${milliseconds}ms`);
  error.code = code;
  error.timeoutMs = milliseconds;
  return error;
}

function withTimeout(promise, milliseconds, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(code, milliseconds)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class CachedSnapshotRepository {
  constructor(source, snapshot) {
    this.source = source;
    this.currentSnapshot = snapshot;
    this.setCache = new Map();
    this.keyCache = new Map();
  }

  async ready() {
    return true;
  }

  async snapshot(id) {
    return !id || id === this.currentSnapshot.id ? this.currentSnapshot : null;
  }

  async get(key) {
    if (!this.setCache.has(key))
      this.setCache.set(key, this.source.get(key, this.currentSnapshot.id));
    return this.setCache.get(key);
  }

  async keys(prefix) {
    if (!this.keyCache.has(prefix))
      this.keyCache.set(prefix, this.source.keys(prefix, this.currentSnapshot.id));
    return this.keyCache.get(prefix);
  }

  async resolve(alias) {
    return this.source.resolve(alias, this.currentSnapshot.id);
  }

  async evidence(evidenceId) {
    return this.source.evidence(evidenceId, this.currentSnapshot.id);
  }
}

const unique = (items) => [...new Set(items.filter(Boolean))];

function actualEvidence(body) {
  const result = body?.data?.questionResult || {};
  return unique([...(result.evidenceIds || []), body?.meta?.evidenceId]);
}

function checkScenario(scenario, expected, body) {
  const result = body?.data?.questionResult || {};
  const values = result.values || {};
  const failures = [];
  const evidence = actualEvidence(body);

  if (body?.meta?.snapshotId == null) failures.push('missing snapshot metadata');
  if (result.status !== expected.status)
    failures.push(`status expected ${expected.status}, got ${result.status || 'missing'}`);
  if (result.resolvedIntent === 'archive_search' || 'matches' in values)
    failures.push('constraint-bearing question fell through to generic archive search');
  if (expected.status === 'answered') {
    if (result.resolvedIntent !== scenario.intent)
      failures.push(
        `intent expected ${scenario.intent}, got ${result.resolvedIntent || 'missing'}`,
      );
    if (typeof values.answer !== 'string' || !values.answer.trim())
      failures.push('answered result has no rendered answer');
    for (const token of expected.answerTokens || [])
      if (
        !String(values.answer || '')
          .toLowerCase()
          .includes(String(token).toLowerCase())
      )
        failures.push(`answer is missing expected value ${JSON.stringify(token)}`);
    if (!evidence.length) failures.push('answered result has no source evidence ID');
    if (body?.meta?.coverage == null && values.coverage == null)
      failures.push('answered result has no coverage metadata');
    for (const [field, value] of Object.entries(expected.fields || {})) {
      if (values[field] !== value)
        failures.push(
          `constraint ${field} expected ${JSON.stringify(value)}, got ${JSON.stringify(values[field])}`,
        );
    }
    if (
      expected.requiredEvidenceIds?.length &&
      !expected.requiredEvidenceIds.some((id) => evidence.includes(id))
    )
      failures.push('source evidence does not include a dataset used for the expected aggregate');
    if (expected.sourceCoverage && values.coverage && values.coverage !== expected.sourceCoverage)
      failures.push(`source coverage expected ${expected.sourceCoverage}, got ${values.coverage}`);
  }
  if (
    expected.status === 'unavailable' ||
    expected.status === 'clarification' ||
    expected.status === 'unsupported'
  ) {
    if (expected.reasonCode && result.reasonCode !== expected.reasonCode)
      failures.push(
        `reason expected ${expected.reasonCode}, got ${result.reasonCode || 'missing'}`,
      );
  }
  if (expected.status === 'clarification' && result.status === 'clarification' && result.values)
    failures.push('clarification unexpectedly included factual values');
  for (const id of evidence)
    if (expected.evidenceIds?.length && !expected.evidenceIds.includes(id))
      failures.push(`evidence ID ${id} does not correspond to the independently used datasets`);

  return {
    scenarioId: scenario.id,
    family: scenario.family,
    question: body?.requestQuestion || null,
    intent: scenario.intent,
    constraints: scenario.constraints,
    expected: {
      status: expected.status,
      reasonCode: expected.reasonCode || null,
      fields: expected.fields || null,
      sourceCoverage: expected.sourceCoverage || null,
      evidenceIds: expected.evidenceIds || [],
    },
    actual: {
      status: result.status || null,
      resolvedIntent: result.resolvedIntent || null,
      reasonCode: result.reasonCode || null,
      values,
      evidenceIds: evidence,
      coverage: values.coverage || body?.meta?.coverage || null,
    },
    pass: failures.length === 0,
    failures,
  };
}

function blockedResult(scenario, question, variant, error, expected = null) {
  const code = error?.code || 'VERIFICATION_BLOCKED';
  const message = error?.message || 'The verification step did not complete.';
  return {
    scenarioId: scenario.id,
    family: scenario.family,
    question,
    variant,
    intent: scenario.intent,
    constraints: scenario.constraints,
    expected: expected
      ? {
          status: expected.status,
          reasonCode: expected.reasonCode || null,
          fields: expected.fields || null,
          sourceCoverage: expected.sourceCoverage || null,
          evidenceIds: expected.evidenceIds || [],
        }
      : null,
    actual: {
      status: null,
      resolvedIntent: null,
      reasonCode: null,
      values: {},
      evidenceIds: [],
      coverage: null,
    },
    blocked: true,
    pass: false,
    failures: [`${code}: ${message}`],
  };
}

function buildReport(results, snapshotId, statusOverride = null) {
  const blocked = results.filter((result) => result.blocked).length;
  const failed = results.filter((result) => !result.pass && !result.blocked).length;
  return {
    status: statusOverride || (blocked ? 'blocked' : failed ? 'failed' : 'passed'),
    contractVersion: QUESTION_CONTRACT_VERSION,
    scope: 'current-publication-read-only',
    snapshotId: snapshotId || null,
    scenarioCount: questionContractScenarios.length,
    questionVariantCount: results.filter((result) => result.scenarioId !== 'publication').length,
    passed: results.filter((result) => result.pass).length,
    failed,
    blocked,
    results,
  };
}

const liveResults = [];
let liveSnapshotId = null;
let verificationFinished = false;
const globalTimeout = setTimeout(() => {
  if (verificationFinished) return;
  const timeout = timeoutError('VERIFICATION_GLOBAL_TIMEOUT', GLOBAL_TIMEOUT_MS);
  const result = {
    scenarioId: 'publication',
    family: 'verification run',
    question: null,
    variant: null,
    intent: null,
    constraints: null,
    expected: null,
    actual: null,
    blocked: true,
    pass: false,
    failures: [timeout.message],
  };
  console.log(JSON.stringify(buildReport([...liveResults, result], liveSnapshotId, 'blocked')));
  process.exit(1);
}, GLOBAL_TIMEOUT_MS);

async function run() {
  const snapshot = await withTimeout(
    sourceRepository.snapshot(),
    PUBLICATION_TIMEOUT_MS,
    'PUBLICATION_SNAPSHOT_TIMEOUT',
  );
  if (!snapshot) {
    const error = new Error('No active public publication is available.');
    error.code = 'PUBLICATION_UNAVAILABLE';
    throw error;
  }
  liveSnapshotId = snapshot.id;
  const repository = new CachedSnapshotRepository(sourceRepository, snapshot);
  const data = {
    get: (key) => repository.get(key),
    keys: (prefix) => repository.keys(prefix),
  };
  const app = createApp({
    repository,
    config: { ...config, openaiEnabled: false, openaiApiKey: null },
    logger: { info() {}, error() {} },
    router: createRouter(repository),
  });
  for (const scenario of questionContractScenarios) {
    const scenarioDeadline = Date.now() + SCENARIO_TIMEOUT_MS;
    let expected;
    try {
      expected = await withTimeout(
        deriveExpected(scenario, data),
        Math.min(DERIVATION_TIMEOUT_MS, Math.max(1, scenarioDeadline - Date.now())),
        'SCENARIO_DERIVATION_TIMEOUT',
      );
    } catch (error) {
      for (let index = 0; index < scenario.questions.length; index++)
        liveResults.push(blockedResult(scenario, scenario.questions[index], index + 1, error));
      continue;
    }
    for (let index = 0; index < scenario.questions.length; index++) {
      const question = scenario.questions[index];
      const remaining = scenarioDeadline - Date.now();
      if (remaining <= 0) {
        const error = timeoutError('SCENARIO_TIMEOUT', SCENARIO_TIMEOUT_MS);
        liveResults.push(blockedResult(scenario, question, index + 1, error, expected));
        continue;
      }
      try {
        const response = await withTimeout(
          request(app)
            .post('/api/v1/questions')
            .send({
              text: question,
              ...(scenario.context && Object.keys(scenario.context).length
                ? { context: scenario.context }
                : {}),
            })
            .timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS + 1000 }),
          Math.min(REQUEST_TIMEOUT_MS + 1000, remaining),
          'QUESTION_REQUEST_TIMEOUT',
        );
        const body = response.body || {};
        body.requestQuestion = question;
        const scenarioResult = checkScenario(scenario, expected, body);
        scenarioResult.httpStatus = response.status;
        scenarioResult.variant = index + 1;
        liveResults.push(scenarioResult);
      } catch (error) {
        liveResults.push(blockedResult(scenario, question, index + 1, error, expected));
      }
    }
  }
  return buildReport(liveResults, snapshot.id);
}

let report;
try {
  report = await run();
} catch (error) {
  report = buildReport(
    [
      {
        scenarioId: 'publication',
        family: 'publication access',
        question: null,
        variant: null,
        intent: null,
        constraints: null,
        expected: null,
        actual: null,
        blocked: true,
        pass: false,
        failures: [`${error.code || 'PUBLICATION_VERIFICATION_FAILED'}: ${error.message}`],
      },
    ],
    liveSnapshotId,
    'blocked',
  );
} finally {
  verificationFinished = true;
  clearTimeout(globalTimeout);
  await withTimeout(pool.end(), 5000, 'POOL_CLOSE_TIMEOUT').catch(() => {});
}

console.log(JSON.stringify(report));
if (report.status !== 'passed') process.exitCode = 1;
