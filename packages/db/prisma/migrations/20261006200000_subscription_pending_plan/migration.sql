-- A plan change awaiting Shopify approval is tracked apart from the plan in force.
ALTER TABLE "subscriptions" ADD COLUMN "pending_plan" TEXT;
ALTER TABLE "subscriptions" ADD COLUMN "pending_charge_id" TEXT;

-- Rows written by the old code put an unapproved plan straight into "plan" with status
-- "pending". Move that to the pending columns; the plan in force reverts to free.
UPDATE "subscriptions"
SET "pending_plan" = "plan", "pending_charge_id" = "shopify_charge_id",
    "plan" = 'free', "status" = 'active', "shopify_charge_id" = NULL
WHERE "status" = 'pending';
