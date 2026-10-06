const retainMissingArrayKeys = new Set([
  'aliases',
  'capabilities',
  'constructors',
  'drivers',
  'features',
  'metrics',
  'phases',
  'sessions',
]);

function identity(item) {
  return item && typeof item === 'object' ? (item.id ?? item.key ?? null) : null;
}

const sourceCorrectionKeys = new Set([
  'fastestLap',
  'winner',
  'podium',
  'points',
  'position',
  'elapsedMs',
  'lapsCompleted',
  'gap',
  'grid',
  'status',
  'statusLabel',
  'publishedOrder',
]);

function preserveValue(previous, incoming, key = '') {
  if (sourceCorrectionKeys.has(key) && incoming !== undefined) return incoming;
  if (incoming === null || incoming === undefined) return previous;
  if (!Array.isArray(incoming) && typeof incoming !== 'object') return incoming;
  if (Array.isArray(incoming)) {
    if (!incoming.length) return previous?.length ? previous : incoming;
    const prior = Array.isArray(previous) ? previous : [];
    const priorById = new Map(prior.map((item) => [identity(item), item]).filter(([id]) => id));
    if (incoming.every((item) => identity(item)) && priorById.size) {
      const merged = incoming.map((item) => preserveValue(priorById.get(identity(item)), item));
      if (retainMissingArrayKeys.has(key)) {
        const incomingIds = new Set(incoming.map(identity));
        merged.push(...prior.filter((item) => !incomingIds.has(identity(item))));
      }
      return merged;
    }
    return incoming;
  }

  const prior =
    previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
  const result = {};
  for (const property of new Set([...Object.keys(prior), ...Object.keys(incoming)]))
    result[property] = preserveValue(prior[property], incoming[property], property);
  return result;
}

export async function preserveRefreshDatasets(repository, snapshotId, sets) {
  for (let index = 0; index < sets.length; index++) {
    const set = sets[index];
    const previous = await repository.get(set.key, snapshotId);
    if (!previous?.items?.length) continue;
    if (set.key.startsWith('profile:')) {
      sets.splice(index--, 1);
      continue;
    }
    const oldById = new Map(
      previous.items.map((item) => [identity(item), item]).filter(([id]) => id),
    );
    if (!set.items?.length) continue;
    set.items = set.items.map((item, itemIndex) => {
      const old =
        oldById.get(identity(item)) ||
        (previous.items.length === set.items.length ? previous.items[itemIndex] : null);
      const merged = preserveValue(old, item);
      if (
        ['EventSummary', 'Session'].includes(set.schema) &&
        old?.status !== 'unknown' &&
        item.status === 'unknown'
      ) {
        merged.status = old.status;
        merged.evidenceId = old.evidenceId || null;
      }
      return merged;
    });
    if (set.key.startsWith('events:') || set.key.startsWith('sessions:')) {
      const incomingIds = new Set(set.items.map(identity));
      set.items.push(...previous.items.filter((item) => !incomingIds.has(identity(item))));
    }
    if (set.key.startsWith('events:') || set.key.startsWith('sessions:')) {
      set.coverage = previous.coverage;
      set.verification = previous.verification;
      set.warnings = previous.warnings;
      set.provenance = previous.provenance;
      set.evidenceId = previous.evidenceId;
      const targetEventId = set.key.startsWith('events:')
        ? null
        : set.key.slice('sessions:'.length);
      for (const item of set.items) {
        const refreshKey = targetEventId
          ? item.kind === 'qualifying'
            ? `qualifying:${item.id}`
            : `results:${item.id}`
          : `results:session:${item.id}:race`;
        const sourceSet = sets.find((candidate) => candidate.key === refreshKey);
        if (sourceSet?.evidenceId) item.evidenceId = sourceSet.evidenceId;
        else if (item.status === 'unknown' || item.kind !== 'race')
          item.evidenceId = oldById.get(identity(item))?.evidenceId || previous.evidenceId;
      }
    }
  }
  return sets;
}
