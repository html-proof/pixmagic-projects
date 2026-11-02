-- The days a store is open (the Profit sheet's profit and loss, docs/kpis.md "Profit and loss"): its
-- recurring costs are spread over those days only (expenseInRange in @app/shared/expenses). Expand-only:
-- one column with a default, so the code live before this release, which never reads it, works as before,
-- and every store keeps spreading its costs over every calendar day until its owner says otherwise.

-- AlterTable
ALTER TABLE "store_expense_settings" ADD COLUMN     "operating_weekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
