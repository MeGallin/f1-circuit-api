# Natural-language archive questions

The `/api/v1/questions` endpoint is a read-only query layer over the published F1 archive. It is deliberately backend-owned: the React client sends question text and optional context, while the Node application resolves names, reads the normalized database snapshot, and assembles the response.

## Resolution order

1. Deterministic handlers handle safe, recognisable query shapes without an AI provider. This includes event winners, circuit race-winner history, podiums, qualifying pole, fastest laps, pit-stop counts and leaders, driver wins and comparisons, generalized finishing-position leader counts, driver history, driver/constructor counts, separate driver metrics for starts, podiums, poles, fastest laps, retirements, disqualifications, DNS and DNQ, plus published session metrics for weather, tyre strategy, race control and overtakes. The Ask route does not fall through to generic record search.
2. If deterministic interpretation cannot resolve the wording, the server retrieves candidate archive documents from the ready publication index using PostgreSQL full-text and pgvector similarity search. The index is a routing aid: it supplies relevant entity, event and dataset context, never facts that bypass the archive executor.
3. The optional OpenAI JavaScript SDK adapter converts the question and retrieved candidates into a strict JSON query plan. The backend validates the plan, resolves every named entity to a canonical database record, and executes it against its own repository. The model does not supply facts, SQL, IDs, URLs, evidence or final answer prose.
4. Unsupported, ambiguous, unavailable and partial states are returned explicitly so the client can explain what happened without inventing an answer. Explore remains the separate route for direct record search.

## Configuration

The deterministic path works with no model credentials. To enable the optional interpreter on the API service, set these server-side environment variables:

```text
OPENAI_ENABLED=true
OPENAI_API_KEY=replace-with-a-server-side-key
OPENAI_MODEL=gpt-5.6-luna
OPENAI_REASONING_EFFORT=max
OPENAI_TIMEOUT_MS=10000
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
QUESTION_RAG_ENABLED=true
```

Never place `OPENAI_API_KEY` in the React client, commit it to Git, or expose it in a browser response. A missing key simply leaves the deterministic archive path active and returns an explicit unavailable result for wording it cannot classify.

The embedding index is built with `npm run index:questions` after a new publication is activated. Its readiness and document count can be checked with `npm run check:question-index`. The index builder writes a ready manifest only after every document has an embedding and every batch has been committed.

## Response guarantees

Successful responses include `data.questionResult` and the normal archive `meta` envelope. Answered results include a deterministic natural-language `values.answer`, structured values, and any available evidence IDs. The frontend renders the answer and links to evidence; it does not generate factual text.

The endpoint does not call Jolpica, F1DB or OpenF1 at question time. Those providers feed the server-side import and reconciliation pipeline; questions query the resulting normalized publication snapshot. A circuit-scoped question can therefore span multiple events and years without requiring a separate handler for every wording variation.

The retrieval and planner path is described in `docs/QUESTION-RAG-SPEC.md`. Raw result rows remain in PostgreSQL and are queried by deterministic executors; only compact semantic profiles, events and dataset summaries are embedded. This keeps exact counts, dates, positions and ties out of vector approximation.

## Metric semantics and edge cases

The question layer counts unique canonical race events. A race start includes a published race entry that started, even if the driver later retired or was disqualified; DNS, DNQ and withdrawn entries are excluded from starts. “Retirements”, “disqualifications”, “did not start” and “did not qualify” are separate metrics. A bare “DNF” question asks for clarification instead of silently choosing one of them.

Race, sprint, qualifying and sprint qualifying are different sessions. Race wins, podiums and fastest laps use the race session; pole uses qualifying; sprint results are not silently included in race totals. Pit-stop answers aggregate published pit-stop rows by the linked race entry, preserve ties, and state whether a fastest duration is stationary or lane duration.

Session metrics are read from normalized, published detail sets. Weather answers summarize recorded observations; tyre answers use stint compounds and lap boundaries; race-control answers classify published messages; and overtake answers count linked passing entrants. OpenF1 describes its overtake feed as potentially incomplete, so the response is explicitly limited to published rows and returns unavailable when entrant mapping or coverage is insufficient. Raw car telemetry is not persisted as a general-purpose sample stream; speed questions remain unavailable until a bounded, validated summary is published.

Constructor comparison questions are answered from published race-result rows grouped by canonical constructor ID. They report race starts, wins, podiums and published points separately for each named constructor; grouped “each constructor” questions use the same executor and never infer missing rows.

Seasonal driver race-win questions parse the canonical driver and explicit year, count published race-result rows at position 1 in that season, include result evidence IDs and coverage metadata, and report unavailable when the season’s race results are not published. They never fall through to a career total or generic archive search. Event circuit questions parse the event name and explicit year, resolve one published event summary, return its canonical circuit association with event evidence, and report unavailable or clarification when the event or venue is not uniquely published. Finishing-position leader questions parse one ordinal or numeric race position, count published race-result rows at that exact position grouped by canonical driver ID, preserve ties, include result evidence IDs, and report unavailable when race positions or driver linkage are not published. Invalid or ambiguous positions are rejected before archive search. Partial source coverage is exposed in the structured values instead of being presented as a complete historical total.
Compound event questions resolve the race once and compose the published podium, constructor, points and fastest-lap rows into one response. Each part retains the same evidence and coverage metadata as its standalone query, and missing fields are reported explicitly rather than inferred.
Fastest-lap leaderboard questions use the same published race-result rows over an explicit year range, count unique race events per driver, and group the leader’s laps by canonical constructor ID. A leaderboard request is never routed as a missing-driver clarification.
Podium leaderboard questions apply the same rules to published P1–P3 race rows, preserving ties and grouping each leader’s podiums by constructor.
Race-win leaderboard questions apply the same rules to published P1 race rows, preserving ties and grouping each leader’s wins by constructor.
Constructor championship leaderboard questions use the model only to resolve the natural-language period and the meaning of “manufacturer”, “constructor”, “team” and “world title”. The executor then counts rank-1 rows in the published constructor standings for every season in that explicit range, preserves ties, and returns the winning constructor(s), title counts, seasons and evidence. No title is inferred from model knowledge.
Constructor rivalry questions use the same boundary for a two-metric comparison. The executor aggregates published race wins and constructors’ championship titles for the explicit period, compares championship-winning constructor pairs using the smallest normalized gap across both metrics, and reports the pair, both totals, the gaps and the supporting evidence. “Closest” is therefore deterministic and inspectable rather than model-generated; low-volume zero-title teams cannot displace actual championship contenders.

Relative periods such as “this year” and “last year” are resolved into explicit year ranges by the query plan. A circuit comparison resolves the circuit once, finds its canonical events in each requested range, and aggregates only the corresponding published session datasets. A country history query resolves all matching circuit profiles before selecting race results. Neither scope may inherit the Explore page’s selected season unless the question explicitly supplies a year or relative period.

The executable contract corpus and live read-only verifier are documented in
`docs/QUESTION-CONTRACT.md`, `tests/question-contract/`, and
`scripts/check-question-contract.js`. The broader acceptance matrix, including
examples for compound questions, current seasons, partial coverage, ties,
missing fields, source conflicts and unsupported datasets, is maintained in
`docs/QUESTION-COVERAGE.md`.
