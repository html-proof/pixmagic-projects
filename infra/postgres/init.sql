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
  -- Read-only or append-only for tenant requests (also in migration 20261016100000_security_hardening,
  -- repeated here because the blanket GRANT above would otherwise hand the rights back).
  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM app_rls;
  END IF;
  IF to_regclass('public.users') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON users FROM app_rls;
  END IF;
  -- The stock history and the adjustments made in bizinsights (migration 20261019120000_inventory_module).
  IF to_regclass('public.inventory_adjustments') IS NOT NULL THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON inventory_adjustments FROM app_rls;
  END IF;
  IF to_regclass('public.inventory_movements') IS NOT NULL THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON inventory_movements FROM app_rls;
  END IF;
END $$;
