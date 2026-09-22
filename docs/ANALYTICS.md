# Performance analytics API

The performance analytics slice is intentionally additive. It reads the active
published snapshot through the existing `PublicationRepository`; it does not
create a second database, query upstream providers at request time, or infer
missing values.

## Endpoints

### `GET /api/v1/analytics/dashboard`

Supported query parameters:

- `season` — four-digit season; when omitted, the latest published season is used.
- `fromRound`, `toRound` — optional inclusive round bounds.
- `driverIds`, `constructorIds`, `circuitIds` — comma-separated canonical IDs.
- `sessionType` — `race`, `qualifying`, or `sprint`; defaults to `race`.
- `snapshotId` — optional immutable publication snapshot.

The response contains `analyticsDashboard` with normalized filters and options,
quick statistics, latest/next highlights, points progression, qualifying versus
finish rows, constructor contribution, circuit performance cells, a default
driver comparison, season intelligence, and deterministic insights. Season
intelligence contains the published season-progress totals, championship and
constructor leaders, the latest completed race with its podium and fastest-lap
attribution when present, up to five leading result rows for the latest race,
and the next scheduled event with its circuit and race-start schedule. Quick
statistics also expose podium and DNF rates calculated from published starts.
`latestSessionHighlights` adds the supporting published datasets for the latest
selected session when they exist: weather ranges and rainfall observations,
tyre-stint summaries, pit-stop totals, overtake leaders, and race-control flag
events. Each dataset carries its own coverage state, so an unavailable historical
publication remains visible as unavailable rather than being treated as zero.
The season-intelligence breakdown reports entries, starts, classified finishes,
DNFs, wins, podiums, and fastest laps from the selected published result rows.
Each section reflects the
published archive and may be empty when the selected snapshot does not contain
the required dataset.

### `GET /api/v1/analytics/driver-comparison`

Accepts the same season and round filters. `drivers` is a comma-separated list
of canonical driver IDs. If it is omitted, all drivers present in the selected
race-result slice are compared. The response reports starts, wins, podiums,
points, average grid/finish, positions gained, DNF rate, fastest laps, points
per race, and recent form.

## Data rules

1. Race results are the source of truth for race-level metrics.
2. Points progression is cumulative over the selected event order; a missing
   result remains `null`, rather than becoming zero.
3. Qualifying rows are joined to race rows by canonical driver ID and event.
4. Constructor contribution is summed from the points on the selected result
   rows, preserving decimal values.
5. Circuit cells contain the published finish position and an explicit start
   count. No ranking or completion is invented for missing data.
6. `meta.snapshotId`, coverage, freshness, verification, sources, and warnings
   come from the existing publication metadata.

## Client contract

The client route is `/analytics`. It uses the existing F1 Circuit design tokens
and shared UI primitives, with Apache ECharts loaded only for that route. The
dashboard is responsive: filters collapse into a single column, statistic cards
reduce to two columns, and chart panels stack on narrow screens. The client
must retain the archive language that distinguishes unavailable data from zero.
