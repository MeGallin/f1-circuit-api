CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE publications (
 id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), content_hash text NOT NULL,
 provenance jsonb NOT NULL, CHECK (jsonb_typeof(provenance)='object')
);
CREATE TABLE current_publication (singleton integer PRIMARY KEY CHECK(singleton=1), publication_id text NOT NULL REFERENCES publications(id));
CREATE TABLE datasets (
 publication_id text NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
 key text NOT NULL, schema_name text NOT NULL, coverage text NOT NULL CHECK(coverage IN ('complete','partial','unavailable','not-applicable','pending')),
 verification text NOT NULL CHECK(verification IN ('verified','reconciled','source-only','conflict','unassessed')),
 evidence_id text NOT NULL, metadata jsonb NOT NULL,
 PRIMARY KEY(publication_id,key)
);
CREATE TABLE normalized_records (
 publication_id text NOT NULL, dataset_key text NOT NULL, id text NOT NULL, ordinal integer NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 PRIMARY KEY(publication_id,dataset_key,id),
 FOREIGN KEY(publication_id,dataset_key) REFERENCES datasets(publication_id,key) ON DELETE CASCADE
);
CREATE INDEX normalized_records_order ON normalized_records(publication_id,dataset_key,ordinal,id);
CREATE TABLE entity_aliases (
 publication_id text NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
 alias text NOT NULL, canonical_id text NOT NULL,
 PRIMARY KEY(publication_id,alias)
);
CREATE TABLE source_observations (
 id text PRIMARY KEY, provider text NOT NULL, source_version text,
 retrieved_at timestamptz NOT NULL, checksum text NOT NULL, source_url text NOT NULL,
 payload jsonb NOT NULL, CHECK(jsonb_typeof(payload) IN ('object','array'))
);
CREATE TABLE sync_runs (
 id text PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 provider text NOT NULL, scope text NOT NULL, status text NOT NULL CHECK(status IN ('running','completed','failed')),
 publication_id text REFERENCES publications(id), error_code text
);
-- Public Supabase Data API access is not used. Server connects with a dedicated database role.
ALTER TABLE publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE current_publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE normalized_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_runs ENABLE ROW LEVEL SECURITY;
