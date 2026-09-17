# F1 Circuit API

Backend repository for the F1 Circuit historical and post-race application.

The default development branch is `main`. This historical vertical slice provides Express health/readiness, exact CORS, safe errors, PostgreSQL publications, validated provider imports and all 35 contract route boundaries. Dataset coverage varies: unsupported enrichments and unqualified historical metrics are explicitly unavailable. No natural-language implementation is included.

Install with `npm ci`, supply an external PostgreSQL `DATABASE_URL` following `.env.example`, run `npm run migrate`, then `npm start`. Environment files are not loaded automatically; inject environment variables or use Node's `--env-file` option locally. Never commit real values. `npm test`, `npm run lint` and `npm run format:check` verify this milestone. Repository tests use pg-mem as a test double; PostgreSQL RLS/locking and managed-database connectivity need a real integration check before deployment. Docker engine availability is required for `docker build -t f1-circuit-api .`.

## Planned architecture

See [coverage and limitations](docs/COVERAGE.md), [deployment and import instructions](docs/DEPLOYMENT.md), the pinned [OpenAPI contract](docs/openapi.json) and [Postman report](docs/POSTMAN-REPORT.md).

Run `npm run check` for lint, formatting, deterministic tests, contract integrity and an actual Newman/Postman run. The Postman runner starts a loopback-only fixture server without production configuration. Production dependency audit is clean; Newman's development-only dependency tree has outstanding advisories, so use only the trusted local collection without real credentials. Newman is excluded from the Docker image.

Node.js and Express with plain JavaScript, using normalized PostgreSQL data. Public requests will read published local data snapshots; provider fetching and reconciliation belong to ingestion jobs.

| Directory                                         | Responsibility                                        |
| ------------------------------------------------- | ----------------------------------------------------- |
| `src/routes`, `src/controllers`                   | HTTP routing and request/response translation         |
| `src/services`                                    | Application use cases                                 |
| `src/models`, `src/repositories`                  | Persistence mappings and database access              |
| `src/providers`                                   | Isolated external source adapters                     |
| `src/schemas`, `src/middleware`, `src/config`     | Validation, HTTP concerns and configuration           |
| `src/ingestion`, `src/reconciliation`, `src/jobs` | Background imports, comparison and publication        |
| `src/questions`                                   | Deterministic question handling                       |
| `src/errors`, `src/observability`                 | Error definitions and operational diagnostics         |
| `supabase/migrations`                             | Versioned database migrations                         |
| `fixtures`                                        | Reviewed synthetic or permitted provider test records |
| `scripts`                                         | Maintenance and import commands                       |
| `docs`                                            | API contracts and backend documentation               |

Provider folders reserve the planned adapter boundaries; their presence does not mean those providers are enabled or verified. Empty folders use `.gitkeep` placeholders.

The client will be a separate repository. Neither project may rely on untracked files in its sibling directory. Keep credentials, private data and local environment files out of Git; use reviewed example configuration when implementation begins.
