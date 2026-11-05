import { appendFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

// Bounded, non-content diagnostic records. Never persist question text, archive
// documents, credentials or exception messages. Failure cannot break Ask.
export async function recordQuestionTrace(trace, filePath = null, write = appendFile) {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) return false;
  const record = Object.fromEntries(
    [
      'requestId',
      'providerRequestId',
      'publicationId',
      'operation',
      'status',
      'reasonCode',
      'retrievalStatus',
      'stages',
      'durationMs',
      'resolutions',
      'failure',
    ]
      .filter((key) => trace[key] !== undefined)
      .map((key) => [key, trace[key]]),
  );
  const line = JSON.stringify({ recordedAt: new Date().toISOString(), ...record }) + '\n';
  if (line.length > 8192) return false;
  try {
    await write(filePath, line);
    return true;
  } catch {
    return false;
  }
}
