-- The Shopping Funnel page: each visit's kind of device and country, the products each visit looked
-- at, and the funnel checklist's done actions. Additive only: code from before ignores the new
-- columns and tables, and visits recorded before have neither (null), which the page says.

-- AlterTable
ALTER TABLE "funnel_visits" ADD COLUMN     "country" TEXT,
ADD COLUMN     "device" TEXT;

-- CreateIndex
CREATE INDEX "funnel_visits_store_id_visitor_day_idx" ON "funnel_visits"("store_id", "visitor", "day");

-- CreateTable
CREATE TABLE "funnel_product_visits" (
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "visitor" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "steps" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "funnel_product_visits_pkey" PRIMARY KEY ("store_id","day","visitor","handle")
);

-- CreateTable
CREATE TABLE "funnel_action_checks" (
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "action_id" TEXT NOT NULL,
    "done_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "done_by" TEXT,

    CONSTRAINT "funnel_action_checks_pkey" PRIMARY KEY ("store_id","action_id")
);

-- CreateIndex
CREATE INDEX "funnel_product_visits_workspace_id_idx" ON "funnel_product_visits"("workspace_id");

-- CreateIndex
CREATE INDEX "funnel_action_checks_workspace_id_idx" ON "funnel_action_checks"("workspace_id");

-- Row level security, as for every store-scoped table (see 20261002070200_rls).
ALTER TABLE "funnel_product_visits" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "funnel_product_visits" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "funnel_action_checks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "funnel_action_checks" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
