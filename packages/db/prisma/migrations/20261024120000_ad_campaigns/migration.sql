-- Each ad campaign as its platform last described it to a sync: name and delivery status (Google's
-- campaign.status, Meta's effective_status), for the Advertising pages' campaign filters. The days stay
-- in ad_campaign_daily. Additive only: code from before ignores the new table; syncs fill it in.

-- CreateTable
CREATE TABLE "ad_campaigns" (
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT,
    "checked_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_campaigns_pkey" PRIMARY KEY ("connection_id","campaign_id")
);

-- CreateIndex
CREATE INDEX "ad_campaigns_workspace_id_idx" ON "ad_campaigns"("workspace_id");

-- CreateIndex
CREATE INDEX "ad_campaigns_store_id_idx" ON "ad_campaigns"("store_id");

-- AddForeignKey
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "ad_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ad_campaigns" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ad_campaigns" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
