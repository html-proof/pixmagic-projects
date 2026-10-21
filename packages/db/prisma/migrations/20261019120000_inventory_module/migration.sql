-- The Inventory module (docs/inventory.md). Expand only: nullable columns on products and
-- product_variants (the product information and the inventory item each variant's stock is keyed
-- by), one column on notification_preferences, and new tables, so the code before it keeps working
-- (applied first, the code that uses them after).
--
-- inventory_locations / inventory_levels: Shopify's locations, and every quantity state of each
-- inventory item at each location, as last read from Shopify. inventory_movements: each change
-- bizinsights saw (or made, confirmed by Shopify). inventory_snapshots: the stock at each day's end,
-- for the trend charts. inventory_adjustments: stock changes asked for in bizinsights and Shopify's
-- answer (settled once, never edited: the trigger below). inventory_settings, inventory_alerts,
-- inventory_sync_runs: thresholds and alert settings, per-variant alert state, and each full pass
-- over the stock (the import, a refresh, the scheduled check against Shopify).
-- AlterTable
ALTER TABLE "notification_preferences" ADD COLUMN     "stock_alerts" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "compare_at_price" DECIMAL(18,2),
ADD COLUMN     "inventory_item_id" TEXT,
ADD COLUMN     "inventory_policy" TEXT,
ADD COLUMN     "low_stock_threshold" INTEGER,
ADD COLUMN     "options" JSONB,
ADD COLUMN     "position" INTEGER,
ADD COLUMN     "requires_shipping" BOOLEAN,
ADD COLUMN     "shopify_created_at" TIMESTAMP(3),
ADD COLUMN     "taxable" BOOLEAN,
ADD COLUMN     "weight" DECIMAL(18,4),
ADD COLUMN     "weight_unit" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "category" TEXT,
ADD COLUMN     "collections" JSONB,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "handle" TEXT,
ADD COLUMN     "image_url" TEXT,
ADD COLUMN     "low_stock_threshold" INTEGER,
ADD COLUMN     "online_store_url" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "inventory_locations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "shopify_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL,
    "is_fulfillment_service" BOOLEAN NOT NULL DEFAULT false,
    "fulfills_online_orders" BOOLEAN,
    "address" JSONB,
    "formatted_address" TEXT,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "inventory_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_levels" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "location_shopify_id" TEXT NOT NULL,
    "available" INTEGER NOT NULL,
    "on_hand" INTEGER NOT NULL,
    "committed" INTEGER NOT NULL,
    "incoming" INTEGER NOT NULL,
    "reserved" INTEGER NOT NULL,
    "damaged" INTEGER NOT NULL,
    "safety_stock" INTEGER NOT NULL,
    "quality_control" INTEGER NOT NULL,
    "shopify_updated_at" TIMESTAMP(3) NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "location_shopify_id" TEXT NOT NULL,
    "variant_shopify_id" TEXT,
    "product_shopify_id" TEXT,
    "product_title" TEXT,
    "variant_title" TEXT,
    "sku" TEXT,
    "location_name" TEXT,
    "quantity_name" TEXT NOT NULL,
    "before" INTEGER,
    "after" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "adjustment_id" TEXT,
    "shopify_updated_at" TIMESTAMP(3) NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_snapshots" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "location_key" TEXT NOT NULL,
    "tracked_variants" INTEGER NOT NULL,
    "untracked_variants" INTEGER NOT NULL,
    "available" INTEGER NOT NULL,
    "on_hand" INTEGER NOT NULL,
    "committed" INTEGER NOT NULL,
    "incoming" INTEGER NOT NULL,
    "low_stock" INTEGER NOT NULL,
    "out_of_stock" INTEGER NOT NULL,
    "cost_value" DECIMAL(18,2),
    "variants_with_cost" INTEGER NOT NULL,
    "variants_in_stock" INTEGER NOT NULL,
    "retail_value" DECIMAL(18,2) NOT NULL,
    "taken_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_adjustments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "inventory_item_id" TEXT NOT NULL,
    "location_shopify_id" TEXT NOT NULL,
    "variant_shopify_id" TEXT,
    "product_shopify_id" TEXT,
    "product_title" TEXT,
    "variant_title" TEXT,
    "sku" TEXT,
    "location_name" TEXT,
    "kind" TEXT NOT NULL,
    "quantity_name" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "reference_id" TEXT,
    "delta" INTEGER,
    "quantity" INTEGER,
    "expected_before" INTEGER,
    "status" TEXT NOT NULL,
    "error_code" TEXT,
    "shopify_group_id" TEXT,
    "result_quantity" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "inventory_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_settings" (
    "store_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "low_stock_threshold" INTEGER NOT NULL DEFAULT 10,
    "email_alerts" BOOLEAN NOT NULL DEFAULT true,
    "dashboard_alerts" BOOLEAN NOT NULL DEFAULT true,
    "whatsapp_alerts" BOOLEAN NOT NULL DEFAULT false,
    "whatsapp_template" TEXT,
    "whatsapp_to_enc" TEXT,
    "reconcile_hours" INTEGER NOT NULL DEFAULT 6,
    "lead_time_days" INTEGER NOT NULL DEFAULT 14,
    "cover_days" INTEGER NOT NULL DEFAULT 30,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_settings_pkey" PRIMARY KEY ("store_id")
);

-- CreateTable
CREATE TABLE "inventory_alerts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "variant_shopify_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "available" INTEGER NOT NULL,
    "threshold" INTEGER,
    "opened_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "notified_at" TIMESTAMP(3),

    CONSTRAINT "inventory_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_sync_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "locations" INTEGER NOT NULL DEFAULT 0,
    "levels_checked" INTEGER NOT NULL DEFAULT 0,
    "differences" INTEGER NOT NULL DEFAULT 0,
    "sample" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "inventory_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_locations_workspace_id_idx" ON "inventory_locations"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_locations_store_id_shopify_id_key" ON "inventory_locations"("store_id", "shopify_id");

-- CreateIndex
CREATE INDEX "inventory_levels_store_id_location_shopify_id_idx" ON "inventory_levels"("store_id", "location_shopify_id");

-- CreateIndex
CREATE INDEX "inventory_levels_workspace_id_idx" ON "inventory_levels"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_levels_store_id_inventory_item_id_location_shopif_key" ON "inventory_levels"("store_id", "inventory_item_id", "location_shopify_id");

-- CreateIndex
CREATE INDEX "inventory_movements_store_id_observed_at_idx" ON "inventory_movements"("store_id", "observed_at");

-- CreateIndex
CREATE INDEX "inventory_movements_store_id_variant_shopify_id_observed_at_idx" ON "inventory_movements"("store_id", "variant_shopify_id", "observed_at");

-- CreateIndex
CREATE INDEX "inventory_movements_workspace_id_idx" ON "inventory_movements"("workspace_id");

-- CreateIndex
CREATE INDEX "inventory_snapshots_workspace_id_idx" ON "inventory_snapshots"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_snapshots_store_id_day_location_key_key" ON "inventory_snapshots"("store_id", "day", "location_key");

-- CreateIndex
CREATE INDEX "inventory_adjustments_store_id_created_at_idx" ON "inventory_adjustments"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_adjustments_workspace_id_idx" ON "inventory_adjustments"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_adjustments_store_id_idempotency_key_key" ON "inventory_adjustments"("store_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "inventory_settings_workspace_id_idx" ON "inventory_settings"("workspace_id");

-- CreateIndex
CREATE INDEX "inventory_alerts_store_id_resolved_at_idx" ON "inventory_alerts"("store_id", "resolved_at");

-- CreateIndex
CREATE INDEX "inventory_alerts_workspace_id_idx" ON "inventory_alerts"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_alerts_store_id_variant_shopify_id_kind_key" ON "inventory_alerts"("store_id", "variant_shopify_id", "kind");

-- CreateIndex
CREATE INDEX "inventory_sync_runs_store_id_started_at_idx" ON "inventory_sync_runs"("store_id", "started_at");

-- CreateIndex
CREATE INDEX "inventory_sync_runs_workspace_id_idx" ON "inventory_sync_runs"("workspace_id");

-- CreateIndex
CREATE INDEX "product_variants_store_id_inventory_item_id_idx" ON "product_variants"("store_id", "inventory_item_id");

-- AddForeignKey
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_settings" ADD CONSTRAINT "inventory_settings_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_alerts" ADD CONSTRAINT "inventory_alerts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_sync_runs" ADD CONSTRAINT "inventory_sync_runs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row level security, as for every tenant table (see 20261002070200_rls).
ALTER TABLE "inventory_locations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory_locations" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "inventory_levels" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory_levels" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "inventory_movements" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory_movements" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "inventory_snapshots" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory_snapshots" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "inventory_adjustments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory_adjustments" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "inventory_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory_settings" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "inventory_alerts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory_alerts" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE "inventory_sync_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory_sync_runs" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- The stock history and the adjustments made in bizinsights are append-only for tenant requests:
-- the worker and the API write them as the owner role (also in infra/postgres/init.sql, which
-- re-runs after migrations in tests and would otherwise hand the rights back).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "inventory_adjustments" FROM app_rls;
    REVOKE UPDATE, DELETE, TRUNCATE ON "inventory_movements" FROM app_rls;
  END IF;
END $$;

-- An adjustment is written "pending" before Shopify is asked, and settled with Shopify's answer
-- (confirmed | failed; "unknown" while no answer came back, until a retry with the same key gets
-- one). After that it is a record: nothing may change it, and before it only the outcome may be
-- filled in. Deleting stays possible, for erasing a store (shop/redact, cascade from stores).
CREATE FUNCTION inventory_adjustment_settle_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('pending', 'unknown') THEN
    RAISE EXCEPTION 'inventory adjustment % is settled and cannot change', OLD.id;
  END IF;
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.store_id <> OLD.store_id
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     OR NEW.inventory_item_id <> OLD.inventory_item_id OR NEW.location_shopify_id <> OLD.location_shopify_id
     OR NEW.kind <> OLD.kind OR NEW.quantity_name <> OLD.quantity_name OR NEW.reason <> OLD.reason
     OR NEW.note IS DISTINCT FROM OLD.note OR NEW.reference_id IS DISTINCT FROM OLD.reference_id
     OR NEW.delta IS DISTINCT FROM OLD.delta OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.expected_before IS DISTINCT FROM OLD.expected_before OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'only the outcome of inventory adjustment % can be recorded', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_adjustments_settle_once BEFORE UPDATE ON "inventory_adjustments"
  FOR EACH ROW EXECUTE FUNCTION inventory_adjustment_settle_once();
