# Publication hold

The active `archive-20260918-backbone` staging publication has a database activation hold, placed on 18 September 2026 following the instruction to continue importing without switching the public snapshot.

Migration 003 adds a targeted hold table and a trigger on the publication pointer. The hold applies only to the selected publication. It does not interrupt source retrieval, round checkpoints or ordinary reads. Native verification attempted the held switch inside a transaction: the trigger rejected it, and the transaction was rolled back. Public data did not change.

The existing archive process normally calls activation after all seasons finish. While this hold exists, that call will fail with the safe database message `ARCHIVE_ACTIVATION_HELD`; the CLI will report a resumable pause. Completed pages and checkpoints remain intact. This is an intentional publication boundary, not a missing-data failure.

Do not release the hold or start enrichment until instructed. After the backbone finishes, verify the staged counts and API payloads before an explicitly authorized activation. Releasing a hold is a separate operator action; the importer does not clear holds automatically. Existing publications are not deleted.
