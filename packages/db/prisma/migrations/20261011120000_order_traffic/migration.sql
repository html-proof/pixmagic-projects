-- Where each order's customer came from (Shopify's own record of the visit; see packages/shared/src/traffic.ts).
-- Nullable, no default: adding them rewrites nothing.
ALTER TABLE "orders" ADD COLUMN "traffic_source" TEXT;
ALTER TABLE "orders" ADD COLUMN "traffic_medium" TEXT;
ALTER TABLE "orders" ADD COLUMN "traffic_campaign" TEXT;
ALTER TABLE "orders" ADD COLUMN "referrer_host" TEXT;
