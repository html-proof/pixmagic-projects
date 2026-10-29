-- Zapier (docs/zapier.md): bizinsights as the OAuth provider for its app on Zapier's Developer Platform.
-- zapier_grants: a store a merchant allowed Zapier to reach, and the member who allowed it.
-- zapier_tokens: the grant's access and refresh tokens, as SHA-256 hashes only.
-- zapier_hooks: the Zaps' triggers Zapier subscribed (REST hooks), always to hooks.zapier.com.
-- zapier_events: the outbox (one row per happening, unique dedupe key), kept 30 days.
-- zapier_deliveries: one event for one trigger, its attempts and outcome.
-- Additive only: code from before ignores the new tables.

-- CreateTable
CREATE TABLE "zapier_grants" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zapier_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zapier_tokens" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "grant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zapier_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zapier_hooks" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "grant_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "target_url" TEXT NOT NULL,
    "inputs" JSONB NOT NULL DEFAULT '{}',
    "zap_id" TEXT,
    "last_delivered_at" TIMESTAMP(3),
    "checked_at" TIMESTAMP(3),
    "check_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zapier_hooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zapier_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "hook_id" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zapier_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zapier_deliveries" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "hook_id" TEXT,
    "event" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enqueued_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "response_status" INTEGER,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zapier_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "zapier_grants_workspace_id_idx" ON "zapier_grants"("workspace_id");

-- CreateIndex
CREATE INDEX "zapier_grants_store_id_idx" ON "zapier_grants"("store_id");

-- CreateIndex
CREATE INDEX "zapier_grants_user_id_idx" ON "zapier_grants"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "zapier_tokens_token_hash_key" ON "zapier_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "zapier_tokens_grant_id_idx" ON "zapier_tokens"("grant_id");

-- CreateIndex
CREATE INDEX "zapier_tokens_workspace_id_idx" ON "zapier_tokens"("workspace_id");

-- CreateIndex
CREATE INDEX "zapier_tokens_expires_at_idx" ON "zapier_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "zapier_hooks_store_id_event_idx" ON "zapier_hooks"("store_id", "event");

-- CreateIndex
CREATE INDEX "zapier_hooks_grant_id_idx" ON "zapier_hooks"("grant_id");

-- CreateIndex
CREATE INDEX "zapier_hooks_workspace_id_idx" ON "zapier_hooks"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "zapier_events_dedupe_key_key" ON "zapier_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "zapier_events_store_id_event_created_at_idx" ON "zapier_events"("store_id", "event", "created_at");

-- CreateIndex
CREATE INDEX "zapier_events_created_at_idx" ON "zapier_events"("created_at");

-- CreateIndex
CREATE INDEX "zapier_events_workspace_id_idx" ON "zapier_events"("workspace_id");

-- CreateIndex
CREATE INDEX "zapier_deliveries_status_next_attempt_at_idx" ON "zapier_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "zapier_deliveries_store_id_created_at_idx" ON "zapier_deliveries"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "zapier_deliveries_hook_id_idx" ON "zapier_deliveries"("hook_id");

-- CreateIndex
CREATE INDEX "zapier_deliveries_workspace_id_idx" ON "zapier_deliveries"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "zapier_deliveries_event_id_hook_id_key" ON "zapier_deliveries"("event_id", "hook_id");

-- AddForeignKey
ALTER TABLE "zapier_tokens" ADD CONSTRAINT "zapier_tokens_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "zapier_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zapier_hooks" ADD CONSTRAINT "zapier_hooks_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "zapier_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zapier_deliveries" ADD CONSTRAINT "zapier_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "zapier_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zapier_deliveries" ADD CONSTRAINT "zapier_deliveries_hook_id_fkey" FOREIGN KEY ("hook_id") REFERENCES "zapier_hooks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "zapier_grants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "zapier_grants" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "zapier_tokens" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "zapier_tokens" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "zapier_hooks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "zapier_hooks" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "zapier_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "zapier_events" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "zapier_deliveries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "zapier_deliveries" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- Token hashes are checked by the API's own (owner) connection only: the tenant role never needs them
-- (also in infra/postgres/init.sql, whose blanket GRANT would otherwise hand them back).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    REVOKE ALL ON "zapier_tokens" FROM app_rls;
  END IF;
END $$;
