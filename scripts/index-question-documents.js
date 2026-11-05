import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';
import { PublicationRepository } from '../src/repositories/publication.repository.js';
import { QuestionRepository } from '../src/repositories/question.repository.js';
import { QuestionIndexer } from '../src/questions/question-indexer.js';

const config = loadConfig();
const pool = createPool(config);
try {
  const indexer = new QuestionIndexer({
    publications: new PublicationRepository(pool),
    repository: new QuestionRepository(pool),
    config,
  });
  const publicationId = process.argv
    .find((arg) => arg.startsWith('--publication='))
    ?.slice('--publication='.length);
  if (process.argv.includes('--dry-run')) {
    const estimate = await indexer.prepare(publicationId);
    delete estimate.documents;
    console.log(JSON.stringify({ status: 'estimate', ...estimate }));
  } else {
    if (!config.openaiApiKey) throw new Error('Question index key unavailable.');
    console.log(
      JSON.stringify(
        await indexer.build({ publicationId, force: process.argv.includes('--force') }),
      ),
    );
  }
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'failed',
      code: [
        'QUESTION_INDEX_LIMIT',
        'QUESTION_EMBEDDING_INVALID',
        'QUESTION_INDEX_ABORTED',
      ].includes(error.code)
        ? error.code
        : 'QUESTION_INDEX_BUILD_FAILED',
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
