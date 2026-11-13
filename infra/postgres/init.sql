-- Runs on first container start (docker-entrypoint-initdb.d), in CI, and by the
-- test global setup. Idempotent. app_rls (tenant requests) and app_system (the
-- system paths, below) are NON-owner roles, so Postgres row level security
-- applies to them. The owner role ("app") runs migrations.
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
  FOREACH t IN ARRAY ARRAY['pixel_events_seen', 'auth_identities', 'auth_events', 'user_sessions', 'zapier_tokens', '_prisma_migrations',
                           -- The self-hosted runtime's queue, schedules and coordinator (migration 20261106120000_selfhost_runtime).
                           'job_queue', 'job_dead', 'schedule_ticks', 'coord_entries',
                           -- The app's own sign-in directory (migration 20261107120000_own_sign_in).
                           'auth_accounts', 'auth_refresh_tokens'] LOOP
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

-- app_system: the system paths' login (systemDb: webhooks, jobs, sweeps, sign-in), and like app_rls
-- a NON-owner, so row-level security applies to it too (docs/system-database-role.md). It reads and
-- writes rows; it owns nothing and changes no table. On AWS the migrate action creates it first,
-- with the password from insights/<env>/db-system, so the development password below never exists there.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
    CREATE ROLE app_system LOGIN PASSWORD 'app_system' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_system', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO app_system;
ALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_system;
DO $$
DECLARE t text;
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON _prisma_migrations FROM app_system;
  END IF;
  -- Which workspace's rows it sees is set per connection by @app/db (forTenant / crossTenant):
  -- `tenant_isolation` (every role) shows the one in app.workspace_id; this shows every workspace
  -- inside crossTenant, which sets app.scope = 'all'. Made here rather than in each migration, so a
  -- new tenant table has it after the next migrate (apps/api/test/security.test.ts checks).
  FOR t IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE c.relkind = 'r' AND (c.relname = 'workspaces' OR EXISTS (
      SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped))
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = format('public.%I', t)::regclass AND p.polname = 'system_all') THEN
      EXECUTE format($p$CREATE POLICY system_all ON public.%I TO app_system USING (current_setting('app.scope', true) = 'all') WITH CHECK (current_setting('app.scope', true) = 'all')$p$, t);
    END IF;
  END LOOP;
  -- Tables that belong to no workspace (people, sign-in, intake): the system paths read them in every
  -- scope, since sign-in needs them before any workspace is known. Named one by one, so a table only
  -- joins this list in review.
  -- to_regclass in the lookup too, never a ::regclass cast: Postgres works the cast out while it
  -- plans the IF, whatever the first half says, and on a fresh volume (no tables yet) the cast
  -- failed with 'relation "public.users" does not exist'. That aborted the entrypoint on every first
  -- start; Docker restarted the container, and CI's `docker compose up --wait` failed whenever it
  -- looked in between (main's browser tests for #379 and #380, 2026-11-12).
  FOREACH t IN ARRAY ARRAY['users', 'auth_identities', 'auth_events', 'user_sessions', 'pixel_events_seen', 'auth_accounts', 'auth_refresh_tokens'] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = to_regclass(format('public.%I', t)) AND p.polname = 'system_any') THEN
      EXECUTE format('CREATE POLICY system_any ON public.%I TO app_system USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
END $$;
