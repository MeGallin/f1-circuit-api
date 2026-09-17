import Decimal from 'decimal.js';
export function compareAssertions(assertions) {
  if (!assertions.length) return { state: 'unassessed', selected: null };
  const first = assertions[0];
  const equivalent = (a, b) =>
    a.unit === b.unit &&
    (a.unit === 'points'
      ? new Decimal(a.value).eq(b.value)
      : JSON.stringify(a.value) === JSON.stringify(b.value));
  if (assertions.some((a) => !equivalent(a, first)))
    return { state: 'conflict', selected: first.value };
  return {
    state: new Set(assertions.map((a) => a.lineage)).size > 1 ? 'reconciled' : 'source-only',
    selected: first.value,
  };
}
