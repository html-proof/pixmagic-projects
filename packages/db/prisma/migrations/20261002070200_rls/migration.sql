-- Row level security: applies to non-owner roles (app_rls). The owner role
-- used by migrations/worker is not affected (RLS is not FORCEd).
-- current_setting(..., true) returns NULL when unset => no rows visible.
ALTER TABLE "stores" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stores" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "products" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "orders" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "order_line_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "order_line_items" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "refunds" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "refunds" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "daily_store_metrics" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "daily_store_metrics" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "funnel_daily" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "funnel_daily" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "sync_jobs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sync_jobs" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "alerts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "alerts" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "api_keys" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_logs" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "memberships" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invitations" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "subscriptions" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notification_preferences" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "webhook_events" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "workspaces" USING (id = current_setting('app.workspace_id', true));
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_members ON "users" USING (id IN (SELECT user_id FROM memberships WHERE workspace_id = current_setting('app.workspace_id', true)));
-- Tables the tenant role must never touch.
ALTER TABLE "email_otps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pixel_events_seen" ENABLE ROW LEVEL SECURITY;
