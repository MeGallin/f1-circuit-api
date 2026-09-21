-- Publication-scoped hybrid retrieval index for the Ask route.
-- The relational publication remains authoritative; these rows are a rebuildable
-- search projection and are never queried as the factual source of an answer.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE question_documents (
  publication_id text NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  document_id text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  dataset_key text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  search_text tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  embedding vector(1536) NOT NULL,
  content_hash text NOT NULL,
  embedding_model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (publication_id, document_id)
);

CREATE INDEX question_documents_entity
  ON question_documents(publication_id, entity_type, entity_id);
CREATE INDEX question_documents_dataset
  ON question_documents(publication_id, dataset_key);
CREATE INDEX question_documents_search_text
  ON question_documents USING GIN(search_text);
CREATE INDEX question_documents_content_trgm
  ON question_documents USING GIN(content gin_trgm_ops);
CREATE INDEX question_documents_embedding_hnsw
  ON question_documents USING hnsw (embedding vector_cosine_ops);

CREATE TABLE question_index_manifests (
  publication_id text PRIMARY KEY REFERENCES publications(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending','building','ready','failed')),
  document_count integer NOT NULL DEFAULT 0,
  embedding_model text NOT NULL,
  source_hash text NOT NULL,
  error_code text,
  started_at timestamptz,
  completed_at timestamptz
);

ALTER TABLE question_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_index_manifests ENABLE ROW LEVEL SECURITY;
