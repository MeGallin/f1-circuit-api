# Performance analytics API

The performance analytics slice is intentionally additive. It reads the active
published snapshot through the existing `PublicationRepository`; it does not
create a second database, query upstream providers at request time, or infer
missing values.

## Endpoints

### `GET /api/v1/seasons/{year}/championship-graphics`

Home-only bounded projection: required `standingSnapshotId=standing:{year}:{round}`,
optional immutable `snapshotId`, conditional ETag. The server selects the exact
published top three for both championships; no arbitrary entity IDs or pagination
parameters. Maximum64 completed rounds, at/before that standing round.
`championshipGraphics` contains driver and constructor round-owned standings gaps
with exact decimal strings, null/missing and per-cell coverage. Each kind uses
that round's unique rank-one leader across all rows, including leaders outside
the displayed top three. Sprint scoring belongs to published championship points.
Constructor cells carry points, gap, rank, leaderId/name/points and coverage;
the superseded Home mosaic contributions/roster payload is removed. Driver cells
retain supplementary race-only entry points and raceCoverage for exact inspection.
Aggregate coverage is complete only when the calendar, every displayed standings
cell and every supplementary driver race cell are complete. Missing race evidence
lowers the aggregate to partial without changing valid standings-cell coverage;
missing/malformed calendar scope is unavailable. Malformed classification rows or
driver arrays invalidate race evidence rather than crashing or inventing zero.
Three existing repository batch phases read one publication; no provider fetches,
N+1 HTTP calls or writes. OpenAPI/manifest own validation. See
[metric definitions](ANALYTICS-METRICS.md) and the
[client contract/browser limits](../../client/docs/HOME-CHAMPIONSHIP-GRAPHICS.md).

### `GET /api/v1/analytics/dashboard`

Supported query parameters:

- `season` — four-digit season; when omitted, the latest published season is used.
- `fromRound`, `toRound` — optional inclusive round bounds.
- `driverIds`, `constructorIds`, `circuitIds` — comma-separated canonical IDs.
- `sessionType` — `race`, `qualifying`, or `sprint`; defaults to `race`.
- `snapshotId` — optional immutable publication snapshot.

The response contains `analyticsDashboard` with normalized filters and eligible
published-season/session options, `analysisScope`, `championship`, quick statistics,
latest/next highlights, points progression, qualifying versus finish rows,
constructor contribution, circuit performance, default comparison and season
intelligence. Championship is season context: published standings at one season,
round and publication, unaffected by analytical round/entity/circuit/session filters.
`driverCoverage` and `constructorCoverage` are separate; there is no shared
`championship.coverage`. Rows retain source rank/decimal points and the matching
`standingSnapshotId`. Mismatched rows lower coverage; none surviving means
unavailable, never a selected-points fallback.

Quick statistics and result charts use the selected result slice, not championship
totals. Podium rate uses eligible ranked podiums over established starts. Retirement
rate is explicit retired entries over known finished-or-retired starts: dashboard
percent, comparison fraction. DSQ/non-start/other/unknown outcomes are separately
reported and excluded from that retirement denominator. It is not an official DNF
claim. Zero denominator and Qualifying retirement rate are null; legacy `dnfRate`
is null. Classification uses only explicit source booleans, independently of rank
or retirement; missing classification is unknown.

Season intelligence retains published progress, championship leaders and latest/
next events, labelled season context rather than selected-result totals. Latest
race podium/fastest-lap attribution is supplied only when published.
`latestSessionHighlights` adds the supporting published datasets for the latest
selected session when they exist: weather ranges and rainfall observations,
tyre-stint summaries, pit-stop totals, overtake leaders, and race-control flag
events. Each dataset carries its own coverage state, so an unavailable historical
publication remains visible as unavailable rather than being treated as zero.
The selected-result breakdown reports entries, established starts, explicit
classified/unclassified/unknown classification counts, retirements, known-outcome
denominator, non-starts, DSQ, other/unknown status, eligible wins/podiums and
fastest laps. Each section reflects the
published archive and may be empty when the selected snapshot does not contain
the required dataset.

### `GET /api/v1/analytics/driver-comparison`

Accepts the same analytical filters; `drivers` is a comma-separated list of
canonical driver IDs. If omitted, drivers in the selected published slice are
compared. Metrics include established starts, shared eligible wins/podiums/fastest
laps, selected points, average grid/finish, positions gained, explicit outcomes,
retirement rate, points per race and recent form. Retained DSQ/DNS/withdrawn ranks
cannot count as achievements; classified-retirement ranks remain eligible.
Average finish and recent form use eligible published ranks, not assumed finishes.
Qualifying reports `qualifyingEntries` and an explicit start definition; its legacy
`races` is an entry count, not a race-start claim. Points per race is null for
missing points, zero established starts or Qualifying; actual zero with starts stays
zero. `dnfRate` remains null. See [precise outcome/scope contract](ANALYTICS-METRICS.md).

## Data rules

1. Selected published Race/Sprint/Qualifying records own their analytical metrics;
   Race point totals exclude Sprint points. Championship uses published standings.
2. Points progression is cumulative over the selected event order; a missing
   result remains `null`, rather than becoming zero.
3. Available published qualifying rows join selected rows by driver ID and event;
   unexpected items from unavailable sets cannot supply either dataset.
4. Constructor contribution is summed from the points on the selected result
   rows, preserving decimal values.
5. Circuit cells contain the published finish position and an explicit start
   count. A circuit enters the performance view only when the selected session
   has published driver rows; scheduled events without results do not reserve
   chart space and appear automatically after their results are published. No
   ranking or completion is invented for missing data.
6. `meta.snapshotId`, coverage, freshness, verification, sources, and warnings
   come from the existing publication metadata.

## Client contract

The client route is `/analytics`, with route-loaded ECharts and shared Apex UI.
One compact scope/summary band precedes Points progression; six season-context
panels remain reachable in a closed native disclosure after the primary analyses.
View standings pins the championship publication/round. Pending entity selectors
cannot borrow old-season choices; known season/session controls remain usable.
Invalid URL selections are explained with explicit reset. Responsive/enlarged-text
controls remain contained; missing points never receive populated-series captions.
Custom tooltip text is escaped. [Current review](../../client/docs/SENIOR-REVIEW-2026-10-08.md)
records completed163 API/460 client checks; this documentation pass reruns no tests
and verifies no new deployment.
