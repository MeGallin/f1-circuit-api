// Strict owned-season calendar date; Date.parse alone normalizes impossible days.
export function ownedSeasonDate(value, year) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) &&
    date.getUTCFullYear() === year &&
    date.toISOString().slice(0, 10) === value
  );
}
