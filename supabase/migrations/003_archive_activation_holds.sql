CREATE TABLE archive_activation_holds (
  publication_id text PRIMARY KEY REFERENCES publications(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE archive_activation_holds ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION prevent_held_archive_activation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.archive_activation_holds WHERE publication_id=NEW.publication_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ARCHIVE_ACTIVATION_HELD';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER archive_activation_hold
BEFORE INSERT OR UPDATE ON current_publication
FOR EACH ROW EXECUTE FUNCTION prevent_held_archive_activation();
