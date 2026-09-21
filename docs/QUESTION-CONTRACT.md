# Question contract validation

The question layer is only considered supported when a scenario passes the full
read-only contract chain:

```text
question text/variants
  -> parsed constraints
  -> deterministic or validated intent
  -> direct repository query
  -> source evidence IDs
  -> independent expected result
  -> API response and rendered answer
```

The production path is hybrid: deterministic handlers run first; unresolved
wording may use the PostgreSQL lexical/vector question index and the optional
OpenAI planner; every successful plan still ends in a direct repository query.
The planner and retrieved documents are never allowed to answer from model
memory or to emit executable SQL. Generic archive matching is not an Ask-route
fallback.

The executable corpus is `tests/question-contract/corpus.js`. Each scenario
records:

- a stable `id`, family, and resolution mode;
- one or more question variants and optional validated request context;
- the expected constraints, intent, status, and unavailable reason where
  applicable; and
- an independent `derive` calculation over repository data.

`tests/question-contract/expected.js` deliberately does not import question
service handlers or answer templates. It reads the published repository sets,
resolves canonical entities independently, calculates aggregates from raw rows,
and identifies the evidence sets used for that calculation. This keeps a
passing answer from proving itself with the same helper that produced it.

## Coverage boundaries

The corpus covers the deterministic event, driver, finishing-position,
comparison, standings, participation, circuit/country history, and published
season families currently exposed by the API. Sparse or unpublished datasets
are represented as explicit unavailable scenarios with their reason codes.
Ambiguous entities, unknown entities, invalid positions, future events,
relative periods, missing result sets, partial coverage, and compound
constraints are tested as boundaries rather than silently treated as answers.

The corpus is not a claim that every historical season or metric is complete.
An answered scenario must expose the archive's coverage metadata; an unavailable
scenario must explain the supported reason and include a deterministic suggestion
for a more answerable wording. When the optional interpreter is available, the
same model may rewrite that suggestion through a separate strict question-only
schema; it receives no archive tools and is not allowed to answer. If that call
fails or returns anything other than a question, the deterministic suggestion is
retained. Suggestions are guidance only: they never replace the direct database
query or invent an answer. The dropdown is not the source of truth for this
contract.

## Running the verifier

From the API repository, run the live verifier against the current read-only
publication snapshot:

```text
node --env-file=.env scripts/check-question-contract.js
```

The command disables the optional interpreter for the run, performs no writes,
and emits one machine-readable JSON report containing the snapshot ID,
scenario/variant counts, parsed contract fields, expected values, actual API
values, evidence IDs, coverage, and pass/fail details. It exits non-zero when a
supported scenario has the wrong result, loses a constraint, lacks source
evidence, exposes the wrong coverage, or falls through to generic archive
matching. The fixture regression tests run with:

```text
node --test tests/question-contract.test.js
```

A new question pattern cannot be marked supported until its fixture path and
the live read-only chain both pass. If the public snapshot is partial or
changes, expected aggregates are derived from the rows in that snapshot; fixed
event identities still require their canonical event/evidence record.
