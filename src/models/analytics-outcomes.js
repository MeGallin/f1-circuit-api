// Classification is an explicit source boolean, independent of finishing status.
// Retirement rate is a known-outcome subset, not an inferred official DNF rate.
export function summarizeOutcomes(rows) {
  const counts = {
    entries: rows.length,
    starts: 0,
    classified: 0,
    unclassified: 0,
    classificationUnknown: 0,
    retirements: 0,
    retirementEligibleStarts: 0,
    nonStarts: 0,
    disqualified: 0,
    unknownStatus: 0,
    otherStatus: 0,
  };
  for (const row of rows) {
    if (row.classified === true) counts.classified++;
    else if (row.classified === false) counts.unclassified++;
    else counts.classificationUnknown++;
    const knownOutcome = ['finished', 'retired'].includes(row.status);
    const nonStart = ['not-started', 'withdrawn'].includes(row.status);
    if (knownOutcome || (!nonStart && Number(row.lapsCompleted) > 0)) counts.starts++;
    if (knownOutcome) counts.retirementEligibleStarts++;
    if (row.status === 'retired') counts.retirements++;
    else if (nonStart) counts.nonStarts++;
    else if (row.status === 'disqualified') counts.disqualified++;
    else if (!row.status || row.status === 'unknown') counts.unknownStatus++;
    else if (row.status !== 'finished') counts.otherStatus++;
  }
  return {
    ...counts,
    retirementRate: counts.retirementEligibleStarts
      ? counts.retirements / counts.retirementEligibleStarts
      : null,
  };
}
