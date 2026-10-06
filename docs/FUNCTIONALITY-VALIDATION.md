# Functionality validation

## Race-update review — 6 October 2026

Local Git logs confirm API `734a4ed` and companion client `fb7cbd0`. Both pushes are user-confirmed. Deployment and production/live smoke verification for these commits are **PENDING**.

### Fixes and regression evidence

- Manual current-UTC-year refresh selects the latest precise scheduled past race, including outside the automatic window. It uses single-flight requests and a shared five-minute cooldown rechecked under the advisory lock, before inserting its own audit row. A cooldown rejection does not create a failed run or restart the cooldown.
- Import cleanup preserves the original work error when failure auditing fails. An unlock failure still releases and destroys the connection rather than returning a potentially locked session to the pool.
- Core source corrections can remove fastest-lap, winner/podium data and obsolete standing rows. Previously imported calendar/session/geography/profile and omitted enrichment data are retained. Manual refresh fetches results plus optional qualifying/standings, without heavy lap/pit-stop imports.
- Automatic imports retain qualifying, sprint, pit-stop and lap breadth, fetch required results/standings before optional detail and use a four-minute total provider budget. Existing enrichments survive unavailable optional reads. Cancelled/postponed events are excluded; the default gate remains start +6h through start +30h, at 15-minute intervals.
- The companion client invalidates catalogue, season summary/calendar/standings, event and session caches. Button/countdown states follow server `retryAfterMs`, including busy responses. Unmount/season changes abort the request and clear timers. Historical refresh reloads archive data only. Pending selection handles precise unknown-status events, final races and ISO clocks without resurfacing an older unknown race after a newer completed race.

New regression tests failed before the corresponding fixes; the final focused client run passed 36/36. Recorded complete checks: API `npm run check` passed lint, formatting, 133 tests, OpenAPI/checksum verification and Newman 114 requests / 192 assertions with zero failures. Client `npm run check` passed lint, 141 tests and production build. Both `git diff --check` checks passed. No live imports, commits, pushes or deployments were performed by the review agent; the subsequent pushes were confirmed by the user. This documentation update does not rerun those runtime checks.

### Remaining verification

Production deployment/version, production-origin CORS and live smoke behavior are pending. GitHub Actions secret setup and successful dispatch are unverified; real PostgreSQL multi-process advisory-lock/cooldown behavior has only deterministic test-double coverage in this review. Database statements have individual timeouts, not a total publication deadline, so the ten-minute Actions budget is not guaranteed. The ten-second API shutdown deadline can interrupt an import; uncommitted transactions rely on PostgreSQL rollback. Client build passed with the existing large-chunk warning. See [deployment operations](DEPLOYMENT.md), [retention](ENRICHMENT-RETENTION.md) and [fixture-only Newman report](POSTMAN-REPORT.md).

## Historical validation — 18 September 2026

The following observations and dataset/deployment boundaries describe that checkpoint only; they were not rechecked on 6 October.

## Changes

Explicit snapshot requests cannot read a staging archive publication. Published historical snapshots remain readable. Comparison requests validate entity kinds and known years; valid season comparisons return unavailable coverage until metrics exist. Missing source standings ranks remain null instead of being inferred from row order.

## Verification

- `npm run check`: lint, formatting, 28 local tests, OpenAPI checksum/schema checks, Newman 110 requests / 184 assertions; no failures.
- Tests selected from tracked files plus `tests/semantic-reads.test.js`: 25 passed. The additional three local tests belong to preserved, uncommitted optional bulk work and are not included in this change.
- `node --env-file=.env scripts/check-product-api.js public`: 35 operations and ten representative season summaries; zero schema/status failures.
- `node --env-file=.env scripts/check-product-api.js staged`: same 45 checks; zero failures. This is a private, in-process read-only repository override, not a public endpoint or activation. HTTP checks have 10-second response / 15-second deadline limits and the script has a 120-second overall limit.
- Read-only database verification: staging, activation_held=true, publicly_active=false, 175 committed round checkpoints, zero before 2019.

## Boundaries

Public data remains the 2024 calendar and British GP validation detail. Staged calendars span 2019–2026; final archive coverage reconciliation has not run. No importing, enrichment, activation, or deployment was performed. These fixes are not yet in the deployed API. Migration 002 is required by snapshot filtering and is already part of the repository's migration sequence.

Profiles and histories passed API contract checks; dedicated client profile/history/comparison pages remain outside the currently implemented UI. Schema validation does not establish historical source accuracy or completeness. Optional bulk changes and the pre-existing deleted .env.example are excluded.
