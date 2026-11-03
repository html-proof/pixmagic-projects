-- When a store was disconnected inside bizinsights (the app stays installed in Shopify, and any
-- charge on the store's bill with it), as opposed to uninstalled in Shopify (which cancels them).
-- Expand-only: one new nullable column. Stores disconnected before it existed keep null and read as
-- uninstalled in Shopify, as the code live before this release takes every uninstalled store to be
-- (paid plans aren't on sale yet, BILLING_ENABLED).
ALTER TABLE "stores" ADD COLUMN "disconnected_at" TIMESTAMP(3);
