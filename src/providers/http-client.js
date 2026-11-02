import { setTimeout as sleep } from 'node:timers/promises';
export function providerError(code, message, path) {
  // Adapter-relative paths only; never retain credentials, query values or bodies.
  const endpoint = String(path).split('?')[0];
  const safePath = /^[a-z\d/_.-]{1,160}$/i.test(endpoint) ? endpoint : 'unknown-endpoint';
  return Object.assign(new Error(`${message} (${safePath})`), { code });
}
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
    const task = this.queue
      .then(() => this.read(path, options))
      .catch((error) => {
        if (error?.code?.startsWith?.('PROVIDER_')) throw error;
        const timeout = ['TimeoutError', 'AbortError'].includes(error?.name);
        const result = providerError(
          error instanceof SyntaxError
            ? 'PROVIDER_INVALID_JSON'
            : timeout
              ? 'PROVIDER_TIMEOUT'
              : 'PROVIDER_TRANSPORT_ERROR',
          error instanceof SyntaxError
            ? 'Provider returned invalid JSON.'
            : timeout
              ? 'Provider request timed out or was aborted.'
              : 'Provider transport failed.',
          path,
        );
        result.name = timeout ? error.name : 'Error';
        throw result;
      });
    this.queue = task.catch(() => {});
    const { signal } = options;
    if (!signal) return task;
    if (signal.aborted)
      return Promise.reject(
        providerError('PROVIDER_TIMEOUT', 'Provider request budget expired.', path),
      );
    return new Promise((resolve, reject) => {
      const abort = () =>
        reject(
          Object.assign(
            providerError('PROVIDER_TIMEOUT', 'Provider request budget expired.', path),
            { name: signal.reason?.name || 'AbortError' },
          ),
        );
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
        if (attempt === maxAttempts - 1)
          throw providerError(
            'PROVIDER_UNAVAILABLE',
            `Provider temporarily unavailable (HTTP ${response.status}).`,
            path,
          );
        const retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 0;
        if (retryAfterMs > this.maxRetryAfterMs)
          throw providerError(
            'PROVIDER_RETRY_LIMIT',
            'Provider requested a retry delay beyond the safe limit.',
            path,
          );
        this.next = Date.now() + Math.max(this.intervalMs * 2 ** attempt, retryAfterMs);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw providerError('PROVIDER_HTTP_ERROR', `Provider HTTP ${response.status}.`, path);
      }
      let bytes = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > this.maxBytes) {
          throw providerError(
            'PROVIDER_PAYLOAD_LIMIT',
            'Provider payload exceeded the limit.',
            path,
          );
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
