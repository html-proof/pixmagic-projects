-- Tables nothing reads or writes any more, all empty on production on 2026-11-12 (row counts by the
-- cron's "counts" action; a manual snapshot of the database was taken before this release):
--
--   * the first WhatsApp feature (2026-10-10 to 2026-10-24): whatsapp_*, order_trackings,
--     order_tracking_events, abandoned_checkouts, customer_reviews;
--   * the Meta Cloud API module that replaced it for a day (2026-10-25): wa_*;
--   * email_otps: sign-in codes are kept by the coordinator, not in a table;
--   * funnel_daily: the funnel reads funnel_visits and funnel_product_visits.
--
-- WhatsApp Automation as it is now lives in the wapp_* tables, which this does not touch; nor the
-- abandoned checkouts report, which is a dataset in shopify_reports, not the table of that name.
-- One statement, so the foreign keys between these tables need no order, and no CASCADE: if
-- anything else still depended on one of them, this fails instead of taking that with it.
DROP TABLE
  "whatsapp_message_events",
  "whatsapp_messages",
  "whatsapp_automation_runs",
  "whatsapp_automation_rules",
  "whatsapp_campaigns",
  "customer_reviews",
  "order_tracking_events",
  "order_trackings",
  "abandoned_checkouts",
  "whatsapp_contacts",
  "whatsapp_templates",
  "whatsapp_settings",
  "whatsapp_connections",
  "wa_message_events",
  "wa_messages",
  "wa_webhook_events",
  "wa_workflow_runs",
  "wa_workflows",
  "wa_campaigns",
  "wa_consent_events",
  "wa_contacts",
  "wa_templates",
  "wa_settings",
  "wa_connections",
  "email_otps",
  "funnel_daily";
