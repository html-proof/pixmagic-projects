-- A platform sign-in that reaches no ad account yet (Meta: the Facebook login has none, its accounts sit
-- in a business portfolio it isn't assigned to, or it shared none), kept connected rather than refused:
-- the card says who is connected, and the cron tick connects the login's ad accounts once the platform
-- lists some. Nothing secret: Nango keeps the token, this row names its connection. Additive only: code
-- from before ignores the new table.

-- CreateTable
CREATE TABLE "ad_logins" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "source_login_id" TEXT NOT NULL,
    "nango_integration_key" TEXT NOT NULL,
    "external_user_id" TEXT,
    "login_name" TEXT,
    "granted_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "access_token_expires_at" TIMESTAMP(3),
    "connected_by_user_id" TEXT,
    "reason" TEXT NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_logins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ad_logins_workspace_id_idx" ON "ad_logins"("workspace_id");

-- CreateIndex
CREATE INDEX "ad_logins_external_user_id_idx" ON "ad_logins"("external_user_id");

-- CreateIndex
CREATE INDEX "ad_logins_source_login_id_idx" ON "ad_logins"("source_login_id");

-- CreateIndex
CREATE UNIQUE INDEX "ad_logins_store_id_provider_key" ON "ad_logins"("store_id", "provider");

ALTER TABLE "ad_logins" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ad_logins" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
