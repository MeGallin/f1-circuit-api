# Provider-backed season catalogue

Run `node --env-file=.env scripts/sync.js jolpica seasons` to import Jolpica's paginated `seasons.json` index into the existing snapshot store. It does not fetch all race weekends and does not call the provider during an HTTP read request.

Only provider-returned season years are added. Existing imported event, result and standings datasets are retained, as are their season counts and coverage. New catalogue-only seasons have coverage `unavailable` and zero imported calendar/result counts. Those counts do not assert that the season had zero races. The catalogue envelope includes that distinction as a warning and retains provider attribution and source observations. Repeated catalogue imports are idempotent by canonical season identity. Provider capabilities from earlier imports are retained.

The existing `/seasons` contract is unchanged. Rows are returned newest first and isCurrent is computed against the server runtime UTC year. Known catalogue-only years return empty calendar/standings envelopes with unavailable coverage, and a summary identifying the season without race facts. Unknown years still return 404. Detailed data remains a separate explicitly selected weekend import.

Real provider index checked on 18 September 2026: 77 season records, 1950 through 2026. This is a reported source result, not a generated year range. No Render deployment is part of this change.
