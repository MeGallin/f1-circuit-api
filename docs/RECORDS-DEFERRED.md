# Records feature deferred

The standalone Records experience is deferred to a later application version. The API no longer publishes a dedicated `/records` operation or capability endpoint, and the client no longer exposes a Records route, navigation entry, browse link, or Records-specific API surface.

This is a feature removal, not a claim that archive data has been deleted. Generic archive records, race/session records, profile history, comparison data, and normalized database records remain part of the application where they are already supported.

## Reintroduction requirements

Before restoring a standalone Records experience, the implementation must have:

- qualified backend aggregates for every advertised scope and metric, including explicit historical scoring and credit rules;
- source and evidence lineage for each published value, with honest coverage, verification, and snapshot metadata;
- one API-owned, scope-aware capability response that drives client options and prevents unsupported direct queries; and
- populated, partial-coverage, unavailable, error, pagination, keyboard/accessibility, and responsive UI tests against the real contract shape.

The removed implementation is recoverable through focused Git history. No database writes, archive deletion, or deployment is part of this deferral.
