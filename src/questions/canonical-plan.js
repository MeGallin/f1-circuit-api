import { normalizeQuestion as normalize } from './period.js';

// A small semantic fast path. Names are already canonical; unknown wording is
// delegated to the planner rather than guessed by a missing-name branch.
export function canonicalPlan(text, profiles, period) {
  const lower = normalize(text);
  const named = (kind) =>
    profiles
      .filter(
        (profile) => profile.kind === kind && lower.includes(normalize(profile.entity.displayName)),
      )
      .sort(
        (a, b) =>
          lower.indexOf(normalize(a.entity.displayName)) -
          lower.indexOf(normalize(b.entity.displayName)),
      );
  const drivers = named('driver');
  const constructors = named('constructor');
  const driverName = drivers[0]?.entity.displayName;
  const comparisonDriverName = drivers[1]?.entity.displayName;
  const range = { fromYear: period.fromYear, toYear: period.toYear };
  const count = /\b(how many|number of|count|total|tally)\b/.test(lower);
  const wins = /\b(wins?|won|victor(?:y|ies))\b/.test(lower);
  const comparison = /\b(compare|comparison|compared|versus|vs|than)\b/.test(lower);
  if (driverName && /\b(championships?|world titles?)\b/.test(lower) && !constructors.length)
    return { intent: 'driver_stat', driverName, metric: 'championships', ...range };
  if (
    /\b(constructors?|manufacturers?|teams?)\b/.test(lower) &&
    /\bmost\b/.test(lower) &&
    /\bpoints\b/.test(lower)
  )
    return {
      intent: 'constructor_points_leaderboard',
      metric: 'points',
      scope: 'season',
      ...range,
    };
  if (
    driverName &&
    /\b(first|debut|last|latest|most recent)\b/.test(lower) &&
    !count &&
    !/\bmost\s+(wins|podiums|fastest)\b/.test(lower)
  ) {
    const direction = /\bfirst|debut\b/.test(lower) ? 'first' : 'last';
    if (wins) return { intent: `driver_${direction}_win`, driverName, ...range };
    if (/\b(race|grand prix|start)\b/.test(lower))
      return { intent: `driver_${direction}_race`, driverName, ...range };
  }
  if (driverName && wins && (count || comparison)) {
    if (comparisonDriverName && comparison)
      return { intent: 'driver_race_wins_comparison', driverName, comparisonDriverName, ...range };
    if (constructors.length) return null; // Do not discard a constructor constraint.
    return {
      intent: period.fromYear ? 'driver_race_wins_season' : 'driver_race_wins',
      driverName,
      metric: 'race_wins',
      ...range,
    };
  }
  return null;
}
