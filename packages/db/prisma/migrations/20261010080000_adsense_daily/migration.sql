-- CreateTable
CREATE TABLE "adsense_daily" (
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "site" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "earnings" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "page_views" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "adsense_daily_pkey" PRIMARY KEY ("connection_id","site","day")
);

-- CreateIndex
CREATE INDEX "adsense_daily_workspace_id_idx" ON "adsense_daily"("workspace_id");

-- CreateIndex
CREATE INDEX "adsense_daily_store_id_day_idx" ON "adsense_daily"("store_id", "day");

-- Row level security, as for every store-scoped table (see 20261002070200_rls).
ALTER TABLE "adsense_daily" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "adsense_daily" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
