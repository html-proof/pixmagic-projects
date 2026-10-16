-- Team & Access invitations: access given by an invitation ends (60 days unless the inviter chose
-- less) until renewed; the link's token is kept encrypted so the same link can be copied again; the
-- link's openings are counted; and each invitation email's delivery is recorded as the mail
-- provider reports it (packages/core/src/mail).

-- AlterTable
ALTER TABLE "invitations" ADD COLUMN     "last_opened_at" TIMESTAMP(3),
ADD COLUMN     "open_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "token_sealed" TEXT;

-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "access_expires_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "email_deliveries" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "invitation_id" TEXT,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "status" TEXT NOT NULL,
    "error_code" TEXT,
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "last_event_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_deliveries_invitation_id_created_at_idx" ON "email_deliveries"("invitation_id", "created_at");

-- CreateIndex
CREATE INDEX "email_deliveries_workspace_id_idx" ON "email_deliveries"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_deliveries_provider_provider_message_id_key" ON "email_deliveries"("provider", "provider_message_id");

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row level security, as for every tenant table (see 20261002070200_rls).
ALTER TABLE "email_deliveries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_deliveries" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- Links already used kept opening the dashboard for 60 days after their first opening; from now on a
-- link opens it until the invitation's expiry, so those keep exactly the time they were promised.
-- Nobody's membership gains an end date: only invitations accepted from now on carry one.
UPDATE "invitations" SET "expires_at" = GREATEST("expires_at", "accepted_at" + INTERVAL '60 days') WHERE "accepted_at" IS NOT NULL;
