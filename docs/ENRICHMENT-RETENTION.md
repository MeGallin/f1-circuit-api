# Held, shared OpenF1 staging

OpenF1 session sync now uses EnrichmentRepository, never PublicationRepository.publish. Migration 004 creates a dataset manifest and a singleton enrichment workspace. The manifest references unchanged immutable core datasets; only enriched datasets get new normalized rows. Repeated sessions reuse the same held publication. Identical dataset fingerprints skip rewrites, avoiding both retained copies and replay-related dead tuples.

The base remains the rollback source; no active or prior publications are deleted. Workspace rotation is refused when the base/public pointer changes, requiring an explicit retention review rather than accumulating full copies. The two small legacy snapshots already retained by the application are not pruned by this change. Manifest foreign keys prevent deletion of referenced base datasets. Do not resume mutation of a referenced finalized backbone without a separate review.

The workspace can share the still-held backbone after its 2000-inclusive boundary is verified and final reconciliation records archive_steps key `scope:2000:coverage-finalized`. Until then, unfinished backbone staging blocks enrichment. The existing importer advisory lock also excludes concurrent writers. Public snapshot requests exclude activation-held publications. There is no activation or hold-release path in this repository; activate() deliberately refuses. Eventual release still requires manifest-aware public reads/atomic activation and explicit authorization; do not manually switch the pointer to an overlay.

## Raw data and limits

Raw responses are content-addressed gzip files in ignored `.cache/openf1-raw`, with a hard 256 MiB aggregate budget and 8 MB uncompressed per-response bound. Postgres source_observations stores only the external key, checksum and size descriptor. Budget exhaustion stops before normalized publication; already-written immutable files may remain after a failed DB transaction, within the bounded budget. Preserve these files/back them up with provenance; they are not deployed or uploaded automatically. A future external-object-store adapter can use the same write contract.

Allowed normalized schemas are Lap, PitStop, Stint, Weather, RaceControl and ProviderStatus. Telemetry/location bulk persistence is rejected. Before each staged transaction, database size plus four times the incoming serialized dataset size must remain below 450 MiB. This is a conservative estimate, not a substitute for the operational guard. Changed data may produce PostgreSQL dead tuples until normal vacuuming reuses them; unchanged replay is a no-op.

## Verification

- `npm run check`: lint/format, 35 local tests, contract checksum/OpenAPI, Newman 110 requests / 184 assertions, all passed. Three optional bulk tests remain preserved outside the focused commits.
- Six dedicated retention tests: repeated sessions retain one workspace/core copy; unfinished backbone rejected; bounded raw dedup/budget; mapped 1,000-lap sample; finalized-held base remains unpublished; database storage reserve rejects writes.
- `node --env-file=.env scripts/check-enrichment-storage.js`: native PostgreSQL temporary-table-only check, no production schema/data changes and no importer lock interference. A synthetic 20-driver × 50-lap session uses the real OpenF1 normalizer.
- Measured normalized relation: base 1,000 rows / 278,528 physical bytes; after 1,000 laps, 2,000 rows / 1,474,560 bytes; identical second publication stays 2,000 rows / 1,474,560 bytes. Base remains exactly 1,000 rows. New normalized payload is 659,000 PostgreSQL bytes; mapped JSON is 498,211 bytes. This sample does not forecast all weather/race-control/raw volume.

## Completed held run (2026-09-18)

Migration 004 was applied after the 2000-inclusive scope finalizer wrote `scope:2000:coverage-finalized` (526 reconciled rounds, 43,804 validated normalized rows). The workspace is based on the held scoped publication and remains held; the public pointer was never changed.

The reviewed OpenF1 batch staged 26 race sessions across 2023–2024: 29,040 laps, 807 pit stops, 1,418 stints, 4,036 weather records and 2,494 race-control records. The bounded compressed raw cache contains 154 files and 1,230,894 bytes. The final measured database size was 143,592,595 bytes, below the 450 MiB write guard. Replaying the retention fixture still deduplicates unchanged datasets.

Las Vegas 2024 (OpenF1 key 9644) remains unavailable because OpenF1 reports a UTC date of 2024-11-24 while the canonical session is dated 2024-11-23. The adapter refused the mismatch; no guessed mapping was published. No activation, deployment, snapshot pruning or public-pointer switch occurred.
