# F1 Circuit API

Backend repository for the F1 Circuit historical and post-race application.

This initial commit establishes the agreed directory structure only. No application code, dependencies, database setup or deployment configuration has been added. The default development branch is `main`.

## Planned architecture

Node.js and Express with plain JavaScript, using normalized PostgreSQL data. Public requests will read published local data snapshots; provider fetching and reconciliation belong to ingestion jobs.

| Directory | Responsibility |
|---|---|
| `src/routes`, `src/controllers` | HTTP routing and request/response translation |
| `src/services` | Application use cases |
| `src/models`, `src/repositories` | Persistence mappings and database access |
| `src/providers` | Isolated external source adapters |
| `src/schemas`, `src/middleware`, `src/config` | Validation, HTTP concerns and configuration |
| `src/ingestion`, `src/reconciliation`, `src/jobs` | Background imports, comparison and publication |
| `src/questions` | Deterministic question handling |
| `src/errors`, `src/observability` | Error definitions and operational diagnostics |
| `supabase/migrations` | Versioned database migrations |
| `fixtures` | Reviewed synthetic or permitted provider test records |
| `scripts` | Maintenance and import commands |
| `docs` | API contracts and backend documentation |

Provider folders reserve the planned adapter boundaries; their presence does not mean those providers are enabled or verified. Empty folders use `.gitkeep` placeholders.

The client will be a separate repository. Neither project may rely on untracked files in its sibling directory. Keep credentials, private data and local environment files out of Git; use reviewed example configuration when implementation begins.
