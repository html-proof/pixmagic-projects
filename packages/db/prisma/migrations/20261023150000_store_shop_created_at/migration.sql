-- When Shopify created each store (Shop.createdAt): where the dashboard's dates begin ("All time",
-- the earliest day custom dates may start). The shop sync job reads it with the store's name, currency
-- and time zone; null until it has. Additive only: code from before ignores the column.
ALTER TABLE "stores" ADD COLUMN "shop_created_at" TIMESTAMP(3);
