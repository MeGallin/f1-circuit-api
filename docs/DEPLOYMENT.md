# Deployment and import operations

The API is a stateless Docker web service intended for Render. PostgreSQL is external, hosted by Supabase. The browser is a separate static application at `https://f1.livenotice.co.uk`.

## Database setup

Supply the Supabase session-pooler PostgreSQL URL through DATABASE_URL with TLS enabled. Certificate verification remains enabled. Use an approved server-side database role. The migration enables RLS and defines no anonymous/browser policies; a dedicated non-owner role needs explicit reviewed grants/policies. A connection string alone does not grant access. Do not expose Supabase/database credentials to the browser.

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

## Render configuration

1. Select this repository's Dockerfile for the web service.
2. Supply NODE_ENV=production, DATABASE_URL, DATABASE_SSL=true, LOG_LEVEL and exact CORS_ALLOWED_ORIGINS. Render supplies PORT.
3. Configure `/health/ready`. An empty migrated database is ready, but reads return 503 until data is imported.
4. Run imports from a separate approved scheduler/operator environment. No maintenance HTTP endpoint is exposed.
5. Run health and known/unknown-resource/CORS smoke checks after deployment.

The image uses an unprivileged node user and production dependencies only. No persistent volume is required. Logs omit queries, request bodies and credentials. No visitor analytics, tracking cookies or model layer is added. Shutdown stops HTTP intake and closes database connections with a bounded timeout.

No Render or Supabase resources were provisioned. A running Docker engine and actual managed-database integration checks are still needed before deployment.
