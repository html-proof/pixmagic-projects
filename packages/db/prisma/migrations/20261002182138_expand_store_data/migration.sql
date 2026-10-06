-- AlterTable
ALTER TABLE "order_line_items" ADD COLUMN     "sku" TEXT,
ADD COLUMN     "variant_shopify_id" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "discount_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "fulfilled_at" TIMESTAMP(3),
ADD COLUMN     "fulfillment_status" TEXT,
ADD COLUMN     "source_name" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "product_type" TEXT,
ADD COLUMN     "shopify_created_at" TIMESTAMP(3),
ADD COLUMN     "vendor" TEXT;

-- CreateTable
CREATE TABLE "product_variants" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "product_shopify_id" TEXT NOT NULL,
    "shopify_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "price" DECIMAL(18,2) NOT NULL,
    "inventory_quantity" INTEGER,
    "unit_cost" DECIMAL(18,2),
    "shopify_updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_variants_store_id_product_shopify_id_idx" ON "product_variants"("store_id", "product_shopify_id");

-- CreateIndex
CREATE INDEX "product_variants_workspace_id_idx" ON "product_variants"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_store_id_shopify_id_key" ON "product_variants"("store_id", "shopify_id");

-- Row level security for the new tenant table (same policy as every other store-scoped table).
ALTER TABLE "product_variants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "product_variants" USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
