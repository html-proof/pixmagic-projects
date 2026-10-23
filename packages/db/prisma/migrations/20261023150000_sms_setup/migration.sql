-- CreateTable
CREATE TABLE "sms_setups" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "step" TEXT NOT NULL DEFAULT 'connect',
    "connection" TEXT,
    "connection_error" TEXT,
    "connection_checked_at" TIMESTAMP(3),
    "connected_by" TEXT,
    "connected_at" TIMESTAMP(3),
    "business_name" TEXT,
    "sender_name" TEXT,
    "country" TEXT,
    "sender_name_status" TEXT NOT NULL DEFAULT 'draft',
    "sender_requested_at" TIMESTAMP(3),
    "sender_requested_by" TEXT,
    "sender_checked_at" TIMESTAMP(3),
    "sender_registration" TEXT,
    "message" TEXT,
    "template_id" TEXT,
    "automations" JSONB NOT NULL DEFAULT '{}',
    "monthly_budget_usd" DECIMAL(12,4),
    "transactional_basis" TEXT,
    "completed_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_setups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sms_setups_store_id_key" ON "sms_setups"("store_id");

-- CreateIndex
CREATE INDEX "sms_setups_workspace_id_idx" ON "sms_setups"("workspace_id");

-- Row level security, as for every tenant table (see 20261002070200_rls).
ALTER TABLE "sms_setups" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_setups" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
