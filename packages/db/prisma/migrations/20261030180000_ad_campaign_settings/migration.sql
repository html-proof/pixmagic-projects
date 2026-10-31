-- What the platforms say about each campaign now beyond its status, read by the syncs with the calls
-- they already make: Google's channel type, primary status and its reasons, and budget (period and
-- amount); Meta's campaign budget. Additive only: code from before ignores the new columns, and the
-- next sync of each account fills them in.

-- AlterTable
ALTER TABLE "ad_campaigns" ADD COLUMN     "budget_amount" DECIMAL(18,2),
ADD COLUMN     "budget_period" TEXT,
ADD COLUMN     "channel_type" TEXT,
ADD COLUMN     "primary_status" TEXT,
ADD COLUMN     "primary_status_reasons" TEXT[] DEFAULT ARRAY[]::TEXT[];
