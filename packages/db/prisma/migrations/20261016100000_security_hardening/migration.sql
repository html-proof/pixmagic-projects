-- Security hardening (docs/security/SECURITY_AUDIT.md). Additive: no table or column changes.

-- 1. The audit trail is append-only. The tenant role (every signed-in request) may read entries and
--    add them, never change or remove one; and no role can edit an entry. Deleting a workspace still
--    removes its entries through the foreign key. `users` is written only by the owner role
--    (sign-in), so tenant requests lose write access to it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "audit_logs" FROM app_rls;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "users" FROM app_rls;
  END IF;
END $$;

CREATE FUNCTION "audit_log_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit log entry % cannot be changed', OLD."id" USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER "audit_logs_immutable" BEFORE UPDATE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION "audit_log_immutable"();

-- 2. Staff Management freeze triggers (20261014120000_staff_management), three gaps closed:
--    a. an UPDATE that cleared locked_at in the same statement as changing a paid shift's times got
--       through (only reversing a payroll may unlock, and it changes nothing else);
--    b. a paid shift's breaks could be deleted (the trigger covered INSERT and UPDATE only);
--    c. a finalized payroll's items could be deleted.
--    Deleting the parent row (a cascade) is still allowed: by then the parent is gone, so the
--    EXISTS checks find nothing.
CREATE OR REPLACE FUNCTION "staff_session_frozen"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."locked_at" IS NOT NULL
     AND (NEW."clock_in_at", NEW."clock_out_at", NEW."employee_id", NEW."approval_status")
         IS DISTINCT FROM (OLD."clock_in_at", OLD."clock_out_at", OLD."employee_id", OLD."approval_status")
  THEN
    RAISE EXCEPTION 'shift % is part of a finalized payroll', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "staff_break_frozen_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "attendance_sessions" s WHERE s."id" = OLD."session_id" AND s."locked_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'shift % is part of a finalized payroll', OLD."session_id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER "break_sessions_frozen_delete" BEFORE DELETE ON "break_sessions" FOR EACH ROW EXECUTE FUNCTION "staff_break_frozen_delete"();

CREATE FUNCTION "staff_payroll_item_frozen_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "payroll_periods" p WHERE p."id" = OLD."period_id" AND p."locked_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'payroll item % belongs to a finalized pay period', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER "payroll_items_frozen_delete" BEFORE DELETE ON "payroll_items" FOR EACH ROW EXECUTE FUNCTION "staff_payroll_item_frozen_delete"();

-- 3. The pixel's dedupe ids are pruned by age every 15 minutes (apps/worker prunePixelDedupe).
CREATE INDEX "pixel_events_seen_seen_at_idx" ON "pixel_events_seen"("seen_at");
