import OpenAI from 'openai';

export class OpenAIEmbeddingClient {
  constructor({ apiKey, model = 'text-embedding-3-small', timeoutMs = 10000 }) {
    this.client = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 1 });
    this.model = model;
  }

  async embed(input) {
    const values = Array.isArray(input) ? input : [input];
    const response = await this.client.embeddings.create({ model: this.model, input: values });
    return response.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
  }
}
