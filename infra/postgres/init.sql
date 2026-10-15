-- Runs on first container start (docker-entrypoint-initdb.d), in CI, and by the
-- test global setup. Idempotent. app_rls is a NON-owner role, so Postgres row
-- level security applies to it. The owner role ("app") runs migrations and
-- system jobs (webhooks, worker).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    CREATE ROLE app_rls LOGIN PASSWORD 'app_rls';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_rls', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO app_rls;
ALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rls;
-- Tenant role never needs these. On a fresh volume (docker-entrypoint-initdb.d) the tables do not
-- exist yet - migrations create them later - and an unconditional REVOKE aborts the entrypoint,
-- so Postgres never starts. The default privileges above would then grant them on creation, so
-- the test/e2e setup re-runs this file after migrating, which is when the REVOKE takes effect.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['email_otps', 'pixel_events_seen', 'auth_identities', 'auth_events', '_prisma_migrations'] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON %I FROM app_rls', t);
    END IF;
  END LOOP;
END $$;
