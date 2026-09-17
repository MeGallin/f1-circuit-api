import { setTimeout as sleep } from 'node:timers/promises';
export class ProviderHttp {
  constructor({ baseUrl, intervalMs = 8000, fetcher = fetch, wait = sleep, maxBytes = 8_000_000 }) {
    Object.assign(this, { baseUrl, intervalMs, fetcher, wait, maxBytes });
    this.next = 0;
    this.queue = Promise.resolve();
  }
  get(path) {
    const task = this.queue.then(() => this.read(path));
    this.queue = task.catch(() => {});
    return task;
  }
  async read(path) {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== new URL(this.baseUrl).origin)
      throw new Error('Provider URL is outside the adapter boundary.');
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.wait(Math.max(0, this.next - Date.now()));
      this.next = Date.now() + this.intervalMs;
      const response = await this.fetcher(url, {
        headers: { 'User-Agent': 'F1Circuit/0.1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
      });
      if (response.status === 429 || response.status >= 500) {
        const seconds = Number(response.headers.get('retry-after'));
        await response.body?.cancel();
        if (attempt === 2) throw new Error('Provider temporarily unavailable.');
        this.next =
          Date.now() +
          Math.min(60000, Math.max(this.intervalMs, Number.isFinite(seconds) ? seconds * 1000 : 0));
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Provider HTTP ${response.status}.`);
      }
      let bytes = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > this.maxBytes) {
          throw new Error('Provider payload exceeded the limit.');
        }
        chunks.push(chunk);
      }
      return {
        payload: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        url: url.toString(),
        retrievedAt: new Date().toISOString(),
      };
    }
  }
}
