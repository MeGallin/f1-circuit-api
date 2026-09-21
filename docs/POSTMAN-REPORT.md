# Postman / Newman acceptance report

Environment: loopback-only Express server with a deterministic fictional repository double. No external provider requests, database credentials or production mutations.

| Request          | Status                |
| ---------------- | --------------------- |
| Success          | listSeasons           | 200 |
| Validation       | listSeasons           | 400 |
| Success          | getSeasonSummary      | 200 |
| Validation       | getSeasonSummary      | 400 |
| Missing resource | getSeasonSummary      | 400 |
| Success          | getCalendar           | 200 |
| Validation       | getCalendar           | 400 |
| Missing resource | getCalendar           | 400 |
| Success          | getStandings          | 200 |
| Validation       | getStandings          | 400 |
| Missing resource | getStandings          | 400 |
| Success          | getProgression        | 200 |
| Validation       | getProgression        | 400 |
| Missing resource | getProgression        | 400 |
| Success          | lookupRace            | 200 |
| Validation       | lookupRace            | 400 |
| Missing resource | lookupRace            | 400 |
| Success          | getEvent              | 200 |
| Validation       | getEvent              | 400 |
| Missing resource | getEvent              | 404 |
| Success          | getImpact             | 200 |
| Validation       | getImpact             | 400 |
| Missing resource | getImpact             | 404 |
| Success          | getClassification     | 200 |
| Validation       | getClassification     | 400 |
| Missing resource | getClassification     | 404 |
| Success          | getQualifying         | 200 |
| Validation       | getQualifying         | 400 |
| Missing resource | getQualifying         | 404 |
| Success          | getLap                | 200 |
| Validation       | getLap                | 400 |
| Missing resource | getLap                | 404 |
| Success          | getPitStop            | 200 |
| Validation       | getPitStop            | 400 |
| Missing resource | getPitStop            | 404 |
| Success          | getStint              | 200 |
| Validation       | getStint              | 400 |
| Missing resource | getStint              | 404 |
| Success          | getWeather            | 200 |
| Validation       | getWeather            | 400 |
| Missing resource | getWeather            | 404 |
| Success          | getRaceControl        | 200 |
| Validation       | getRaceControl        | 400 |
| Missing resource | getRaceControl        | 404 |
| Success          | getPenalty            | 200 |
| Validation       | getPenalty            | 400 |
| Missing resource | getPenalty            | 404 |
| Success          | getPosition           | 200 |
| Validation       | getPosition           | 400 |
| Missing resource | getPosition           | 404 |
| Success          | getInterval           | 200 |
| Validation       | getInterval           | 400 |
| Missing resource | getInterval           | 404 |
| Success          | getOvertake           | 200 |
| Validation       | getOvertake           | 400 |
| Missing resource | getOvertake           | 404 |
| Success          | getRadio              | 200 |
| Validation       | getRadio              | 400 |
| Missing resource | getRadio              | 404 |
| Success          | getTelemetry          | 200 |
| Validation       | getTelemetry          | 400 |
| Missing resource | getTelemetry          | 404 |
| Success          | getLocation           | 200 |
| Validation       | getLocation           | 400 |
| Missing resource | getLocation           | 404 |
| Success          | getdriverProfile      | 200 |
| Validation       | getdriverProfile      | 400 |
| Missing resource | getdriverProfile      | 404 |
| Success          | getdriverHistory      | 200 |
| Validation       | getdriverHistory      | 400 |
| Missing resource | getdriverHistory      | 404 |
| Success          | getconstructorProfile | 200 |
| Validation       | getconstructorProfile | 400 |
| Missing resource | getconstructorProfile | 404 |
| Success          | getconstructorHistory | 200 |
| Validation       | getconstructorHistory | 400 |
| Missing resource | getconstructorHistory | 404 |
| Success          | getcircuitProfile     | 200 |
| Validation       | getcircuitProfile     | 400 |
| Missing resource | getcircuitProfile     | 404 |
| Success          | getcircuitHistory     | 200 |
| Validation       | getcircuitHistory     | 400 |
| Missing resource | getcircuitHistory     | 404 |
| Success          | getLayouts            | 200 |
| Validation       | getLayouts            | 400 |
| Missing resource | getLayouts            | 404 |
| Success          | getComparison         | 200 |
| Validation       | getComparison         | 400 |
| Success          | search                | 200 |
| Validation       | search                | 400 |
| Success          | getSources            | 200 |
| Validation       | getSources            | 400 |
| Success          | getEvidence           | 200 |
| Validation       | getEvidence           | 400 |
| Missing resource | getEvidence           | 404 |
| Success          | askQuestion           | 200 |
| Validation       | askQuestion           | 400 |
| Health           | live                  | 200 |
| Health           | ready                 | 200 |
| CORS             | allowed preflight     | 204 |
| CORS             | denied origin         | 403 |
| Pagination       | first page            | 200 |
| Pagination       | next page             | 200 |
| Filtering        | driver                | 200 |
| Snapshot         | expired               | 409 |
| Validation       | invalid limit         | 400 |
| Validation       | reversed lap range    | 400 |
| Maintenance      | no public sync route  | 404 |

Requests: 110. Assertions: 184. Failures: 0.

Coverage: every documented OpenAPI operation, validation, missing resources, pagination, filtering, snapshots, health/readiness and CORS. Unsupported data is explicitly unavailable; a 200 response does not imply every enrichment is implemented. Sync/import are operator CLI commands, not public endpoints.

Limits: repository double does not verify Supabase connectivity, RLS, PostgreSQL locking, provider availability or container runtime. These require separate integration checks.
