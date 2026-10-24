-- Automations hub (docs/automations.md): one automation's messages, newest first, for its history
-- and its 30-day counts. Both tables are small today; a plain CREATE INDEX takes a moment.

-- CreateIndex
CREATE INDEX "email_messages_workspace_id_rule_id_created_at_idx" ON "email_messages"("workspace_id", "rule_id", "created_at");

-- CreateIndex
CREATE INDEX "sms_message_jobs_store_id_rule_id_created_at_idx" ON "sms_message_jobs"("store_id", "rule_id", "created_at");
