-- Email integrations and automation (docs/email.md): connected sending accounts (Google, Microsoft,
-- SMTP) with envelope-encrypted credentials, verified domains, sender identities, templates with
-- version history, automation rules, business events, executions, messages, delivery events,
-- suppressions and event API keys.
--
-- Additive only: no existing table changes. Every table carries workspace_id and gets the
-- tenant_isolation RLS policy at the end; references between email tables are composite
-- (id, workspace_id) foreign keys so they can't cross workspaces.

-- CreateTable
CREATE TABLE "email_settings" (
    "workspace_id" TEXT NOT NULL,
    "business_name" TEXT,
    "business_address" TEXT,
    "daily_limit" INTEGER,
    "sending_paused" BOOLEAN NOT NULL DEFAULT false,
    "suspended_at" TIMESTAMP(3),
    "suspended_reason" TEXT,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_settings_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "email_accounts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "connection_method" TEXT NOT NULL,
    "email_address" TEXT NOT NULL,
    "display_name" TEXT,
    "reply_to_address" TEXT,
    "provider_account_id" TEXT,
    "provider_tenant_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "status_reason" TEXT,
    "granted_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "daily_limit" INTEGER,
    "connected_by_user_id" TEXT,
    "last_verified_at" TIMESTAMP(3),
    "last_successful_send_at" TIMESTAMP(3),
    "last_error_code" TEXT,
    "last_error_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "email_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_oauth_credentials" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "email_account_id" TEXT NOT NULL,
    "refresh_token_enc" TEXT NOT NULL,
    "access_token_enc" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "encryption_key_version" INTEGER NOT NULL,
    "credential_version" INTEGER NOT NULL DEFAULT 1,
    "last_refreshed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_oauth_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_smtp_credentials" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "email_account_id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "encryption_mode" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "secret_enc" TEXT NOT NULL,
    "encryption_key_version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_smtp_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_domains" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "verification_method" TEXT NOT NULL DEFAULT 'dns_txt',
    "verification_token_hash" TEXT NOT NULL,
    "verification_token_enc" TEXT NOT NULL,
    "verification_status" TEXT NOT NULL DEFAULT 'unverified',
    "ownership_verified_at" TIMESTAMP(3),
    "verification_expires_at" TIMESTAMP(3) NOT NULL,
    "sending_service" TEXT NOT NULL DEFAULT 'other',
    "dkim_selectors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "spf_status" TEXT,
    "dkim_status" TEXT,
    "dmarc_status" TEXT,
    "dns_results" JSONB,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "last_checked_at" TIMESTAMP(3),
    "next_check_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_sender_identities" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "email_account_id" TEXT NOT NULL,
    "domain_id" TEXT,
    "sender_email" TEXT NOT NULL,
    "sender_name" TEXT,
    "authorization_status" TEXT NOT NULL DEFAULT 'pending',
    "verification_method" TEXT,
    "verification_code_hash" TEXT,
    "verification_code_expires_at" TIMESTAMP(3),
    "verification_attempts" INTEGER NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMP(3),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_sender_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_templates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'transactional',
    "event_type" TEXT,
    "subject_template" TEXT NOT NULL,
    "html_template" TEXT NOT NULL,
    "text_template" TEXT NOT NULL,
    "allowed_variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "reply_to_address" TEXT,
    "created_by_user_id" TEXT,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_template_versions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "event_type" TEXT,
    "subject_template" TEXT NOT NULL,
    "html_template" TEXT NOT NULL,
    "text_template" TEXT NOT NULL,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_automation_rules" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "event_type" TEXT NOT NULL,
    "store_id" TEXT,
    "condition_json" JSONB,
    "action_json" JSONB NOT NULL,
    "sender_identity_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "delay_minutes" INTEGER NOT NULL DEFAULT 0,
    "frequency_policy" JSONB NOT NULL,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "last_triggered_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "email_automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_business_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT,
    "source" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "recipient_hash" TEXT,
    "payload_enc" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "detect_after" TIMESTAMP(3),
    "rules_matched" INTEGER NOT NULL DEFAULT 0,
    "processed_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_business_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_automation_executions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "recipient_hash" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "detail" TEXT,
    "failure_reason" TEXT,
    "message_id" TEXT,
    "evaluated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduled_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_automation_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_messages" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "email_account_id" TEXT NOT NULL,
    "sender_identity_id" TEXT,
    "rule_id" TEXT,
    "execution_id" TEXT,
    "event_id" TEXT,
    "template_id" TEXT,
    "template_version" INTEGER,
    "store_id" TEXT,
    "kind" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'transactional',
    "provider" TEXT NOT NULL,
    "sender_address" TEXT NOT NULL,
    "recipient_enc" TEXT NOT NULL,
    "recipient_hash" TEXT NOT NULL,
    "recipient_masked" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "internet_message_id" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "enqueued_at" TIMESTAMP(3),
    "processing_started_at" TIMESTAMP(3),
    "provider_accepted_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_message_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "provider_event_id" TEXT,
    "event_timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_message_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_suppressions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "email_hash" TEXT NOT NULL,
    "email_masked" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'all',
    "source" TEXT NOT NULL,
    "created_by_user_id" TEXT,
    "message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_ingest_keys" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_ingest_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_accounts_workspace_id_status_idx" ON "email_accounts"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "email_accounts_id_workspace_id_key" ON "email_accounts"("id", "workspace_id");

-- CreateIndex
CREATE INDEX "email_oauth_credentials_workspace_id_idx" ON "email_oauth_credentials"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_oauth_credentials_email_account_id_workspace_id_key" ON "email_oauth_credentials"("email_account_id", "workspace_id");

-- CreateIndex
CREATE INDEX "email_smtp_credentials_workspace_id_idx" ON "email_smtp_credentials"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_smtp_credentials_email_account_id_workspace_id_key" ON "email_smtp_credentials"("email_account_id", "workspace_id");

-- CreateIndex
CREATE INDEX "email_domains_verification_status_next_check_at_idx" ON "email_domains"("verification_status", "next_check_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_domains_workspace_id_domain_key" ON "email_domains"("workspace_id", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "email_domains_id_workspace_id_key" ON "email_domains"("id", "workspace_id");

-- CreateIndex
CREATE INDEX "email_sender_identities_workspace_id_idx" ON "email_sender_identities"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_sender_identities_email_account_id_sender_email_key" ON "email_sender_identities"("email_account_id", "sender_email");

-- CreateIndex
CREATE UNIQUE INDEX "email_sender_identities_id_workspace_id_key" ON "email_sender_identities"("id", "workspace_id");

-- CreateIndex
CREATE INDEX "email_templates_workspace_id_status_idx" ON "email_templates"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "email_templates_id_workspace_id_key" ON "email_templates"("id", "workspace_id");

-- CreateIndex
CREATE INDEX "email_template_versions_workspace_id_idx" ON "email_template_versions"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_template_versions_template_id_version_key" ON "email_template_versions"("template_id", "version");

-- CreateIndex
CREATE INDEX "email_automation_rules_workspace_id_event_type_enabled_idx" ON "email_automation_rules"("workspace_id", "event_type", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "email_automation_rules_id_workspace_id_key" ON "email_automation_rules"("id", "workspace_id");

-- CreateIndex
CREATE INDEX "email_business_events_status_detect_after_idx" ON "email_business_events"("status", "detect_after");

-- CreateIndex
CREATE INDEX "email_business_events_workspace_id_created_at_idx" ON "email_business_events"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "email_business_events_store_id_recipient_hash_idx" ON "email_business_events"("store_id", "recipient_hash");

-- CreateIndex
CREATE UNIQUE INDEX "email_business_events_workspace_id_source_external_id_key" ON "email_business_events"("workspace_id", "source", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_business_events_id_workspace_id_key" ON "email_business_events"("id", "workspace_id");

-- CreateIndex
CREATE INDEX "email_automation_executions_rule_id_created_at_idx" ON "email_automation_executions"("rule_id", "created_at");

-- CreateIndex
CREATE INDEX "email_automation_executions_rule_id_recipient_hash_created__idx" ON "email_automation_executions"("rule_id", "recipient_hash", "created_at");

-- CreateIndex
CREATE INDEX "email_automation_executions_event_id_idx" ON "email_automation_executions"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_automation_executions_workspace_id_idempotency_key_key" ON "email_automation_executions"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "email_messages_status_scheduled_at_idx" ON "email_messages"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "email_messages_workspace_id_created_at_idx" ON "email_messages"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "email_messages_email_account_id_created_at_idx" ON "email_messages"("email_account_id", "created_at");

-- CreateIndex
CREATE INDEX "email_messages_rule_id_created_at_idx" ON "email_messages"("rule_id", "created_at");

-- CreateIndex
CREATE INDEX "email_messages_workspace_id_recipient_hash_idx" ON "email_messages"("workspace_id", "recipient_hash");

-- CreateIndex
CREATE INDEX "email_messages_store_id_idx" ON "email_messages"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_workspace_id_idempotency_key_key" ON "email_messages"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_id_workspace_id_key" ON "email_messages"("id", "workspace_id");

-- CreateIndex
CREATE INDEX "email_message_events_message_id_event_timestamp_idx" ON "email_message_events"("message_id", "event_timestamp");

-- CreateIndex
CREATE INDEX "email_message_events_workspace_id_idx" ON "email_message_events"("workspace_id");

-- CreateIndex
CREATE INDEX "email_suppressions_workspace_id_created_at_idx" ON "email_suppressions"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_suppressions_workspace_id_email_hash_scope_key" ON "email_suppressions"("workspace_id", "email_hash", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "email_ingest_keys_key_hash_key" ON "email_ingest_keys"("key_hash");

-- CreateIndex
CREATE INDEX "email_ingest_keys_workspace_id_idx" ON "email_ingest_keys"("workspace_id");

-- AddForeignKey
ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_oauth_credentials" ADD CONSTRAINT "email_oauth_credentials_email_account_id_workspace_id_fkey" FOREIGN KEY ("email_account_id", "workspace_id") REFERENCES "email_accounts"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_smtp_credentials" ADD CONSTRAINT "email_smtp_credentials_email_account_id_workspace_id_fkey" FOREIGN KEY ("email_account_id", "workspace_id") REFERENCES "email_accounts"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_domains" ADD CONSTRAINT "email_domains_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_sender_identities" ADD CONSTRAINT "email_sender_identities_email_account_id_workspace_id_fkey" FOREIGN KEY ("email_account_id", "workspace_id") REFERENCES "email_accounts"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_template_versions" ADD CONSTRAINT "email_template_versions_template_id_workspace_id_fkey" FOREIGN KEY ("template_id", "workspace_id") REFERENCES "email_templates"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_automation_rules" ADD CONSTRAINT "email_automation_rules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_automation_rules" ADD CONSTRAINT "email_automation_rules_sender_identity_id_workspace_id_fkey" FOREIGN KEY ("sender_identity_id", "workspace_id") REFERENCES "email_sender_identities"("id", "workspace_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_automation_rules" ADD CONSTRAINT "email_automation_rules_template_id_workspace_id_fkey" FOREIGN KEY ("template_id", "workspace_id") REFERENCES "email_templates"("id", "workspace_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_business_events" ADD CONSTRAINT "email_business_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_automation_executions" ADD CONSTRAINT "email_automation_executions_rule_id_workspace_id_fkey" FOREIGN KEY ("rule_id", "workspace_id") REFERENCES "email_automation_rules"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_automation_executions" ADD CONSTRAINT "email_automation_executions_event_id_workspace_id_fkey" FOREIGN KEY ("event_id", "workspace_id") REFERENCES "email_business_events"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_email_account_id_workspace_id_fkey" FOREIGN KEY ("email_account_id", "workspace_id") REFERENCES "email_accounts"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_message_events" ADD CONSTRAINT "email_message_events_message_id_workspace_id_fkey" FOREIGN KEY ("message_id", "workspace_id") REFERENCES "email_messages"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_ingest_keys" ADD CONSTRAINT "email_ingest_keys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What Prisma can't express ------------------------------------------------------------------

-- One live account per address and connection method (a disconnected one may be connected again).
CREATE UNIQUE INDEX "email_accounts_live_address_key" ON "email_accounts" ("workspace_id", "connection_method", "email_address") WHERE "deleted_at" IS NULL;
-- At most one default sender per workspace.
CREATE UNIQUE INDEX "email_sender_identities_one_default_key" ON "email_sender_identities" ("workspace_id") WHERE "is_default";
-- Template names are unique per workspace, ignoring case and deleted templates.
CREATE UNIQUE INDEX "email_templates_live_name_key" ON "email_templates" ("workspace_id", lower("name")) WHERE "deleted_at" IS NULL;

-- States the code relies on, enforced by the database too.
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_status_check"
  CHECK ("status" IN ('pending', 'connected', 'testing', 'degraded', 'reauthorization_required', 'disabled', 'revoked', 'failed'));
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_connection_method_check"
  CHECK ("connection_method" IN ('oauth_google', 'oauth_microsoft', 'smtp'));
-- SMTP is always encrypted: implicit TLS on 465, STARTTLS on 587 and 2525. No plaintext mode exists.
ALTER TABLE "email_smtp_credentials" ADD CONSTRAINT "email_smtp_credentials_tls_check"
  CHECK (("encryption_mode" = 'tls' AND "port" = 465) OR ("encryption_mode" = 'starttls' AND "port" IN (587, 2525)));
ALTER TABLE "email_domains" ADD CONSTRAINT "email_domains_status_check"
  CHECK ("verification_status" IN ('unverified', 'pending', 'verified', 'failed', 'expired', 'recheck_required'));
ALTER TABLE "email_sender_identities" ADD CONSTRAINT "email_sender_identities_status_check"
  CHECK ("authorization_status" IN ('pending', 'verified', 'revoked'));
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_status_check"
  CHECK ("status" IN ('draft', 'active', 'archived') AND "category" IN ('transactional', 'marketing'));
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_status_check"
  CHECK ("status" IN ('queued', 'processing', 'accepted_by_provider', 'delivered', 'bounced', 'deferred', 'failed', 'suppressed', 'cancelled', 'unknown'));
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_attempts_check" CHECK ("attempts" >= 0 AND "max_attempts" BETWEEN 1 AND 8);
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_scope_check" CHECK ("scope" IN ('marketing', 'all'));

-- Delivery events are an audit trail: rows are inserted, never changed (retention may delete them).
CREATE FUNCTION "email_message_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'email_message_events rows are append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER "email_message_events_no_update" BEFORE UPDATE ON "email_message_events" FOR EACH ROW EXECUTE FUNCTION "email_message_events_append_only"();

-- Row level security, as for every tenant table (see 20261002070200_rls).
ALTER TABLE "email_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_settings" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "email_accounts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_accounts" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "email_oauth_credentials" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_oauth_credentials" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "email_smtp_credentials" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_smtp_credentials" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "email_domains" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_domains" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "email_sender_identities" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_sender_identities" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "email_templates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_templates" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "email_template_versions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_template_versions" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "email_automation_rules" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_automation_rules" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "email_business_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_business_events" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "email_automation_executions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_automation_executions" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "email_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_messages" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "email_message_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_message_events" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "email_suppressions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_suppressions" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "email_ingest_keys" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_ingest_keys" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
