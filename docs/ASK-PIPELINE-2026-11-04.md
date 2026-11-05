# Ask pipeline — 4 November 2026

Subsequent local review/fixes and fresh gates are recorded in the
[5 November senior review](SENIOR-REVIEW-2026-11-05.md). The results and acceptance
below remain dated4 November evidence.

Current local implementation; no commit, push or deployment. Functional gates and
explicit parent browser acceptance are complete. Configured Cody launch:
gpt-6.1-sol / medium, not independently verified runtime or billing.

## Query contract

- Configured requests use the structured planner first. The capability registry
  owns operation descriptions, required/allowed entities, allowed metrics, scopes,
  sessions, filters and executor dispatch. JSON-schema/AJV and semantic checks run
  before execution; unknown fields, SQL, incompatible metrics and discarded filters
  are rejected. Fixed-metric operations accept their matching metric or null.
- No-model recognizers propose a plan through the same validator; they cannot
  bypass it. Alias resolution uses published profiles and season race participation.
  Surname ambiguity returns actual canonical choices. Constructor/circuit names do
  not acquire invented final-word aliases. Implicit numeric surnames cannot consume
  a history count. Model entity slots are resolved individually after planning.
- `context.entitySelections` optionally pins validated canonical choices by slot
  (`driverName`, `comparisonDriverName`, `constructorName`, `constructor0`,
  `constructor1`, `circuitName`). Existing context fields and publication envelopes
  remain valid. Choice retries keep the original question, without appending labels.
- Questions are stateless. Optional context is deliberate user input, not an
  inherited URL season. Explicit question/context conflicts request clarification.
  Current UTC date/year, publication coverage and a published completed-event
  reference are supplied as planner context. Relative last-race resolution uses
  completed published events; scheduled events are not called completed.
- Year ranges are inclusive. “Last N years/seasons” means N completed calendar
  seasons ending at current UTC year minus one; it does not imply complete data.
  Explicit non-contiguous year lists require supported comparison-period fields or
  return unsupported. Race wins exclude Sprint sessions. Incompatible sessions and
  unsupported constructor/circuit metric filters are never replaced with race data.
- Missing years and calendared completed events degrade win-range/comparison
  coverage explicitly. Comparison prose names its period. Absence of participation
  is unavailable rather than an invented zero; a participating driver may have zero
  observed wins. Final championship counts share the finality gate; past year alone
  cannot establish a final champion. Complete calendar/round evidence can establish
  finality; the existing driver/constructor title-outlook projection can establish
  conditional secured status. Otherwise rank one is a published leader.
- Pit-stop driver filtering precedes duration reduction. Event totals and per-driver
  maxima are distinct operations. Circuit-wide session aggregation currently supports
  weather/rainfall/temperatures; other circuit metrics return precise unsupported.
- The original planner response can include one validated constraint-preserving
  retry question. Actionable canonical-choice clarifications do not trigger another
  model call. Retired automatic rephraser code and unrelated stock Italian-GP
  suggestions were removed. Retry suggestions are guidance, never factual answers.

## Retrieval and lifecycle amendment

This task explicitly supersedes QUESTION-RAG-SPEC sections 4.3/12: race publication
**must not wait for an embedding provider**. The post-commit maintainer checks the
current publication on startup and every minute, under a cross-process advisory
lock. Durable manifests retain sanitized failure/backoff status. Questions use
publication-pinned lexical fallback when semantic indexing is missing, incompatible
or unavailable. Index readiness is separate from archive fact availability.

The active publication `af6f10af-cc5c-4653-8ff4-acf5fc06fe77` was indexed once:
5,024 compact documents, all actual vectors `text-embedding-3-small` / 1536.
Physical model/dimension/norm/publication integrity and expected entity rankings
were verified. The initial shape-only semantic check failed relevance and was
superseded by an expected-ID red/green check. Unchanged rebuild and maintainer
checks proved zero embedding calls. Only question index tables were written.

Atomic replacement preserves an old index on failure. Compatible committed vectors
can be reused. **Uncommitted paid embedding batches are not durably checkpointed**
with the current schema; a first-build failure cannot resume those batches. No
schema migration or factual/source publication was authorized or performed.

## Request cost and observability

Request/publication-owned caches batch profile/result reads and scope result keys
before loading a selected year. No answer cache crosses publications. The planner
uses the remaining 30-second question budget with no automatic retry; this replaces
the earlier two 10-second attempts for Ask, without changing configured model or
reasoning effort. Embedding/index work retains its own bounded provider/job budgets.

Pino logs and response `Server-Timing`, `X-Request-Id`, `X-Question-Operation`,
`X-Question-Retrieval` and provider request-ID headers identify stages without raw
questions, model JSON, candidates, names or credentials. File tracing is off by
default. `QUESTION_TRACE_FILE` can explicitly opt in to an absolute local QA path
outside production; production ignores it. Records are whitelisted and bounded.

## Verification and limits

- Initial 11 pipeline regressions all failed before production changes. The initial
  output is transcribed, explicitly labeled, in the external evidence archive.
- Additional captured red/green regressions cover planner-first comparisons,
  constructor filters, historical finality, missing years, disjoint periods,
  optional entities, required metrics, second-slot choices, pit-stop reductions,
  original-plan suggestions, missing entity slots and secured projections.
- `tests/question-contract/pipeline-corpus.js` version `2026-11-04.1` has **124**
  distinct question variants across all 31 registry entries. Its 125 checks validate
  independently specified mocked plans against real fixture executors and raw-row
  count/evidence/coverage oracles. This is **not** proof of LLM understanding.
- Index worker: 35 focused checks, actual ready/physical-vector/relevance proof,
  cross-process busy proof and unchanged/no-provider proof.
- Final API `npm run check`: **536 tests**, lint/format, OpenAPI/checksum and
  Newman117 requests/197 assertions passed after the last source edits.
- Full client verification: lint, **721 tests/65 files** using two workers, asset
  checks49 constructors/30 flags and production build passed (exit0). The original
  unbounded test run was aborted under resource pressure and is not a passing gate.
  The bounded run took764.28s, build32.43s; Vitest's agent-mode minimal reporter
  concealed passing-file progress. Existing scrollTo/chunk warnings remain.
- After that full client gate, the parent authorized one labels-dictionary-only
  readability correction. Its new regression failed before the change; all
  **10 affected question tests**, lint, assets and build37.51s passed afterward.
  The full721 suite was not rerun for that explicitly bounded follow-up. No component
  markup, styling, layout or asset changes; final parent recheck accepted the labels.
- Initial live repaired surname request answered Max Verstappen 19 with actual
  planner and canonical resolver evidence. Parent subsequently observed surname19
  and inclusive2021–2023 range44. Earlier generic browser errors remain of unproven
  cause; an observed interpreter timeout and empty clarification are separate facts.
- Legacy calendar finality prefers explicit observation references. Where legacy
  provenance lacks those references, authorized read-only corroboration requires
  a trusted root-calendar source URL/year, retrieval before the pinned publication,
  complete pagination, exact unique calendar identity/date/circuit rows through
  published canonical aliases, a hash matching the physical pinned calendar, every
  completed race classification published, and matching final standings round.
  Post-publication/untrusted/changed/partial/duplicate/mixed-year evidence is rejected.
  This is labeled **inferred-content-match**, never original lineage. Facts and
  generic field-coverage metadata remain unchanged.
- Actual2000 proof matched all17 events/classifications and round17 standings to
  the independent oracle. Canonical content SHA256 starts76136159; the real HTTP
  request returned Michael Schumacher,108 points, final, with semantic retrieval,
  real planner and exact executor evidence. Opaque proof hashes/observation IDs
  stay in external proof artifacts; UI values contain a human-readable coverage
  explanation and source-evidence links. No hardcoded champion/year special case.
- Last API source edit22:00:29UTC. API and Vite-proxy health200 were checked
  at22:01:45UTC; strict API freeze marker22:01:46UTC. Last client labels-only edit
  was22:04:56UTC. Parent explicitly accepted the final result after that edit:
  **17 distinct question texts / 18 final expectation checks**, including a keyboard
  choice continuation, matched independent facts or appropriate non-answer states.
  Actual desktop1097/client1084, CSS390/client376Dark and CSS320/client306Light,
  plus preceding paired Light/Dark views, showed no observed root/field clipping.
  Enter choices/disclosures/evidence and Clear flows passed. System appearance,
  Viewer local time and normal viewport were restored; Max19 remains with closed
  disclosures. This is selected-language/interaction evidence, not exhaustive
  accessibility or external-provider accuracy certification.

External audit root:
`C:/Users/garya/OneDrive/Documents/ChatGPT/F1/audit-2026-11-04`.
`execution-evidence/index-handoff.md` contains the index worker's complete proof
inventory. `browser-ready.json` records freeze/review status. Raw logs/screenshots
remain outside Git.

Final browser verdict: `browser-evidence/browser-acceptance.json`;
`browser-evidence/accepted-question-runs.json` retains initial failures and repaired
attempts separately. Final screenshot: `browser-evidence/final-desktop-max-2023.png`.
`execution-evidence/changed-path-inventory.json` records absolute task paths and
preserved user-owned dirty documents. Earlier generic transport errors remain of
**unproven cause**; successful frozen retries do not establish their cause fixed.

## Isolated embedding comparison

The separately authorized [benchmark report](C:/Users/garya/OneDrive/Documents/ChatGPT/F1/audit-2026-11-04/embedding-benchmark/REPORT.md)
compared small1536, large1536 and large3072 against the same 5,024 documents and
48 declared retrieval targets. Hybrid all-required coverage@5 was35/48 for all;
@16 was35/48 small versus36/48 for either large, MRR0.7224/0.7339/0.7343.
Twelve misses were shared by all variants; compact dataset descriptors and target
definitions limit the interpretation. These are retrieval rankings, **not answer
accuracy**. Active model, dimensions, stored vectors and database schema were not
changed by that experiment. The measured gain does not justify an active upgrade
for this task; retain small pending a broader answer-level evaluation.
