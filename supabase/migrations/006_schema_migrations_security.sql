-- The migration runner connects as postgres and remains the owner of this table.
-- RLS has no policies, and the Data API roles receive no table privileges.
ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM PUBLIC, anon, authenticated;
