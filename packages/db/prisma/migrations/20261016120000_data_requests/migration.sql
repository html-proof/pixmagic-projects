-- Shopify's customers/data_request: what was asked and of which store, so the owner can download
-- the customer's data (packages/core/src/privacy.ts). Holds keyed hashes only, no PII.
CREATE TABLE "data_requests" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "shopify_request_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "customer_key" TEXT,
    "phone_hash" TEXT,
    "email_hash" TEXT,
    "orders_requested" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "downloaded_at" TIMESTAMP(3),

    CONSTRAINT "data_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "data_requests_workspace_id_received_at_idx" ON "data_requests"("workspace_id", "received_at");

CREATE UNIQUE INDEX "data_requests_store_id_shopify_request_id_key" ON "data_requests"("store_id", "shopify_request_id");

ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row level security, as for every tenant table (see 20261002070200_rls).
ALTER TABLE "data_requests" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "data_requests" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
