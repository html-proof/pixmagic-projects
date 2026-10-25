-- WhatsApp Automation on Evolution API (docs/whatsapp.md): the wapp_* tables. Additive only: the retired
-- wa_* and whatsapp_* tables stay as they are (erase-only) until a later migration drops them.

-- CreateTable
CREATE TABLE "wapp_connections" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pairing',
    "status_reason" TEXT,
    "shard" TEXT NOT NULL,
    "instance_name" TEXT,
    "instance_id" TEXT,
    "instance_token_enc" TEXT,
    "webhook_key_enc" TEXT,
    "pairing_method" TEXT,
    "phone_enc" TEXT,
    "phone_masked" TEXT,
    "profile_name" TEXT,
    "waba_id" TEXT,
    "phone_number_id" TEXT,
    "business_id" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "qr_count" INTEGER NOT NULL DEFAULT 0,
    "pairing_started_at" TIMESTAMP(3),
    "connected_at" TIMESTAMP(3),
    "disconnected_at" TIMESTAMP(3),
    "last_event_at" TIMESTAMP(3),
    "last_checked_at" TIMESTAMP(3),
    "down_since" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wapp_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wapp_settings" (
    "store_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_name" TEXT,
    "order_updates" TEXT NOT NULL DEFAULT 'unset',
    "order_updates_set_by" TEXT,
    "order_updates_set_at" TIMESTAMP(3),
    "marketing_enabled" BOOLEAN NOT NULL DEFAULT false,
    "shopify_sms_consent" BOOLEAN NOT NULL DEFAULT false,
    "send_window_start" INTEGER NOT NULL DEFAULT 9,
    "send_window_end" INTEGER NOT NULL DEFAULT 20,
    "time_zone" TEXT,
    "daily_limit" INTEGER,
    "per_customer_daily_limit" INTEGER NOT NULL DEFAULT 3,
    "retention_days" INTEGER NOT NULL DEFAULT 90,
    "configured_at" TIMESTAMP(3),
    "test_phone_hash" TEXT,
    "test_phone_enc" TEXT,
    "test_phone_masked" TEXT,
    "test_code_hash" TEXT,
    "test_code_expires_at" TIMESTAMP(3),
    "test_code_attempts" INTEGER NOT NULL DEFAULT 0,
    "test_verified_at" TIMESTAMP(3),
    "test_passed_at" TIMESTAMP(3),
    "automation_paused_at" TIMESTAMP(3),
    "automation_paused_by" TEXT,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wapp_settings_pkey" PRIMARY KEY ("store_id")
);

-- CreateTable
CREATE TABLE "wapp_templates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "meta_name" TEXT,
    "meta_language" TEXT,
    "meta_id" TEXT,
    "meta_status" TEXT,
    "meta_reason" TEXT,
    "meta_checked_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wapp_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wapp_contacts" (
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
    "last_outbound_at" TIMESTAMP(3),
    "not_on_whatsapp_at" TIMESTAMP(3),
    "orders_count" INTEGER NOT NULL DEFAULT 0,
    "total_spent" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "last_order_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wapp_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wapp_consent_events" (
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

    CONSTRAINT "wapp_consent_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wapp_suppressions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "phone_hash" TEXT NOT NULL,
    "phone_masked" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wapp_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wapp_messages" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "connection_id" TEXT,
    "provider" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'out',
    "contact_id" TEXT,
    "phone_hash" TEXT,
    "phone_enc" TEXT,
    "phone_masked" TEXT,
    "source" TEXT NOT NULL,
    "automation_id" TEXT,
    "run_id" TEXT,
    "campaign_id" TEXT,
    "idempotency_key" TEXT,
    "category" TEXT,
    "type" TEXT NOT NULL,
    "template_id" TEXT,
    "payload_enc" TEXT,
    "preview_enc" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "reason" TEXT,
    "send_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enqueued_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "provider_message_id" TEXT,
    "error_code" TEXT,
    "error_detail" TEXT,
    "accepted_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "final_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wapp_message_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider_status" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wapp_message_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wapp_webhook_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "body_hash" TEXT NOT NULL,
    "body_enc" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "provider_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enqueued_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "wapp_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wapp_automations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger" TEXT NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "template_id" TEXT NOT NULL,
    "recipient" TEXT NOT NULL DEFAULT 'customer',
    "delay_minutes" INTEGER NOT NULL DEFAULT 0,
    "send_window_start" INTEGER,
    "send_window_end" INTEGER,
    "test_mode" BOOLEAN NOT NULL DEFAULT true,
    "cooldown_minutes" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" TEXT,
    "updated_by_user_id" TEXT,
    "activated_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wapp_automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wapp_automation_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "automation_id" TEXT NOT NULL,
    "automation_version" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "subject_key" TEXT NOT NULL,
    "subject_label" TEXT,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "detail" TEXT,
    "message_id" TEXT,
    "contact_id" TEXT,
    "test_mode" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wapp_automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wapp_campaigns" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "audience" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "scheduled_at" TIMESTAMP(3),
    "confirmed_recipients" INTEGER,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "cursor" TEXT,
    "materialized_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "created_by_user_id" TEXT,
    "launched_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wapp_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wapp_connections_store_id_key" ON "wapp_connections"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "wapp_connections_instance_name_key" ON "wapp_connections"("instance_name");

-- CreateIndex
CREATE UNIQUE INDEX "wapp_connections_phone_number_id_key" ON "wapp_connections"("phone_number_id");

-- CreateIndex
CREATE INDEX "wapp_connections_workspace_id_idx" ON "wapp_connections"("workspace_id");

-- CreateIndex
CREATE INDEX "wapp_connections_status_idx" ON "wapp_connections"("status");

-- CreateIndex
CREATE INDEX "wapp_settings_workspace_id_idx" ON "wapp_settings"("workspace_id");

-- CreateIndex
CREATE INDEX "wapp_templates_workspace_id_idx" ON "wapp_templates"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "wapp_templates_store_id_name_key" ON "wapp_templates"("store_id", "name");

-- CreateIndex
CREATE INDEX "wapp_contacts_store_id_marketing_opted_out_idx" ON "wapp_contacts"("store_id", "marketing", "opted_out");

-- CreateIndex
CREATE INDEX "wapp_contacts_store_id_shopify_customer_id_idx" ON "wapp_contacts"("store_id", "shopify_customer_id");

-- CreateIndex
CREATE INDEX "wapp_contacts_workspace_id_idx" ON "wapp_contacts"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "wapp_contacts_store_id_phone_hash_key" ON "wapp_contacts"("store_id", "phone_hash");

-- CreateIndex
CREATE INDEX "wapp_consent_events_contact_id_occurred_at_idx" ON "wapp_consent_events"("contact_id", "occurred_at");

-- CreateIndex
CREATE INDEX "wapp_consent_events_store_id_created_at_idx" ON "wapp_consent_events"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "wapp_consent_events_workspace_id_idx" ON "wapp_consent_events"("workspace_id");

-- CreateIndex
CREATE INDEX "wapp_suppressions_workspace_id_idx" ON "wapp_suppressions"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "wapp_suppressions_store_id_phone_hash_scope_key" ON "wapp_suppressions"("store_id", "phone_hash", "scope");

-- CreateIndex
CREATE INDEX "wapp_messages_status_send_after_idx" ON "wapp_messages"("status", "send_after");

-- CreateIndex
CREATE INDEX "wapp_messages_store_id_created_at_idx" ON "wapp_messages"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "wapp_messages_store_id_direction_accepted_at_idx" ON "wapp_messages"("store_id", "direction", "accepted_at");

-- CreateIndex
CREATE INDEX "wapp_messages_campaign_id_status_idx" ON "wapp_messages"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "wapp_messages_automation_id_created_at_idx" ON "wapp_messages"("automation_id", "created_at");

-- CreateIndex
CREATE INDEX "wapp_messages_contact_id_created_at_idx" ON "wapp_messages"("contact_id", "created_at");

-- CreateIndex
CREATE INDEX "wapp_messages_workspace_id_idx" ON "wapp_messages"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "wapp_messages_store_id_idempotency_key_key" ON "wapp_messages"("store_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "wapp_messages_connection_id_provider_message_id_key" ON "wapp_messages"("connection_id", "provider_message_id");

-- CreateIndex
CREATE INDEX "wapp_message_events_store_id_idx" ON "wapp_message_events"("store_id");

-- CreateIndex
CREATE INDEX "wapp_message_events_workspace_id_idx" ON "wapp_message_events"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "wapp_message_events_message_id_status_key" ON "wapp_message_events"("message_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "wapp_webhook_events_body_hash_key" ON "wapp_webhook_events"("body_hash");

-- CreateIndex
CREATE INDEX "wapp_webhook_events_status_received_at_idx" ON "wapp_webhook_events"("status", "received_at");

-- CreateIndex
CREATE INDEX "wapp_webhook_events_connection_id_received_at_idx" ON "wapp_webhook_events"("connection_id", "received_at");

-- CreateIndex
CREATE INDEX "wapp_webhook_events_workspace_id_idx" ON "wapp_webhook_events"("workspace_id");

-- CreateIndex
CREATE INDEX "wapp_automations_store_id_trigger_status_idx" ON "wapp_automations"("store_id", "trigger", "status");

-- CreateIndex
CREATE INDEX "wapp_automations_workspace_id_idx" ON "wapp_automations"("workspace_id");

-- CreateIndex
CREATE INDEX "wapp_automation_runs_store_id_created_at_idx" ON "wapp_automation_runs"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "wapp_automation_runs_automation_id_created_at_idx" ON "wapp_automation_runs"("automation_id", "created_at");

-- CreateIndex
CREATE INDEX "wapp_automation_runs_workspace_id_idx" ON "wapp_automation_runs"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "wapp_automation_runs_automation_id_subject_key_key" ON "wapp_automation_runs"("automation_id", "subject_key");

-- CreateIndex
CREATE INDEX "wapp_campaigns_store_id_status_idx" ON "wapp_campaigns"("store_id", "status");

-- CreateIndex
CREATE INDEX "wapp_campaigns_status_scheduled_at_idx" ON "wapp_campaigns"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "wapp_campaigns_workspace_id_idx" ON "wapp_campaigns"("workspace_id");


-- Row-level security: the same tenant policy as every workspace table.
ALTER TABLE "wapp_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wapp_connections" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wapp_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wapp_settings" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wapp_templates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wapp_templates" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wapp_contacts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wapp_contacts" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wapp_consent_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wapp_consent_events" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wapp_suppressions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wapp_suppressions" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wapp_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wapp_messages" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wapp_message_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wapp_message_events" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wapp_webhook_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wapp_webhook_events" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wapp_automations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wapp_automations" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wapp_automation_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wapp_automation_runs" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "wapp_campaigns" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "wapp_campaigns" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
