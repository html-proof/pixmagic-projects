-- A store's full order history (read_all_orders) is imported one store-local calendar year at a
-- time, newest first: one row per year of the import's plan (packages/core/src/orderHistory.ts), so
-- the dashboard can say which years are in, an import that stopped resumes at the year it stopped
-- in, and a year that failed says why. Additive only: code from before ignores the new table, and the
-- new code reads it only for stores holding read_all_orders.
-- Two indexes on orders: the cancellations in the dates asked about (recent orders), and a year's
-- orders by creation date (what each year's import holds).

-- CreateTable
CREATE TABLE "order_history_windows" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "plan_job_id" TEXT NOT NULL,
    "sync_job_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "from_at" TIMESTAMP(3) NOT NULL,
    "to_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'queued',
    "orders" INTEGER NOT NULL DEFAULT 0,
    "with_customers" BOOLEAN NOT NULL,
    "bulk_operation_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_history_windows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_history_windows_workspace_id_idx" ON "order_history_windows"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_history_windows_store_id_year_key" ON "order_history_windows"("store_id", "year");

-- CreateIndex
CREATE INDEX "orders_store_id_cancelled_at_idx" ON "orders"("store_id", "cancelled_at");

-- CreateIndex
CREATE INDEX "orders_store_id_shopify_created_at_idx" ON "orders"("store_id", "shopify_created_at");

ALTER TABLE "order_history_windows" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "order_history_windows" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
