import { setTimeout as sleep } from 'node:timers/promises';
export class ProviderHttp {
  constructor({
    baseUrl,
    intervalMs = 8000,
    fetcher = fetch,
    wait = sleep,
    maxBytes = 8_000_000,
    timeoutMs = 20000,
    maxAttempts = 3,
    maxRetryAfterMs = 300000,
  }) {
    Object.assign(this, {
      baseUrl,
      intervalMs,
      fetcher,
      wait,
      maxBytes,
      timeoutMs,
      maxAttempts,
      maxRetryAfterMs,
    });
    this.next = 0;
    this.queue = Promise.resolve();
  }
  get(path, options = {}) {
    const task = this.queue.then(() => this.read(path, options));
    this.queue = task.catch(() => {});
    const { signal } = options;
    if (!signal) return task;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  async read(path, { signal, timeoutMs = this.timeoutMs, maxAttempts = this.maxAttempts } = {}) {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== new URL(this.baseUrl).origin)
      throw new Error('Provider URL is outside the adapter boundary.');
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      signal?.throwIfAborted();
      await this.wait(Math.max(0, this.next - Date.now()), undefined, { signal });
      signal?.throwIfAborted();
      this.next = Date.now() + this.intervalMs;
      let response;
      try {
        response = await this.fetcher(url, {
          headers: { 'User-Agent': 'F1Circuit/0.1.0', Accept: 'application/json' },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
      } catch (error) {
        if (signal?.aborted || attempt === maxAttempts - 1) throw error;
        this.next = Date.now() + this.intervalMs * 2 ** attempt;
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        const retry = response.headers.get('retry-after');
        const seconds =
          retry && /^\d+(\.\d+)?$/.test(retry)
            ? Number(retry)
            : (Date.parse(retry) - Date.now()) / 1000;
        await response.body?.cancel();
        if (attempt === maxAttempts - 1) throw new Error('Provider temporarily unavailable.');
        const retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 0;
        if (retryAfterMs > this.maxRetryAfterMs)
          throw new Error('Provider requested a retry delay beyond the safe limit.');
        this.next = Date.now() + Math.max(this.intervalMs * 2 ** attempt, retryAfterMs);
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
