-- Ad connections: why one stopped (a code the UI words; the platform's own text stays for the logs),
-- the ad account's own health at the platform, the AdSense sites that belong to the store, how far the
-- stored days reach without a gap, whether a sync is on its way, and failures in a row.
-- Additive only: code from before ignores every new column.
ALTER TABLE "ad_connections" ADD COLUMN "error_code" TEXT;
ALTER TABLE "ad_connections" ADD COLUMN "account_status" TEXT;
ALTER TABLE "ad_connections" ADD COLUMN "account_status_detail" TEXT;
ALTER TABLE "ad_connections" ADD COLUMN "sites" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ad_connections" ADD COLUMN "synced_through" TEXT;
ALTER TABLE "ad_connections" ADD COLUMN "sync_requested_at" TIMESTAMP(3);
ALTER TABLE "ad_connections" ADD COLUMN "consecutive_failures" INTEGER NOT NULL DEFAULT 0;

-- Campaign days: link clicks (Meta's clicks count likes, comments and profile clicks too) and purchases
-- only (Google's conversions count every primary conversion action: leads, sign-ups, calls...).
ALTER TABLE "ad_campaign_daily" ADD COLUMN "link_clicks" INTEGER;
ALTER TABLE "ad_campaign_daily" ADD COLUMN "purchases" DECIMAL(18,2);
ALTER TABLE "ad_campaign_daily" ADD COLUMN "purchase_value" DECIMAL(18,2);

-- What is known already: Meta's stored conversions are its purchases, and Google's clicks are clicks
-- on the ad. The rest is read again by the next syncs.
UPDATE "ad_campaign_daily" SET "purchases" = "conversions", "purchase_value" = "conversion_value" WHERE "provider" = 'meta';
UPDATE "ad_campaign_daily" SET "link_clicks" = "clicks" WHERE "provider" = 'google';

-- How far each connection's days reach: the account's own day of its last sync that worked.
UPDATE "ad_connections"
SET "synced_through" = to_char(
  ("last_synced_at" AT TIME ZONE 'UTC') AT TIME ZONE (CASE WHEN "timezone" IN (SELECT "name" FROM pg_timezone_names) THEN "timezone" ELSE 'UTC' END),
  'YYYY-MM-DD'
)
WHERE "last_synced_at" IS NOT NULL AND "history_from" IS NOT NULL;

-- Days of connections that are gone (a sync in flight while one was disconnected wrote them), then
-- foreign keys, so a disconnect takes its days with it and a late sync can't write them back.
DELETE FROM "ad_campaign_daily" d WHERE NOT EXISTS (SELECT 1 FROM "ad_connections" c WHERE c."id" = d."connection_id");
DELETE FROM "adsense_daily" d WHERE NOT EXISTS (SELECT 1 FROM "ad_connections" c WHERE c."id" = d."connection_id");
ALTER TABLE "ad_campaign_daily" ADD CONSTRAINT "ad_campaign_daily_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "ad_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "adsense_daily" ADD CONSTRAINT "adsense_daily_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "ad_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
