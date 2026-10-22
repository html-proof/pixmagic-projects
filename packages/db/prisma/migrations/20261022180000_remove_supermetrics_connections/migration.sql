-- Supermetrics is removed: an ad account read through it can't be read any more. Each such connection
-- goes as a disconnect takes it: its open alerts are closed (adConnections/alerts.ts adAlertCode), and
-- the row is deleted with its stored days and sync records (ON DELETE CASCADE). Data only: the
-- columns stay (ad_connections.source and source_login_id also serve Nango connections).
UPDATE "alerts" SET "resolved_at" = CURRENT_TIMESTAMP
WHERE "resolved_at" IS NULL
  AND "code" IN (
    SELECT k || ':' || c."id"
    FROM "ad_connections" c
    CROSS JOIN unnest(ARRAY['ads_reconnect', 'ads_expiring', 'ads_failing', 'ads_unavailable']) AS k
    WHERE c."source" = 'supermetrics'
  );

DELETE FROM "ad_connections" WHERE "source" = 'supermetrics';
