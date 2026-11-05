# Uncommitted API/client senior review — 5 November 2026

Review and authorized fixes complete; no commit, push, deployment, source import,
factual database write, migration or model/settings change. Configured Cody:
gpt-6.1-sol / medium, not independently verified runtime/billing. Curie owns the
read-only historical loading-failure investigation; application fixes remain with
this reviewer. Existing user-owned client CHECKPOINT, 13 October review and other
dirty documentation are preserved.

## Findings and fixes

Paths below are relative to
`C:/xampp/htdocs/WebSitesDesigns/developments/f1-circuit/`.
Severity P2 means incorrect supported behavior or reliability; P3 means diagnostic
or accessibility weakness. Findings are reproduced, not inferred historical causes.

| ID  | Severity / path                                                    | Reproduction and expected result                                                                                                                                                                | Fix / evidence                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | P2 `api/src/questions/request-data.js`, `question-orchestrator.js` | A bounded source read starts with 25ms remaining and settles after 150ms. Ask must stop waiting at its deadline. Original get/keys/getMany/proof all exceeded it.                               | Shared beforeDeadline bounds waits and checks late completions; stage and resolver waits use it. Four red regressions, green in focused 56 and full 549. SQL already has 15s statement/5s acquisition limits; in-flight SQL is not cancelled.                                                                                                                                                                                                  |
| F2  | P2 `api/src/questions/question-orchestrator.js`                    | Planner asks whether success means wins or titles while supplying a resolvable driver. Name resolution must not answer that metric question.                                                    | Clear only a narrowly recognizable entity-only clarification. Metric regression red; missing-name and supplied-surname recovery both green. A supplied resolvable entity was already recovered before this review; that suspected defect was not independently reproduced.                                                                                                                                                                     |
| F3  | P2 `api/src/questions/period.js`, `question-orchestrator.js`       | Actual question “How many races did Max Verstappen win from 2023 to 2022?” was answered over sorted 2022–2023. Directional inversion must clarify.                                              | Detect inverted from/to, through and until before sorted endpoints; unordered between remains inclusive. One red, two endpoint tests green. Separate comparison-period guard preserved.                                                                                                                                                                                                                                                        |
| F4  | P2 `api/src/repositories/question.repository.js`                   | Index insert fails, then ROLLBACK fails. Original failure must survive and connection must be discarded.                                                                                        | Guard rollback, retain original error, release(discard). One red; six atomic repository tests green. Old index replacement remains transactional.                                                                                                                                                                                                                                                                                              |
| F5  | P2 `api/src/questions/canonical-plan.js`                           | No-model “How many championships did Max Verstappen win in 2023?” selected race wins.                                                                                                           | Recognize driver championship metric before generic win count. Red regression then green.                                                                                                                                                                                                                                                                                                                                                      |
| F6  | P2 `api/src/services/question.service.js`                          | Driver title question requests 2023–2024 but only 2024 standings exist; another driver is absent from every finalized standing. Missing season must be disclosed; absence must not become zero. | Finalized-year coverage/missingYears in answer and values; no finalized participation returns unavailable. Two red tests with mocked planner/finality and independent requested-year oracle, then green. Initial no-model trial exposed F5 instead and is retained separately.                                                                                                                                                                 |
| F7  | P2 `api/src/questions/query-plan-schema.js`                        | Weather/session aggregation with driverName silently returned event-wide weather.                                                                                                               | Reject driver filters/comparisons for weather and unsupported circuit aggregates before execution. One red then green. No provider facts invented.                                                                                                                                                                                                                                                                                             |
| F8  | P2/P3 `client/src/pages/Questions.jsx`                             | Clear while interpreting leaves fetch active and keyboard focus on a removed control.                                                                                                           | Abort on Clear/replacement/unmount, restore textarea focus. Captured abort red then 11 green; expanded 13 focused cover retry text/year and late old response isolation. Existing RTK request identity already protects against stale result publication; no prior stale-result failure claimed.                                                                                                                                               |
| F9  | P3 `api/src/controllers/read.controller.js`, `middleware/http.js`  | Invalid completed response loses question-stage headers; request socket closes before finish and produces no terminal request log.                                                              | Set safe headers before validation; log stable contract code/schema; exactly one finish/close record with completed flag and null unfinished status. Original header/close regressions red. Final 3 green after correcting fixture schema name from nonexistent QuestionResponse to askQuestionResponse. Initial unknown-schema lookup fault is not claimed as a real invalid-body fail-before; corrected real-schema after-fix checks passed. |

Raw logs are external at
`C:/Users/garya/OneDrive/Documents/ChatGPT/F1/audit-2026-11-05/`:
`api-initial-regressions-red.txt`, `api-direction-red.txt`, `api-rollback-red.txt`,
`api-title-filter-red.txt`, `api-review-focused-green.txt`, `api-full-check.txt`,
`api-http-diagnostics-red.txt`, `api-http-diagnostics-final-green.txt`,
`client-clear-red.txt`, `client-clear-green.txt`,
`client-review-focused-final.txt`. `client-review-focused.txt` failed because a new
test response omitted required meta; corrected fixture passed, not an app defect.

## Reviewed surface and boundaries

Additional lifecycle finding **F10 (P2)**:
`api/src/server.js` waited for jobs before refusing new connections and forced exit
after10s, cutting off an otherwise in-budget15s request. A job-stop rejection also
skipped HTTP/pool cleanup. Two fixture regressions failed before the fix. Shutdown
now closes HTTP immediately, joins HTTP/jobs with allSettled, ends the pool despite
job failure, and emits stable failure/timeout codes. The35s grace is best effort:
snapshot reads precede Ask's30s service budget and hosting termination allowances
remain unverified. These are implementation bounds, not every-HTTP completion
guarantees. Final combined shutdown/diagnostic 5 tests pass. Curie's external
old-source15s fixture reset at10s; latest frozen-source fixtures passed:15s request
HTTP200/exit0 at18,051ms,150ms control HTTP200/exit0 at3,183ms, hung request/job
exit1 at35,024ms with SHUTDOWN_TIMEOUT. New connections were refused during all
three drains; normal cases ended the pool once. Source hash stayed unchanged.
Evidence: `loading-failures/shutdown-postfix-results.json` and original
`shutdown-results.json`. No native Windows signal or hosting-platform test ran.

Review covers all initial tracked/untracked API/client implementation, contracts,
scripts and tests, not just this pass's fixes: registry/schema/dispatch, planner and
deterministic proposals, per-slot resolution, periods/session preservation,
coverage/finality/calendar evidence, publication-scoped data and retrieval caches,
embeddings and compact documents, atomic index replacement, cross-process lock,
reuse, maintainer/backoff/cost boundaries, server startup/shutdown, request/response
validation and tracing, client choices/retries/context and labels/accessibility.
Existing31-entry registry dispatch and124-question mocked-plan corpus remain
fixture evidence, not proof of model comprehension or all natural-language forms.
Retain explicit/inferred calendar proof distinction and pinned record context.

No unrelated refactor, new UI design, CSS/token/asset edits, model change or actual
index rebuild is part of this review. Database/provider records remain fact sources.
Index transaction/lock/reuse tests use fixtures; no new real cross-process DB test
or paid embedding relevance test ran. Uncommitted paid embedding batches remain
non-resumable, already documented; no schema migration is authorized.

## Final verification and limits

- Fresh final frozen API check passed554 tests, lint/format, OpenAPI/checksum and
  Newman117 requests/197 assertions, exit0. It follows all backend source edits;
  evidence: `api-final-frozen-check.txt`. Earlier549 predates diagnostics/shutdown.
  The first final attempt stopped at formatting the new review document, before
  application tests; `api-final-check.txt` is not a passing run.
- Client 13 focused tests pass. Fresh full client gate passed lint, 725 tests in
  65 files with maxWorkers2 (553.42s), 49 constructor/30 flag asset guards and
  production build (19.49s), exit0. Evidence: `client-full-gate.txt`.
  Only one bounded full client run was launched. Existing scrollTo/chunk-size
  warnings remain; a duplicate-key warning occurs in ui-number-semantics's
  RacePodium fixture, outside the changed Ask implementation.
- Historical536 API/721 client/17 browser question texts remain4 November evidence.
  They are not this review's results.
- Parent explicitly accepted the final visual/interaction changes. Client source frozen08:41:32UTC;
  external browser-ready.json records health, SHA256, URL, process ownership and
  requested matrix. Existing dev terminals were not launched/restarted by reviewer.
- All application code is strictly frozen: last backend source edit
  2026-11-05T08:49:53.7035991Z; client2026-11-05T08:41:32.2835375Z.
  Later documentation edits do not refresh or rerun application test evidence.
- All 211 API/client source files matched the strict-freeze hash inventory after
  the build's idempotent generation. Both Git diff checks passed. Final
  documentation-only formatting/link verification is recorded separately; no
  application suite is rerun solely for documentation.
- No assigned implementation/test/visual gate remains. Deployment, native signal
  and hosting termination behavior, new real cross-process DB lock verification,
  paid index resumability and the uncorrelated loading-error causes remain the
  explicit limits above, not verified repairs. User retains commit/push ownership.

Current absolute dirty-path inventory: external `changed-path-inventory.json`.
It includes pre-existing user changes; `reviewerTouched` identifies this review's
edits. Shared root memory is outside both repositories and recorded separately.

## Visual handoff

Reference inspected before client code:4 November accepted
`browser-evidence/final-desktop-max-2023.png`, plus Questions,
ArchiveQuestionResult and questions.css source. Reuse Panel, Button, ErrorState,
Skeleton, StatusBadge, existing native disclosures and Apex font/space/color/shape
tokens. No new style, layout, component variant, icon or modal.

Parent explicitly accepted the final changes, recorded in external
`browser/acceptance.json`. Actual desktop1368/client1355, CSS390/client376 Dark/Light
and CSS320/client306 Light/Dark showed no observed overflow or field clipping.
Keyboard Clear returned blank/focused question-text on desktop/320 Light; pending
Max was cleared and a new2000 answer remained current despite the old response.
Frozen inverted-range Try again preserved original wording and clarified.
Schumacher's three canonical choices, Enter Michael and original wording produced
the published Brazil25 November2012 final race; native details keyboard passed.
Normal viewport, System appearance and Viewer local were restored.

External screenshots: `browser/final-desktop.png`, `desktop-light.png`,
`320-light-cleared.png`, `320-dark-choice-result.png`, `390-light-details.png`
and preceding `390-dark-result.png`. The latter predates the final backend edit;
do not call it post-freeze backend evidence. Optional-year transport retry was
fixture-only, not forced live. Selected states are not exhaustive accessibility,
language or source-accuracy certification. No new modal/shared visual consumer is
introduced. Client abort does not imply cancellation of server planner billing or
PostgreSQL work.

The earlier two generic loading failures still lack their original HTTP response,
request correlation and terminal logs. New transport reproductions prove possible
failure classes and diagnostic gaps; they do not establish those historical causes.

The new interim5 November inverted-range browser error is also unclassified.
Exact proxy/direct probes returned valid200 clarification and the frozen browser
retry passed. Nearby08:49:53 backend edit/watch overlap remains a hypothesis,
without the failed response or request correlation. Full read-only investigation:
`loading-failures/HANDOFF.md`. Generic client errors can represent API500, socket
failure, timeout, parsing failure or malformed successful envelopes; planner
unavailable domain results normally return200 and a distinct explicit UI state.
