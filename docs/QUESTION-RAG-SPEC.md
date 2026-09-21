# F1 Circuit question system: hybrid RAG and exact-query specification

**Status:** Approved for implementation planning
**Scope:** Node/Express API, Supabase/Postgres publication store, OpenAI-backed Ask route, and the supporting client contract
**Primary endpoint:** `POST /api/v1/questions`
**Out of scope:** Explore's ordinary archive search, provider imports themselves, and any use of external web search at question time

## 1. Purpose

The current question layer has grown as a collection of deterministic handlers and explicit examples. That approach can answer the patterns that have been anticipated, but it cannot scale to ordinary questions such as:

> When was Michael Schumacher's last race?

The failure mode is unacceptable: when no specific handler matches, the Ask route must not fall back to a generic list of keyword matches. The system must either answer from published database records, ask a precise clarification, or state that the required data is not published.

This specification replaces the question layer's finite-pattern mindset with a capability-driven, hybrid retrieval and exact-query architecture:

```text
question
  -> hybrid retrieval and entity candidates
  -> structured query plan
  -> schema and capability validation
  -> exact Postgres execution
  -> independent evidence and coverage checks
  -> deterministic answer presentation
```

The language model is an interpreter and planner. It is not the factual source, database, calculator, SQL generator, or final authority.

## 2. Architecture decisions

### 2.1 Keep the current platform

The implementation remains:

- JavaScript only, running on Node.js 22.
- Express API in the existing Docker container.
- Supabase-hosted PostgreSQL as the canonical published archive.
- Immutable publication snapshots selected through `current_publication`.
- React client consuming the existing versioned API.
- OpenAI access from the server only, never from the browser.

No separate vector database is required for the first implementation. Supabase/Postgres will hold the vector index alongside the relational archive. This keeps publication IDs, evidence, coverage and embeddings aligned.

### 2.2 Use hybrid retrieval, not vector search alone

Vector search is useful for meaning, aliases, misspellings and natural wording. It is not reliable for exact counts, dates, rankings or comparisons. Retrieval therefore combines:

1. Exact canonical and alias lookup.
2. PostgreSQL full-text/trigram matching for names and phrases.
3. Vector similarity over archive documents.
4. Metadata filters for publication, entity type, season, event, circuit and constructor.

Retrieval produces candidate entities and supporting context. It does not itself produce the answer.

### 2.3 Use the model for constrained planning

The OpenAI adapter will use the official server-side JavaScript SDK and Responses API. Its output must be strict structured data matching the application's JSON schema. The model may select an approved operation and fill its constraints; it may not emit SQL, facts, source URLs, evidence IDs or answer prose.

The API key remains server-side in the Render environment. It must never be present in the React build, browser network response, logs, or repository. The model name, timeout and reasoning setting remain environment-configurable, with the current project defaults retained until benchmarked.

Reference: [official OpenAI API reference](https://developers.openai.com/api/reference/overview).

## 3. Existing components to retain and change

### Retain

- `src/repositories/publication.repository.js` as the read-only snapshot boundary.
- `src/repositories/archive.repository.js` for staging and publication workflows.
- `publications`, `current_publication`, `datasets`, `normalized_records`, `entity_aliases` and source-observation tables.
- Existing provider import and reconciliation services.
- `POST /api/v1/questions` and its response envelope.
- Existing evidence IDs, dataset coverage and provenance metadata.
- Existing contract tests as regression coverage.

### Refactor

`src/services/question.service.js` is currently a large collection of parsing, resolution, execution and presentation responsibilities. It must become a small façade that delegates to explicit modules:

```text
src/questions/
  question.service.js          // public façade used by read.service.js
  question-orchestrator.js     // pipeline coordination
  question-normalizer.js       // whitespace, spelling and safe normalization
  question-retriever.js        // hybrid candidate retrieval
  entity-resolver.js           // canonical entity resolution and ambiguity
  query-planner.js             // model/rule plan creation
  query-plan-schema.js         // JSON schema and AJV validation
  capability-registry.js       // approved operations and data requirements
  query-executor.js             // operation dispatch to repositories
  evidence-builder.js          // evidence IDs and source records
  coverage-evaluator.js         // complete, partial, missing and conflict states
  answer-composer.js           // deterministic templates from returned rows
  question-errors.js           // typed clarification/unavailable errors
```

`src/providers/openai/question-interpreter.js` should be replaced by an adapter named `query-planner.js` or `src/providers/openai/query-planner.js`. During migration, the existing adapter may be wrapped, but the old name and duplicated intent schema must be removed once the new path is active.

### Remove or isolate

- The Ask route's generic `archive_search` fallback. It belongs to Explore, not question answering.
- Parser branches that duplicate the same entity resolution or metric calculation.
- Answer templates that can silently substitute career scope for season scope.
- Intent names that are not registered in the capability registry.
- Dead prompt instructions, unused context fields and old tests that pass only because a generic record list was returned.
- Any frontend-side factual answer construction.

The Explore search endpoint and its repository logic remain available, but the Ask route must never use it as an answer fallback.

## 4. Publication-aware vector index

### 4.1 Migration

Add a migration after the current publication migrations. The exact embedding dimension is fixed for the initial embedding model and must not be changed in place.

Conceptual schema:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE question_documents (
  publication_id text NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  document_id text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  dataset_key text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  search_text tsvector NOT NULL,
  metadata jsonb NOT NULL,
  embedding vector(1536) NOT NULL,
  content_hash text NOT NULL,
  embedding_model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (publication_id, document_id)
);

CREATE INDEX question_documents_entity
  ON question_documents(publication_id, entity_type, entity_id);

CREATE INDEX question_documents_search_text
  ON question_documents USING GIN(search_text);

CREATE INDEX question_documents_embedding_hnsw
  ON question_documents USING hnsw (embedding vector_cosine_ops);

CREATE TABLE question_index_manifests (
  publication_id text PRIMARY KEY REFERENCES publications(id) ON DELETE CASCADE,
  status text NOT NULL CHECK(status IN ('pending','building','ready','failed')),
  document_count integer NOT NULL DEFAULT 0,
  embedding_model text NOT NULL,
  source_hash text NOT NULL,
  error_code text,
  started_at timestamptz,
  completed_at timestamptz
);
```

If the installed Supabase extension does not support the selected index form, the migration must fail clearly and the implementation must use the supported equivalent. No silent no-op index is acceptable.

### 4.2 Documents to index

Documents are derived from the normalized published snapshot, not from provider responses at question time:

- Driver profile and aliases.
- Constructor profile and aliases.
- Circuit profile, country and aliases.
- Event profile, year, round, circuit and schedule.
- Driver-event race result.
- Driver-event qualifying result.
- Driver-event fastest-lap result.
- Driver-constructor participation history.
- Published championship standings.
- Published session-detail summaries where available.
- Dataset coverage and source-evidence summaries.

Each document must include metadata sufficient to filter before returning candidates:

```json
{
  "publicationId": "...",
  "entityType": "driver-result",
  "entityId": "result:2024:...",
  "driverId": "driver:...",
  "constructorId": "constructor:...",
  "eventId": "event:2024:...",
  "circuitId": "circuit:...",
  "season": 2024,
  "session": "race",
  "datasetKey": "results:2024",
  "evidenceIds": ["..."],
  "coverage": "partial"
}
```

### 4.3 Index lifecycle

A new archive publication must not become active until its question index is ready. The existing staging model should become:

```text
build publication
  -> validate datasets
  -> generate documents
  -> embed changed documents in bounded batches
  -> build/update indexes
  -> run index integrity checks
  -> run question evaluation suite
  -> activate publication
```

The indexer must be incremental. Documents with the same `content_hash`, publication and embedding model are reused. A changed embedding model creates a new index version; it never mixes vectors from incompatible models.

## 5. Capability registry

The registry is the scalable replacement for a list of question examples. It defines operations, required datasets, accepted constraints, executor name, answer shape and coverage rules.

Initial operations:

```text
event_winner
event_podium
event_pole
event_fastest_lap
event_circuit
event_result_position
driver_metric
driver_season_metric
driver_last_race
driver_first_race
driver_last_win
driver_first_win
driver_constructor_metric
driver_comparison
finishing_position_leader
circuit_race_winners
country_race_winners
season_champion
season_round_standings
session_metric
coverage_query
```

Each capability must declare:

- operation name;
- required entity types;
- allowed metrics;
- accepted filters and period forms;
- session scope;
- required dataset prefixes;
- SQL/repository executor;
- answer fields;
- unavailable reason codes;
- evidence requirements;
- whether partial coverage may be answered;
- ambiguity rules;
- fixture and live evaluation references.

No capability may be executable merely because the model invented its name.

## 6. Structured query plan

The planner output is validated before execution. The shape should be close to:

```json
{
  "operation": "driver_last_race",
  "entities": {
    "driver": { "candidateId": "driver:schumacher", "name": "Michael Schumacher" }
  },
  "filters": {
    "fromYear": null,
    "toYear": null,
    "eventId": null,
    "circuitId": null,
    "constructorId": null,
    "session": "race"
  },
  "metric": null,
  "order": { "field": "eventDate", "direction": "desc" },
  "limit": 1,
  "ambiguity": { "required": false, "reason": null }
}
```

The schema must reject:

- arbitrary operation names;
- raw SQL or SQL fragments;
- unknown fields;
- unbounded limits;
- contradictory periods;
- implicit inheritance of the Explore season;
- a driver name that has not been resolved to one canonical ID;
- a metric not supported by the selected dataset;
- an answer plan that has no evidence path.

The model receives the user question, the capability descriptions and a bounded set of retrieved candidate entities. It does not receive instructions from archive documents. Retrieved content is data, not executable instructions.

## 7. Query pipeline

### Step 1: Normalize

Normalize whitespace, punctuation, apostrophes, common aliases and safe spelling variants. Preserve the original question for display and audit. Do not silently change a year, driver, event or circuit.

### Step 2: Retrieve candidates

Run exact alias lookup, full-text lookup and vector retrieval against the active publication. Apply likely metadata filters only when the question explicitly contains them. Return a bounded candidate set with similarity and lexical scores.

### Step 3: Plan

Use deterministic extraction for obvious values such as explicit years, ordinals and named event forms. Use the OpenAI planner for natural-language relationships and unresolved wording. The planner must return the structured schema, not prose.

### Step 4: Resolve entities

Resolve candidate entities against canonical IDs. If there is one high-confidence candidate, continue. If there are multiple plausible candidates, return clarification with the choices. If there are none, return an unavailable unknown-entity result.

### Step 5: Validate capability and data

Confirm that the operation is registered, all required datasets exist in the active publication, the required fields are present, and the coverage state permits the requested answer.

### Step 6: Execute exact query

Dispatch to a repository executor. The executor uses parameterized SQL or existing repository reads. It performs the actual sorting, filtering, grouping, distinct-event counting, comparison and aggregation.

Examples:

- `driver_last_race`: select the latest published race result by event date.
- `driver_first_win`: select the earliest published race result where position is 1.
- `finishing_position_leader`: group race results by driver for the requested position and preserve ties.
- `circuit_race_winners`: resolve the circuit, select its race events, order by event date, limit N, then join winners.
- `session_metric`: read only the published session dataset and return unavailable if it is absent or incomplete for the requested metric.

### Step 7: Build evidence and coverage

Every answer must include the dataset keys, evidence IDs, publication ID, coverage state and checked timestamp. A result based on partial coverage must say so. Missing data is not zero.

### Step 8: Compose answer

Answer wording is generated by deterministic templates from structured query results. The model does not write factual answer prose. The client renders the returned answer and evidence; it does not calculate or invent anything.

## 8. Response contract

Extend the existing `questionResult` shape without breaking the client envelope:

```json
{
  "status": "answered",
  "operation": "driver_last_race",
  "values": {
    "answer": "Michael Schumacher's last published race was the 2012 Brazilian Grand Prix at Interlagos on 25 November 2012.",
    "rows": [
      {
        "driverId": "driver:schumacher",
        "eventId": "event:2012:brazilian-grand-prix",
        "eventName": "Brazilian Grand Prix",
        "date": "2012-11-25",
        "circuitName": "Autódromo José Carlos Pace"
      }
    ]
  },
  "coverage": {
    "state": "partial",
    "fromYear": 2000,
    "toYear": 2026,
    "message": "The published archive currently covers 2000 onward."
  },
  "evidence": [{ "id": "...", "datasetKey": "results:2012", "provider": "..." }],
  "provenance": {
    "publicationId": "...",
    "sourceOnly": true,
    "checkedAt": "..."
  }
}
```

Other valid statuses:

- `clarification`: more than one canonical entity or missing essential constraint.
- `unavailable`: the question is understood but the required published dataset/field is absent.
- `unsupported`: the plan is outside the registered capabilities.
- `error`: operational failure, with no factual answer.

The Ask route must never return `archive_search` as the answer to a natural-language question.

## 9. Data and coverage rules

- The active publication is the only factual source at query time.
- Jolpica, F1DB and OpenF1 are import sources, not query-time answer sources.
- “Last race” means the latest published race result within the archive boundary, not an assertion that no later race exists outside the archive.
- “First” and “last” require a date/order field and an explicit coverage qualification.
- “This year” and “last year” are converted into explicit UTC years before execution.
- “Silverstone” resolves to a circuit scope unless the user names a Grand Prix.
- Sprint, qualifying, sprint qualifying and race remain separate sessions.
- DNS, DNQ, retirements and disqualifications remain distinct states.
- Empty verified data may return zero; absent or failed data returns unavailable.
- Ties are preserved.
- Partial coverage is always visible in the answer metadata and relevant answer wording.
- Source conflicts are returned as conflict metadata; values are never silently averaged.

## 10. Technical-debt removal plan

Before the new path becomes the default:

1. Inventory every branch in the current `question.service.js` and map it to a capability or remove it.
2. Move all reusable profile/entity resolution into `entity-resolver.js`.
3. Move all dataset availability and partial-coverage checks into `coverage-evaluator.js`.
4. Move every aggregation into a named executor with one testable responsibility.
5. Delete the Ask-specific generic archive-search fallback.
6. Keep Explore search in its own service and route; do not share answer templates with Ask.
7. Remove duplicate intent schemas and obsolete OpenAI prompt instructions.
8. Remove tests that assert only that a generic list was returned.
9. Add a static check that every planner operation is registered and every registered operation has an executor.
10. Run ESLint, Prettier, unit tests, contract tests, Postman/Newman tests and the live question evaluator after each migration step.
11. Preserve unrelated dirty worktree changes; do not fold them into this refactor.
12. Commit in logical slices: index migration, indexer, capability registry, planner, executors, response contract, cleanup, then client verification.

No compatibility wrapper may remain indefinitely. A wrapper is removed once all tests and the API route use the new module.

## 11. Testing and evaluation

### Unit tests

- normalization and alias handling;
- query-plan JSON schema rejection;
- capability registry completeness;
- entity ambiguity;
- date and relative-period resolution;
- each executor's raw-row calculation;
- evidence and coverage construction;
- deterministic answer templates.

### Integration tests

For every capability, include:

- one ordinary natural-language question;
- at least five paraphrases;
- one explicit constraint variant;
- one ambiguous entity case;
- one unavailable dataset case;
- one partial-coverage case where applicable;
- one tie or empty-data case where applicable;
- an assertion that the result did not use generic archive search.

### Independent expected results

Expected values must be calculated by a separate test helper over raw published rows. The expected-result helper must not import the executor or answer template under test.

### Evaluation corpus

Build a versioned corpus of at least 100 questions derived from the current database capabilities, not only hand-picked dropdown examples. Include:

- driver history and career boundaries;
- first/last operations;
- season and relative-year constraints;
- circuit and country history;
- race, qualifying and sprint distinctions;
- comparisons;
- ordinal finishing positions;
- constructor participation;
- weather, tyre, race-control and overtaking coverage boundaries;
- misspellings, aliases and ambiguous surnames;
- compound questions and unsupported requests.

The evaluator must report, for every question:

```text
question
plan
resolved entities
operation
expected status/value
actual status/value
evidence IDs
coverage
generic-search fallback used
latency
pass/fail reason
```

The evaluator fails the build if a supported question returns an incorrect value, loses a constraint, lacks evidence, claims complete coverage when coverage is partial, or falls through to generic search.

### Browser acceptance tests

The live client must be tested with at least:

- Michael Schumacher's last race;
- Oscar Piastri's first and last wins;
- Max Verstappen's 2023 wins;
- the 2022 Italian Grand Prix circuit;
- the last three races at Monza;
- the driver with the most second-place finishes;
- a driver/constructor comparison;
- a question with an ambiguous surname;
- a published-but-partial result;
- an unavailable weather/pit-stop/race-control question.

Each browser test must clear the previous answer, submit the exact question, capture the answer, expand evidence, and confirm that no unrelated records were presented as the answer.

## 12. Operational requirements

- Index builds run as bounded jobs and are resumable.
- Only the server can call OpenAI or PostgreSQL.
- Log request correlation ID, publication ID, planner status, operation, latency, retrieval counts and OpenAI request ID when available; never log API keys or full sensitive request payloads.
- Add rate limiting and an input length limit to the question endpoint.
- Cache retrieval candidates and completed answers by publication ID, normalized question hash and planner version. Never serve a cached answer from a different publication.
- Apply timeouts to embedding, planning, retrieval and SQL separately.
- If the model is unavailable, simple registered deterministic operations may continue; unresolved questions return a clear unavailable response.
- A new publication is not activated if its index is not ready or the evaluation gate fails.
- A model change requires a new evaluation run and a recorded planner version. Pinned model versions are preferred for reproducible results.

## 13. Implementation phases

### Phase 0: baseline and cleanup

- [ ] Freeze the current API contract and capture the current test baseline.
- [ ] Inventory question branches, datasets, field availability and answer templates.
- [ ] Separate Explore search from Ask.
- [ ] Add the missing Michael Schumacher last-race regression test as a failing test.

### Phase 1: index foundation

- [ ] Add the Supabase vector/search migration.
- [ ] Add document builders and content hashes.
- [ ] Add bounded embedding client and index job.
- [ ] Add publication/index manifest checks.
- [ ] Prove rebuild, resume, rollback and publication isolation.

### Phase 2: planner and retrieval

- [ ] Add hybrid retrieval repository methods.
- [ ] Add canonical entity resolver with ambiguity results.
- [ ] Add capability registry and strict plan schema.
- [ ] Replace the old interpreter contract with the structured query planner.
- [ ] Add planner timeouts, safe failure and request correlation.

### Phase 3: exact executors

- [ ] Implement first/last race and first/last win executors.
- [ ] Move existing event, driver, comparison and history logic into executors.
- [ ] Add coverage/evidence enforcement before answer composition.
- [ ] Remove Ask generic fallback.
- [ ] Add deterministic answer templates and response contract tests.

### Phase 4: evaluation and client

- [ ] Build the 100-question evaluation corpus.
- [ ] Run independent expected-result validation.
- [ ] Run Postman/Newman API tests.
- [ ] Run browser tests across answered, clarification and unavailable states.
- [ ] Update the React Ask route only where the response contract requires it.

### Phase 5: cutover and cleanup

- [ ] Enable the new orchestrator behind an environment feature flag.
- [ ] Compare old and new results without changing public answers.
- [ ] Switch the Ask route to the new path.
- [ ] Delete obsolete parser branches, old interpreter files and dead tests.
- [ ] Run the full quality gate and commit the refactor in logical slices.

## 14. Definition of done

The work is complete only when all of the following are true:

- “When was Michael Schumacher's last race?” returns one canonical driver and one latest published race, with date, event, circuit, evidence and coverage.
- No ordinary Ask question can return a misleading generic list of matching profiles.
- The model cannot emit SQL, facts, evidence IDs or final factual prose.
- Every answered value is calculated from the active Supabase publication.
- Every answer exposes its evidence and coverage state.
- Unsupported and unavailable data are explained precisely.
- The vector index is tied to the publication snapshot and cannot leak data from another snapshot.
- The 100-question independent evaluation passes.
- Browser acceptance tests pass for realistic questions, paraphrases and edge cases.
- Old redundant handlers and dead code have been removed, not merely hidden.
- API, lint, formatting, contract and Postman checks pass.
- The implementation remains JavaScript-only and follows the existing Express routes/controllers/services/repositories/models structure.
