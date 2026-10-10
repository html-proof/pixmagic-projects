-- CreateTable
CREATE TABLE "ad_connections" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "account_name" TEXT,
    "currency" TEXT,
    "timezone" TEXT,
    "login_customer_id" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_error" TEXT,
    "last_synced_at" TIMESTAMP(3),
    "access_token_enc" TEXT NOT NULL,
    "refresh_token_enc" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "token_key_version" INTEGER NOT NULL,
    "connected_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_campaign_daily" (
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "campaign_name" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "spend" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "conversions" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "conversion_value" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "leads" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_campaign_daily_pkey" PRIMARY KEY ("connection_id","campaign_id","day")
);

-- CreateIndex
CREATE INDEX "ad_connections_workspace_id_idx" ON "ad_connections"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "ad_connections_store_id_provider_account_id_key" ON "ad_connections"("store_id", "provider", "account_id");

-- CreateIndex
CREATE INDEX "ad_campaign_daily_workspace_id_idx" ON "ad_campaign_daily"("workspace_id");

-- CreateIndex
CREATE INDEX "ad_campaign_daily_store_id_day_idx" ON "ad_campaign_daily"("store_id", "day");

-- Row level security, as for every store-scoped table (see 20261002070200_rls).
ALTER TABLE "ad_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ad_connections" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "ad_campaign_daily" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ad_campaign_daily" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
