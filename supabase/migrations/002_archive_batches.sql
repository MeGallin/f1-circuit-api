CREATE TABLE archive_batches (
  id text PRIMARY KEY,
  phase text NOT NULL,
  base_publication text REFERENCES publications(id),
  publication_id text NOT NULL REFERENCES publications(id),
  status text NOT NULL CHECK (status IN ('staging','completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE archive_steps (
  batch_id text NOT NULL REFERENCES archive_batches(id),
  key text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(batch_id,key)
);
ALTER TABLE archive_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_steps ENABLE ROW LEVEL SECURITY;
