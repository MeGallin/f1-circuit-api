import { createHash } from 'node:crypto';
export const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const slug = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
export function dataset(key, schema, items, provenance, options = {}) {
  const id = 'evidence:' + hash([key, items, provenance]).slice(0, 32);
  return {
    key,
    schema,
    items: items.map((item) => ({ ...item, evidenceId: item.evidenceId || id })),
    coverage: items.length ? 'partial' : 'unavailable',
    verification: 'source-only',
    warnings: [],
    ...options,
    evidenceId: id,
    provenance,
  };
}
export function meta(set, snapshot) {
  const retrieved = set?.provenance?.retrievedAt || null;
  return {
    schemaVersion: '1.0.0-draft.1',
    snapshotId: snapshot.id,
    generatedAt: new Date().toISOString(),
    lastSuccessfulRetrieval: retrieved,
    freshness: retrieved
      ? Date.now() - Date.parse(retrieved) > 14 * 86400000
        ? 'stale'
        : 'fresh'
      : 'unknown',
    coverage: set?.coverage || 'unavailable',
    verification: set?.verification || 'unassessed',
    sources: set?.provenance?.sources || [],
    warnings: set?.warnings || [],
    evidenceUrl: set?.evidenceId ? `/api/v1/evidence/${encodeURIComponent(set.evidenceId)}` : null,
  };
}
