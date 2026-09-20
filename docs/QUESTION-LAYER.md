# Natural-language archive questions

The `/api/v1/questions` endpoint is a read-only query layer over the published F1 archive. It is deliberately backend-owned: the React client sends question text and optional context, while the Node application resolves names, reads the normalized database snapshot, and assembles the response.

## Resolution order

1. Deterministic templates handle known wording without an AI provider. This includes archive searches, event-winner questions with an event context, last-win questions and supported driver/constructor counts.
2. If deterministic interpretation cannot resolve the wording, the optional OpenAI JavaScript SDK adapter can classify the question into a strict JSON intent.
3. The backend validates and executes that intent against its own repository. The model does not supply facts, SQL, IDs, URLs, evidence or final answer prose.
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

The endpoint does not call Jolpica, F1DB or OpenF1 at question time. Those providers feed the server-side import and reconciliation pipeline; questions query the resulting normalized publication snapshot.
