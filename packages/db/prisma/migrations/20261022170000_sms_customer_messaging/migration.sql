-- CreateTable
CREATE TABLE "sms_sender_configurations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "sender_type" TEXT NOT NULL,
    "origination_identity" TEXT NOT NULL,
    "identity_label" TEXT,
    "identity_country" TEXT,
    "identity_status" TEXT,
    "two_way" BOOLEAN NOT NULL DEFAULT false,
    "identity_check" TEXT NOT NULL DEFAULT 'unchecked',
    "identity_checked_at" TIMESTAMP(3),
    "registration_status" TEXT NOT NULL DEFAULT 'unknown',
    "aws_region" TEXT NOT NULL,
    "configuration_set" TEXT,
    "opt_out_list" TEXT,
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sending_enabled" BOOLEAN NOT NULL DEFAULT false,
    "marketing_enabled" BOOLEAN NOT NULL DEFAULT false,
    "monthly_budget_usd" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "hard_stop" BOOLEAN NOT NULL DEFAULT true,
    "monthly_message_quota" INTEGER,
    "budget_alerts" JSONB NOT NULL DEFAULT '{}',
    "transactional_basis" TEXT NOT NULL DEFAULT 'none',
    "transactional_basis_by" TEXT,
    "transactional_basis_at" TIMESTAMP(3),
    "quiet_start" INTEGER NOT NULL DEFAULT 21,
    "quiet_end" INTEGER NOT NULL DEFAULT 9,
    "max_per_customer_day" INTEGER NOT NULL DEFAULT 3,
    "max_marketing_per_week" INTEGER NOT NULL DEFAULT 2,
    "dlt_entity_id" TEXT,
    "held_until" TIMESTAMP(3),
    "held_reason" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_sender_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_templates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "latest_version" INTEGER NOT NULL DEFAULT 1,
    "approved_version" INTEGER,
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_template_versions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "dlt_template_id" TEXT,
    "dlt_text" TEXT,
    "encoding" TEXT NOT NULL,
    "segments" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "review_note" TEXT,
    "created_by" TEXT,
    "submitted_by" TEXT,
    "submitted_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_automation_rules" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "config" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active_config" JSONB,
    "active_version" INTEGER,
    "active_trigger" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 50,
    "submitted_by" TEXT,
    "submitted_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_segments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filter" JSONB NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_campaigns" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "template_version" INTEGER,
    "segment_id" TEXT,
    "filter" JSONB NOT NULL,
    "discount_code" TEXT,
    "attribution_days" INTEGER NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "estimated_recipients" INTEGER,
    "estimated_cost_usd" DECIMAL(14,6),
    "confirmed_recipients" INTEGER,
    "scheduled_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "submitted_by" TEXT,
    "submitted_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "scheduled_by" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_campaign_recipients" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "job_id" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_contacts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "phone_hash" TEXT NOT NULL,
    "phone_enc" TEXT NOT NULL,
    "phone_masked" TEXT NOT NULL,
    "country" TEXT,
    "first_name_enc" TEXT,
    "shopify_customer_id" TEXT,
    "customer_key" TEXT,
    "consent_state" TEXT NOT NULL DEFAULT 'unknown',
    "consent_opt_in_level" TEXT,
    "consent_source" TEXT,
    "consent_collected_from" TEXT,
    "consent_updated_at" TIMESTAMP(3),
    "suppressed_all" BOOLEAN NOT NULL DEFAULT false,
    "suppressed_marketing" BOOLEAN NOT NULL DEFAULT false,
    "orders_count" INTEGER NOT NULL DEFAULT 0,
    "total_spent" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "last_order_at" TIMESTAMP(3),
    "last_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_contact_orders" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "shopify_order_id" TEXT NOT NULL,
    "order_name" TEXT,
    "total" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "placed_at" TIMESTAMP(3) NOT NULL,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_contact_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_consent_records" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "opt_in_level" TEXT,
    "source" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "effective_at" TIMESTAMP(3) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_suppression_list" (
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

    CONSTRAINT "sms_suppression_list_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_checkouts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "checkout_token" TEXT NOT NULL,
    "contact_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "product_title" TEXT,
    "total" DECIMAL(18,2),
    "currency" TEXT,
    "recovery_url_enc" TEXT,
    "last_activity_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "completed_order_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_message_jobs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "trigger" TEXT,
    "rule_id" TEXT,
    "rule_version" INTEGER,
    "campaign_id" TEXT,
    "template_id" TEXT,
    "template_version" INTEGER,
    "contact_id" TEXT,
    "test_number_id" TEXT,
    "phone_hash" TEXT,
    "phone_masked" TEXT,
    "destination_country" TEXT,
    "values_enc" TEXT,
    "body_enc" TEXT,
    "encoding" TEXT,
    "segments" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "reason" TEXT,
    "send_after" TIMESTAMP(3) NOT NULL,
    "enqueued_at" TIMESTAMP(3),
    "claimed_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "aws_region" TEXT,
    "origination_identity" TEXT,
    "provider_message_id" TEXT,
    "accepted_at" TIMESTAMP(3),
    "provider_status" TEXT,
    "provider_status_at" TIMESTAMP(3),
    "final_at" TIMESTAMP(3),
    "error_code" TEXT,
    "estimated_cost_usd" DECIMAL(14,6),
    "price_usd" DECIMAL(14,6),
    "carrier_fee_usd" DECIMAL(14,6),
    "parts_billed" INTEGER,
    "opt_out_code_hash" TEXT,
    "subject_key" TEXT,
    "order_id" TEXT,
    "checkout_token" TEXT,
    "attributed_order_id" TEXT,
    "attributed_revenue" DECIMAL(18,2),
    "attributed_currency" TEXT,
    "attributed_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_message_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_delivery_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "message_status" TEXT NOT NULL,
    "is_final" BOOLEAN NOT NULL,
    "event_at" TIMESTAMP(3) NOT NULL,
    "iso_country" TEXT,
    "parts" INTEGER,
    "price_usd" DECIMAL(14,6),
    "carrier_fee_usd" DECIMAL(14,6),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_delivery_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_cost_records" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "rule_id" TEXT,
    "country" TEXT,
    "month" TEXT NOT NULL,
    "parts" INTEGER NOT NULL,
    "price_usd" DECIMAL(14,6) NOT NULL,
    "carrier_fee_usd" DECIMAL(14,6) NOT NULL,
    "total_usd" DECIMAL(14,6) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_cost_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_audit_logs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT,
    "actor_user_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "version" INTEGER,
    "snapshot" JSONB,
    "metadata" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_test_numbers" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "phone_hash" TEXT NOT NULL,
    "phone_enc" TEXT NOT NULL,
    "phone_masked" TEXT NOT NULL,
    "country" TEXT,
    "aws_verified_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_by" TEXT,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_test_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sms_sender_configurations_store_id_key" ON "sms_sender_configurations"("store_id");

-- CreateIndex
CREATE INDEX "sms_sender_configurations_workspace_id_idx" ON "sms_sender_configurations"("workspace_id");

-- CreateIndex
CREATE INDEX "sms_templates_workspace_id_idx" ON "sms_templates"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_templates_store_id_name_key" ON "sms_templates"("store_id", "name");

-- CreateIndex
CREATE INDEX "sms_template_versions_workspace_id_idx" ON "sms_template_versions"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_template_versions_template_id_version_key" ON "sms_template_versions"("template_id", "version");

-- CreateIndex
CREATE INDEX "sms_automation_rules_store_id_active_trigger_status_idx" ON "sms_automation_rules"("store_id", "active_trigger", "status");

-- CreateIndex
CREATE INDEX "sms_automation_rules_workspace_id_idx" ON "sms_automation_rules"("workspace_id");

-- CreateIndex
CREATE INDEX "sms_segments_workspace_id_idx" ON "sms_segments"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_segments_store_id_name_key" ON "sms_segments"("store_id", "name");

-- CreateIndex
CREATE INDEX "sms_campaigns_store_id_status_idx" ON "sms_campaigns"("store_id", "status");

-- CreateIndex
CREATE INDEX "sms_campaigns_status_scheduled_at_idx" ON "sms_campaigns"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "sms_campaigns_workspace_id_idx" ON "sms_campaigns"("workspace_id");

-- CreateIndex
CREATE INDEX "sms_campaign_recipients_campaign_id_status_idx" ON "sms_campaign_recipients"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "sms_campaign_recipients_workspace_id_idx" ON "sms_campaign_recipients"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_campaign_recipients_campaign_id_contact_id_key" ON "sms_campaign_recipients"("campaign_id", "contact_id");

-- CreateIndex
CREATE INDEX "sms_contacts_store_id_consent_state_idx" ON "sms_contacts"("store_id", "consent_state");

-- CreateIndex
CREATE INDEX "sms_contacts_store_id_customer_key_idx" ON "sms_contacts"("store_id", "customer_key");

-- CreateIndex
CREATE INDEX "sms_contacts_workspace_id_idx" ON "sms_contacts"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_contacts_store_id_phone_hash_key" ON "sms_contacts"("store_id", "phone_hash");

-- CreateIndex
CREATE INDEX "sms_contact_orders_contact_id_placed_at_idx" ON "sms_contact_orders"("contact_id", "placed_at");

-- CreateIndex
CREATE INDEX "sms_contact_orders_workspace_id_idx" ON "sms_contact_orders"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_contact_orders_store_id_shopify_order_id_key" ON "sms_contact_orders"("store_id", "shopify_order_id");

-- CreateIndex
CREATE INDEX "sms_consent_records_contact_id_recorded_at_idx" ON "sms_consent_records"("contact_id", "recorded_at");

-- CreateIndex
CREATE INDEX "sms_consent_records_workspace_id_idx" ON "sms_consent_records"("workspace_id");

-- CreateIndex
CREATE INDEX "sms_suppression_list_workspace_id_idx" ON "sms_suppression_list"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_suppression_list_store_id_phone_hash_scope_key" ON "sms_suppression_list"("store_id", "phone_hash", "scope");

-- CreateIndex
CREATE INDEX "sms_checkouts_store_id_status_last_activity_at_idx" ON "sms_checkouts"("store_id", "status", "last_activity_at");

-- CreateIndex
CREATE INDEX "sms_checkouts_workspace_id_idx" ON "sms_checkouts"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_checkouts_store_id_checkout_token_key" ON "sms_checkouts"("store_id", "checkout_token");

-- CreateIndex
CREATE UNIQUE INDEX "sms_message_jobs_provider_message_id_key" ON "sms_message_jobs"("provider_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_message_jobs_opt_out_code_hash_key" ON "sms_message_jobs"("opt_out_code_hash");

-- CreateIndex
CREATE INDEX "sms_message_jobs_status_send_after_idx" ON "sms_message_jobs"("status", "send_after");

-- CreateIndex
CREATE INDEX "sms_message_jobs_store_id_created_at_idx" ON "sms_message_jobs"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "sms_message_jobs_campaign_id_idx" ON "sms_message_jobs"("campaign_id");

-- CreateIndex
CREATE INDEX "sms_message_jobs_rule_id_idx" ON "sms_message_jobs"("rule_id");

-- CreateIndex
CREATE INDEX "sms_message_jobs_contact_id_accepted_at_idx" ON "sms_message_jobs"("contact_id", "accepted_at");

-- CreateIndex
CREATE INDEX "sms_message_jobs_store_id_checkout_token_idx" ON "sms_message_jobs"("store_id", "checkout_token");

-- CreateIndex
CREATE INDEX "sms_message_jobs_workspace_id_idx" ON "sms_message_jobs"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_message_jobs_store_id_dedupe_key_key" ON "sms_message_jobs"("store_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "sms_message_jobs_store_id_attributed_order_id_key" ON "sms_message_jobs"("store_id", "attributed_order_id");

-- CreateIndex
CREATE INDEX "sms_delivery_events_job_id_idx" ON "sms_delivery_events"("job_id");

-- CreateIndex
CREATE INDEX "sms_delivery_events_workspace_id_idx" ON "sms_delivery_events"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_delivery_events_provider_message_id_event_type_event_at_key" ON "sms_delivery_events"("provider_message_id", "event_type", "event_at");

-- CreateIndex
CREATE UNIQUE INDEX "sms_cost_records_job_id_key" ON "sms_cost_records"("job_id");

-- CreateIndex
CREATE INDEX "sms_cost_records_store_id_month_idx" ON "sms_cost_records"("store_id", "month");

-- CreateIndex
CREATE INDEX "sms_cost_records_month_idx" ON "sms_cost_records"("month");

-- CreateIndex
CREATE INDEX "sms_cost_records_workspace_id_idx" ON "sms_cost_records"("workspace_id");

-- CreateIndex
CREATE INDEX "sms_audit_logs_store_id_created_at_idx" ON "sms_audit_logs"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "sms_audit_logs_target_id_idx" ON "sms_audit_logs"("target_id");

-- CreateIndex
CREATE INDEX "sms_audit_logs_workspace_id_idx" ON "sms_audit_logs"("workspace_id");

-- CreateIndex
CREATE INDEX "sms_test_numbers_workspace_id_idx" ON "sms_test_numbers"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_test_numbers_store_id_phone_hash_key" ON "sms_test_numbers"("store_id", "phone_hash");

-- AddForeignKey
ALTER TABLE "sms_template_versions" ADD CONSTRAINT "sms_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "sms_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_campaign_recipients" ADD CONSTRAINT "sms_campaign_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "sms_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_contact_orders" ADD CONSTRAINT "sms_contact_orders_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "sms_contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_consent_records" ADD CONSTRAINT "sms_consent_records_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "sms_contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_delivery_events" ADD CONSTRAINT "sms_delivery_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "sms_message_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row level security, as for every tenant table (see 20261002070200_rls).
ALTER TABLE "sms_sender_configurations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_sender_configurations" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "sms_templates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_templates" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "sms_template_versions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_template_versions" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "sms_automation_rules" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_automation_rules" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "sms_segments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_segments" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "sms_campaigns" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_campaigns" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "sms_campaign_recipients" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_campaign_recipients" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "sms_contacts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_contacts" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "sms_contact_orders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_contact_orders" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "sms_consent_records" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_consent_records" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "sms_suppression_list" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_suppression_list" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "sms_checkouts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_checkouts" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "sms_message_jobs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_message_jobs" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "sms_delivery_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_delivery_events" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "sms_cost_records" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_cost_records" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "sms_audit_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_audit_logs" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "sms_test_numbers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sms_test_numbers" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- Consent history, AWS's delivery events and the Customer Messaging audit trail are append-only
-- for tenant requests: the API and the worker write them as the owner role (also in
-- infra/postgres/init.sql, which re-runs after migrations in tests and would otherwise hand the
-- rights back). Deleting stays possible for the owner role: erasing a customer or a store.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "sms_consent_records" FROM app_rls;
    REVOKE UPDATE, DELETE, TRUNCATE ON "sms_delivery_events" FROM app_rls;
    REVOKE UPDATE, DELETE, TRUNCATE ON "sms_audit_logs" FROM app_rls;
  END IF;
END $$;
