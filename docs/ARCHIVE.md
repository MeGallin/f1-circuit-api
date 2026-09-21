# Resumable archive import

Run from the API repository with the existing local environment and verified CA:

```powershell
node --env-file=.env scripts/archive.js backbone archive-20260918
node --env-file=.env scripts/archive.js laps-pits archive-20260918
```

Run backbone first. Re-run the identical command to resume; completed batches are no-ops. A new run ID creates a fresh source cache and publication for later updates. Do not run another writer while a staged archive exists: activation refuses to overwrite a newer public publication.

Native database verification (temporary tables only, no published data changes):

```powershell
node --env-file=.env scripts/check-archive-database.js
```

The command discovers provider-listed seasons, newest first, with season-wide results, qualifying and sprint queries and explicit round standings. Laps and pits are a separate phase. Successful raw pages, including empty successful responses, are checksum-checked in ignored `.cache/archive/RUN_ID/jolpica`; paths identify season, round, category and page offset. Never delete this cache during an incomplete run. HTTP errors are not cached as missing coverage. Failed required categories stop the phase, keeping public readers on the preceding complete snapshot. Re-running reuses pages and committed round checkpoints. Current-season data is fixed to the run's retrieved responses; use a new run ID to refresh it.

An optional third argument supplies a verified official Jolpica bulk export directory containing `dump.zip` and its public `metadata.json` (the delayed CSV dump object from the official dump metadata API). The ZIP is rechecked against the manifest SHA256 and byte length on every load. Only named CSV tables are read in memory; no ZIP paths are extracted. This supplies historical standings only, using the provider's explicit driver/team reference identifiers and round identities. Points and ranks are read from the export, never recomputed. Missing rank remains null. The export year and newer years always use API requests; unmapped identities, absent rows and other unsupported mappings fall back to the API. Per-standing provenance records the export timestamp and checksum version. API race data keeps its own provenance. The optional argument is not enabled automatically and does not change a running process.

```powershell
node --env-file=.env scripts/archive.js backbone archive-20260918 .cache/archive/archive-20260918/bulk-review
```

Only use this after mapping checks against cached API standings pass. Public bulk files stay ignored; never commit source data. A completed round checkpoint is retained when resuming with the optional export, so earlier successful API work is preserved.

Provider requests use concurrency one, at least eight seconds between requests (below Jolpica's documented 500/hour sustained limit), network/429/5xx retries and Retry-After including HTTP dates. Completed page responses contain public data only. No credentials belong in cache, command arguments or logs.

Each phase creates one staging publication and copies the preceding snapshot once. Parameterized bulk inserts replace only affected datasets; observations are content-addressed. Normalized rows and the round checkpoint commit together. A transaction failure cannot mark that round complete. Provenance, aliases, retained data, reconciliation and source status pass through the existing SyncService. Activation changes the public pointer atomically after all seasons finish, with a base-publication check. Existing snapshots are retained; no destructive pruning is performed. This avoids one full snapshot per weekend, but does not remove the need to measure database capacity before high-volume enrichment.

Sources with no results remain unavailable; scheduled events are not called completed. The source catalogue does not prove data for every category. F1DB is not automatically mixed into this command: pinned checksum and reviewed identity mapping remain prerequisites. OpenF1 mapping/enrichment runs separately; telemetry ingestion is not claimed by this command.

Operational progress is JSON containing phase, year, round, safe counts and status. A paused failure deliberately suppresses database details. Run IDs and `archive_steps` provide durable progress; `sync_runs` records each execution outcome. A killed process can leave a running audit row, but connection loss releases the global advisory lock and the next invocation resumes from durable steps.
