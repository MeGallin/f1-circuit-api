# F1DB source pin and identity gate

The reviewed F1DB source is the official single-JSON release **v2026.14.0**.

| Field                   | Pinned value                                                                     |
| ----------------------- | -------------------------------------------------------------------------------- |
| Release page            | <https://github.com/f1db/f1db/releases/tag/v2026.14.0>                           |
| Single JSON asset       | <https://github.com/f1db/f1db/releases/download/v2026.14.0/f1db-json-single.zip> |
| Asset bytes             | `6739988`                                                                        |
| SHA-256                 | `4fca2f9d5119a959dd043852b3936fcb452b8eedf50e1c5fa1dc62a2e10a332e`               |
| Extracted JSON SHA-256  | `f4872275d077c2d90c753ee8a5bf33b315dd496cd40a5ec1717487fca762ce93`               |
| Observed release marker | `1e00082`                                                                        |
| Attribution             | F1DB contributors — CC BY 4.0                                                    |

The downloaded archive was checksum-verified before inspection. The extracted
single JSON contains 917 drivers, 187 constructors, 78 circuits, 77 seasons and
1172 races. The archive remains in the ignored local cache and is not a
repository or public-release input.

The held overlay importer verifies the extracted JSON checksum shown above and
retains the release-asset checksum in its source descriptor. This keeps the
zip pin and the exact decompressed input independently auditable.

F1DB identity mapping is now fail-closed. Before a weekend can be normalized,
every driver and constructor referenced by that weekend and every circuit in
its year calendar must have an explicit mapping of the form
`driver:f1db-id -> driver:canonical_id`, `constructor:f1db-id ->
constructor:canonical_id` or `circuit:f1db-id -> circuit:canonical_id`.
Mappings must use the matching canonical namespace and cannot collide. The
importer no longer silently emits `f1db-*` identities in its default path.
The reviewed alias manifest is [f1db-mapping-2000-2025.json](./f1db-mapping-2000-2025.json).
It contains 206 explicit mappings (129 drivers, 39 constructors and 38
circuits). Against the staged canonical profile catalog, all 503 F1DB races
from 2000 through 2025 passed the mapping gate and normalized without an
unresolved identity. Temporal constructor aliases such as `kick-sauber` and
`sauber` intentionally converge on the canonical Sauber identity; the gate
still rejects a collision when both aliases appear in one imported weekend.
The regression coverage exercises missing mappings, valid mappings and
namespace violations.

The reviewed 2000–2025 races are staged through bounded batches with
`scripts/stage-f1db-held.js`. Each normalized race is written under an
explicit `f1db:<year>:<round>:` namespace in the held enrichment manifest;
canonical base datasets are never overwritten and no F1DB aliases are added
to the manifest. The source observation stores the release version, both the
release-asset and extracted-JSON checksums, and the reviewed mapping manifest.
The namespace is accepted only for the F1DB provider mode, and item IDs are
deterministic when an EventDetail item has no native ID. This keeps the import
resumable, provenance-preserving and private until a separate manifest-aware
release review.

The mapping review is complete for 2000–2025; 2026 remains intentionally
outside this manifest because the staged canonical catalog has not completed
that season. The current 2026 gate reports three absent canonical identities
(`driver:arvid-lindblad`, `constructor:audi` and `constructor:cadillac`) and
one unmapped venue addendum (`circuit:madring`). No activation or
public-pointer change is permitted.

OpenF1 session mapping is explicit for 221 canonical 2023–2024 sessions,
including qualifying, sprint, sprint-qualifying and practice sessions. The
held workspace currently materializes 62 mapped session bundles across the
bounded Lap, PitStop, Stint, Weather and RaceControl datasets. Three
source/canonical date disagreements remain unavailable as documented in
`ENRICHMENT-RETENTION.md`; they are not inferred.
