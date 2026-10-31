-- Refunds shown on the Total sales tile (docs/kpis.md, "Total refunded"). Expand-only: the code
-- live before this release reads none of it.
--
-- daily_store_metrics.total_refunded: what refunds, returns and cancellations took off total sales
-- that day, tax, shipping, duties and fees in. Until now only the returns line (before tax, items
-- only) was kept, so the dashboard couldn't say how much of total sales refunds took back.

-- AlterTable
ALTER TABLE "daily_store_metrics" ADD COLUMN     "total_refunded" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- Data: every stored day's refunds, from the same sales records and with the same arithmetic as
-- dayTotals in packages/core/src/persist.ts (a return's sales with their signs, taxes included;
-- gift cards and tips aside). total_sales and every other column stay as they are: no figure
-- Shopify reports changes. Idempotent: it sets, never adds.
UPDATE daily_store_metrics m
SET total_refunded = x.refunded
FROM (
  SELECT s.store_id, s.local_day AS day, -SUM(s.amount) AS refunded
  FROM order_sales s
  JOIN orders o ON o.id = s.order_id
  WHERE s.action_type = 'return' AND s.line_type NOT IN ('gift_card', 'tip')
  GROUP BY s.store_id, s.local_day
) x
WHERE m.store_id = x.store_id AND m.day = x.day;
