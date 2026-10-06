-- CreateTable
CREATE TABLE "funnel_visits" (
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "visitor" TEXT NOT NULL,
    "entered_at" TIMESTAMP(3),
    "entry_section" TEXT,
    "entry_path" TEXT,
    "exited_at" TIMESTAMP(3),
    "exit_section" TEXT,
    "exit_path" TEXT,
    "furthest_step" SMALLINT NOT NULL DEFAULT 0,
    "sections" INTEGER NOT NULL DEFAULT 0,
    "page_views" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "funnel_visits_pkey" PRIMARY KEY ("store_id","day","visitor")
);

-- CreateIndex
CREATE INDEX "funnel_visits_workspace_id_idx" ON "funnel_visits"("workspace_id");

-- Row level security, as for every store-scoped table (see 20261002070200_rls).
ALTER TABLE "funnel_visits" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "funnel_visits" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
