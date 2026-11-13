-- refunds held one row per Shopify refund. Since 2026-10-16 (20261016200000_shopify_sales) returns
-- are read from Shopify's sales records (order_sales) and nothing writes this table; its last use
-- was the store erase, which only deleted from it. On production it held 2 rows on 2026-11-12, left
-- from before that change (the database snapshot taken that day, before the 26 retired tables
-- went, has them). No CASCADE: if anything still depended on it, this fails instead of taking
-- that with it.
DROP TABLE "refunds";
