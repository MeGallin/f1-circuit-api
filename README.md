# F1 Circuit API

Backend repository for the F1 Circuit historical and post-race application.

## Current uncommitted senior review — 8 October 2026

Fresh full check passed163 tests, lint/format, pinned OpenAPI checksum and Newman
114 requests/192 assertions, zero failures. Comparison rank eligibility and coverage
guards are aligned without erasing classified retirements or real zero values.
See [current review](../client/docs/SENIOR-REVIEW-2026-10-08.md) and
[metric definitions](docs/ANALYTICS-METRICS.md). Earlier audit totals below are
historical. All changes remain local/uncommitted; no deployment or live mutation.

## Current local audit verification — 8 October 2026

UX-01/02/08 use publication/round-owned championship standings, explicit
retirement/unknown outcomes, eligible season/session filters and null versus real
zero semantics. Final `npm run check` passed lint/format,160 tests, OpenAPI
structure/checksum and Newman114 requests/192 assertions, zero failures.
All twelve companion UI gates are parent-browser accepted; its final check passed
436 tests/43 files and build. See [analytics metrics](docs/ANALYTICS-METRICS.md)
and [audit evidence](../client/docs/UX-AUDIT-IMPLEMENTATION-VERIFICATION.md).
These changes are local/uncommitted, not deployed. No provider import/live writes.

## Deployed verification — 7 October 2026 (separate from local audit)

The user confirmed push of API `7bb44fe`. Parent browser evidence confirms Render Live at 17:48 BST with readiness HTTP 200 and successful [Actions run #8](https://github.com/MeGallin/f1-circuit-api/actions/runs/37655393608) on the same commit after replacement of the existing CA secret. Secure database connectivity and the scheduler's `scheduled` decision are verified; post-race provider publication, future cron cadence and broader production smoke/concurrency checks remain pending. The earlier TLS coding verification passed 147 API tests; no tests were rerun for this documentation followup. See [current evidence](docs/FUNCTIONALITY-VALIDATION.md) and [secret mapping, CA setup and troubleshooting](docs/DEPLOYMENT.md). These findings supersede the relevant pending statuses in the historical review below.

## Race-update review — 6 October 2026

Local Git history confirms API commit `734a4ed`; the companion client commit is `fb7cbd0`. The user confirmed both pushes. Deployment and production smoke verification for these commits remain **PENDING**; a push is not evidence of a deployed release.

The review hardened manual cooldown checks under the shared importer lock, connection cleanup, source corrections and enrichment retention. Automatic imports retain their data breadth with a four-minute provider budget and results/standings fetched before optional detail. `npm run check` passed: 133 API tests, lint/format, contract verification and Newman 114 requests / 192 assertions, zero failures. The companion client passed 141 tests, lint and production build. See [review evidence and limits](docs/FUNCTIONALITY-VALIDATION.md), [refresh operations](docs/DEPLOYMENT.md) and [refresh retention](docs/ENRICHMENT-RETENTION.md). Actions secrets/dispatch and real PostgreSQL multi-process locking are unverified. The earlier foundation description below is historical scope, not current release verification.

## Historical foundation milestone

The default development branch is `main`. This historical vertical slice provided Express health/readiness, exact CORS, safe errors, PostgreSQL publications, validated provider imports and all 35 contract route boundaries. Dataset coverage varied: unsupported enrichments and unqualified historical metrics were explicitly unavailable. No natural-language implementation was included at that milestone.

Install with `npm ci`, supply an external PostgreSQL `DATABASE_URL` following `.env.example`, run `npm run migrate`, then `npm start`. Environment files are not loaded automatically; inject environment variables or use Node's `--env-file` option locally. Never commit real values. `npm test`, `npm run lint` and `npm run format:check` verify this milestone. Repository tests use pg-mem as a test double; PostgreSQL RLS/locking and managed-database connectivity need a real integration check before deployment. Docker engine availability is required for `docker build -t f1-circuit-api .`.

## Architecture and repository guidance

See [coverage and limitations](docs/COVERAGE.md), [deployment and import instructions](docs/DEPLOYMENT.md), the pinned [OpenAPI contract](docs/openapi.json) and [Postman report](docs/POSTMAN-REPORT.md).

Run `npm run check` for lint, formatting, deterministic tests, contract integrity and an actual Newman/Postman run. The Postman runner starts a loopback-only fixture server without production configuration. Production dependency audit is clean; Newman's development-only dependency tree has outstanding advisories, so use only the trusted local collection without real credentials. Newman is excluded from the Docker image.

Node.js and Express with plain JavaScript, using normalized PostgreSQL data. Public requests will read published local data snapshots; provider fetching and reconciliation belong to ingestion jobs.

| Directory                                         | Responsibility                                        |
| ------------------------------------------------- | ----------------------------------------------------- |
| `src/routes`, `src/controllers`                   | HTTP routing and request/response translation         |
| `src/services`                                    | Application use cases                                 |
| `src/models`, `src/repositories`                  | Persistence mappings and database access              |
| `src/providers`                                   | Isolated external source adapters                     |
| `src/schemas`, `src/middleware`, `src/config`     | Validation, HTTP concerns and configuration           |
| `src/ingestion`, `src/reconciliation`, `src/jobs` | Background imports, comparison and publication        |
| `src/questions`                                   | Deterministic question handling                       |
| `src/errors`, `src/observability`                 | Error definitions and operational diagnostics         |
| `supabase/migrations`                             | Versioned database migrations                         |
| `fixtures`                                        | Reviewed synthetic or permitted provider test records |
| `scripts`                                         | Maintenance and import commands                       |
| `docs`                                            | API contracts and backend documentation               |

Provider folders reserve the planned adapter boundaries; their presence does not mean those providers are enabled or verified. Empty folders use `.gitkeep` placeholders.

The client will be a separate repository. Neither project may rely on untracked files in its sibling directory. Keep credentials, private data and local environment files out of Git; use reviewed example configuration when implementation begins.
