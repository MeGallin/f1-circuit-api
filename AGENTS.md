# API implementation guidance

Read `../AGENTS.md`, shared `../memory.md` and relevant API contracts before
changes. The parent orchestrates; Cody implements and tests. Preserve unrelated
dirty work, publication/season ownership and the established backend architecture.
No commit, push, deployment, source import or live write without explicit authority.

## Mandatory visual-consistency completion gate

API changes that alter rendered information, coverage, loading, error or empty
states must also pass the gate in
[../client/docs/UI-CONSISTENCY.md](../client/docs/UI-CONSISTENCY.md).
API tests alone do not prove client presentation correctness. Identify affected
consumers and obtain the parent's explicit desktop/mobile visual acceptance before
calling the whole feature finished. Record actual states and external screenshots;
missing or failed review means verification pending. For API-only work with no
rendered impact, record the specific N/A reason. Never invent browser evidence or
relabel earlier test executions as fresh runs.
