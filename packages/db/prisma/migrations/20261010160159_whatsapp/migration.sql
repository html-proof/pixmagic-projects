-- CreateTable
CREATE TABLE "whatsapp_connections" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "business_id" TEXT,
    "waba_id" TEXT NOT NULL,
    "waba_name" TEXT,
    "phone_number_id" TEXT NOT NULL,
    "display_phone_number" TEXT,
    "verified_name" TEXT,
    "name_status" TEXT,
    "quality_rating" TEXT,
    "messaging_limit_tier" TEXT,
    "registered" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_error" TEXT,
    "access_token_enc" TEXT NOT NULL,
    "app_secret_enc" TEXT,
    "verify_token_enc" TEXT,
    "verify_token_hash" TEXT,
    "token_key_version" INTEGER NOT NULL,
    "webhook_verified_at" TIMESTAMP(3),
    "last_webhook_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "connected_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_settings" (
    "store_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "basis_set_by_user_id" TEXT,
    "basis_set_at" TIMESTAMP(3),
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_settings_pkey" PRIMARY KEY ("store_id")
);

-- CreateTable
CREATE TABLE "whatsapp_templates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "meta_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "components" JSONB NOT NULL,
    "rejected_reason" TEXT,
    "quality_score" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_contacts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "phone_hash" TEXT NOT NULL,
    "phone_enc" TEXT NOT NULL,
    "phone_masked" TEXT NOT NULL,
    "country" TEXT,
    "customer_key" TEXT,
    "first_name_enc" TEXT,
    "marketing_status" TEXT NOT NULL DEFAULT 'unknown',
    "marketing_source" TEXT,
    "marketing_updated_at" TIMESTAMP(3),
    "opted_out" BOOLEAN NOT NULL DEFAULT false,
    "opted_out_at" TIMESTAMP(3),
    "opt_out_source" TEXT,
    "last_inbound_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "kind" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'unknown',
    "template_name" TEXT,
    "template_language" TEXT,
    "params_enc" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "phone_masked" TEXT,
    "tracking_id" TEXT,
    "order_name" TEXT,
    "checkout_id" TEXT,
    "campaign_id" TEXT,
    "rule_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "enqueued_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "provider_message_id" TEXT,
    "error_code" TEXT,
    "error_title" TEXT,
    "reason" TEXT,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "pricing_category" TEXT,
    "billable" BOOLEAN,
    "click_code" TEXT,
    "click_url_enc" TEXT,
    "clicked_at" TIMESTAMP(3),
    "attributed_order_id" TEXT,
    "attributed_revenue" DECIMAL(18,2),
    "attributed_at" TIMESTAMP(3),
    "test" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_message_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "error_code" TEXT,
    "error_title" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_message_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_trackings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "shopify_order_id" TEXT NOT NULL,
    "order_name" TEXT NOT NULL,
    "contact_id" TEXT,
    "token_hash" TEXT NOT NULL,
    "token_enc" TEXT NOT NULL,
    "review_token_hash" TEXT NOT NULL,
    "review_token_enc" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "total_price" DECIMAL(18,2) NOT NULL,
    "items" JSONB NOT NULL,
    "financial_status" TEXT,
    "status" TEXT NOT NULL DEFAULT 'placed',
    "shipment_rank" INTEGER NOT NULL DEFAULT 0,
    "carrier_events" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "checkout_token" TEXT,
    "cart_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "sms_consent" BOOLEAN NOT NULL DEFAULT false,
    "country" TEXT,
    "order_created_at" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_trackings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_tracking_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "tracking_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "fulfillment_id" TEXT,
    "courier" TEXT,
    "tracking_number" TEXT,
    "tracking_url" TEXT,
    "estimated_delivery_at" TIMESTAMP(3),
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_tracking_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abandoned_checkouts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "checkout_token" TEXT NOT NULL,
    "contact_id" TEXT,
    "customer_name_enc" TEXT,
    "phone_masked" TEXT,
    "currency" TEXT NOT NULL,
    "total_price" DECIMAL(18,2) NOT NULL,
    "items" JSONB NOT NULL,
    "recovery_url_enc" TEXT,
    "marketing_consent" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'open',
    "ineligible_reason" TEXT,
    "checkout_created_at" TIMESTAMP(3) NOT NULL,
    "last_activity_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "recovered_order_id" TEXT,
    "recovered_order_name" TEXT,
    "recovered_revenue" DECIMAL(18,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abandoned_checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_campaigns" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "occasion" TEXT NOT NULL,
    "objective" TEXT,
    "template_name" TEXT NOT NULL,
    "template_language" TEXT NOT NULL,
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "variables" JSONB NOT NULL DEFAULT '{}',
    "media_url" TEXT,
    "link_url" TEXT,
    "discount_code" TEXT,
    "audience" JSONB NOT NULL DEFAULT '{}',
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "estimated_recipients" INTEGER,
    "created_by_user_id" TEXT,
    "approved_by_user_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_reviews" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "tracking_id" TEXT NOT NULL,
    "shopify_order_id" TEXT NOT NULL,
    "order_name" TEXT NOT NULL,
    "product_id" TEXT NOT NULL DEFAULT '',
    "product_title" TEXT,
    "rating" INTEGER NOT NULL,
    "body" TEXT,
    "reviewer_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "moderation_reason" TEXT,
    "moderated_by_user_id" TEXT,
    "moderated_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMP(3),

    CONSTRAINT "customer_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_automation_rules" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "trigger" TEXT NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "action" JSONB NOT NULL,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_automation_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "subject_key" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_connections_store_id_key" ON "whatsapp_connections"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_connections_verify_token_hash_key" ON "whatsapp_connections"("verify_token_hash");

-- CreateIndex
CREATE INDEX "whatsapp_connections_workspace_id_idx" ON "whatsapp_connections"("workspace_id");

-- CreateIndex
CREATE INDEX "whatsapp_connections_waba_id_idx" ON "whatsapp_connections"("waba_id");

-- CreateIndex
CREATE INDEX "whatsapp_connections_phone_number_id_idx" ON "whatsapp_connections"("phone_number_id");

-- CreateIndex
CREATE INDEX "whatsapp_settings_workspace_id_idx" ON "whatsapp_settings"("workspace_id");

-- CreateIndex
CREATE INDEX "whatsapp_templates_store_id_idx" ON "whatsapp_templates"("store_id");

-- CreateIndex
CREATE INDEX "whatsapp_templates_workspace_id_idx" ON "whatsapp_templates"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_templates_connection_id_name_language_key" ON "whatsapp_templates"("connection_id", "name", "language");

-- CreateIndex
CREATE INDEX "whatsapp_contacts_store_id_customer_key_idx" ON "whatsapp_contacts"("store_id", "customer_key");

-- CreateIndex
CREATE INDEX "whatsapp_contacts_store_id_marketing_status_idx" ON "whatsapp_contacts"("store_id", "marketing_status");

-- CreateIndex
CREATE INDEX "whatsapp_contacts_workspace_id_idx" ON "whatsapp_contacts"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_contacts_store_id_phone_hash_key" ON "whatsapp_contacts"("store_id", "phone_hash");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_provider_message_id_key" ON "whatsapp_messages"("provider_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_click_code_key" ON "whatsapp_messages"("click_code");

-- CreateIndex
CREATE INDEX "whatsapp_messages_status_scheduled_for_idx" ON "whatsapp_messages"("status", "scheduled_for");

-- CreateIndex
CREATE INDEX "whatsapp_messages_store_id_created_at_idx" ON "whatsapp_messages"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "whatsapp_messages_campaign_id_idx" ON "whatsapp_messages"("campaign_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_tracking_id_idx" ON "whatsapp_messages"("tracking_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_checkout_id_idx" ON "whatsapp_messages"("checkout_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_contact_id_sent_at_idx" ON "whatsapp_messages"("contact_id", "sent_at");

-- CreateIndex
CREATE INDEX "whatsapp_messages_workspace_id_idx" ON "whatsapp_messages"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_store_id_dedupe_key_key" ON "whatsapp_messages"("store_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_store_id_attributed_order_id_key" ON "whatsapp_messages"("store_id", "attributed_order_id");

-- CreateIndex
CREATE INDEX "whatsapp_message_events_store_id_idx" ON "whatsapp_message_events"("store_id");

-- CreateIndex
CREATE INDEX "whatsapp_message_events_workspace_id_idx" ON "whatsapp_message_events"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_message_events_message_id_status_key" ON "whatsapp_message_events"("message_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "order_trackings_token_hash_key" ON "order_trackings"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "order_trackings_review_token_hash_key" ON "order_trackings"("review_token_hash");

-- CreateIndex
CREATE INDEX "order_trackings_store_id_order_created_at_idx" ON "order_trackings"("store_id", "order_created_at");

-- CreateIndex
CREATE INDEX "order_trackings_contact_id_idx" ON "order_trackings"("contact_id");

-- CreateIndex
CREATE INDEX "order_trackings_workspace_id_idx" ON "order_trackings"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_trackings_store_id_shopify_order_id_key" ON "order_trackings"("store_id", "shopify_order_id");

-- CreateIndex
CREATE INDEX "order_tracking_events_store_id_idx" ON "order_tracking_events"("store_id");

-- CreateIndex
CREATE INDEX "order_tracking_events_workspace_id_idx" ON "order_tracking_events"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_tracking_events_tracking_id_dedupe_key_key" ON "order_tracking_events"("tracking_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "abandoned_checkouts_store_id_last_activity_at_idx" ON "abandoned_checkouts"("store_id", "last_activity_at");

-- CreateIndex
CREATE INDEX "abandoned_checkouts_workspace_id_idx" ON "abandoned_checkouts"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "abandoned_checkouts_store_id_checkout_token_key" ON "abandoned_checkouts"("store_id", "checkout_token");

-- CreateIndex
CREATE INDEX "whatsapp_campaigns_store_id_status_idx" ON "whatsapp_campaigns"("store_id", "status");

-- CreateIndex
CREATE INDEX "whatsapp_campaigns_workspace_id_idx" ON "whatsapp_campaigns"("workspace_id");

-- CreateIndex
CREATE INDEX "customer_reviews_store_id_status_idx" ON "customer_reviews"("store_id", "status");

-- CreateIndex
CREATE INDEX "customer_reviews_workspace_id_idx" ON "customer_reviews"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_reviews_tracking_id_product_id_key" ON "customer_reviews"("tracking_id", "product_id");

-- CreateIndex
CREATE INDEX "whatsapp_automation_rules_store_id_trigger_idx" ON "whatsapp_automation_rules"("store_id", "trigger");

-- CreateIndex
CREATE INDEX "whatsapp_automation_rules_workspace_id_idx" ON "whatsapp_automation_rules"("workspace_id");

-- CreateIndex
CREATE INDEX "whatsapp_automation_runs_store_id_created_at_idx" ON "whatsapp_automation_runs"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "whatsapp_automation_runs_workspace_id_idx" ON "whatsapp_automation_runs"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_automation_runs_rule_id_trigger_subject_key_key" ON "whatsapp_automation_runs"("rule_id", "trigger", "subject_key");

-- Row level security, as for every store-scoped table (see 20261002070200_rls). The public
-- tracking and review pages and the Meta webhook use the owner role, found by token or signature.
ALTER TABLE "whatsapp_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "whatsapp_connections" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "whatsapp_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "whatsapp_settings" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "whatsapp_templates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "whatsapp_templates" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "whatsapp_contacts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "whatsapp_contacts" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "whatsapp_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "whatsapp_messages" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "whatsapp_message_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "whatsapp_message_events" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "order_trackings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "order_trackings" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "order_tracking_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "order_tracking_events" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "abandoned_checkouts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "abandoned_checkouts" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "whatsapp_campaigns" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "whatsapp_campaigns" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "customer_reviews" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_reviews" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "whatsapp_automation_rules" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "whatsapp_automation_rules" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "whatsapp_automation_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "whatsapp_automation_runs" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
