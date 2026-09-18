-- OpenF1 staging stores only changed datasets. Manifests share immutable base rows.
CREATE TABLE publication_dataset_refs (
 publication_id text NOT NULL REFERENCES publications(id),
 key text NOT NULL,
 dataset_publication_id text NOT NULL,
 PRIMARY KEY(publication_id,key),
 FOREIGN KEY(dataset_publication_id,key) REFERENCES datasets(publication_id,key)
);
CREATE TABLE enrichment_workspace (
 singleton integer PRIMARY KEY CHECK(singleton=1),
 publication_id text NOT NULL UNIQUE REFERENCES publications(id),
 base_publication text NOT NULL REFERENCES publications(id),
 public_at_creation text NOT NULL REFERENCES publications(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE publication_dataset_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_workspace ENABLE ROW LEVEL SECURITY;
