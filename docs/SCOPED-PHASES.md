# 2000-inclusive phase sequence

Final scope is 2000 through the current year, preserving all existing routes and provider-backed functionality. No 1999-or-earlier detail retrieval is authorized.

The active archive-20260918 worker is unchanged. An independent scope guard stops it after the committed 2000 round 17 checkpoint, before the next provider request; the independent 450 MiB size guard remains active. Verify process absence, importer advisory-lock availability, archive_steps and cache keys before proceeding. Never start a duplicate worker or use a fresh run ID to resume this job.

After stop, run `node --env-file=.env scripts/finalize-archive-scope.js archive-20260918`. This acquires the normal importer lock, refuses pre-2000 cache/checkpoints or any missing scoped season/round, reconciles staged event coverage, restricts the staged catalogue to 2000+, validates all normalized rows and only then writes `scope:2000:coverage-finalized`. It never releases the activation hold or changes the public pointer. A failure is resumable and must be reviewed before enrichment.

Only after that review may migration 004 be applied and held enrichment begin using the explicit staged backbone publication ID as the third OpenF1 argument. Use mapped representative sessions, measure database/raw-cache growth, then bounded batches. OpenF1 historical coverage begins in 2023; absent earlier coverage remains unavailable. Preserve Jolpica laps/pits where supplied; F1DB requires a checksum-pinned release and reviewed canonical identity mapping before mixing sources. Never use the old direct-publication provider path for archive-wide detail updates.

Run contract/Newman/API checks and private staged sweeps after each completed phase. Do not activate or deploy. The manifest-aware public release remains a later review gate. This sequence is authorized operational work, but no precondition may be inferred from elapsed time or a running worker's log alone.

## Completed run state (2026-09-18)

The guard stopped after `jolpica:2000:17:backbone`; the authoritative staged archive contains 526 checkpoints with oldest year 2000 and no pre-2000 Jolpica cache URLs. Finalization reconciled 526 events, validated 43,804 rows, and wrote `scope:2000:coverage-finalized`. Migration 004 is applied, the held enrichment workspace is based on the staged publication, and both the activation hold and private-publication state remain in force.
