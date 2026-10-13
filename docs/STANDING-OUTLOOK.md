# Standing gaps and conditional title outlook — 13 October 2026

Latest [senior review](SENIOR-REVIEW-2026-10-13.md) records canonical score omission/
coverage degradation, selected-cutoff chronology anchoring, collision-safe podium
identity, aligned typed/status contract domains and frozen full gates300API/720client.
Earlier totals below retain their historical scopes; no live data write occurred.

Current additive [title scenarios](STANDING-SCENARIOS.md) preserve the conservative
target below, but separately allow proven race-wins-only countback dominance.
Equal wins/later stages stay unresolved. Earlier verification below remains dated.

`getStandings` adds `gapToLeader`/`gapCoverage` to each standing row and a single
leader-only `data.titleOutlook` before pagination. All reads share the standing
row's season, cutoff and immutable publication. Decimal arithmetic is reused by
Home's unchanged points-gap calculation; no standings points are reconstructed.

## Approved evidence and scope

Only 2026 currently has a verified scoring profile:
`src/models/scoring-2026.json`, version
`2026-fia-a2.2-issue03-calendar-2026-10-13`. It explicitly records full race maxima
driver25/team43 (25+18), Sprint maxima driver8/team15 (8+7), and no fastest-lap
bonus. Constructor ceilings assume two scoring cars. The reviewed sources are:

- [FIA2026 Section A, Issue03,25 June2026](https://www.fia.com/system/files/documents/fia_2026_f1_regulations_-_section_a_general_provisions_-_iss_03_-_2026-06-25.pdf),
  A2.2.1 and A2.2.2, full-points columns. Reduced-distance awards can be lower.
- [FIA exhaustive2026 Sprint calendar](https://www.fia.com/news/fia-and-formula-1-announce-2026-sprint-calendar):
  Shanghai, Miami, Montreal, Silverstone, Zandvoort and Singapore.
- [Current official2026 race calendar](https://www.formula1.com/en/racing/2026):
  reviewed23-event scope, rather than an obsolete season count.

Every canonical2026 event has an explicit circuit/round/sprint-or-no-sprint entry.
The complete stored calendar must match that reviewed mapping. Missing sprint
sessions are not treated as no-sprint evidence: the affirmative registry supplies
the known schedule, including positively declared Sprint events not yet imported.
An unexpected stored Sprint, missing race index, duplicate/foreign session,
unknown venue/circuit, missing calendar round or conflicting scope is unavailable.
Remaining race dates must be real UTC-roundtripping dates in the owned season and
match their event date; regex/Date.parse normalization alone is insufficient.
Cancelled events contribute no remaining opportunities. Later completed rounds
still represent hypothetical opportunities when inspecting an earlier cutoff;
their actual awarded points are never substituted for the full-points ceiling.

Other years retain score-derived gaps, including fractional/negative published
scores. A missing historical scoring profile never borrows2026 rates. A complete
historical calendar with no remaining events can establish remaining maximum0;
its title target/countback still remain unavailable. Partial historical calendars
do not establish an exhaustive future absence merely because the supplied list ends.

## Math and honest meaning

Leader gap is `published leader points − own published points`, with a unique
rank1 and noncontradictory score context. Null lower ranks and equal-point tied
lower ranks are valid historical data, not missing leader evidence. Contradictory
rank/score order, foreign standing context and ambiguous leading ranks are rejected.
Malformed point rows are omitted from the response and coverage is reduced; they
cannot turn an invalid raw score into a valid derived target or response500.

For the leader's title outlook, the approved trust policy accepts a unique valid
published rank2 as the upper bound for unlisted lower-ranked rivals, even when
generic source coverage is partial. Supplied unranked rivals cannot exceed that
bound. Missing/ambiguous rank1/rank2 or conflicting points cannot establish a target.
Source ranking trust is explicitly disclosed, not promoted to independently
verified complete sporting coverage.

`remainingMaximum = remaining races × race ceiling + remaining Sprints × Sprint ceiling`

`rivalCeiling = highest published rival points + remainingMaximum`

If the leader already exceeds that ceiling, sufficient addition is0. Otherwise:

`sufficientAdditional = rivalCeiling + 1 − leader points`

This one-point safety margin is sufficient, not necessary, under the stated
calendar/rule/participation assumptions. Rivals' independent maxima need not be
simultaneously achievable while the leader scores. Ties/countback and the exact
minimum winning requirement are not calculated. If the target exceeds the available
points, the only conclusion presented is **Conservative target exceeds points
available; Minimum winning requirement not calculated**. It does not establish
elimination or inability to secure the title from future results.

`coverage: conditional` means approved rule/schedule/rank assumptions establish
the displayed bound; generic source coverage is retained separately. Unavailable
reasons distinguish standings, calendar, session, rival-bound and scoring-profile
limitations. Budgets/targets are nonnegative decimal strings or null; the published
rival ceiling may legitimately be negative. `targetWithinAvailablePoints` compares
the sufficient target with the ceiling; it is not a championship-contender flag.

## Integration and cache

`requestDatasets` shares request-local batched reads with the podium projection:
calendar is read once, sessions are loaded in bounded batches, never per standing
row. Source projection precedes slicing, so later pages retain the same leader
summary. Existing standings ETags already include derived data and stable metadata;
calendar/budget/coverage changes invalidate them, equivalent requests retain304.

Client `standingsResponse` alone retains and validates the optional outlook;
generic collection transforms still expose only their existing fields. It validates
publication, context, decimals/counts and whitelists the outlook shape, accepting
legacy omission. Standings Fetch requests use `cache: no-cache` to revalidate the
HTTP response when RTK refetches, preserving conditional ETags. RTK invalidation by
itself did not override Fetch's default mode with server max-age60. Parent observed
an old historical body after refresh and a corrected full reload during hot edits;
the original browser cache path was not independently traced or assigned a cause.

UI uses four row stats and one compact leader summary, all presentation in Apex
with existing tokens. Visible `Gap` retains sr-only ` to leader` and the full title
attribute. An assumptions/source disclosure keeps long explanations out of rows.

## Verification and current checkpoint

API red evidence:20 initial outlook cases,3 invalid/foreign-date cases,2 historical
lower-rank cases. Final new cases25; combined outlook/podium/Home projection94
passed. Final `npm run check`:257 tests, lint/format, OpenAPI/checksum and
Newman117 requests/197 assertions passed. Earlier255 gate predates lower-rank fixes.

Client red evidence:five initial missing UI cases, actual RTK transport dropping
outlook, default Fetch cache-mode assertion, short mobile label, and signed rival
ceiling. Some failures are successive assertions in the same transport test; these
are not nine distinct final test cases. Final client verification passed49 tests
in five files, lint and production build after the short-label/signed-ceiling fixes.
Prebuild validated49 constructor assets/30 country flags. No new assets were added.
Full client suite is not rerun. The existing Vite large-chunk warning remains.
Contract extension regeneration preserved API/client/checksum hashes; unrelated
contract differences remain intact. No import, live write, commit, push or deployment.

At publication `1cf93890-260a-43ad-9cab-9d3170ff43b3`, parent independently checked all23
driver/all11 constructor gaps and2026R17 remaining/target150/49 and258/125. Six
remaining races/no Sprints. Parent also checked2026R1 constructors1036/1021,
22 races/six Sprints. Cody R1 driver GET gives598/592 and gaps0/7/10.
Historical2000R1 GETs show driver gaps0/4/6 and constructor0/12/12, with unavailable
historical title scoring. Parent latest andR1 browser values/three source links
matched; historical became correct after full reload. At390px client/scroll376,
four stat columns68.65px. At320px client/scroll306; title metric values shared
y465.3125 and labels39.60px/two lines. The parent requested the short Gap label to
restore row-stat value alignment. Final parent390 labels all19.801px and first-row
values all at y435.511 (second row603.196); at320 all labels19.801px and no overflow.
Title320 captions39.602px/two lines and both values y465.312. Disclosure toggled
with three sources. External screenshots:
`site-wide/standing-outlook-2026-10-13-{drivers,constructors,mobile,historical-unavailable}.jpg`.
Normal viewport/2026 Drivers Latest/System/disclosure closed restored by parent.
These are sampled browser checks, not all-season or exhaustive accuracy proof.
Final documentation annotations did not trigger additional application tests.

## Changed absolute paths for this outlook assignment

- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/api/src/models/championship-points.js`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/api/src/models/scoring-2026.json`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/api/src/repositories/request-datasets.js`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/api/src/services/standing-outlook.service.js`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/api/src/services/standing-podiums.service.js`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/api/src/services/home-championship-graphics.service.js`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/api/src/services/read.service.js`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/api/tests/standing-outlook.test.js`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/api/scripts/update-standing-outlook-contract.js`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/api/docs/openapi.json`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/api/docs/contract-manifest.json`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/api/docs/STANDING-OUTLOOK.md`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/api/docs/ANALYTICS-METRICS.md`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/client/contracts/openapi.json`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/client/src/api/archiveApi.js`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/client/src/pages/Standings.jsx`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/client/src/design-system/standings-context.css`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/client/tests/standing-outlook.test.jsx`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/client/docs/STANDING-OUTLOOK.md`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/client/docs/CHECKPOINT.md`
- `C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/memory.md` (outside both repositories)

Existing uncommitted podium work and other files are preserved. Configured Cody
settings are gpt-6.1-sol/medium; this is not independent runtime/billing verification.
