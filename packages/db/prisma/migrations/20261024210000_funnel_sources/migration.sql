-- The Shopping Funnel page by traffic source: where each visit came from, as one word (a
-- TRAFFIC_SOURCES value, packages/shared/src/traffic.ts), set from the first arrival the pixel
-- reports. Additive only: code from before ignores the column, and visits recorded before the pixel
-- sent arrivals have none (null), which the page shows as "Not recorded". funnel_product_visits.steps
-- gains bits 2-4 (quick add, checkout, purchase) without a schema change.

-- AlterTable
ALTER TABLE "funnel_visits" ADD COLUMN     "source" TEXT;
