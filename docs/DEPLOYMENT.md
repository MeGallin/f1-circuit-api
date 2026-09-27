# Deployment and import operations

The API is a stateless Docker web service intended for Render. PostgreSQL is external, hosted by Supabase. The browser is a separate static application at `https://f1.livenotice.co.uk`.

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

## Render configuration

1. Select this repository's Dockerfile for the web service.
2. Supply NODE_ENV=production, DATABASE_URL, DATABASE_SSL=true, LOG_LEVEL and exact CORS_ALLOWED_ORIGINS. Render supplies PORT.
3. Configure `/health/ready`. An empty migrated database is ready, but reads return 503 until data is imported.
4. Run imports from a separate approved scheduler/operator environment. No maintenance HTTP endpoint is exposed.
5. Run health and known/unknown-resource/CORS smoke checks after deployment.

The image uses an unprivileged node user and production dependencies only. No persistent volume is required. Logs omit queries, request bodies and credentials. The optional question interpreter and fallback rephraser run server-side only when enabled; they do not receive database tools and do not provide final archive answers. No visitor analytics or tracking cookies are added. Shutdown stops HTTP intake and closes database connections with a bounded timeout.

No Render or Supabase resources were provisioned. A running Docker engine and actual managed-database integration checks are still needed before deployment.
