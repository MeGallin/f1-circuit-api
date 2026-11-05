// Inspect requested seasons and calendar-owned race evidence, not just whichever
// result datasets happened to exist. Absence is never a complete zero.
export async function raceCoverage(sets, fromYear, toYear, helpers) {
  const raceSets = sets.filter((set) =>
    set?.items?.some((row) => row.sessionId?.endsWith(':race')),
  );
  const years = new Set(
    raceSets.flatMap((set) =>
      set.items.map((row) => Number(row.sessionId?.match(/event:(\d{4}):/)?.[1])),
    ),
  );
  const missingYears = [];
  const missingEvents = [];
  let incompleteCalendar = false;
  if (Number.isInteger(fromYear) && Number.isInteger(toYear))
    for (let year = fromYear; year <= toYear; year++) {
      if (!years.has(year)) missingYears.push({ year });
      const calendar = await helpers.get(`events:${year}`);
      if (!calendar || calendar.coverage !== 'complete') incompleteCalendar = true;
      for (const event of calendar?.items || [])
        if (['completed', 'finished'].includes(event.status)) {
          const set = await helpers.get(`results:session:${event.id}:race`);
          if (!set?.items?.length || !['complete', 'partial'].includes(set.coverage))
            missingEvents.push({ event: event.name, year });
        }
    }
  return {
    coverage:
      incompleteCalendar ||
      missingYears.length ||
      missingEvents.length ||
      raceSets.some((set) => set.coverage !== 'complete' || set.warnings?.length)
        ? 'partial'
        : 'complete',
    missingYears,
    missingEvents,
  };
}
