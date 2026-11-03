-- Profit & Loss: costs the owner manages from the page (docs/kpis.md "Costs and net profit"). Expand-only:
-- new nullable columns or columns with a default on store_expenses, and two new tables, so the code live
-- before this release reads and writes store_expenses as before (every cost it saved is an amount, not
-- paused), and reads none of the new tables.
--
-- store_expenses: how a cost is worked out (an amount, a percentage of sales, an amount per order or
-- item), what a percentage is of, the currency it was entered in, a description, vendor and payment
-- method, from which day its payments stopped while paused, and the cost it took over from.
-- expense_categories: a category a store made for its own costs, with the section they go in.
-- expense_entries: each payment of a recurring cost that has fallen due, kept as it was paid; one per
-- cost and due day, so recording them again never makes a second.

-- AlterTable
ALTER TABLE "store_expenses" ADD COLUMN     "currency" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "method" TEXT NOT NULL DEFAULT 'amount',
ADD COLUMN     "paused_from" TEXT,
ADD COLUMN     "payment_method" TEXT,
ADD COLUMN     "percent_base" TEXT,
ADD COLUMN     "replaces_id" TEXT,
ADD COLUMN     "vendor" TEXT;

-- CreateTable
CREATE TABLE "expense_categories" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_entries" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "expense_id" TEXT NOT NULL,
    "due_on" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "scheduled_amount" DECIMAL(18,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'posted',
    "note" TEXT,
    "edited_by_user_id" TEXT,
    "edited_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expense_categories_workspace_id_idx" ON "expense_categories"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_store_id_name_key" ON "expense_categories"("store_id", "name");

-- CreateIndex
CREATE INDEX "expense_entries_workspace_id_idx" ON "expense_entries"("workspace_id");

-- CreateIndex
CREATE INDEX "expense_entries_store_id_due_on_idx" ON "expense_entries"("store_id", "due_on");

-- CreateIndex
CREATE UNIQUE INDEX "expense_entries_expense_id_due_on_key" ON "expense_entries"("expense_id", "due_on");

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "store_expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row level security, as for every tenant table (see 20261002070200_rls).
ALTER TABLE "expense_categories" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "expense_categories" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "expense_entries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "expense_entries" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
