-- The store whose Shopify bill carries a workspace's charges: only that store's token can cancel
-- them, and uninstalling the app from it ends them (Shopify cancels an app's charges on uninstall).
ALTER TABLE "subscriptions" ADD COLUMN "billing_store_id" TEXT;

CREATE INDEX "subscriptions_billing_store_id_idx" ON "subscriptions"("billing_store_id");

-- A store erased by shop/redact leaves the subscription without one (its charges ended at uninstall).
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_billing_store_id_fkey" FOREIGN KEY ("billing_store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A charge recorded before this column existed was made through one of the workspace's stores:
-- the only one, where there is just one. Elsewhere the cancel route tries each live store.
UPDATE "subscriptions" s
SET "billing_store_id" = (SELECT st."id" FROM "stores" st WHERE st."workspace_id" = s."workspace_id")
WHERE (s."shopify_charge_id" IS NOT NULL OR s."pending_charge_id" IS NOT NULL)
  AND (SELECT count(*) FROM "stores" st WHERE st."workspace_id" = s."workspace_id") = 1;
