import OpenAI from 'openai';

// One immutable contract for both indexed documents and query vectors. Config
// may select this model, but cannot silently change the installed vector schema.
export const QUESTION_EMBEDDING_MODEL = 'text-embedding-3-small';
export const QUESTION_EMBEDDING_DIMENSIONS = 1536;
export function embeddingError() {
  return Object.assign(new Error('Question embedding response is incompatible.'), {
    code: 'QUESTION_EMBEDDING_INVALID',
  });
}
export function validateEmbedding(values) {
  if (
    !Array.isArray(values) ||
    values.length !== QUESTION_EMBEDDING_DIMENSIONS ||
    !values.every((value) => typeof value === 'number' && Number.isFinite(value)) ||
    !values.some((value) => value !== 0)
  )
    throw embeddingError();
  return values;
}

export class OpenAIEmbeddingClient {
  constructor({ apiKey, model = QUESTION_EMBEDDING_MODEL, timeoutMs = 10000 }) {
    if (model !== QUESTION_EMBEDDING_MODEL) throw embeddingError();
    this.client = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 1 });
    this.model = model;
    this.dimensions = QUESTION_EMBEDDING_DIMENSIONS;
  }

  async embed(input, { signal } = {}) {
    const values = Array.isArray(input) ? input : [input];
    if (
      !values.length ||
      values.length > 100 ||
      values.some((value) => typeof value !== 'string' || !value.trim() || value.length > 16000)
    )
      throw embeddingError();
    const response = await this.client.embeddings.create(
      {
        model: this.model,
        input: values,
        dimensions: this.dimensions,
        encoding_format: 'float',
      },
      { signal },
    );
    if (
      response.model !== this.model ||
      !Array.isArray(response.data) ||
      response.data.length !== values.length
    )
      throw embeddingError();
    const result = new Array(values.length);
    for (const item of response.data) {
      if (
        !Number.isInteger(item.index) ||
        item.index < 0 ||
        item.index >= values.length ||
        result[item.index]
      )
        throw embeddingError();
      result[item.index] = validateEmbedding(item.embedding);
    }
    this.lastUsage = response.usage?.total_tokens ?? null;
    return result;
  }
}
