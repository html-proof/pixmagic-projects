import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { signUp, uniqueEmail } from "./helpers";

/**
 * The Inventory section in the browser: the sidebar link, the overview's figures from stock held,
 * the stock list's search and the product panel, on a store with stock levels (two locations).
 * The API's rules are covered by apps/api/test/inventory.test.ts; this checks the pages show them.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.OWNER_DATABASE_URL });
test.afterAll(() => db.end());

async function ownerWithStore(page: Page) {
  await signUp(page, uniqueEmail("inventory"));
  const ws = await page.evaluate(async () => {
    const r = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Stockroom" }) });
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  });
  const scopes = ["read_orders", "read_products", "read_inventory", "read_locations"];
  // Imported already (last_synced_at): a store that never finished an import gets its first import
  // again when the dashboard opens, stock pass included, and this one has no Shopify to read.
  const { rows } = await db.query(
    `INSERT INTO stores (id, workspace_id, shop_domain, name, status, timezone, currency, granted_scopes, pixel_ingest_key, last_synced_at, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, 'Stockroom', 'active', 'UTC', 'USD', $3, gen_random_uuid()::text, now(), now(), now()) RETURNING id`,
    [ws, `stockroom-${Date.now()}.myshopify.com`, scopes],
  );
  const store = rows[0].id as string;
  const q = (sql: string, args: unknown[]) => db.query(sql, args);
  await q(`INSERT INTO products (id, workspace_id, store_id, shopify_id, title, status, vendor, shopify_updated_at, tags) VALUES (gen_random_uuid()::text, $1, $2, '1', 'Classic Tee', 'active', 'Northwind', now(), '{}'), (gen_random_uuid()::text, $1, $2, '2', 'Canvas Tote', 'active', 'Harbour', now(), '{}')`, [ws, store]);
  await q(
    `INSERT INTO product_variants (id, workspace_id, store_id, product_shopify_id, shopify_id, title, sku, price, unit_cost, inventory_quantity, inventory_item_id, shopify_updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, '1', '11', 'M', 'TEE-M', 30, 12, 57, '911', now()), (gen_random_uuid()::text, $1, $2, '2', '21', 'Default Title', 'TOTE', 15, 5, 4, '921', now())`,
    [ws, store],
  );
  await q(`INSERT INTO inventory_locations (id, workspace_id, store_id, shopify_id, name, is_active, synced_at) VALUES (gen_random_uuid()::text, $1, $2, '100', 'Warehouse', true, now()), (gen_random_uuid()::text, $1, $2, '200', 'Shop', true, now())`, [ws, store]);
  await q(
    `INSERT INTO inventory_levels (id, workspace_id, store_id, inventory_item_id, location_shopify_id, available, on_hand, committed, incoming, reserved, damaged, safety_stock, quality_control, shopify_updated_at, synced_at)
     VALUES (gen_random_uuid()::text, $1, $2, '911', '100', 50, 53, 3, 10, 0, 0, 0, 0, now(), now()),
            (gen_random_uuid()::text, $1, $2, '911', '200', 7, 7, 0, 0, 0, 0, 0, 0, now(), now()),
            (gen_random_uuid()::text, $1, $2, '921', '100', 4, 4, 0, 0, 0, 0, 0, 0, now(), now())`,
    [ws, store],
  );
  await q(`INSERT INTO inventory_sync_runs (id, workspace_id, store_id, trigger, status, locations, levels_checked, started_at, finished_at) VALUES (gen_random_uuid()::text, $1, $2, 'import', 'succeeded', 2, 3, now(), now())`, [ws, store]);
  return { ws, store };
}

test("an owner opens Inventory: the figures from the stock held, a search, and a product's stock per location", async ({ page }) => {
  const { store } = await ownerWithStore(page);
  // The dashboard's first poll is what queues a store's background refresh (apps/api sync.ts,
  // autoRefresh): the first import again for a store without last_synced_at, whose stock pass then
  // read as "Checking every stock level against Shopify…" (CI runs 39234248011, 39237161498). On a
  // fast machine the click below beat that poll, so the check passed or failed by timing. Let the
  // poll land first, every run, and check the strip after it.
  const dashboardPolled = page.waitForResponse((r) => r.url().includes(`/stores/${store}/overview`));
  await page.goto("/dashboard");
  await dashboardPolled;
  const nav = page.getByRole("complementary").getByRole("navigation", { name: "App" });
  await nav.getByRole("link", { name: "Stock", exact: true }).click();
  await expect(page).toHaveURL(/\/inventory\/?$/);

  // 57 + 4 available; 60 + 4 on hand; the tote (4 ≤ 10) is low.
  await expect(page.getByTestId("kpi-available")).toContainText("61");
  await expect(page.getByTestId("kpi-onHand")).toContainText("64");
  await expect(page.getByTestId("kpi-lowStock")).toContainText("1");
  await expect(page.getByTestId("kpi-outOfStock")).toContainText("0");
  await expect(page.getByTestId("inventory-sync")).toContainText("In step with Shopify");

  await page.getByRole("navigation", { name: "Stock", exact: true }).getByRole("link", { name: "All stock" }).click();
  await page.getByTestId("stock-search").fill("TOTE");
  await expect(page.getByTestId("stock-row-21")).toBeVisible();
  await expect(page.getByTestId("stock-row-11")).toHaveCount(0);
  await page.getByTestId("stock-search").fill("");
  await expect(page.getByTestId("stock-row-11")).toBeVisible();

  await page.getByTestId("stock-row-11").getByRole("button", { name: /Classic Tee/ }).click();
  const panel = page.getByTestId("product-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("variant-11")).toContainText("Warehouse");
  await expect(panel.getByTestId("variant-11")).toContainText("Shop");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("a member without inventory access has no Inventory link", async ({ page, browser }) => {
  const { ws } = await ownerWithStore(page);
  const other = await browser.newPage();
  const email = uniqueEmail("no-inventory");
  await signUp(other, email);
  const { rows } = await db.query(`SELECT id FROM users WHERE email = $1`, [email.toLowerCase()]);
  await db.query(`INSERT INTO memberships (id, workspace_id, user_id, role, permissions, created_at) VALUES (gen_random_uuid()::text, $1, $2, 'custom', '{analytics.sales}', now())`, [ws, rows[0].id]);
  await other.goto("/dashboard");
  const nav = other.getByRole("complementary").getByRole("navigation", { name: "App" });
  await expect(nav.getByRole("link", { name: "Sales" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Stock", exact: true })).toHaveCount(0);
  await other.close();
});
