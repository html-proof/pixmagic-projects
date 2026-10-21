-- Shopify's total sales breakdown line by line (docs/kpis.md, "Total sales breakdown and Custom
-- sales"). Expand-only: the code live before this release reads none of it.
--
-- daily_store_metrics: duties and additional fees get columns of their own. Until now they were
-- only inside total_sales (dayTotals' "other"), so the dashboard couldn't show or leave them out.
-- sales_calculations: a store's own calculation from those lines (which lines Custom sales counts),
-- never an amount.

-- AlterTable
ALTER TABLE "daily_store_metrics" ADD COLUMN     "additional_fees" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "duties" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "sales_calculations" (
    "store_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "components" JSONB NOT NULL,
    "label" TEXT,
    "apply_to_dashboard" BOOLEAN NOT NULL DEFAULT false,
    "presets" JSONB NOT NULL DEFAULT '[]',
    "updated_by_user_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_calculations_pkey" PRIMARY KEY ("store_id")
);

-- CreateIndex
CREATE INDEX "sales_calculations_workspace_id_idx" ON "sales_calculations"("workspace_id");

-- AddForeignKey
ALTER TABLE "sales_calculations" ADD CONSTRAINT "sales_calculations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row level security, as for every tenant table (see 20261002070200_rls).
ALTER TABLE "sales_calculations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales_calculations" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- Data: split out the duties and additional fees every stored day already holds inside total_sales,
-- from the same sales records and with the same arithmetic as dayTotals in
-- packages/core/src/persist.ts (a duty sale is a duty; a fee, an additional fee or a sale of no
-- known type is an additional fee; values before tax). total_sales and every other column stay as
-- they are: no figure Shopify reports changes. Idempotent: it sets, never adds.
UPDATE daily_store_metrics m
SET duties = x.duties,
    additional_fees = x.fees
FROM (
  SELECT s.store_id, s.local_day AS day,
         COALESCE(SUM(s.amount - s.tax) FILTER (WHERE s.line_type = 'duty'), 0) AS duties,
         COALESCE(SUM(s.amount - s.tax) FILTER (WHERE s.line_type <> 'duty'), 0) AS fees
  FROM order_sales s
  JOIN orders o ON o.id = s.order_id
  WHERE s.line_type NOT IN ('product', 'adjustment', 'shipping', 'gift_card', 'tip')
  GROUP BY s.store_id, s.local_day
) x
WHERE m.store_id = x.store_id AND m.day = x.day;
