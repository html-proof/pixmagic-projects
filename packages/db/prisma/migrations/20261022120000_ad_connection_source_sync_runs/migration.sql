-- Ad accounts read through Supermetrics (docs/supermetrics.md) next to the ones bizinsights reads from
-- the platforms itself: how each connection's figures are read ("direct" or "supermetrics") and, for a
-- Supermetrics one, the id of the Supermetrics login it reads with. When each account's last sync
-- started, whatever came of it. And a record of every sync as it ended (ad_sync_runs), for the
-- settings cards and support.
-- Additive only: code from before ignores the new columns and the new table.
ALTER TABLE "ad_connections" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE "ad_connections" ADD COLUMN "source_login_id" TEXT;
ALTER TABLE "ad_connections" ADD COLUMN "last_sync_attempt_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ad_sync_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "since" TEXT,
    "until" TEXT,
    "outcome" TEXT NOT NULL,
    "rows" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ad_sync_runs_connection_id_started_at_idx" ON "ad_sync_runs"("connection_id", "started_at");

-- CreateIndex
CREATE INDEX "ad_sync_runs_workspace_id_idx" ON "ad_sync_runs"("workspace_id");

-- AddForeignKey
ALTER TABLE "ad_sync_runs" ADD CONSTRAINT "ad_sync_runs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "ad_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ad_sync_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ad_sync_runs" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
