# Held, shared OpenF1 staging

OpenF1 session sync now uses EnrichmentRepository, never PublicationRepository.publish. Migration 004 creates a dataset manifest and a singleton enrichment workspace. The manifest references unchanged immutable core datasets; only enriched datasets get new normalized rows. Repeated sessions reuse the same held publication. Identical dataset fingerprints skip rewrites, avoiding both retained copies and replay-related dead tuples.

The base remains the rollback source; no active or prior publications are deleted. Workspace rotation is refused when the base/public pointer changes, requiring an explicit retention review rather than accumulating full copies. The two small legacy snapshots already retained by the application are not pruned by this change. Manifest foreign keys prevent deletion of referenced base datasets. Do not resume mutation of a referenced finalized backbone without a separate review.

The workspace can share the still-held backbone after its 2000-inclusive boundary is verified and final reconciliation records archive_steps key `scope:2000:coverage-finalized`. Until then, unfinished backbone staging blocks enrichment. The existing importer advisory lock also excludes concurrent writers. Public snapshot requests exclude activation-held publications. There is no activation or hold-release path in this repository; activate() deliberately refuses. Eventual release still requires manifest-aware public reads/atomic activation and explicit authorization; do not manually switch the pointer to an overlay.

## Raw data and limits

Raw responses are content-addressed gzip files in ignored `.cache/openf1-raw`, with a hard 256 MiB aggregate budget and 8 MB uncompressed per-response bound. Postgres source_observations stores only the external key, checksum and size descriptor. Budget exhaustion stops before normalized publication; already-written immutable files may remain after a failed DB transaction, within the bounded budget. Preserve these files/back them up with provenance; they are not deployed or uploaded automatically. A future external-object-store adapter can use the same write contract.

OpenF1 staging allows only Lap, PitStop, Stint, Weather, RaceControl and
ProviderStatus. The reviewed F1DB held overlay additionally allows the core
schemas it normalizes (EventSummary, EventDetail, Session, Classification,
Qualifying, Profile, Standing, Season, Lap and PitStop), but only when every
dataset key carries an explicit `f1db:<year>:<round>:` namespace and aliases
are empty. This prevents a provider overlay from replacing canonical rows or
silently changing identity resolution. Telemetry/location bulk persistence is
rejected. Before each staged transaction, database size plus four times the
incoming serialized dataset size must remain below 450 MiB. This is a
conservative estimate, not a substitute for the operational guard. Changed
data may produce PostgreSQL dead tuples until normal vacuuming reuses them;
unchanged replay is a no-op.

## Verification

- `npm run check`: lint/format, 35 local tests, contract checksum/OpenAPI, Newman 110 requests / 184 assertions, all passed. Three optional bulk tests remain preserved outside the focused commits.
- Six dedicated retention tests: repeated sessions retain one workspace/core copy; unfinished backbone rejected; bounded raw dedup/budget; mapped 1,000-lap sample; finalized-held base remains unpublished; database storage reserve rejects writes.
- `node --env-file=.env scripts/check-enrichment-storage.js`: native PostgreSQL temporary-table-only check, no production schema/data changes and no importer lock interference. A synthetic 20-driver × 50-lap session uses the real OpenF1 normalizer.
- Measured normalized relation: base 1,000 rows / 278,528 physical bytes; after 1,000 laps, 2,000 rows / 1,474,560 bytes; identical second publication stays 2,000 rows / 1,474,560 bytes. Base remains exactly 1,000 rows. New normalized payload is 659,000 PostgreSQL bytes; mapped JSON is 498,211 bytes. This sample does not forecast all weather/race-control/raw volume.

## Completed held run (2026-09-18)

Migration 004 was applied after the 2000-inclusive scope finalizer wrote `scope:2000:coverage-finalized` (526 reconciled rounds, 43,804 validated normalized rows). The workspace is based on the held scoped publication and remains held; the public pointer was never changed.

The reviewed F1DB overlay now covers all 503 mapped races from 2000–2025 in 31,689 namespaced datasets and 110,450 normalized rows. The bounded OpenF1 pass materializes 62 session bundles across the five allowed dataset families: 30,289 laps, 846 pit stops, 1,500 stints, 7,070 weather records and 3,782 race-control records. The compressed raw cache contains 347 files and 1,998,188 bytes. The measured database size is 330,353,811 bytes, below the 450 MiB write guard. Replaying the retention fixture still deduplicates unchanged datasets.

The reviewed UTC rollover mappings now cover the local-date-compatible Las Vegas 2023 practice sessions, plus Las Vegas 2024 qualifying/practice/race sessions (OpenF1 keys 9182, 9184, 9637, 9638, 9639, 9640 and 9644). The checked-in manifest contains 221 explicit 2023–2024 canonical session mappings: 214 exact-date mappings and 7 local-timezone rollovers. Three apparent one-day matches remain deliberately unmapped because the provider's local date does not agree with the canonical session date (Las Vegas 2023 qualifying/Practice 2 and São Paulo 2024 qualifying). Each accepted mapping requires the canonical session/event identity, round, circuit, provider circuit name and provider year; a one-day difference additionally requires the correct local timezone. Unrelated mismatches continue to fail closed. No activation, deployment, snapshot pruning or public-pointer switch occurred.
