import { compareAssertions } from './compare.js';
function scalars(value, path = '', result = {}) {
  if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value))
      if (key !== 'evidenceId')
        scalars(v, path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1'), result);
  } else result[path] = value;
  return result;
}
export function reconcileDataset(previous, incoming) {
  const oldSource = previous.provenance?.sources?.[0];
  const newSource = incoming.provenance?.sources?.[0];
  if (!oldSource || !newSource || oldSource.id === newSource.id) return incoming;
  const rank =
    incoming.schema === 'Lap'
      ? { openf1: 3, jolpica: 2, f1db: 1 }
      : { jolpica: 3, f1db: 2, openf1: 1 };
  const preferred = (rank[oldSource.id] || 0) > (rank[newSource.id] || 0) ? previous : incoming;
  const alternative = preferred === previous ? incoming : previous;
  const selected = structuredClone(preferred);
  const otherRows = new Map(alternative.items.map((r, i) => [r.id || String(i), r]));
  selected.fieldComparisons = [];
  for (const [i, row] of selected.items.entries()) {
    const other = otherRows.get(row.id || String(i));
    if (!other) continue;
    const a = scalars(row),
      b = scalars(other);
    for (const [path, value] of Object.entries(a)) {
      if (value === null || b[path] === null || b[path] === undefined) continue;
      const assertions = [
        {
          value,
          unit: path.endsWith('/points') ? 'points' : 'value',
          lineage: preferred.provenance.sources[0].id,
        },
        {
          value: b[path],
          unit: path.endsWith('/points') ? 'points' : 'value',
          lineage: alternative.provenance.sources[0].id,
        },
      ];
      const comparison = compareAssertions(assertions);
      if (comparison.state === 'conflict')
        selected.fieldComparisons.push({
          path: `/items/${i}${path}`,
          verification: 'conflict',
          coverage: 'partial',
          reasonCode: 'SOURCE_DISAGREEMENT',
          selectedValue: value,
          selectionReason: 'Configured source precedence; disagreement retained.',
          ruleVersion: 'source-precedence-1',
          assertions: assertions.map((a, j) => {
            const set = j ? alternative : preferred;
            const source = set.provenance.sources[0];
            return {
              sourceId: source.id,
              value: a.value,
              retrievedAt: set.provenance.retrievedAt,
              sourceVersion: source.version,
              lineageGroup: source.id,
              referenceUrl: source.url,
            };
          }),
        });
    }
  }
  selected.evidenceId = incoming.evidenceId;
  selected.items = selected.items.map((r) =>
    Object.hasOwn(r, 'evidenceId') ? { ...r, evidenceId: selected.evidenceId } : r,
  );
  if (selected.fieldComparisons.length) {
    selected.verification = 'conflict';
    selected.warnings.push({
      code: 'SOURCE_DISAGREEMENT',
      message: 'Source differences require review; preferred-source values are retained.',
      scope: selected.key,
    });
  }
  // Do not assert independence or verified status merely because two providers agree.
  selected.provenance.sources = [
    ...new Map(
      [...preferred.provenance.sources, ...alternative.provenance.sources].map((s) => [s.id, s]),
    ).values(),
  ];
  return selected;
}
