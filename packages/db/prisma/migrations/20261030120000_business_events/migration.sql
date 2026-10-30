-- Business events on the Profit sheet (/sheet, docs/kpis.md "Profit sheet"). Expand-only: one new
-- table, nothing else changes, so the code live before this release reads none of it; between this
-- release's deploy and this migration the sheet shows its figures without the events.
--
-- business_events: one event a member marked (a sale, an ad campaign, a product launch...) from one
-- store-local day to another, both included.

-- CreateTable
CREATE TABLE "business_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "starts_on" TEXT NOT NULL,
    "ends_on" TEXT NOT NULL,
    "note" TEXT,
    "created_by_user_id" TEXT,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "business_events_workspace_id_idx" ON "business_events"("workspace_id");

-- CreateIndex
CREATE INDEX "business_events_store_id_starts_on_idx" ON "business_events"("store_id", "starts_on");

-- AddForeignKey
ALTER TABLE "business_events" ADD CONSTRAINT "business_events_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row level security, as for every tenant table (see 20261002070200_rls).
ALTER TABLE "business_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "business_events" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
