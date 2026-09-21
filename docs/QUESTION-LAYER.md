# Natural-language archive questions

The `/api/v1/questions` endpoint is a read-only query layer over the published F1 archive. It is deliberately backend-owned: the React client sends question text and optional context, while the Node application resolves names, reads the normalized database snapshot, and assembles the response.

## Resolution order

1. Deterministic templates handle safe, recognisable query shapes without an AI provider. This includes archive searches, event winners, circuit race-winner history, podiums, qualifying pole, fastest laps, pit-stop counts and leaders, driver wins and comparisons, generalized finishing-position leader counts, driver history, driver/constructor counts, separate driver metrics for starts, podiums, poles, fastest laps, retirements, disqualifications, DNS and DNQ, plus published session metrics for weather, tyre strategy, race control and overtakes.
2. If deterministic interpretation cannot resolve the wording, the optional OpenAI JavaScript SDK adapter produces a strict JSON query plan. The plan can describe an event, circuit, country, season or career scope, a metric, relative year ranges and a comparison.
3. The backend validates the plan, resolves every named entity to a canonical database record, and executes it against its own repository. The model does not supply facts, SQL, IDs, URLs, evidence or final answer prose.
4. Unsupported, ambiguous, unavailable and partial states are returned explicitly so the client can explain what happened without inventing an answer.

## Configuration

The deterministic path works with no model credentials. To enable the optional interpreter on the API service, set these server-side environment variables:

```text
OPENAI_ENABLED=true
OPENAI_API_KEY=replace-with-a-server-side-key
OPENAI_MODEL=gpt-5.6-luna
OPENAI_REASONING_EFFORT=max
OPENAI_TIMEOUT_MS=10000
```

Never place `OPENAI_API_KEY` in the React client, commit it to Git, or expose it in a browser response. A missing key simply leaves the deterministic archive path active and returns an explicit unavailable result for wording it cannot classify.

## Response guarantees

Successful responses include `data.questionResult` and the normal archive `meta` envelope. Answered results include a deterministic natural-language `values.answer`, structured values, and any available evidence IDs. The frontend renders the answer and links to evidence; it does not generate factual text.

The endpoint does not call Jolpica, F1DB or OpenF1 at question time. Those providers feed the server-side import and reconciliation pipeline; questions query the resulting normalized publication snapshot. A circuit-scoped question can therefore span multiple events and years without requiring a separate handler for every wording variation.

## Metric semantics and edge cases

The question layer counts unique canonical race events. A race start includes a published race entry that started, even if the driver later retired or was disqualified; DNS, DNQ and withdrawn entries are excluded from starts. “Retirements”, “disqualifications”, “did not start” and “did not qualify” are separate metrics. A bare “DNF” question asks for clarification instead of silently choosing one of them.

Race, sprint, qualifying and sprint qualifying are different sessions. Race wins, podiums and fastest laps use the race session; pole uses qualifying; sprint results are not silently included in race totals. Pit-stop answers aggregate published pit-stop rows by the linked race entry, preserve ties, and state whether a fastest duration is stationary or lane duration.

Session metrics are read from normalized, published detail sets. Weather answers summarize recorded observations; tyre answers use stint compounds and lap boundaries; race-control answers classify published messages; and overtake answers count linked passing entrants. OpenF1 describes its overtake feed as potentially incomplete, so the response is explicitly limited to published rows and returns unavailable when entrant mapping or coverage is insufficient. Raw car telemetry is not persisted as a general-purpose sample stream; speed questions remain unavailable until a bounded, validated summary is published.

Seasonal driver race-win questions parse the canonical driver and explicit year, count published race-result rows at position 1 in that season, include result evidence IDs and coverage metadata, and report unavailable when the season’s race results are not published. They never fall through to a career total or generic archive search. Finishing-position leader questions parse one ordinal or numeric race position, count published race-result rows at that exact position grouped by canonical driver ID, preserve ties, include result evidence IDs, and report unavailable when race positions or driver linkage are not published. Invalid or ambiguous positions are rejected before archive search. Partial source coverage is exposed in the structured values instead of being presented as a complete historical total.

Relative periods such as “this year” and “last year” are resolved into explicit year ranges by the query plan. A circuit comparison resolves the circuit once, finds its canonical events in each requested range, and aggregates only the corresponding published session datasets. A country history query resolves all matching circuit profiles before selecting race results. Neither scope may inherit the Explore page’s selected season unless the question explicitly supplies a year or relative period.

The complete acceptance matrix, including examples for compound questions, current seasons, partial coverage, ties, missing fields, source conflicts and unsupported datasets, is maintained in `docs/QUESTION-COVERAGE.md`.
