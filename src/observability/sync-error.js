export function safeSyncError(error, fallbackCode = 'SYNC_FAILED') {
  const code = String(error?.code || '');
  const message = String(error?.message || 'Synchronization failed.')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/g, '[REDACTED]')
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/gi, '[REDACTED URL]')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(
      /\b(password|passwd|pwd|token|secret|api[_-]?key|authorization|database[_-]?url)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[REDACTED]',
    )
    // eslint-disable-next-line no-control-regex -- Remove log-injection controls.
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, ' ')
    .slice(0, 500);
  return {
    code: /^(?:[A-Z][A-Z0-9_]{0,63}|[0-9A-Z]{5})$/.test(code) ? code : fallbackCode,
    message,
  };
}

export function schedulerOutcome(result) {
  return {
    status: result.status,
    ...(Number.isInteger(result.year) ? { year: result.year } : {}),
    ...(Number.isInteger(result.round) ? { round: result.round } : {}),
    ...(result.error ? { error: safeSyncError(result.error, 'AUTO_SYNC_FAILED') } : {}),
  };
}
