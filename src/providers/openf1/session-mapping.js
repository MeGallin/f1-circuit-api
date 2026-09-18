import reviewedMappings from './session-mapping.json' with { type: 'json' };

function dateInTimeZone(value, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(value))
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value: part }) => [type, part]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function oneUtcDayApart(a, b) {
  return (
    Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) === 24 * 60 * 60 * 1000
  );
}

export function reviewedSessionMapping(canonicalSessionId, openf1SessionKey) {
  const mapping = reviewedMappings[canonicalSessionId];
  return mapping?.openf1SessionKey === openf1SessionKey ? mapping : null;
}

export function matchesSessionDate(canonicalSession, openf1Session, event, mapping) {
  const upstreamDate = openf1Session.date_start?.slice(0, 10);
  if (!mapping || !event) return canonicalSession.schedule.date === upstreamDate;
  if (
    mapping.canonicalSessionId !== canonicalSession.id ||
    mapping.canonicalEventId !== canonicalSession.eventId ||
    mapping.openf1SessionKey !== openf1Session.session_key ||
    mapping.canonicalYear !== event.year ||
    mapping.canonicalRound !== event.round ||
    mapping.canonicalCircuitId !== event.circuit?.id ||
    mapping.openf1CircuitShortName !== openf1Session.circuit_short_name ||
    mapping.canonicalYear !== openf1Session.year ||
    !mapping.timeZone
  )
    return false;
  if (canonicalSession.schedule.date === upstreamDate) return true;
  if (!mapping.timeZone) return false;
  return (
    dateInTimeZone(openf1Session.date_start, mapping.timeZone) === canonicalSession.schedule.date &&
    oneUtcDayApart(canonicalSession.schedule.date, upstreamDate)
  );
}
