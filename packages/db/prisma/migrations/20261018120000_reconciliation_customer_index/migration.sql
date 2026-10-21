-- Shopify reconciliation, customer order position and Shopify's own report figures. Expand only:
-- two nullable columns and three new tables, so the code before it keeps working (deployed first,
-- the code that uses them after).
--
-- orders.customer_order_index: Shopify's position of the order in its customer's history
-- (CustomerJourneySummary.customerOrderIndex), so a customer's first purchase counts as new even
-- after they buy again; customer_order_count: Customer.numberOfOrders when read, the fallback.
-- reconciliations / reconciliation_results: each check of a store's figures against Shopify
-- (packages/core/src/reconcile.ts). shopify_reports: ShopifyQL answers (read_reports).
-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "customer_order_count" INTEGER,
ADD COLUMN     "customer_order_index" INTEGER;

-- CreateTable
CREATE TABLE "shopify_reports" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "time_window" TEXT NOT NULL,
    "values" JSONB,
    "error" TEXT,
    "fetched_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "from_day" TEXT NOT NULL,
    "to_day" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "orders_checked" INTEGER NOT NULL DEFAULT 0,
    "findings" JSONB,
    "actions" JSONB,
    "state" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_results" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "reconciliation_id" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "shopify_value" DECIMAL(18,2),
    "before_value" DECIMAL(18,2),
    "after_value" DECIMAL(18,2),
    "status" TEXT NOT NULL,
    "cause" TEXT,

    CONSTRAINT "reconciliation_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shopify_reports_workspace_id_idx" ON "shopify_reports"("workspace_id");

-- CreateIndex
CREATE INDEX "shopify_reports_fetched_at_idx" ON "shopify_reports"("fetched_at");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_reports_store_id_dataset_time_window_key" ON "shopify_reports"("store_id", "dataset", "time_window");

-- CreateIndex
CREATE INDEX "reconciliations_store_id_started_at_idx" ON "reconciliations"("store_id", "started_at");

-- CreateIndex
CREATE INDEX "reconciliations_workspace_id_idx" ON "reconciliations"("workspace_id");

-- CreateIndex
CREATE INDEX "reconciliation_results_workspace_id_idx" ON "reconciliation_results"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_results_reconciliation_id_metric_key" ON "reconciliation_results"("reconciliation_id", "metric");

-- AddForeignKey
ALTER TABLE "shopify_reports" ADD CONSTRAINT "shopify_reports_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_results" ADD CONSTRAINT "reconciliation_results_reconciliation_id_fkey" FOREIGN KEY ("reconciliation_id") REFERENCES "reconciliations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row level security, as for every tenant table (see 20261002070200_rls).
ALTER TABLE "shopify_reports" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "shopify_reports" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "reconciliations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reconciliations" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "reconciliation_results" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reconciliation_results" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
