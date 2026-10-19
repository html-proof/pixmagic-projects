-- Shopify's report rules for the order count, items sold and average order value (docs/kpis.md),
-- found by checking a dev store of seeded orders against its own ShopifyQL sales report. Expand
-- only: nullable or defaulted columns, so the code before it keeps working (deployed first).
--
-- orders.shopify_processed_at: Order.processedAt, the date Shopify's reports put an order on. An
-- imported, POS-offline or marketplace order was processed before Shopify created it. Null on
-- orders stored before it was read: the re-read after the deploy (seedSalesRereads) fills it in.
-- orders.gift_card_only: every item a gift card; Shopify's reports count neither such an order nor
-- its customer.
-- order_sales.agreement: the agreement a sales record belongs to (OrderActionType, lowercase:
-- order, order_edit, refund, return, ...). Shopify's AOV counts an order's own sales only.
-- daily_store_metrics.order_value: AOV's numerator. Null on rows from before it was kept, where
-- the dashboard falls back to gross sales - discounts.
-- AlterTable
ALTER TABLE "daily_store_metrics" ADD COLUMN     "order_value" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "order_sales" ADD COLUMN     "agreement" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "gift_card_only" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shopify_processed_at" TIMESTAMP(3);
