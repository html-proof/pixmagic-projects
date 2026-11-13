-- Customer Messaging (SMS), the email module (Settings → Email integrations) and the Automations hub
-- were removed from the app on 2026-11-13 (20261113120000_resolve_removed_module_alerts shipped with
-- that release). Since then nothing reads or writes their tables. The owner asked for them to be
-- deleted the same day, with what they hold: SMS contacts, consent history, texts, costs and senders;
-- connected mailboxes and their encrypted credentials, domains, sender addresses, templates, rules,
-- events, messages, suppressions and event API keys.
--
-- Ships only after the release that removed the code is the one running: the release before it
-- calls into both modules on every order webhook, and would fail on a missing table.
--
-- Not touched: email_deliveries (the app's own invitation emails, core/mail), and wapp_* (WhatsApp
-- Automation). One statement, so the foreign keys between these tables need no order, and no
-- CASCADE: if anything else still depended on one of them, this fails instead of taking that with it.
DROP TABLE
  "email_message_events",
  "email_messages",
  "email_automation_executions",
  "email_business_events",
  "email_automation_rules",
  "email_template_versions",
  "email_templates",
  "email_suppressions",
  "email_sender_identities",
  "email_domains",
  "email_oauth_credentials",
  "email_smtp_credentials",
  "email_accounts",
  "email_ingest_keys",
  "email_settings",
  "sms_delivery_events",
  "sms_cost_records",
  "sms_message_jobs",
  "sms_campaign_recipients",
  "sms_campaigns",
  "sms_segments",
  "sms_automation_rules",
  "sms_template_versions",
  "sms_templates",
  "sms_checkouts",
  "sms_consent_records",
  "sms_contact_orders",
  "sms_contacts",
  "sms_suppression_list",
  "sms_test_numbers",
  "sms_audit_logs",
  "sms_sender_configurations",
  "sms_setups";

-- The trigger function that kept email_message_events append-only: its triggers went with the table.
DROP FUNCTION "email_message_events_append_only"();

-- The keyed hash of the address a customer's data request named: it found that customer's rows in
-- email_messages, which is gone. Requests are found by customer id, order ids and the phone hash.
ALTER TABLE "data_requests" DROP COLUMN "email_hash";
