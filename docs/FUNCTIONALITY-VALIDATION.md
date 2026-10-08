# Functionality validation

## Current senior review — 8 October 2026

Fresh `npm run check`: lint/format,163 tests, pinned OpenAPI structure/checksum and
Newman114 requests/192 assertions, zero failures. Shared comparison rank eligibility,
unavailable qualifying rows and rejected-standings coverage have independent
fail-first regressions. See [metric contract](ANALYTICS-METRICS.md) and
[cross-repository review](../../client/docs/SENIOR-REVIEW-2026-10-08.md).
Earlier160/158 counts below remain dated history; no deployment/live writes/imports.

## Analytics audit batch — 8 October 2026

UX-01/02/08 now distinguish published championship standings from selected-result points, share an explicit retirement/unknown outcome definition, and limit entity options to published season/session entries. Season context remains independent of analytical circuit/round/entity filters. Missing records remain unavailable; standings links pin publication and round. See [metric/scope contract](ANALYTICS-METRICS.md) and the [implementation verification log](../../client/docs/UX-AUDIT-IMPLEMENTATION-VERIFICATION.md).

Final consolidated API `npm run check` on8 October passed lint, formatting,
160 tests, OpenAPI structure/checksum and Newman114 requests/192 assertions,
zero failures. The earlier158-test first-batch check is historical. Companion
client passed436 tests/43 files, lint/asset guard/build; all12 parent browser
gates are accepted, including the repaired grid and consolidated Analytics.
Eight initial API regressions plus missing-points and rate/Qualifying followups
failed before fixes; exact retained logs are linked above. Local read-only trace
confirms320 published championship versus294 Race+26 Sprint in one publication.
No commit/push/deploy/provider import/live DB write; these fixtures do not verify
live locking, post-race publication or source accuracy. The deployed TLS checkpoint
below remains separate from this local/uncommitted audit.

## Deployment and Actions TLS verification — 7 October 2026

This checkpoint supersedes the earlier pending API deployment and Actions configuration/manual-dispatch statuses. Evidence is supplied by the parent's browser review, not new checks in this documentation-only task. The user confirmed push of `7bb44feba032f9ce254d88911faa2ba59666a82e`; [Render deployment](https://dashboard.render.com/web/srv-damhhhbm8hqs73d62b8g/deploys/dep-db37fpnlk1mc739ml4a0) reached Live at 17:48 BST on 7 October with readiness HTTP 200.

Run #5 lacked the workflow's required secrets. The user initially supplied a secret named `DATABASE_URL`, then supplied the exact repository names `F1_CIRCUIT_DATABASE_URL` and `SUPABASE_DATABASE_CA_PEM`. [Run #6](https://github.com/MeGallin/f1-circuit-api/actions/runs/37654033670) on `c7dd38d` failed with `SELF_SIGNED_CERT_IN_CHAIN` at publication readiness. Cody reproduced a URL SSL override defect using the real local connection plus a synthetic `ssl` parameter, then stripped seven SSL-related URL options. Twelve intended regressions failed before the fix; afterward all 15 focused TLS tests and the full 147-test API suite passed, with focused lint, formatting and diff checks. These are dated earlier 7 October coding results, not tests rerun for this followup; the full `npm run check`/Newman workflow was not rerun for that fix.

The actual local URL had no query parameters. The 1367-character local CA matched the official Supabase certificate fingerprint documented in [deployment operations](DEPLOYMENT.md). The old synthetic override caused `SELF_SIGNED_CERT_IN_CHAIN`; the fixed connection passed `SELECT 1` and publication readiness with authorized TLS 1.3. This proves the code defect and local recovery, not the original Actions secret contents.

[Run #7](https://github.com/MeGallin/f1-circuit-api/actions/runs/37655123659) still failed with the same TLS error on deployed `7bb44fe`. Under user authorization the parent replaced the existing `SUPABASE_DATABASE_CA_PEM` secret with the full locally verified official CA text; GitHub confirmed the update at 17:51 BST. The database URL secret and Supabase settings were unchanged. Prior secret contents were unreadable, so no specific claim about their original defect is supported.

[Run #8](https://github.com/MeGallin/f1-circuit-api/actions/runs/37655393608) succeeded on the same `7bb44fe` after CA replacement: 21 seconds overall, 15-second job, log `One-shot current-season check finished: scheduled.` Secure database connectivity and the scheduler decision are verified. Actions runs directly against Supabase independently of Render; a Render deployment does not configure GitHub secrets. The CA is publicly distributed certificate material, not a private key. The runner writes it to a temporary file, maps that path to `DATABASE_SSL_CA_FILE` and removes it on exit. Certificate and hostname verification remain enabled.

Still pending: an eligible post-race provider import through publication, future scheduled-trigger cadence, real PostgreSQL multi-process advisory-lock/cooldown verification, production-origin CORS and broader live/client smoke behavior. The successful `scheduled` run exercised no provider import. This documentation followup changes no implementation, executes no application tests, and makes no commit, push, deployment, import, live write or secret update.

## Race-update review — 6 October 2026

Local Git logs confirm API `734a4ed` and companion client `fb7cbd0`. Both pushes are user-confirmed. Deployment and production/live smoke verification for these commits are **PENDING**.

This is the historical 6 October status; the 7 October checkpoint above supersedes API deployment and Actions connectivity/dispatch pending items only.

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
