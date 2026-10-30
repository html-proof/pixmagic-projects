-- A store's own costs (Settings -> Costs, docs/kpis.md "Costs and net profit"). Expand-only: two
-- new tables, nothing else changes, so the code live before this release reads none of it; the
-- release's own code waits for them (core expenses.ts, expensesReady) between its deploy and this
-- migration.
--
-- store_expenses: one cost the owner entered (the Shopify plan, an app, staff, rent...), in the
-- store's currency, and how often it is paid.
-- store_expense_settings: from which day the owner says the list holds every cost (net profit is
-- given only for dates from then on).

-- CreateTable
CREATE TABLE "store_expenses" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "cadence" TEXT NOT NULL,
    "starts_on" TEXT NOT NULL,
    "ends_on" TEXT,
    "note" TEXT,
    "created_by_user_id" TEXT,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_expense_settings" (
    "store_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "complete_from" TEXT,
    "updated_by_user_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_expense_settings_pkey" PRIMARY KEY ("store_id")
);

-- CreateIndex
CREATE INDEX "store_expenses_workspace_id_idx" ON "store_expenses"("workspace_id");

-- CreateIndex
CREATE INDEX "store_expenses_store_id_idx" ON "store_expenses"("store_id");

-- CreateIndex
CREATE INDEX "store_expense_settings_workspace_id_idx" ON "store_expense_settings"("workspace_id");

-- AddForeignKey
ALTER TABLE "store_expenses" ADD CONSTRAINT "store_expenses_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_expense_settings" ADD CONSTRAINT "store_expense_settings_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row level security, as for every tenant table (see 20261002070200_rls).
ALTER TABLE "store_expenses" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "store_expenses" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "store_expense_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "store_expense_settings" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
