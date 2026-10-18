-- From when a store's web pixel counts its visits, and from which day each ad account's figures are
-- stored. The dashboard compares visits and ad figures only with dates from then on ("No earlier
-- data" before), as it does sales with stores.orders_history_from.
ALTER TABLE "stores" ADD COLUMN "pixel_installed_at" TIMESTAMP(3);
ALTER TABLE "ad_connections" ADD COLUMN "history_from" TEXT;

-- Stores with a pixel from before the column existed: the first install_pixel job that worked, or
-- the first visit recorded when that is earlier (a pixel already in place) or no job is kept.
UPDATE "stores" s
SET "pixel_installed_at" = f."first"
FROM (
  SELECT "store_id", MIN("t") AS "first"
  FROM (
    SELECT "store_id", "finished_at" AS "t" FROM "sync_jobs" WHERE "kind" = 'install_pixel' AND "status" = 'succeeded'
    UNION ALL
    SELECT "store_id", "entered_at" FROM "funnel_visits"
  ) x
  WHERE "t" IS NOT NULL
  GROUP BY "store_id"
) f
WHERE s."id" = f."store_id";

-- Ad accounts connected before the column existed. Their first sync asked for 90 days, but whether
-- it worked isn't recorded: the first day they hold figures for is a start they surely hold, maybe
-- late. The worker's next daily re-check fetches the whole 90 days for an account whose start falls
-- short of them, and records the exact start.
UPDATE "ad_connections" c
SET "history_from" = f."first"
FROM (
  SELECT "connection_id", MIN("day") AS "first"
  FROM (
    SELECT "connection_id", "day" FROM "ad_campaign_daily"
    UNION ALL
    SELECT "connection_id", "day" FROM "adsense_daily"
  ) x
  GROUP BY "connection_id"
) f
WHERE c."id" = f."connection_id";
