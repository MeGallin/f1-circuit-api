# Deployment and import operations

The API is a stateless Docker web service intended for Render. PostgreSQL is external, hosted by Supabase. The browser is a separate static application at `https://f1.livenotice.co.uk`.

## Current release verification — 7 October 2026

The user confirmed the TLS fix was pushed as `7bb44feba032f9ce254d88911faa2ba59666a82e`. Parent browser evidence confirms [Render deployment](https://dashboard.render.com/web/srv-damhhhbm8hqs73d62b8g/deploys/dep-db37fpnlk1mc739ml4a0) reached **Live** on 7 October at 17:48 BST on that commit, with readiness HTTP 200. [Actions run #8](https://github.com/MeGallin/f1-circuit-api/actions/runs/37655393608) succeeded on the same commit after replacement of the existing CA secret, logging `One-shot current-season check finished: scheduled.` Secure database connectivity and the scheduler decision are verified. Post-race provider fetch/publication, future scheduled-trigger cadence, production-origin CORS and real PostgreSQL multi-process lock/cooldown behavior remain unverified. This supersedes the deployment and Actions configuration/dispatch pending statuses below, without claiming full production validation.

## Historical release verification — 6 October 2026

Local logs confirm API `734a4ed` and companion client `fb7cbd0`; the user confirmed both pushes. Deployment and production/live smoke verification for these commits are **PENDING**. The local review passed API `npm run check` (133 tests, lint/format, contract checks, Newman 114 requests / 192 assertions) and client `npm run check` (141 tests, lint, production build). These fixture/local checks do not establish production behavior. See [review evidence](FUNCTIONALITY-VALIDATION.md).

The historical checks above do not establish current Actions connectivity. See the 7 October TLS checkpoint below. Real PostgreSQL multi-process importer-lock/cooldown verification remains pending.

## Actions database TLS checkpoint — 7 October 2026

[Workflow run #6](https://github.com/MeGallin/f1-circuit-api/actions/runs/37654033670) failed on commit `c7dd38d`; the supplied log reports `SELF_SIGNED_CERT_IN_CHAIN` at `PublicationRepository.ready`. Secret names were verified by the parent, but their stored values are not inspectable and are not established as correct by this investigation.

The installed `pg` parser reparses the pool connection string when constructing a client. In addition to `sslmode`, `sslcert`, `sslkey` and `sslrootcert`, URL `ssl` can replace the explicit SSL object and lose its configured CA; `sslnegotiation=direct` can implicitly enable SSL with the same effect. `uselibpqcompat` changes SSL mode semantics. The local fix strips all seven options, keeping application TLS policy authoritative and preserving other URL parameters. Certificate and hostname verification remain enabled. See [node-postgres SSL documentation](https://node-postgres.com/features/ssl). The regression checks effective client settings, rather than only the pool's unparsed options.

Read-only local evidence on 7 October:

- The local URL had no query parameter names. The unchanged local configuration passed `SELECT 1` before the fix.
- HTTPS fetch of the [official Supabase CA](https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt), independently identified by the parent in Database Settings, matched the existing 1367-character local certificate. Both SHA-256 certificate fingerprints were `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`. The credential file was not overwritten.
- Adding a synthetic `ssl` URL option to that same local connection reproduced `SELF_SIGNED_CERT_IN_CHAIN` under the old handling. With the fix, the same connection passed `SELECT 1` and `PublicationRepository.ready`; the TLS socket reported `authorized: true`, protocol TLS 1.3.
- Twelve regression cases failed before the fix; all 15 focused TLS tests passed afterward. The fresh full `npm test` run passed 147 tests; focused ESLint, Prettier and `git diff --check` also passed. These checks establish the code defect and local recovery, not the contents of Actions secrets or the definitive cause of run #6. The broader `npm run check`/Newman workflow was not rerun for this configuration-only fix.

The evidence above was collected during the earlier coding investigation; its 147-test result was not rerun for this documentation followup. That investigation made no workflow dispatch, deployment, provider import, live database write or Supabase/GitHub setting change. The parent observed Supabase SSL enforcement off and left it unchanged; the application still verifies TLS.

Subsequent parent browser evidence, 7 October:

- Run #5 failed for missing configuration. The user initially added a repository secret named `DATABASE_URL`, then supplied the workflow's required names `F1_CIRCUIT_DATABASE_URL` and `SUPABASE_DATABASE_CA_PEM`.
- Run #6 failed on `c7dd38d` as recorded above. After the user pushed the code fix and Render deployed `7bb44fe`, [run #7](https://github.com/MeGallin/f1-circuit-api/actions/runs/37655123659) still failed with `SELF_SIGNED_CERT_IN_CHAIN`.
- Under user authorization, the parent updated the **existing** `SUPABASE_DATABASE_CA_PEM` repository secret with the full locally verified official CA text; GitHub confirmed the update at 17:51 BST. The database URL secret was not changed. The prior stored PEM was unreadable, so its original defect cannot be identified as a path, truncation or any other specific mistake.
- [Run #8](https://github.com/MeGallin/f1-circuit-api/actions/runs/37655393608) then succeeded on the **same** `7bb44fe` commit in 21 seconds (job: 15 seconds), logging `One-shot current-season check finished: scheduled.` This supports CA secret replacement as the intervention that resolved the remaining runner trust failure. It verifies secure database connection and a scheduler decision; it exercised no provider import or end-to-end post-race publication and does not prove future cron cadence.

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

The repository secret must be named exactly `F1_CIRCUIT_DATABASE_URL`; the workflow maps it to the process environment variable `DATABASE_URL`. A repository secret named only `DATABASE_URL` is not read by this workflow. `SUPABASE_DATABASE_CA_PEM` holds the full certificate text, including PEM boundaries and line breaks, not a filesystem path. This certificate is a publicly distributed CA certificate, not a private key. Local and Render `DATABASE_SSL_CA_FILE` instead name a readable file on their respective hosts. The runner creates its own temporary PEM, sets `DATABASE_SSL_CA_FILE` to that runner path and uses an exit trap to remove it. Never put a local Windows path into the PEM secret.

Actions connects directly to Supabase and runs the scheduler in its own process; it does not call Render. A successful Render deployment neither updates GitHub repository secrets nor establishes Actions connectivity.

### Troubleshooting the runner

- Missing configuration: check the two exact repository secret names and workflow mapping. The startup guard fails before a database connection when either required value is empty.
- TLS trust failure: compare the CA against the official certificate and ensure the secret contains its complete text. Inspect only sanitized URL parameter names and certificate metadata; never print credentials or PEM contents. The code strips URL SSL overrides while retaining certificate and hostname verification. Do not bypass TLS verification.
- Provider/publication failure: only investigate this stage after secure database connectivity succeeds and an eligible race window actually causes a provider check. A successful `scheduled` decision does not test provider availability, imports, publication or concurrency.

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
cadence or an operational guarantee. Secret configuration and manual dispatch
succeeded on 7 October as recorded above; future scheduled-trigger cadence
has not yet been observed. No paid Render upgrade is assumed.

## Render configuration

1. Select this repository's Dockerfile for the web service.
2. Supply NODE_ENV=production, DATABASE_URL, DATABASE_SSL=true, LOG_LEVEL and exact CORS_ALLOWED_ORIGINS. Render supplies PORT.
3. Configure `/health/ready`. An empty migrated database is ready, but reads return 503 until data is imported.
4. Keep `AUTO_SYNC_ENABLED=true` for in-process catch-up and configure the optional GitHub Actions runner as described above for best-effort checks while a Free instance sleeps. The runner uses the approved server-side database role; no maintenance HTTP endpoint is exposed for automated imports.
5. Run health and known/unknown-resource/CORS smoke checks after deployment.

The image uses an unprivileged node user and production dependencies only. No persistent volume is required. Logs omit queries, request bodies and credentials. The optional question interpreter and fallback rephraser run server-side only when enabled; they do not receive database tools and do not provide final archive answers. No visitor analytics or tracking cookies are added. Shutdown stops HTTP intake and closes database connections with a bounded timeout.

No Render or Supabase resources were provisioned by this documentation task. The 7 October parent evidence confirms the deployed API and runner connectivity; broader integration and production smoke checks remain bounded by the pending items above.
