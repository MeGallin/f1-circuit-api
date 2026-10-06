# Deployment and import operations

The API is a stateless Docker web service intended for Render. PostgreSQL is external, hosted by Supabase. The browser is a separate static application at `https://f1.livenotice.co.uk`.

## Release verification — 6 October 2026

Local logs confirm API `734a4ed` and companion client `fb7cbd0`; the user confirmed both pushes. Deployment and production/live smoke verification for these commits are **PENDING**. The local review passed API `npm run check` (133 tests, lint/format, contract checks, Newman 114 requests / 192 assertions) and client `npm run check` (141 tests, lint, production build). These fixture/local checks do not establish production behavior. See [review evidence](FUNCTIONALITY-VALIDATION.md).

Actions secrets `F1_CIRCUIT_DATABASE_URL` / `SUPABASE_DATABASE_CA_PEM`, successful workflow dispatch and real PostgreSQL multi-process importer-lock/cooldown verification remain unverified. The instructions below are setup/run procedures, not a record that they have been completed. No live imports or deployment checks were performed for this documentation update.

## Database setup

Supply the Supabase session-pooler PostgreSQL URL through DATABASE_URL with TLS enabled. Certificate verification remains enabled. Use an approved server-side database role. The migration enables RLS and defines no anonymous/browser policies; a dedicated non-owner role needs explicit reviewed grants/policies. A connection string alone does not grant access. Do not expose Supabase/database credentials to the browser.

For Supabase's certificate chain, download the server root CA from the project's Database Settings → SSL configuration → Download certificate. Store it locally in `credentials/supabase-ca.pem` (ignored by Git) and set `DATABASE_SSL_CA_FILE` to its absolute path in the local `.env`. This configures trust only for the database connection; certificate and hostname verification remain enabled. A missing configured file fails closed. Never disable certificate verification to resolve a trust error. See [Supabase SSL guidance](https://supabase.com/docs/guides/platform/ssl-enforcement).

Locally run `node --env-file=.env scripts/migrate.js` and `npm run dev`. `npm run sync` loads `.env` when it exists; production services must still receive their environment through the deployment environment, and the optional file flag does not replace that injection. Node's startup CA settings are not reliably loaded from `--env-file`; use the explicit database CA file setting above. Production must supply the CA file and its runtime path separately; do not deploy a Windows-local path or assume the ignored file is included in the Docker image.

Run `npm run migrate` as a release step with the migration-authorized role. It holds an advisory lock, tracks files and runs pending migrations in a transaction. Take an external logical backup first and test restoration separately before launch. Container files are not backups. Environment variables must be injected; `.env` is not loaded automatically.

## Source import commands

```sh
npm run sync -- jolpica 2024 12
npm run sync -- f1db /path/to/f1db.json EXPECTED_SHA256 2024.12.0 2024 12
npm run sync -- f1db /path/to/f1db.json EXPECTED_SHA256 2024.12.0 2024 12 /path/to/reviewed-id-mapping.json
npm run sync -- openf1 CANONICAL_SESSION_ID HISTORICAL_SESSION_KEY
```

These illustrate arguments, not locally installed releases. F1DB needs a pinned single-JSON archive and matching trusted checksum. Mapping keys `driver:archive-id`, `constructor:archive-id` and `circuit:archive-id` map to reviewed canonical identity suffixes. Without mappings F1DB identities are namespaced. Cross-source venue mismatches stop publication for review. A checksum is not a licence grant.

OpenF1 requires OPENF1_ENABLED=true, a previously imported backbone session and explicit upstream session key. Date/kind must match and the session must have ended. No live subscription is used. Shared-drive and unsupported historical mappings remain explicit limitations.

Jolpica requests use a custom user agent, eight-second serialization, bounded paging, timeouts, response-size caps and bounded retries. Weekend import covers that round plus the year calendar; repeat for other rounds. No public sync endpoint exists. Sync commands are serialized with a database advisory lock. Failed publication retains the previous data; no synthetic production seed is provided.

The current-season manual source-check endpoint described below is the only public refresh route; it does not authorize arbitrary operator sync parameters.

The API can optionally watch each race in the current published season for
results. The scheduler is disabled by default; set `AUTO_SYNC_ENABLED=true` to
enable it. The first check is scheduled at `AUTO_SYNC_GRACE_MS` after the
published scheduled start (default 21600000ms / six hours), then repeats every
`AUTO_SYNC_INTERVAL_MS` (default 900000ms / 15 minutes) for at most
`AUTO_SYNC_WINDOW_MS` (default 86400000ms / 24 hours). The watched interval is
`[scheduled start + AUTO_SYNC_GRACE_MS, scheduled start + AUTO_SYNC_GRACE_MS +
AUTO_SYNC_WINDOW_MS)`, which defaults to `[start +6h, start +30h)`. The calendar
exposes no actual finish timestamp: 24 hours is measured from the +6h
activation, not from a known finish. If the race finishes within that initial
six-hour grace, this gives at least 24 hours of post-finish coverage; the
schedule does not claim finish-time precision. Date-only events without a
precise scheduled timestamp are not monitored.

On startup/restart, the scheduler immediately catches up only if the current
time is inside a race's activation-to-expiry window, skips expired windows, or
sets one timer for the next activation. It does not query the provider between
race windows. While no window is active it performs a sparse database-only
catalogue/publication rescan every `AUTO_SYNC_RESCAN_MS` (default 21600000ms / 6
hours) so newly published calendars are noticed. A watch ends once race result
rows, the completed race session, and current driver and constructor standings
for that round are all present in one published snapshot, or at the window
deadline. Partial optional-provider coverage leaves the watch active for retry.
Imports use the same advisory lock and `SyncService` path as the operator
command; provider or database failures are logged and leave the prior
publication active. The read-only `GET /api/v1/publication-config` response
exposes only timing values, whether automatic sync is configured, the scheduled
start anchor, and whether date-only events are monitored. For example, the
default timing shape is `{"automaticRaceResults":{"enabled":false,"intervalMs":900000,"graceMs":21600000,"windowMs":86400000,"rescanMs":21600000,"anchor":"scheduled-race-start","dateOnlyRacesMonitored":false}}`.
`enabled` is configuration, not a live scheduler heartbeat. No provider or
database credential is exposed to the browser.

## Manual latest-race refresh

`POST /api/v1/refresh-data` accepts only `{ "season": <current UTC year> }`;
it never accepts a caller-selected round or provider parameters. The API picks
the latest scheduled race whose precise start time has passed and checks the
race-result source. This explicit user-triggered check is allowed after the
automatic start+6-hour/24-hour watch has expired, so a missed result can be
recovered without reopening recurring polling. Automatic and manual work still
share the PostgreSQL advisory lock.

Manual checks are single-flight and use a shared five-minute cooldown. A
successful response distinguishes `updated` (a publication was activated),
`unchanged` (the source was checked and the active data already matches),
`pending` (the source has not published race results), `busy`, `cooldown`, and
`no-race`. Updated/unchanged/pending/busy/cooldown responses include the
server's remaining `retryAfterMs`; source-check outcomes include the check
time. Cooldown is rechecked under the shared lock before creating an audit
run; rejection does not record a failed run or extend the cooldown. Cleanup
preserves the original importer error if its failure audit cannot be written,
and destroys a connection if releasing its advisory lock fails.
Provider/network failures return the standard API 503 error
envelope. The importer prioritizes race results and treats qualifying and
standings as optional enrichment; it does not fetch lap/pit-stop pages. A
failed or pending check does not replace the active database publication, so
the client can keep/reload its existing published snapshot. Source reads have
a 29-second total budget; database publication is additional work. Current
refresh preserves omitted enrichments while accepting core source corrections;
see [retention behavior](ENRICHMENT-RETENTION.md).

## Free-instance scheduled checks

Render Free instances can spin down while idle, so their in-process timer is
best-effort across sleep. The repository includes a GitHub Actions one-shot
runner at `.github/workflows/current-season-sync.yml`. It invokes the same
current-season scheduler and window gates: outside an eligible race window it
only reads the published database calendar and never polls Jolpica; inside the
window it uses the existing sync advisory lock. The automatic watch remains
anchored at scheduled start +6 hours and expires 24 hours later.

To enable the runner, configure the repository Actions secrets
`F1_CIRCUIT_DATABASE_URL` (approved server-side database role) and
`SUPABASE_DATABASE_CA_PEM` (the verified database CA PEM). The workflow writes
the CA only to the ephemeral runner's temporary directory and removes it at
job exit; it contains references to secrets only and does not provision or
copy them. Then use **Actions → Current-season race results check → Run
workflow** for the initial smoke check. Outside a race window this verifies
the credentials, database connection, and scheduler's database-only path. To
exercise a provider import, dispatch only while a race's configured window is
active and its publication is incomplete.

Automatic provider reads have a four-minute total budget, including calendar,
pagination, retries and rate-limit waits. Results and championship standings
are fetched before optional qualifying, sprint, pit-stop and lap pages. Prior
enrichments survive unavailable optional reads. This leaves room within the
ten-minute Actions job limit for publication and cleanup, but database statements
are bounded individually (15 seconds), so the total database publication time
is not guaranteed. The API shutdown deadline is ten seconds; an in-flight
import may be interrupted, with an uncommitted publication rolled back by
PostgreSQL. A stale running audit row is retried through the advisory lock.

GitHub scheduled jobs are best-effort: they can be delayed or dropped, and a
public repository with no activity for 60 days can have scheduled workflows
disabled. The cron is intentionally offset to minutes 7, 22, 37, and 52 to
avoid the top of the hour; this is not a guaranteed 15-minute service-level
cadence or an operational guarantee. The user confirmed the code push, but
secrets setup and a successful manual dispatch remain unverified as of
6 October 2026. No paid Render upgrade is assumed.

## Render configuration

1. Select this repository's Dockerfile for the web service.
2. Supply NODE_ENV=production, DATABASE_URL, DATABASE_SSL=true, LOG_LEVEL and exact CORS_ALLOWED_ORIGINS. Render supplies PORT.
3. Configure `/health/ready`. An empty migrated database is ready, but reads return 503 until data is imported.
4. Keep `AUTO_SYNC_ENABLED=true` for in-process catch-up and configure the optional GitHub Actions runner as described above for best-effort checks while a Free instance sleeps. The runner uses the approved server-side database role; no maintenance HTTP endpoint is exposed for automated imports.
5. Run health and known/unknown-resource/CORS smoke checks after deployment.

The image uses an unprivileged node user and production dependencies only. No persistent volume is required. Logs omit queries, request bodies and credentials. The optional question interpreter and fallback rephraser run server-side only when enabled; they do not receive database tools and do not provide final archive answers. No visitor analytics or tracking cookies are added. Shutdown stops HTTP intake and closes database connections with a bounded timeout.

No Render or Supabase resources were provisioned. A running Docker engine and actual managed-database integration checks are still needed before deployment.
