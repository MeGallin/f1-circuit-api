# Senior review — 13 October 2026

Current outcome: all approved findings resolved and independently re-reviewed;
full API300/check/Newman117/197 and client720/65/check passed. Parent explicitly
accepted the frozen sampled visual matrix. This completed code-review checkpoint
has subsequently been committed by the user. Known limits are recorded below.

## Commit and push checkpoint — 13 October 2026

Local Git verified API HEAD `990d58757bcc6794825569dce4bb6e26f92ee77a` and client
HEAD `c231f8b43de6df97dbabefd1180b6928b634cb86`, both with the actual subject
`feat(standings): add evidence-aware title outlook dialog and championship metrics`.
Both repositories were clean before this documentation update. Both pushes are
user-confirmed, not independently remote-ref verified. No deployment, build/upload
or live API verification was performed for this checkpoint. All checks and browser
evidence below are dated previous runs; none were rerun for these documentation-only
edits. These edits remain local/uncommitted; Cody performed no commit or push.

## Scope and initial findings

At review time, all uncommitted API/client work was preserved. Cody configured gpt-6.1-sol/medium;
this is not independent runtime/billing verification. Parent orchestrates and owns
visual acceptance; Franklin provided read-only API review. No commit/push/deploy,
source imports or live database writes are authorized.

Approved concrete fixes:

| ID     | Priority    | Finding                                                                                                               | Minimal resolution / regression                                                                                                                            |
| ------ | ----------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CR-01  | P2          | Generated standings contract uses signed/nullable budgets and unrestricted path status text, unlike client acceptance | Separate signed, nonnegative and positive opportunity domains; precise statuses/evidence invariants; schema mutation tests; keyed regeneration/idempotence |
| API-01 | P2          | Future event ID can collide with a selected event without invalidating selected podium identity                       | Check cross-cutoff ID reuse, preserving unrelated future-corruption tolerance                                                                              |
| API-02 | P2          | Selected race ID can collide with a Sprint ID in loaded session indexes                                               | Check all loaded index rows for selected race identity collisions, not race rows alone                                                                     |
| API-03 | P2          | Remaining scenario dates are sorted without anchoring after a validated selected cutoff                               | Validate owned cutoff date and strict future chronology, including Sprint                                                                                  |
| API-04 | P2          | Published score helper accepts numeric/leading-zero values that response schema rejects                               | Canonical signed decimal strings only; omit invalid rows/degrade coverage; preserve penalties                                                              |
| CE-01  | P2          | Client accepts contradictory scenario status/evidence combinations                                                    | Validate relationships without duplicating title mathematics                                                                                               |
| CE-02  | P2 adjacent | Standing cutoff note can mix pinned standings with latest calendar                                                    | Use the standing publication for calendar context; avoid mismatched captions while loading                                                                 |

Standing.number and missing older client endpoint contracts are inherited differences,
not this fix scope. No blanket OpenAPI sync. New podium/outlook/standings-response
schemas must remain semantically aligned. Existing shared-driver/per-car semantics,
batch reads and legitimate signed penalties must stay intact.

Raw execution evidence is external under
`C:/Users/garya/OneDrive/Documents/ChatGPT/F1/audit-2026-10-13/execution-evidence/`.
Red/green results, freeze verification and final acceptance are now recorded below,
not inferred from earlier checkpoints. Client visual matrix/reference is in the
companion client review. The table above was recorded before implementation; the
following section records the final resolution, not inferred historical evidence.

## Final resolutions and actual verification

All seven findings are closed in the approved scope. Parent relayed Franklin's
independent re-review closing all four API findings and the residual outer-coverage
CR-01 case. CE-01/CE-02 are verified in the client companion report.

- CR-01: signed penalty/proof scores remain valid; budgets/gaps are nonnegative,
  event maxima positive/non-null, statuses precise and evidence presence tied to
  status. Unavailable outer outlook cannot contain conditional scenarios; optional
  legacy/null and conditional outlook with unavailable chronology remain supported.
- API-01: later event ID reuse invalidates a selected identity, while unrelated
  future corruption is still ignored.
- API-02: selected race IDs are checked against every row in the already loaded
  selected-event session indexes, including Sprint/quali. No extra reads or N+1.
- API-03: scenarios are strictly after a validated owned-season cutoff date. A
  small shared season-date model removes duplicate date guards without moving
  schedule logic into the score model or creating a generic validation framework.
- API-04: published scores are canonical signed decimal strings. Numeric and
  leading-zero malformed rows are omitted with coverage degradation, not500/zero.

Per-car constructor/shared-driver semantics, canonical rank eligibility, historical
ownership, batch projection before paging, immutable publication and Decimal
arithmetic remain intact. Explicit services/repositories and small pure projection
helpers are retained; no broad DRY/SOLID/KISS restructuring or new dependencies.

| Execution                | Actual result                                                       |
| ------------------------ | ------------------------------------------------------------------- |
| Initial API fail-first   | 89 tests:59 pass,30 intended failures                               |
| Outer-coverage follow-up | 1 intended failure before fix                                       |
| Frozen focused API       | 90/90 pass                                                          |
| Full API `npm run check` | 300/300, lint/format, OpenAPI/checksum pass                         |
| Newman                   | 117 requests,197 assertions,0 failures                              |
| Full client gate         | 720 tests/65 files, lint/build pass                                 |
| Contract regeneration    | Both scoped generators idempotent; checksum pass                    |
| Semantics                | New podium/outlook/standings-response schemas match exactly         |
| Frozen code              | 31 source/test/contract hashes unchanged through gates/regeneration |

Standing.number's API-only property **and required member** are inherited in HEAD;
other missing client endpoints are inherited too. They were not synchronized.
The first comparison helper removed only the property and incorrectly flagged its
required member; the corrected semantic check confirms no new difference. This
diagnostic trial is retained, not represented as a source defect or green execution.

External evidence directory above contains `senior-api-red.log`,
`senior-api-outer-coverage-red.log`, `senior-api-frozen-focused.log`,
`senior-api-full-check.log`, `senior-contract-regeneration.log`,
`senior-contract-semantic-final.log`, `senior-frozen-code-hashes.json` and the client/
asset/design logs. Initial/intermediate runs remain distinguishable. The review
ran against base HEADs APIea73219/clienta63cac3; these are historical review bases,
not current HEADs. Subsequent user commits are recorded in the checkpoint above.

Functional code froze at the parent-notified13:35 checkpoint, before full gates;
no functional/UI edits followed. Parent explicitly accepted the sampled frozen
visual matrix in the client report. Missing/loading/error browser states were not
claimed verified; fixtures/full tests are separate. Existing Vite chunk warnings
remain. No full WCAG, all-source accuracy, exhaustive historical data, exact later
countback, deployment or live-write proof is claimed. This review used fixtures,
in-memory test infrastructure and read-only parent browser observations, not imports
or live DB writes. Final documentation-only edits do not rerun application tests.
