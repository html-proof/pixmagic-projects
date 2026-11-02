-- Ad spend, impressions and clicks as the store's marketing apps report them to Shopify (ShopifyQL's
-- marketing_engagements, docs/advertising.md "Shopify marketing"). Expand-only: two new tables, nothing
-- else changes, so the code live before this release reads none of it; the release's own code finds
-- them missing between its deploy and this migration and shows nothing from them meanwhile
-- (core shopifyMarketing.ts, marketingReady).
--
-- shopify_marketing_days: one channel's figures for one store-local day, whole (campaign '') or one
-- campaign's part of it, replaced window by window on each read.
-- shopify_marketing_syncs: one row per store: the days read and the last read's outcome.

-- CreateTable
CREATE TABLE "shopify_marketing_days" (
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "app" TEXT NOT NULL DEFAULT '',
    "campaign" TEXT NOT NULL DEFAULT '',
    "spend" DECIMAL(18,2),
    "impressions" INTEGER,
    "clicks" INTEGER,
    "orders" DOUBLE PRECISION,
    "sales" DECIMAL(18,2),
    "new_customers" DOUBLE PRECISION,
    "currency" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_marketing_days_pkey" PRIMARY KEY ("store_id","day","channel","app","campaign")
);

-- CreateTable
CREATE TABLE "shopify_marketing_syncs" (
    "store_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "covered_from" TEXT,
    "synced_through" TEXT,
    "backfilled" BOOLEAN NOT NULL DEFAULT false,
    "last_synced_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_marketing_syncs_pkey" PRIMARY KEY ("store_id")
);

-- CreateIndex
CREATE INDEX "shopify_marketing_days_workspace_id_idx" ON "shopify_marketing_days"("workspace_id");

-- CreateIndex
CREATE INDEX "shopify_marketing_syncs_workspace_id_idx" ON "shopify_marketing_syncs"("workspace_id");

-- AddForeignKey
ALTER TABLE "shopify_marketing_days" ADD CONSTRAINT "shopify_marketing_days_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_marketing_syncs" ADD CONSTRAINT "shopify_marketing_syncs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row level security, as for every tenant table (see 20261002070200_rls).
ALTER TABLE "shopify_marketing_days" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "shopify_marketing_days" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "shopify_marketing_syncs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "shopify_marketing_syncs" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
