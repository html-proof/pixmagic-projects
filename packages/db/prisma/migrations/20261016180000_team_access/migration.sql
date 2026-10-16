-- Team & Access (packages/shared/src/access.ts): restricted members see exactly the permissions
-- granted to them; invitations carry those permissions, an optional message, and stay on record
-- after they end (revoked, accepted, expired) until the retention sweep removes them.

-- Two more templates for restricted members. PostgreSQL 12+ accepts ADD VALUE inside the
-- migration's transaction; nothing below uses the new values, which only become usable on commit.
ALTER TYPE "Role" ADD VALUE 'manager';
ALTER TYPE "Role" ADD VALUE 'custom';

-- AlterTable
ALTER TABLE "invitations" ADD COLUMN     "accepted_by_id" TEXT,
ADD COLUMN     "invited_by_id" TEXT,
ADD COLUMN     "message" TEXT,
ADD COLUMN     "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "revoked_at" TIMESTAMP(3),
ADD COLUMN     "send_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "send_failed_at" TIMESTAMP(3),
ADD COLUMN     "sent_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "access_changed_at" TIMESTAMP(3),
ADD COLUMN     "invited_by_id" TEXT,
ADD COLUMN     "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "revoked_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "invitations_workspace_id_email_idx" ON "invitations"("workspace_id", "email");

-- CreateIndex
CREATE INDEX "invitations_invited_by_id_idx" ON "invitations"("invited_by_id");

-- CreateIndex
CREATE INDEX "memberships_invited_by_id_idx" ON "memberships"("invited_by_id");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Nobody gains or loses access by the change: existing viewers and analysts (and invitations not yet
-- accepted) get, as permissions, everything they could see before. These lists are LEGACY_GRANTS in
-- packages/shared/src/access.ts (a test there checks the two agree).
UPDATE "memberships" SET "permissions" = ARRAY['analytics.sales', 'analytics.conversion', 'analytics.behavior', 'analytics.traffic', 'customers.analytics', 'products.view', 'products.performance', 'products.inventory', 'products.prices', 'orders.list', 'orders.payments', 'orders.fulfillment', 'orders.cancellations', 'marketing.ads', 'marketing.campaigns', 'marketing.attribution', 'discounts.codes', 'discounts.performance', 'finance.breakdown', 'finance.refunds', 'finance.reports', 'integrations.status', 'reports.view']::TEXT[] WHERE "role" = 'viewer';
UPDATE "memberships" SET "permissions" = ARRAY['analytics.sales', 'analytics.conversion', 'analytics.abandonment', 'analytics.behavior', 'analytics.traffic', 'customers.list', 'customers.profiles', 'customers.contact', 'customers.orders', 'customers.analytics', 'products.view', 'products.performance', 'products.inventory', 'products.prices', 'orders.list', 'orders.payments', 'orders.fulfillment', 'orders.cancellations', 'marketing.ads', 'marketing.campaigns', 'marketing.attribution', 'discounts.codes', 'discounts.performance', 'finance.breakdown', 'finance.refunds', 'finance.reports', 'integrations.status', 'reports.view']::TEXT[] WHERE "role" = 'analyst';
UPDATE "invitations" SET "permissions" = ARRAY['analytics.sales', 'analytics.conversion', 'analytics.behavior', 'analytics.traffic', 'customers.analytics', 'products.view', 'products.performance', 'products.inventory', 'products.prices', 'orders.list', 'orders.payments', 'orders.fulfillment', 'orders.cancellations', 'marketing.ads', 'marketing.campaigns', 'marketing.attribution', 'discounts.codes', 'discounts.performance', 'finance.breakdown', 'finance.refunds', 'finance.reports', 'integrations.status', 'reports.view']::TEXT[] WHERE "role" = 'viewer' AND "accepted_at" IS NULL;
UPDATE "invitations" SET "permissions" = ARRAY['analytics.sales', 'analytics.conversion', 'analytics.abandonment', 'analytics.behavior', 'analytics.traffic', 'customers.list', 'customers.profiles', 'customers.contact', 'customers.orders', 'customers.analytics', 'products.view', 'products.performance', 'products.inventory', 'products.prices', 'orders.list', 'orders.payments', 'orders.fulfillment', 'orders.cancellations', 'marketing.ads', 'marketing.campaigns', 'marketing.attribution', 'discounts.codes', 'discounts.performance', 'finance.breakdown', 'finance.refunds', 'finance.reports', 'integrations.status', 'reports.view']::TEXT[] WHERE "role" = 'analyst' AND "accepted_at" IS NULL;
-- Invitations from before this went out (by email, or as a link handed over) when they were made.
UPDATE "invitations" SET "send_count" = 1, "sent_at" = "created_at";
