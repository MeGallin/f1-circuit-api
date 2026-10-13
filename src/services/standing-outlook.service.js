import profile2026 from '../models/scoring-2026.json' with { type: 'json' };
import { pointsGap, publishedScore } from '../models/championship-points.js';
import { ownedSeasonDate as seasonDate } from '../models/season-date.js';
import { titleScenarios, unavailableScenarios } from './title-scenarios.js';

const available = (set) => ['complete', 'partial'].includes(set?.coverage);
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 160;
const assumptions = [
  'Based on this publication’s calendar; full points, unchanged rules, no additional events or penalties.',
  'Published unique ranks 1 and 2 bound unlisted lower-ranked rivals, even when overall source coverage is partial.',
  'One-point safety margin; sufficient, not necessary. Minimum winning requirement and countback are not calculated.',
];
function rankedStandings(set, year, requestedRound) {
  if (!available(set) || !Array.isArray(set.items) || !set.items.length || set.items.length > 256)
    return null;
  const match = /^standing:(\d+):([1-9]\d*)$/.exec(set.items[0]?.standingSnapshotId || '');
  const round = Number(match?.[2]);
  if (
    !match ||
    Number(match[1]) !== year ||
    round > 64 ||
    (requestedRound && round !== requestedRound)
  )
    return null;
  const ids = new Set(),
    ranks = new Set();
  for (const row of set.items) {
    if (
      !row ||
      row.standingSnapshotId !== match[0] ||
      !id(row.entity?.id) ||
      ids.has(row.entity.id) ||
      (row.rank !== null && (!Number.isSafeInteger(row.rank) || row.rank < 1)) ||
      (row.rank !== null && row.rank <= 2 && ranks.has(row.rank)) ||
      !publishedScore(row.points)
    )
      return null;
    ids.add(row.entity.id);
    ranks.add(row.rank);
  }
  const ranked = set.items.filter((row) => row.rank !== null).sort((a, b) => a.rank - b.rank);
  const rows = [...ranked, ...set.items.filter((row) => row.rank === null)];
  if (
    rows[0]?.rank !== 1 ||
    rows.some((row) => publishedScore(row.points).gt(rows[0].points)) ||
    ranked.some(
      (row, index) =>
        index &&
        (publishedScore(row.points).gt(ranked[index - 1].points) ||
          (row.rank === ranked[index - 1].rank &&
            !publishedScore(row.points).eq(ranked[index - 1].points))),
    )
  )
    return null;
  return { rows, round, standingSnapshotId: match[0] };
}
export class StandingOutlookService {
  async project(set, { year, kind, round: requestedRound, snapshotId, readMany }) {
    if (!set || !Array.isArray(set.items)) return set;
    const context = rankedStandings(set, year, requestedRound);
    const leader = context?.rows[0];
    const outlook = {
      year,
      round: context?.round || null,
      snapshotId,
      standingSnapshotId: context?.standingSnapshotId || null,
      coverage: 'unavailable',
      reasonCode: 'STANDINGS_CONTEXT_UNAVAILABLE',
      leaderId: leader?.entity.id || null,
      leaderName: leader?.entity.displayName || null,
      remainingMaximum: null,
      sufficientAdditional: null,
      rivalCeiling: null,
      targetWithinAvailablePoints: null,
      remainingRaces: null,
      remainingSprints: null,
      ruleVersion: null,
      sourceUrls: [],
      assumptions,
    };
    const validPoints = set.items.filter((row) => publishedScore(row?.points));
    outlook.scenarios = unavailableScenarios(outlook);
    const result = {
      ...set,
      coverage:
        validPoints.length === set.items.length
          ? set.coverage
          : validPoints.length
            ? 'partial'
            : 'unavailable',
      titleOutlook: outlook,
      items: validPoints.map((row) => ({
        ...row,
        gapToLeader: context ? (pointsGap(leader.points, row.points)?.toFixed() ?? null) : null,
        gapCoverage: context ? set.coverage : 'unavailable',
      })),
    };
    try {
      if (!context) return result;
      const first = await readMany([`events:${year}`]);
      const calendar = first.get(`events:${year}`);
      const events = calendar?.items;
      outlook.reasonCode = 'CALENDAR_CONTEXT_UNAVAILABLE';
      if (!available(calendar) || !Array.isArray(events) || !events.length || events.length > 64)
        return result;
      const ids = new Set(),
        rounds = new Set();
      for (const event of events) {
        if (
          !event ||
          !id(event.id) ||
          event.year !== year ||
          !Number.isSafeInteger(event.round) ||
          event.round < 1 ||
          event.round > 64 ||
          ids.has(event.id) ||
          rounds.has(event.round) ||
          !['completed', 'scheduled', 'cancelled'].includes(event.status)
        )
          return result;
        ids.add(event.id);
        rounds.add(event.round);
      }
      if (
        Math.max(...rounds) !== events.length ||
        !rounds.has(context.round) ||
        events.some(
          (event) =>
            event.round <= context.round && !['completed', 'cancelled'].includes(event.status),
        )
      )
        return result;
      const remaining = events.filter(
        (event) => event.round > context.round && event.status !== 'cancelled',
      );
      if (year !== profile2026.year) {
        outlook.reasonCode = 'SCORING_PROFILE_UNAVAILABLE';
        // A complete historical calendar can prove zero without a scoring rate.
        if (calendar.coverage === 'complete' && !remaining.length) {
          outlook.remainingMaximum = '0';
          outlook.remainingRaces = 0;
          outlook.remainingSprints = 0;
        }
        return result;
      }
      outlook.ruleVersion = profile2026.version;
      outlook.sourceUrls = profile2026.sources;
      if (events.length !== profile2026.events.length) return result;
      for (const event of events) {
        const known = profile2026.events.find((known) => known.round === event.round);
        if (
          !known ||
          event.id !== `event:2026:${known.event}` ||
          event.circuit?.id !== `circuit:${known.circuit}`
        )
          return result;
      }
      outlook.reasonCode = 'SESSION_CONTEXT_UNAVAILABLE';
      const sessionSets = await readMany(remaining.map((event) => `sessions:${event.id}`));
      const sessionIds = new Set();
      for (const event of remaining) {
        const sessions = sessionSets.get(`sessions:${event.id}`);
        if (!available(sessions) || !Array.isArray(sessions.items) || sessions.items.length > 32)
          return result;
        for (const session of sessions.items) {
          if (
            !session ||
            !id(session.id) ||
            session.eventId !== event.id ||
            sessionIds.has(session.id)
          )
            return result;
          sessionIds.add(session.id);
        }
        const races = sessions.items.filter((session) => session.kind === 'race');
        const sprints = sessions.items.filter((session) => session.kind === 'sprint');
        const known = profile2026.events.find((known) => known.round === event.round);
        if (
          races.length !== 1 ||
          sprints.length > 1 ||
          (!known.sprint && sprints.length) ||
          !['completed', 'scheduled', 'unknown'].includes(races[0].status) ||
          sprints.some(
            (sprint) => !['completed', 'scheduled', 'unknown'].includes(sprint.status),
          ) ||
          !seasonDate(races[0].schedule?.date, year) ||
          races[0].schedule.date !== event.schedule?.date
        )
          return result;
      }
      outlook.remainingRaces = remaining.length;
      outlook.remainingSprints = remaining.filter(
        (event) => profile2026.events.find((known) => known.round === event.round).sprint,
      ).length;
      const maximum = publishedScore(profile2026.race[kind])
        .times(outlook.remainingRaces)
        .plus(publishedScore(profile2026.sprint[kind]).times(outlook.remainingSprints));
      outlook.remainingMaximum = maximum.toFixed();
      outlook.reasonCode = 'RIVAL_BOUND_UNAVAILABLE';
      const second = context.rows.find((row) => row.rank === 2);
      if (
        !second ||
        context.rows.some(
          (row) => row.rank === null && publishedScore(row.points).gt(second.points),
        )
      )
        return result;
      const ceiling = publishedScore(second.points).plus(maximum);
      const own = publishedScore(leader.points);
      const additional = own.gt(ceiling) ? publishedScore('0') : ceiling.plus(1).minus(own);
      outlook.rivalCeiling = ceiling.toFixed();
      outlook.sufficientAdditional = additional.toFixed();
      outlook.targetWithinAvailablePoints = additional.lte(maximum);
      outlook.coverage = 'conditional';
      outlook.reasonCode = null;
      outlook.scenarios = titleScenarios({
        outlook,
        rows: context.rows,
        remaining,
        sessionSets,
        profile: profile2026,
        cutoffDate: events.find((event) => event.round === context.round)?.schedule?.date,
        kind,
        sourceCoverage: set.coverage,
        completedRaces: events.filter(
          (event) => event.round <= context.round && event.status === 'completed',
        ).length,
      });
      return result;
    } finally {
      if (outlook.coverage !== 'conditional') outlook.scenarios = unavailableScenarios(outlook);
    }
  }
}
