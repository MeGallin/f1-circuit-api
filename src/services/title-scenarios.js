import { publishedScore as score } from '../models/championship-points.js';
import { ownedSeasonDate as validDate } from '../models/season-date.js';

export const unavailableScenarios = (outlook, reasonCode = outlook.reasonCode) => ({
  snapshotId: outlook.snapshotId,
  standingSnapshotId: outlook.standingSnapshotId,
  coverage: 'unavailable',
  reasonCode: reasonCode || 'SCENARIO_EVIDENCE_UNAVAILABLE',
  now: null,
  next: null,
  earliest: null,
  constantGap: null,
  winningPattern: null,
});
function chronology(events, sessionSets, profile, kind, cutoffDate) {
  if (!validDate(cutoffDate, profile.year)) return null;
  const opportunities = [];
  for (const event of events) {
    const known = profile.events.find((row) => row.round === event.round);
    const sessions = sessionSets.get(`sessions:${event.id}`)?.items;
    const race = sessions?.find((session) => session.kind === 'race');
    if (!known || !race || !validDate(race.schedule?.date, profile.year)) return null;
    const add = (sessionKind, date) =>
      opportunities.push({
        eventId: event.id,
        name: event.name || `Round ${event.round}`,
        round: event.round,
        kind: sessionKind,
        date,
        maximum: profile[sessionKind][kind],
      });
    if (known.sprint) {
      const sprint = sessions.find((session) => session.kind === 'sprint');
      const date = sprint?.schedule?.date || known.sprintDate;
      if (
        !validDate(date, profile.year) ||
        date >= race.schedule.date ||
        (sprint && date !== known.sprintDate)
      )
        return null;
      add('sprint', date);
    }
    add('race', race.schedule.date);
  }
  opportunities.sort((a, b) => a.date.localeCompare(b.date));
  if (
    opportunities.length > 128 ||
    opportunities.some(
      (event, i) =>
        event.date <= cutoffDate ||
        (i &&
          (event.date === opportunities[i - 1].date || event.round < opportunities[i - 1].round)),
    )
  )
    return null;
  return opportunities;
}
const total = (opportunities) =>
  opportunities.reduce((sum, event) => sum.plus(event.maximum), score('0'));
const races = (opportunities) => opportunities.filter((event) => event.kind === 'race').length;
function awards(profile, kind, sessionKind) {
  const table = profile.awards[sessionKind].map((value) => score(value));
  if (kind === 'drivers')
    return {
      leader: table[0],
      nearest: table[1],
      other: table[2],
      allowed: [...table.slice(1), score('0')],
      finish: (value) => table.findIndex((points) => points.eq(value)) + 1 || null,
    };
  const tail = [...table.slice(2), score('0'), score('0')];
  const sums = new Map();
  for (let i = 0; i < tail.length; i++)
    for (let j = i + 1; j < tail.length; j++) {
      const sum = tail[i].plus(tail[j]);
      sums.set(sum.toFixed(), sum);
    }
  return {
    leader: table[0].plus(table[1]),
    nearest: table[2].plus(table[3]),
    other: table[4].plus(table[5]),
    allowed: [...sums.values()].sort((a, b) => b.comparedTo(a)),
    finish: () => null,
  };
}
function comparison(own, rival, remaining, ownWins, remainingRaces) {
  const ceiling = score(rival.points).plus(remaining);
  if (own.gt(ceiling)) return { secured: true, tie: false, method: 'strict-points', ceiling };
  if (own.eq(ceiling)) {
    if (ownWins !== null && rival.wins !== null && ownWins > rival.wins + remainingRaces)
      return { secured: true, tie: false, method: 'wins-countback', ceiling };
    return { secured: false, tie: true, method: null, ceiling };
  }
  return { secured: false, tie: false, method: null, ceiling };
}
function assess(own, rivals, remaining, ownWins, remainingRaces) {
  const comparisons = rivals.map((rival) =>
    comparison(own, rival, remaining, ownWins, remainingRaces),
  );
  return {
    secured: comparisons.every((row) => row.secured),
    unresolved:
      comparisons.every((row) => row.secured || row.tie) && comparisons.some((row) => row.tie),
    strongestRivalCeiling:
      comparisons
        .reduce((max, row) => (max === null || row.ceiling.gt(max) ? row.ceiling : max), null)
        ?.toFixed() ?? null,
    method: comparisons.some((row) => row.method === 'wins-countback')
      ? 'wins-countback'
      : 'strict-points',
  };
}

// Bounded constructive paths, not a general combinatorial or exact countback solver.
export function titleScenarios({
  outlook,
  rows,
  remaining,
  sessionSets,
  profile,
  kind,
  sourceCoverage,
  completedRaces,
  cutoffDate,
}) {
  if (outlook.coverage !== 'conditional') return unavailableScenarios(outlook);
  const opportunities = chronology(remaining, sessionSets, profile, kind, cutoffDate);
  if (!opportunities || !profile.awards)
    return unavailableScenarios(outlook, 'SCENARIO_CHRONOLOGY_UNAVAILABLE');
  const leader = rows[0],
    nearest = rows.find((row) => row.rank === 2);
  const knownWinSum = rows.reduce(
    (sum, row) => sum + (Number.isSafeInteger(row.wins) && row.wins >= 0 ? row.wins : 0),
    0,
  );
  const win = (row) =>
    Number.isSafeInteger(row.wins) &&
    row.wins >= 0 &&
    row.wins <= completedRaces &&
    knownWinSum <= completedRaces
      ? row.wins
      : null;
  const rivals = rows
    .filter((row) => row.entity.id !== leader.entity.id)
    .map((row) => ({
      entityId: row.entity.id,
      name: row.entity.displayName || row.entity.id,
      points: row.points,
      wins: win(row),
    }));
  // Equal points at the rank2 upper bound imply no better existing wins count
  // for an unlisted lower-ranked rival under the disclosed source ranking trust.
  const shadow =
    sourceCoverage === 'partial'
      ? {
          entityId: null,
          name: 'Any unlisted challenger',
          points: nearest.points,
          wins: win(nearest),
        }
      : null;
  const all = shadow ? [...rivals, shadow] : rivals;
  const own = score(leader.points),
    ownWins = win(leader),
    remainingMax = total(opportunities);
  const initial = assess(own, all, remainingMax, ownWins, races(opportunities));
  const now = {
    status: initial.secured ? 'secured' : initial.unresolved ? 'tie-unresolved' : 'not-secured',
    method: initial.secured ? initial.method : null,
  };
  const nextEvent = opportunities[0];
  const next = {
    status: nextEvent ? 'not-proven' : 'no-opportunities',
    event: nextEvent || null,
    leaderGain: null,
    remainingAfter: null,
    conditions: [],
    unlistedCondition: null,
  };
  if (nextEvent) {
    const allocation = awards(profile, kind, nextEvent.kind);
    const after = opportunities.slice(1),
      budget = total(after),
      addedWin = nextEvent.kind === 'race' ? 1 : 0;
    const condition = (rival) => {
      for (const gain of allocation.allowed) {
        const result = comparison(
          own.plus(allocation.leader),
          { ...rival, points: score(rival.points).plus(gain).toFixed() },
          budget,
          ownWins === null ? null : ownWins + addedWin,
          races(after),
        );
        if (result.secured)
          return {
            entityId: rival.entityId,
            name: rival.name,
            maximumPoints: gain.toFixed(),
            finishAtOrBelow: kind === 'drivers' ? allocation.finish(gain) : null,
            tieResolution: result.method === 'wins-countback' ? 'wins-countback' : null,
          };
      }
      return {
        entityId: rival.entityId,
        name: rival.name,
        maximumPoints: null,
        finishAtOrBelow: null,
        tieResolution: null,
      };
    };
    const alive = rivals.filter((rival) => score(rival.points).plus(remainingMax).gte(own));
    next.conditions = alive.map(condition);
    next.unlistedCondition =
      shadow && score(shadow.points).plus(remainingMax).gte(own) ? condition(shadow) : null;
    next.leaderGain = allocation.leader.toFixed();
    next.remainingAfter = budget.toFixed();
    if (
      [...next.conditions, ...(next.unlistedCondition ? [next.unlistedCondition] : [])].every(
        (row) => row.maximumPoints !== null,
      )
    )
      next.status = 'possible';
  }
  const gap = own.minus(nearest.points);
  const constantGap = { status: 'hypothetical', event: null, remainingAfter: null };
  const earliest = {
    status: initial.secured ? 'already-secured' : 'not-proven',
    event: null,
    leaderPoints: null,
    strongestRivalCeiling: null,
    witness:
      kind === 'drivers'
        ? 'Leader wins; all other competitors score zero.'
        : 'Leader team finishes 1–2; all other teams score zero.',
  };
  const winningPattern = {
    status: initial.secured ? 'already-secured' : 'not-proven',
    event: null,
    leaderPoints: null,
    strongestRivalCeiling: null,
    outcome:
      kind === 'drivers'
        ? 'Leader first, nearest challenger second; other rivals use independent upper bounds from third place, not simultaneous finishing-place allocations.'
        : 'Leader team 1–2, nearest team 3–4; other teams use independent upper bounds from fifth and sixth places, not simultaneous finishing-place allocations.',
  };
  let gains = score('0'),
    addedWins = 0,
    earlierTie = initial.unresolved;
  const patternRivals = all.map((rival) => ({ ...rival }));
  for (let i = 0; i < opportunities.length; i++) {
    const event = opportunities[i],
      allocation = awards(profile, kind, event.kind);
    const after = opportunities.slice(i + 1),
      budget = total(after);
    gains = gains.plus(allocation.leader);
    if (event.kind === 'race') addedWins++;
    const wins = ownWins === null ? null : ownWins + addedWins;
    const optimistic = assess(own.plus(gains), all, budget, wins, races(after));
    if (!initial.secured && !earliest.event) {
      if (optimistic.secured)
        Object.assign(earliest, {
          status: earlierTie ? 'proven-path' : 'possible',
          event,
          leaderPoints: own.plus(gains).toFixed(),
          strongestRivalCeiling: optimistic.strongestRivalCeiling,
        });
      else if (optimistic.unresolved) earlierTie = true;
    }
    patternRivals.forEach((rival) => {
      rival.points = score(rival.points)
        .plus(rival.entityId === nearest.entity.id ? allocation.nearest : allocation.other)
        .toFixed();
    });
    const pattern = assess(own.plus(gains), patternRivals, budget, wins, races(after));
    if (!initial.secured && !winningPattern.event && pattern.secured)
      Object.assign(winningPattern, {
        status: 'guaranteed-path',
        event,
        leaderPoints: own.plus(gains).toFixed(),
        strongestRivalCeiling: pattern.strongestRivalCeiling,
      });
    if (!constantGap.event && budget.lt(gap))
      Object.assign(constantGap, { event, remainingAfter: budget.toFixed() });
  }
  return {
    snapshotId: outlook.snapshotId,
    standingSnapshotId: outlook.standingSnapshotId,
    coverage: 'conditional',
    reasonCode: null,
    now,
    next,
    earliest,
    constantGap,
    winningPattern,
  };
}
