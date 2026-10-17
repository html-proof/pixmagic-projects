-- The dashboard reads one store's recent webhook events on every poll (data freshness).
CREATE INDEX "webhook_events_store_id_received_at_idx" ON "webhook_events"("store_id", "received_at");
