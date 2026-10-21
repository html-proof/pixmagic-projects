-- From when every Shopify order of a store is imported: the start of its earliest completed import
-- window (Shopify shares 60 days without read_all_orders), the epoch when its whole history was
-- imported. The dashboard compares only with dates from then on ("No earlier data" before).
ALTER TABLE "stores" ADD COLUMN "orders_history_from" TIMESTAMP(3);

-- Stores imported before the column existed. Their first full import finished, and its 60-day
-- window began, no later than their last successful orders sweep, so every order from 60 days
-- before that sweep on is in: a start they are sure to hold, at most a few days late. (The
-- dashboard still counts from an earlier first imported order.) Disconnected stores are left out:
-- their orders were deleted, and their next import records its own window.
UPDATE "stores"
SET "orders_history_from" = "last_synced_at" - INTERVAL '60 days'
WHERE "last_synced_at" IS NOT NULL AND "status" <> 'uninstalled';
