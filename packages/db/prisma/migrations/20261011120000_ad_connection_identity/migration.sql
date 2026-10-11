-- Who granted an ad connection's access (the platform's own user id: Google's `sub`, Meta's app-scoped
-- user id) and what they granted. Disconnecting revokes the platform access only when no other
-- connection still relies on the same person's grant.
ALTER TABLE "ad_connections" ADD COLUMN "external_user_id" TEXT;
ALTER TABLE "ad_connections" ADD COLUMN "granted_scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "ad_connections_external_user_id_idx" ON "ad_connections"("external_user_id");
