-- Ad platforms sign in through bizinsights' own OAuth again (Nango left, docs/ads-setup.md "Leaving
-- Nango"): a waiting login holds the person's token itself, encrypted like a connection's, instead of
-- naming a Nango connection. The Nango columns stay, nullable, for the logins made through Nango until
-- the move (leaveNango.ts) has read their tokens; a later change drops them. Additive: code from before
-- still reads every row it wrote.

-- AlterTable
ALTER TABLE "ad_logins" ADD COLUMN     "access_token_enc" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "token_key_version" INTEGER,
ALTER COLUMN "source_login_id" DROP NOT NULL,
ALTER COLUMN "nango_integration_key" DROP NOT NULL;
