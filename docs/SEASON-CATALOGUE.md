# Provider-backed season catalogue

Run `node --env-file=.env scripts/sync.js jolpica seasons` to import Jolpica's paginated `seasons.json` index into the existing snapshot store. It does not fetch all race weekends and does not call the provider during an HTTP read request.

Only provider-returned season years are added. Existing imported event, result and standings datasets are retained, as are their season counts and coverage. New catalogue-only seasons have coverage `unavailable` and zero imported calendar/result counts. Those counts do not assert that the season had zero races. The catalogue envelope includes that distinction as a warning and retains provider attribution and source observations. Repeated catalogue imports are idempotent by canonical season identity. Provider capabilities from earlier imports are retained.

The existing `/seasons` contract is unchanged. Rows are returned newest first and isCurrent is computed against the server runtime UTC year. Known catalogue-only years return empty calendar/standings envelopes with unavailable coverage, and a summary identifying the season without race facts. Unknown years still return 404. Detailed data remains a separate explicitly selected weekend import.

Real provider index checked on 18 September 2026: 77 season records, 1950 through 2026. This is a reported source result, not a generated year range. No Render deployment is part of this change.

## Refresh integration — 6 October 2026

The current-season manual refresh uses the already-published catalogue/calendar to select the latest precise scheduled past race; it does not generate a calendar or import the season index on demand. Cancelled/postponed events and date-only starts are excluded. Refresh is current-UTC-year only and may check the source outside the automatic start+6h/24h window. The companion client invalidates its catalogue and season-summary caches after refresh, while historical reload remains archive-only.

Local logs confirm API `734a4ed` and client `fb7cbd0`; both pushes are user-confirmed. Recorded checks passed 133 API tests, Newman 114 requests / 192 assertions and 141 client tests with production build. Deployment/live smoke, Actions secrets/dispatch and real PostgreSQL multi-process locking remain **PENDING/unverified**. The September provider-index result above was not rechecked. See [review evidence](FUNCTIONALITY-VALIDATION.md) and [refresh operations](DEPLOYMENT.md).
