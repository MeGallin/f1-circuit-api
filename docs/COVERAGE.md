# Implemented coverage and release boundaries

This delivery implements an API foundation and a historical vertical slice. All 35 contract operations are registered and schema checked; **route coverage is not equivalent to full historical dataset coverage**. The remaining product breadth is visible through unavailable states rather than fabricated responses.

| Capability                                              | Current implementation                                                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Seasons/calendar                                        | Imported-season index and selected-year calendar; date precision preserved                                                             |
| Event/session identity                                  | Year/round aliases, retained event IDs, race/qualifying/sprint/practice identities; venue changes require reviewed mapping             |
| Results/fastest laps                                    | Race and sprint results, statuses, decimal points, available timing and fastest-lap fields                                             |
| Qualifying                                              | Jolpica phase values and F1DB equivalents; nonstandard historical formats need further normalization                                   |
| Laps/pits                                               | Jolpica pagination, durations and entrant mapping; OpenF1 sectors/speeds, lane and stationary pit times                                |
| Stints/weather/race control                             | OpenF1 historical adapter with explicit session mapping; unavailable fields remain null                                                |
| Standings                                               | Published round snapshots and progression; earlier-round imports do not regress latest standings                                       |
| Profiles/history/search                                 | Imported driver, constructor and circuit identities, supplied biography/location and scoped histories                                  |
| Evidence/source status                                  | Selected assertions, field conflicts, retrieval metadata, provider status and import coverage                                          |
| Impact/records/comparisons                              | Unavailable until historical scoring/credit and before/after snapshots are qualified; no modern-rule recomputation                     |
| Penalties                                               | Contract exists; no automatic inference from race-control prose                                                                        |
| Telemetry/positions/intervals/locations/overtakes/radio | Contract boundary exists; high-volume/media ingestion remains follow-up work                                                           |
| Circuit layout assets                                   | Contract exists; asset permission/identity verification remains a release gate                                                         |
| Questions                                               | Deterministic database-backed intents plus optional closed-schema natural-language classification; unsupported metrics remain explicit |

F1DB supports more than this adapter currently projects. The full imported source payload is retained with checksum/version, but retaining a payload does not mean every field is exposed. Shared-drive events stop for reviewed credit mapping. Practice results, nonstandard qualifying and historical scoring require follow-up work. These are vertical-slice limits, not removal of product requirements.

## Integration and operational gates

- Native PostgreSQL/Supabase migration, RLS, advisory-lock, restore and connectivity checks require an approved actual database. pg-mem is a deterministic test double, with unsupported RLS excluded; it does not prove native database behaviour.
- The Docker CLI exists but its engine is not running. No successful container build or deployment is claimed.
- No automatic snapshot pruning is installed. Establish measured retention/backup policy before importing the full archive; raw observations and copied read snapshots otherwise grow.
- Reads load a dataset before filtering/cursor pagination. Full-archive performance requires database query/index optimization and load tests.
- Sync uses fresh source HTTP responses; durable upstream response-cache reuse is not implemented. Page requests never call upstream.
- Sync job rows record outcomes. Database outages cannot publish source-health updates; operational logs remain the failure signal.
- Cross-provider alignment uses reviewed mappings, never fuzzy names. Matching providers alone do not imply independent verification.
- Freshness uses a conservative fourteen-day historical age bound. Fine-grained source scheduling remains operational follow-up work.
- The implementation-plan and OpenAPI references were under `outputs/api-contract`, not the supplied output root. The synced `sources/` directory was empty; existing root-level reference documents were read without modification.
- Production dependency audit has no findings. Development audit has 19 findings in the Newman dependency tree (including one critical). A non-breaking audit fix did not resolve them. Newman runs only trusted local fixtures without credentials and is omitted from the production image. Do not run untrusted collections or environments.

## Source checks

Jolpica documentation and a read-only historical result response confirmed the parser shape. OpenF1 documentation distinguishes lane and stationary durations; deprecated pit_duration is compatibility-only. F1DB's single-JSON schema supplied field mappings. Live fixtures are not silently replaced by synthetic test data.

- [Jolpica documentation](https://github.com/jolpica/jolpica-f1/blob/main/docs/README.md)
- [Jolpica rate policy](https://github.com/jolpica/jolpica-f1/blob/main/docs/rate_limits.md)
- [Jolpica terms](https://github.com/jolpica/jolpica-f1/blob/main/TERMS.md)
- [F1DB documentation](https://github.com/f1db/f1db)
- [F1DB schema](https://raw.githubusercontent.com/f1db/f1db/main/src/schema/current/single/f1db.schema.json)
- [OpenF1 documentation](https://openf1.org/docs/)
