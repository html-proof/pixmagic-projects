-- Indexes for two filters that run all the time and had none (additive; no data changes).
-- Safe to apply before or after deploying the code, and to leave in place on a rollback.

-- A customer's earlier orders: the returning-customer flag on every order write, customer
-- redaction (GDPR), recomputing returning customers, campaign audiences.
-- CreateIndex
CREATE INDEX "orders_store_id_customer_key_shopify_created_at_idx" ON "orders"("store_id", "customer_key", "shopify_created_at");

-- The 15-minute sweep for stalled sync jobs reads only those queued or running.
-- CreateIndex
CREATE INDEX "sync_jobs_status_idx" ON "sync_jobs"("status");
