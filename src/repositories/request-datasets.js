// Request-scoped publication cache shared by bounded read projections.
export function requestDatasets(repository, snapshotId) {
  const cache = new Map();
  return async (keys) => {
    const unique = [...new Set(keys)];
    const missing = unique.filter((key) => !cache.has(key));
    if (missing.length) {
      const supplied = await repository.getMany(missing, snapshotId);
      for (const key of missing) cache.set(key, supplied.get(key) || null);
    }
    return new Map(unique.map((key) => [key, cache.get(key)]));
  };
}
