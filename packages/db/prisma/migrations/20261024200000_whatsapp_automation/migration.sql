-- WhatsApp Automation (docs/whatsapp.md): the wa_* tables. Additive only: the legacy whatsapp_* tables
-- stay as they are until a later migration drops them.

-- CreateTable
CREATE TABLE "wa_connections" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "step" TEXT,
    "status_detail" TEXT,
    "nango_connection_id" TEXT,
    "signup_flow" TEXT,
    "business_id" TEXT,
    "waba_id" TEXT NOT NULL,
    "waba_name" TEXT,
    "phone_number_id" TEXT,
    "display_phone_number" TEXT,
    "verified_name" TEXT,
    "name_status" TEXT,
    "quality_rating" TEXT,
    "messaging_limit_tier" TEXT,
    "registered" BOOLEAN NOT NULL DEFAULT false,
    "pin_enc" TEXT,
    "granted_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subscribed_at" TIMESTAMP(3),
    "last_webhook_at" TIMESTAMP(3),
    "last_checked_at" TIMESTAMP(3),
    "reconnect_since" TIMESTAMP(3),
    "connected_by_user_id" TEXT,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wa_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wa_settings" (
    "store_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "order_updates" TEXT NOT NULL DEFAULT 'unset',
    "order_updates_set_by" TEXT,
    "order_updates_set_at" TIMESTAMP(3),
    "shopify_sms_consent" BOOLEAN NOT NULL DEFAULT false,
    "send_window_start" INTEGER NOT NULL DEFAULT 9,
    "send_window_end" INTEGER NOT NULL DEFAULT 20,
    "daily_limit" INTEGER,
    "test_phone_enc" TEXT,
    "test_phone_masked" TEXT,
    "event_key_hash" TEXT,
    "event_key_hint" TEXT,
    "event_key_created_at" TIMESTAMP(3),
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wa_settings_pkey" PRIMARY KEY ("store_id")
);

-- CreateTable
CREATE TABLE "wa_templates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "waba_id" TEXT NOT NULL,
    "meta_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "components" JSONB NOT NULL,
    "rejected_reason" TEXT,
    "quality_score" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wa_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wa_contacts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "phone_hash" TEXT NOT NULL,
    "phone_enc" TEXT NOT NULL,
    "phone_masked" TEXT NOT NULL,
    "country" TEXT,
    "first_name_enc" TEXT,
    "shopify_customer_id" TEXT,
    "opted_out" BOOLEAN NOT NULL DEFAULT false,
    "opted_in" BOOLEAN NOT NULL DEFAULT false,
    "marketing" TEXT NOT NULL DEFAULT 'unknown',
    "consent_updated_at" TIMESTAMP(3),
    "last_inbound_at" TIMESTAMP(3),
    "orders_count" INTEGER NOT NULL DEFAULT 0,
    "total_spent" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "last_order_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wa_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wa_consent_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "note" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wa_consent_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wa_messages" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "connection_id" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'out',
    "contact_id" TEXT,
    "phone_hash" TEXT,
    "phone_enc" TEXT,
    "phone_masked" TEXT,
    "source" TEXT NOT NULL,
    "workflow_id" TEXT,
    "workflow_run_id" TEXT,
    "campaign_id" TEXT,
    "idempotency_key" TEXT,
    "type" TEXT NOT NULL,
    "template_name" TEXT,
    "template_language" TEXT,
    "category" TEXT,
    "payload_enc" TEXT,
    "preview_enc" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "reason" TEXT,
    "send_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enqueued_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "wamid" TEXT,
    "error_code" TEXT,
    "error_title" TEXT,
    "accepted_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "final_at" TIMESTAMP(3),
    "billable" BOOLEAN,
    "pricing_category" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wa_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wa_message_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "error_code" TEXT,
    "error_title" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wa_message_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wa_webhook_events" (
    "id" TEXT NOT NULL,
    "body_hash" TEXT NOT NULL,
    "body_enc" TEXT,
    "waba_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enqueued_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "wa_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wa_workflows" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "event_name" TEXT,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "template_name" TEXT NOT NULL,
    "template_language" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "header_media_url" TEXT,
    "timing_mode" TEXT NOT NULL DEFAULT 'after_trigger',
    "timing_minutes" INTEGER NOT NULL DEFAULT 0,
    "send_window_start" INTEGER,
    "send_window_end" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" TEXT,
    "updated_by_user_id" TEXT,
    "activated_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wa_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wa_workflow_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "workflow_version" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "subject_key" TEXT NOT NULL,
    "subject_label" TEXT,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "message_id" TEXT,
    "contact_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wa_workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wa_campaigns" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "template_name" TEXT NOT NULL,
    "template_language" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "header_media_url" TEXT,
    "audience" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "scheduled_at" TIMESTAMP(3),
    "estimated_recipients" INTEGER,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "cursor" TEXT,
    "materialized_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "last_test_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "scheduled_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wa_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wa_connections_store_id_key" ON "wa_connections"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "wa_connections_phone_number_id_key" ON "wa_connections"("phone_number_id");

-- CreateIndex
CREATE INDEX "wa_connections_workspace_id_idx" ON "wa_connections"("workspace_id");

-- CreateIndex
CREATE INDEX "wa_connections_waba_id_idx" ON "wa_connections"("waba_id");

-- CreateIndex
CREATE UNIQUE INDEX "wa_settings_event_key_hash_key" ON "wa_settings"("event_key_hash");

-- CreateIndex
CREATE INDEX "wa_settings_workspace_id_idx" ON "wa_settings"("workspace_id");

-- CreateIndex
CREATE INDEX "wa_templates_waba_id_meta_id_idx" ON "wa_templates"("waba_id", "meta_id");

-- CreateIndex
CREATE INDEX "wa_templates_workspace_id_idx" ON "wa_templates"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "wa_templates_store_id_name_language_key" ON "wa_templates"("store_id", "name", "language");

-- CreateIndex
CREATE INDEX "wa_contacts_store_id_marketing_opted_out_idx" ON "wa_contacts"("store_id", "marketing", "opted_out");

-- CreateIndex
CREATE INDEX "wa_contacts_store_id_shopify_customer_id_idx" ON "wa_contacts"("store_id", "shopify_customer_id");

-- CreateIndex
CREATE INDEX "wa_contacts_workspace_id_idx" ON "wa_contacts"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "wa_contacts_store_id_phone_hash_key" ON "wa_contacts"("store_id", "phone_hash");

-- CreateIndex
CREATE INDEX "wa_consent_events_contact_id_occurred_at_idx" ON "wa_consent_events"("contact_id", "occurred_at");

-- CreateIndex
CREATE INDEX "wa_consent_events_store_id_created_at_idx" ON "wa_consent_events"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "wa_consent_events_workspace_id_idx" ON "wa_consent_events"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "wa_messages_wamid_key" ON "wa_messages"("wamid");

-- CreateIndex
CREATE INDEX "wa_messages_status_send_after_idx" ON "wa_messages"("status", "send_after");

-- CreateIndex
CREATE INDEX "wa_messages_store_id_created_at_idx" ON "wa_messages"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "wa_messages_campaign_id_status_idx" ON "wa_messages"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "wa_messages_workflow_id_created_at_idx" ON "wa_messages"("workflow_id", "created_at");

-- CreateIndex
CREATE INDEX "wa_messages_contact_id_created_at_idx" ON "wa_messages"("contact_id", "created_at");

-- CreateIndex
CREATE INDEX "wa_messages_workspace_id_idx" ON "wa_messages"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "wa_messages_store_id_idempotency_key_key" ON "wa_messages"("store_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "wa_message_events_store_id_idx" ON "wa_message_events"("store_id");

-- CreateIndex
CREATE INDEX "wa_message_events_workspace_id_idx" ON "wa_message_events"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "wa_message_events_message_id_status_key" ON "wa_message_events"("message_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "wa_webhook_events_body_hash_key" ON "wa_webhook_events"("body_hash");

-- CreateIndex
CREATE INDEX "wa_webhook_events_status_received_at_idx" ON "wa_webhook_events"("status", "received_at");

-- CreateIndex
CREATE INDEX "wa_workflows_store_id_trigger_status_idx" ON "wa_workflows"("store_id", "trigger", "status");

-- CreateIndex
CREATE INDEX "wa_workflows_workspace_id_idx" ON "wa_workflows"("workspace_id");

-- CreateIndex
CREATE INDEX "wa_workflow_runs_store_id_created_at_idx" ON "wa_workflow_runs"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "wa_workflow_runs_workflow_id_created_at_idx" ON "wa_workflow_runs"("workflow_id", "created_at");

-- CreateIndex
CREATE INDEX "wa_workflow_runs_workspace_id_idx" ON "wa_workflow_runs"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "wa_workflow_runs_workflow_id_subject_key_key" ON "wa_workflow_runs"("workflow_id", "subject_key");

-- CreateIndex
CREATE INDEX "wa_campaigns_store_id_status_idx" ON "wa_campaigns"("store_id", "status");

-- CreateIndex
CREATE INDEX "wa_campaigns_status_scheduled_at_idx" ON "wa_campaigns"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "wa_campaigns_workspace_id_idx" ON "wa_campaigns"("workspace_id");

-- Row-level security: the same tenant policy as every workspace table. wa_webhook_events has no
-- workspace (one body can speak for several stores); only the owner role (webhooks, jobs) uses it.
ALTER TABLE "wa_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wa_connections" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wa_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wa_settings" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wa_templates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wa_templates" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wa_contacts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wa_contacts" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wa_consent_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wa_consent_events" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wa_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wa_messages" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wa_message_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wa_message_events" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wa_workflows" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wa_workflows" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wa_workflow_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wa_workflow_runs" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wa_campaigns" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wa_campaigns" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
