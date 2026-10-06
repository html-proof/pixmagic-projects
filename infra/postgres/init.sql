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
-- Tenant role never needs these.
REVOKE ALL ON email_otps, pixel_events_seen, _prisma_migrations FROM app_rls;
