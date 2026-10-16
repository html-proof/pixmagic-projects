-- Shopify's own sales records (Order.agreements → sales), which its reports are built from: the
-- dashboard's sales totals are read from these so they match Shopify's (docs/kpis.md).
ALTER TABLE "daily_store_metrics" ADD COLUMN     "shipping" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "taxes" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "total_sales" DECIMAL(18,2) NOT NULL DEFAULT 0;

ALTER TABLE "orders" ADD COLUMN     "sales_key" TEXT,
ADD COLUMN     "sales_updated_at" TIMESTAMP(3);

CREATE TABLE "order_sales" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "shopify_id" TEXT NOT NULL,
    "local_day" TEXT NOT NULL,
    "happened_at" TIMESTAMP(3) NOT NULL,
    "action_type" TEXT NOT NULL,
    "line_type" TEXT NOT NULL,
    "line_item_shopify_id" TEXT,
    "quantity" INTEGER,
    "amount" DECIMAL(18,2) NOT NULL,
    "discount" DECIMAL(18,2) NOT NULL,
    "tax" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "order_sales_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "order_sales_store_id_local_day_idx" ON "order_sales"("store_id", "local_day");

CREATE INDEX "order_sales_order_id_idx" ON "order_sales"("order_id");

CREATE INDEX "order_sales_workspace_id_idx" ON "order_sales"("workspace_id");

CREATE UNIQUE INDEX "order_sales_store_id_shopify_id_key" ON "order_sales"("store_id", "shopify_id");

ALTER TABLE "order_sales" ADD CONSTRAINT "order_sales_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row level security, as for every tenant table (see 20261002070200_rls).
ALTER TABLE "order_sales" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "order_sales" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- Until each store's orders are read again with their sales (the dashboard's refresh does it once,
-- apps/api/src/sync.ts), its existing days keep their old totals; give them shipping, tax and a
-- total from the order totals meanwhile, so "Total sales" doesn't read $0 in the gap.
UPDATE "daily_store_metrics" m
SET "shipping" = o.shipping,
    "taxes" = o.taxes,
    "total_sales" = m."gross_sales" - m."discounts" - m."refunds" + o.shipping + o.taxes
FROM (
  SELECT "store_id", "local_day", SUM("total_shipping") AS shipping, SUM("total_tax") AS taxes
  FROM "orders"
  WHERE "cancelled_at" IS NULL
  GROUP BY "store_id", "local_day"
) o
WHERE o."store_id" = m."store_id" AND o."local_day" = m."day";
UPDATE "daily_store_metrics" SET "total_sales" = "gross_sales" - "discounts" - "refunds" WHERE "total_sales" = 0;
