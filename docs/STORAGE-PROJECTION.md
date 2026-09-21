# Read-only archive storage projection — 18 September 2026

## Measurement and coverage

Read-only repeatable-read inspection at 14:14:09 UTC: database 45,034,643 bytes (45.03 decimal MB), 199 committed rounds. 2018 was complete (21 rounds); 2017 had 3. Activation held, staged publication not public. Importer and 450 MiB guard continue unchanged.

The SHA256-verified official Jolpica CSV export dated 23 August 2026 contains 77 seasons (1950–2026) and 1,172 non-cancelled rounds; its 2018–2026 counts match the pinned archive calendars. At the question's 194-round checkpoint, 978 remained: two 2018 rounds plus 976 in 1950–2017. At this measurement 973 remained, across 68 older seasons (2017 partially complete). These are provider-export counts, not a claim that every as-yet-unfetched live calendar/category has been independently verified. Final coverage must use the run's actual calendar/checkpoint comparison.

## Growth

At 175 rounds: 41,446,547 bytes. At 196 after 2018: 44,289,171 bytes. Marginal 2018 growth: 2,842,624 bytes / 21 = 135,363 bytes per round (0.135 MB). Recent individual round increments were 0.164–0.197 MB; PostgreSQL page allocation/reuse causes variation. Dividing the whole database by completed rounds would incorrectly count fixed system overhead as per-round growth.

Retained normalized payload bytes by completed season (not physical database growth, excludes index/raw overhead): 2018 1.149 MB; 2019 1.150; 2020 0.943; 2021 1.264; 2022 1.279; 2023 1.332; 2025 1.441. 2024 is 1.888 MB including retained lap/pit detail. No continuous physical-size history exists for every earlier completed season, so physical per-season growth cannot be honestly reconstructed from current relation sizes.

Provider export era sizes: 1950s 84 rounds/10 seasons; 1960–1979 244/20; 1980–1999 318/20; 2000–2017 330/18. Older seasons have fewer rounds, but are not uniformly cheaper per round: race entries plus driver/constructor standings average approximately 89 rows/round in the 1950s, 71 in 1960–1979, 69 in 1980–1999, 55 in 2000–2017 and 48 in 2018–2026, before qualifying/other rows. Older-era qualifying coverage/field richness varies. A wider growth allowance is appropriate.

## Backbone projection

For the remaining 973 rounds, applied to the measured 45.03 MB database:

| Marginal physical allowance | Projected final database |
| --------------------------- | ------------------------ |
| 0.150 MB/round              | 190.98 MB                |
| 0.200 MB/round              | 239.63 MB                |
| 0.250 MB/round              | 288.28 MB                |

Use **350 MB as a conservative planning allowance**, rather than a guarantee: roughly 21% headroom above the high case for older rows, metadata, final reconciliation and allocation/bloat. This is below both the supplied 500 MB quota and 450 MiB = 471.8592 MB stop threshold. Continue the existing guarded backbone. Re-estimate at older-era milestones; do not disable the guard.

## Actual storage drivers

- normalized_records: 28.42 MB physical, including 10.36 MB indexes. Approximately 19,479 live rows and 3,001 dead rows reported by PostgreSQL statistics (estimates, not exact physical reclaimability).
- source_observations: 2.56 MB physical; 532 Jolpica rows, 2.08 MB stored payload.
- datasets: 1.97 MB; entity_aliases: 0.59 MB. Other application tables small; remaining database size includes system/other schema overhead.
- Staged payload: Classification 4.23 MB/4,416 rows; Qualifying 3.25 MB/3,818; Standing 2.81 MB/6,198. These are the main backbone drivers.
- Staged normalized rows: 17,017. Public-base plus another retained snapshot: 2,462 rows, 1.10 MB payload combined. They are not currently the main problem; do not delete snapshots mid-import.

## Separate OpenF1 scenarios — estimates, not measurements

Official OpenF1 documentation places history at 2023 onward and telemetry at approximately 3.7 Hz: https://openf1.org/ . The implemented adapter requests laps, pits, stints, weather and race control, not telemetry. There are 93 calendar weekends across 2023–2026, including future/uncompleted 2026 rounds; using all 93 is a conservative envelope, not an authorization to import future data.

Current normalized physical storage averages about 1.46 kB/row including indexes. Model enrichment at 1–2 kB per additional row including normalized/index/raw overhead; this is uncertain until a representative OpenF1 sample is measured.

| Scenario assuming efficient shared staging / bounded retention     | Added storage | Total with 350 MB backbone allowance |
| ------------------------------------------------------------------ | ------------- | ------------------------------------ |
| Race-session-only detail: 800–1,600 rows/weekend × 93 × 1–2 kB     | 74–298 MB     | 424–648 MB                           |
| All-session weekend detail: 3,000–6,000 rows/weekend × 93 × 1–2 kB | 279–1,116 MB  | 629–1,466 MB                         |

These are transparent sensitivity assumptions, not provider row-count measurements. Timing/weather frequency and raw JSON compression can change them materially. A 2-hour, 20-driver race at 3.7 Hz produces about 532,800 telemetry rows for one stream alone: about 0.53–1.07 GB at the same row allowance. Full telemetry is unsuitable for this Free database.

**Existing enrichment publication behavior is more expensive than those tables assume.** scripts/sync.js uses PublicationRepository.publish, which copies all normalized records/datasets/aliases from the current publication and retains prior snapshots for each session. Repeated OpenF1 session syncs can therefore exceed quota after only a few copies of a completed backbone, even before detail volume dominates. The archive importer already uses a single staging publication; do not use the per-session full-copy path for bulk enrichment unchanged.

## Recommendation

Continue the current guarded backbone; no immediate compaction or import-strategy switch is needed. Before enrichment, use shared staging or immutable dataset versions referenced by lightweight manifests, together with explicit snapshot retention. Review duplicated latest/round standings and long text index keys only after measuring actual benefit; preserve cursor/snapshot consistency and provenance. Dead-row statistics alone do not justify blocking VACUUM FULL or index rebuilds during import.

For bulky OpenF1 detail, prefer a hybrid approach: keep identities/results/standings and compact summaries in PostgreSQL, fetch detail on demand with bounded caching, and keep checksum-pinned raw/detail files outside the database where appropriate. Measure a representative mapped session before choosing retention limits. No data deletion, schema modification, optimization, import restart, enrichment, activation or deployment was performed for this projection.
