# Functionality validation — 18 September 2026

## Changes

Explicit snapshot requests cannot read a staging archive publication. Published historical snapshots remain readable. Record/comparison requests validate entity kinds and known years; valid season comparisons return unavailable coverage until metrics exist. Missing source standings ranks remain null instead of being inferred from row order.

## Verification

- `npm run check`: lint, formatting, 28 local tests, OpenAPI checksum/schema checks, Newman 110 requests / 184 assertions; no failures.
- Tests selected from tracked files plus `tests/semantic-reads.test.js`: 25 passed. The additional three local tests belong to preserved, uncommitted optional bulk work and are not included in this change.
- `node --env-file=.env scripts/check-product-api.js public`: 35 operations and ten representative season summaries; zero schema/status failures.
- `node --env-file=.env scripts/check-product-api.js staged`: same 45 checks; zero failures. This is a private, in-process read-only repository override, not a public endpoint or activation. HTTP checks have 10-second response / 15-second deadline limits and the script has a 120-second overall limit.
- Read-only database verification: staging, activation_held=true, publicly_active=false, 175 committed round checkpoints, zero before 2019.

## Boundaries

Public data remains the 2024 calendar and British GP validation detail. Staged calendars span 2019–2026; final archive coverage reconciliation has not run. No importing, enrichment, activation, or deployment was performed. These fixes are not yet in the deployed API. Migration 002 is required by snapshot filtering and is already part of the repository's migration sequence.

Profiles and histories passed API contract checks; dedicated client profile/history/comparison pages remain outside the currently implemented UI. Schema validation does not establish historical source accuracy or completeness. Optional bulk changes and the pre-existing deleted .env.example are excluded.
