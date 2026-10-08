# Analytics metric and scope contract — 8 October 2026

Implements audit UX-01, UX-02 and UX-08. Source records are read at one publication snapshot; no source imports or database rewrites are needed.

## Current senior-review boundary — 8 October 2026

Comparison wins/podiums/fastest laps now use the dashboard's shared rank eligibility:
retained DNS/withdrawn/DSQ ranks cannot count as sporting achievements. Classified
retirement ranks remain eligible; averages/recent form use those same eligible
published positions, not a claim that every ranked record finished. Positive DSQ
laps may establish a start, independently from rank eligibility. Qualifying cannot
use unexpected items from unavailable sets. Standings coverage becomes partial
when mismatched rows are dropped and unavailable when none survive.

Fresh full API check passed163 tests, lint/format, pinned OpenAPI structure/checksum
and Newman114 requests/192 assertions with zero failures. The160-test audit total
below is historical. [Cross-repository senior-review evidence](../../client/docs/SENIOR-REVIEW-2026-10-08.md)
records fail-before checks and the client boundary; no source import/live mutation.

## Championship versus selected results

`championship` is season context. Its `season`, `round` and `snapshotId` identify the published standings. The latest driver standing set determines a single season-owned round; driver and constructor lists are read from the exact corresponding round keys in that publication. Rows with mismatched standing identities and unavailable sets are excluded. Missing standings produce an empty list and unavailable leader, never a derived-points fallback. Published rank, points, wins and supplied number remain source-backed.

Championship context is unaffected by analytical driver, constructor, circuit, session or from/to-round filters. A round range narrows the result analysis; it does not request historical championship standings. The client states both scopes and its View standings action pins the championship publication and round.

`defaultComparison`, `pointsProgression`, `constructorContribution`, position charts, quick stats and `raceBreakdown` use selected result records. Race points exclude sprint points; Sprint includes only published sprint results; neither is labelled championship points. Missing point observations are null, genuine zero points remain zero, and known partial sums are explicitly coverage-limited. Standings themselves are not overwritten to force agreement.

Read-only local trace on 8 October, publication `6d626406-a9da-40af-a0ca-4027f7c12e1e`: Antonelli's Race total 294, Sprint total 26, published championship 320 after round 16. This arithmetic explains the inspected discrepancy within that publication; it does not independently certify the sporting source or every season.

## Retirement and classification

One shared `summarizeOutcomes` definition supplies dashboard and per-driver outcome counts. Retirement rate is **explicit retired entries / known finished-or-retired starts**. The dashboard displays percent; comparison metrics carry a fraction. It is a published-result subset statistic, not an official DNF statistic or a claim of complete-season absence.

| Source state                             | Start handling                        | Retirement-rate handling     |
| ---------------------------------------- | ------------------------------------- | ---------------------------- |
| Finished                                 | Known start                           | Denominator                  |
| Retired, including classified retirement | Known start                           | Numerator and denominator    |
| Not started (DNS), withdrawn             | Non-start                             | Excluded                     |
| Disqualified (DSQ)                       | Start only if positive published laps | Excluded; separately counted |
| Not classified / other status            | Start only if positive published laps | Excluded; separately counted |
| Missing / unknown status                 | Start only if positive published laps | Excluded; separately counted |

Qualifying retirement rate is unavailable. Zero eligible denominator gives null, not 0% or NaN. Classification counts use only the source's explicit true/false boolean; null/missing classification is unknown, even when a position is supplied. Published rankings remain usable for position charts without being interpreted as starts/finishes. The old `dnfRate` field is retained as null for compatibility and is no longer presented by client consumers.

The UI discloses entries, known-outcome denominator, retirements, non-starts, DSQ, other/unknown status and classification unknown counts, with selected publication coverage. The current observed 48.7% retirement rate is a calculation from normalized published statuses, not an independently verified official retirement total.

## Eligibility and empty selections

Entity options come from published entries for the selected season/session, not archive-wide profiles. Circuit options likewise require published entries. Unavailable sets cannot contribute unexpected items. `analysisScope` carries matching entries, published sessions, selected events, coverage and an explicit empty flag. No matching entries produce null point/outcome metrics and no fake driver series. Series with no published point values are not presented as populated charts.

An invalid URL selection is retained visibly with an explanation; Reset analysis filters explicitly returns to the season's default Race slice while retaining its pinned publication. Season/session changes clear dependent entity selections. Season leaders, latest/next race and timeline remain labelled season context; rates and charts are labelled selected-result scope.

## Verification boundary

Latest followup: comparison `pointsPerRace` is null for missing points, zero established starts or Qualifying; genuine zero points with established race/sprint starts remains zero. Qualifying comparison counts published entries explicitly through `qualifyingEntries` and `startDefinition: published qualifying entries`; its legacy `races` metric is an entry count for that session and the client labels it accordingly. It is not evidence of a race start or retirement. Focused API verification now passes 20 cases; see the implementation log for retained fail-first output and the earlier full-suite boundary.

Final consolidated8 October API check passed160 tests, lint/format, pinned
contract checksum and Newman114 requests/192 assertions with zero failures.
The new `AnalyticsChampionship` and `AnalyticsScope` OpenAPI schemas and checksum
manifest describe response additions. Each type has its own driverCoverage or
constructorCoverage and standingSnapshotId rows; there is no championship.coverage
field. Compact client summaries validate season/publication/round-owned rows and
type coverage, preserving source decimals rather than borrowing filtered totals.
Independent fixtures cover race25+sprint8 versus standings33, absent/mismatched
standings, explicit/unknown outcomes and zero denominators, eligibility, no records,
real zero and missing/fractional points. The client [audit implementation log](../../client/docs/UX-AUDIT-IMPLEMENTATION-VERIFICATION.md)
records final436-test/build evidence and all12 accepted browser gates, including
2023 championship575/860 round22 versus selected2242 partial440entries/22sessions.
Fixtures/read-only traces do not establish exhaustive source accuracy or deployment.
