-- Customer Messaging (SMS), the email module (Settings → Email integrations) and the Automations hub
-- were removed from the app on 2026-11-13. An alert one of them raised and that is still open would
-- stay in the bell with no page left to fix it on, worded as "Something needs your attention": it
-- is marked resolved here. No table or column changes: the sms_* tables and the email module's
-- tables are left as they are for this release (nothing reads or writes them any more) and are
-- dropped by a later migration, as 20261112120000_drop_retired_tables did for the ones before them.
UPDATE "alerts"
SET "resolved_at" = now() AT TIME ZONE 'utc'
WHERE "resolved_at" IS NULL
  AND (
    "code" IN ('sms_account_limit', 'sms_sender_problem', 'sms_budget_50', 'sms_budget_80', 'sms_budget_100')
    OR left("code", 21) = 'email_account_reauth:'
    OR left("code", 22) = 'email_sender_rejected:'
  );
