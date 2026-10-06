// Request-scoped only: a new publication must never reuse an older snapshot's data.
export async function cacheSnapshot(repository, snapshotId, keys) {
  const unique = [...new Set(keys)];
  const sets = repository.getMany
    ? await repository.getMany(unique, snapshotId)
    : new Map(
        await Promise.all(unique.map(async (key) => [key, await repository.get(key, snapshotId)])),
      );
  const cached = Object.create(repository);
  cached.get = async (key, id) => {
    if (id !== snapshotId) return repository.get(key, id);
    if (!sets.has(key)) sets.set(key, await repository.get(key, id));
    return sets.get(key) || null;
  };
  for (const key of unique) if (!sets.has(key)) sets.set(key, null);
  return cached;
}
