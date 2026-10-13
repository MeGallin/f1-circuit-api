import Decimal from 'decimal.js';
const Score = Decimal.clone({ precision: 128 });
export const publishedScore = (value) =>
  typeof value === 'string' && /^-?(0|[1-9]\d*)(\.\d+)?$/.test(value) && value.length <= 120
    ? new Score(value)
    : null;

export function pointsGap(leader, own) {
  const leading = publishedScore(leader),
    points = publishedScore(own);
  const gap = leading && points ? leading.minus(points) : null;
  return gap && !gap.isNegative() ? gap : null;
}
