import { expect, test } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertStore, signUp, stubShopify, uniqueEmail } from "./helpers";

// The Shopping Funnel page (/funnel): its figures from the visits the pixel recorded, a stage's
// explanation, visits by traffic source and products' checkouts, the filter narrowing the page, the
// checklist kept per store, the download, and the dashboard's old ?view=shoppers link landing on it.

const db = new pg.Pool({ connectionString: E2E_ENV.OWNER_DATABASE_URL });
test.afterAll(() => db.end());

const DAY = "2026-09-21";

test("shows the shopping funnel, explains a stage, filters it and keeps the checklist", async ({ page }) => {
  const email = uniqueEmail("funnel");
  await signUp(page, email);
  const ws = await createWorkspace(page, "Funnel Co");
  await stubShopify(page);
  const storeId = await insertStore(db, ws, `funnel-${Date.now()}.myshopify.com`, ["read_orders", "read_products", "write_pixels", "read_customer_events"]);
  await db.query("UPDATE stores SET pixel_installed = true, pixel_installed_at = '2026-09-01T00:00:00Z' WHERE id = $1", [storeId]);
  // Six visits on 21 Sep (four on phones, two on computers; three from Google, one typed in), two the day before.
  const visits: Array<[string, string, number, string | null, string | null]> = [
    [DAY, "v1", 4, "mobile", "google"],
    [DAY, "v2", 2, "mobile", "google"],
    [DAY, "v3", 1, "mobile", "google"],
    [DAY, "v4", 0, "mobile", "direct"],
    [DAY, "v5", 3, "desktop", null],
    [DAY, "v6", 1, "desktop", null],
    ["2026-09-20", "p1", 4, "desktop", null],
    ["2026-09-20", "p2", 0, "mobile", null],
  ];
  for (const [day, visitor, step, device, source] of visits) {
    await db.query(
      `INSERT INTO funnel_visits (workspace_id, store_id, day, visitor, furthest_step, device, country, source, entry_section, entry_path, entered_at, exited_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'AU', $7, 'home', '/', ($3 || 'T10:00:00Z')::timestamp, ($3 || 'T10:20:00Z')::timestamp)`,
      [ws, storeId, day, visitor, step, device, source],
    );
  }
  // v1 viewed the shirt, added it on its page, took it to checkout and bought it (1 + 2 + 8 + 16).
  await db.query(`INSERT INTO funnel_product_visits (workspace_id, store_id, day, visitor, handle, steps) VALUES ($1, $2, $3, 'v1', 'linen-shirt', 27), ($1, $2, $3, 'v2', 'linen-shirt', 3), ($1, $2, $3, 'v3', 'linen-shirt', 1)`, [ws, storeId, DAY]);
  await db.query(`INSERT INTO products (id, workspace_id, store_id, shopify_id, handle, title, shopify_updated_at) VALUES (gen_random_uuid()::text, $1, $2, '501', 'linen-shirt', 'Linen Shirt', now())`, [ws, storeId]);

  await page.goto(`/funnel?preset=custom&from=${DAY}&to=${DAY}`);
  await expect(page.getByRole("heading", { name: "Shopping Funnel", level: 1 })).toBeVisible();
  await expect(page.getByTestId("funnel-kpi-visited")).toContainText("from 6 browsers");
  // 6 visits against 2: +200%.
  await expect(page.getByTestId("funnel-kpi-visited")).toContainText("200%");
  await expect(page.getByTestId("funnel-kpi-conversion")).toContainText("16.7%");
  // Visits per stage 6, 5, 3, 2, 1: product discovery → added to cart lost the most (2).
  await expect(page.getByTestId("funnel-transition-viewed_product")).toContainText("Largest drop-off");
  await expect(page.getByTestId("funnel-products")).toContainText("Linen Shirt");
  // The product's checkouts and purchases by tracked visits.
  await expect(page.getByTestId("funnel-products-table")).toContainText("Checkout (visits)");
  await expect(page.getByTestId("funnel-products-table")).toContainText("1 bought");

  // Visits by where they came from; the two with no recorded arrival say so.
  await page.getByRole("tab", { name: "Traffic source" }).click();
  const sources = page.getByTestId("funnel-segments-source");
  await expect(sources).toContainText("Google");
  await expect(sources).toContainText("Direct");
  await expect(sources).toContainText("Not recorded");

  // A stage explains itself, and closes on Escape.
  await page.getByTestId("funnel-stage-added_to_cart").click();
  const detail = page.getByTestId("funnel-stage-detail");
  await expect(detail).toContainText("What this stage means");
  await expect(detail).toContainText("How it's calculated");
  await expect(detail).toContainText("Of the 5 visits at the stage before, 60% went on to add to cart");
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);

  // The filter narrows the whole page, and the address keeps it.
  await page.getByTestId("funnel-filter-device").selectOption("desktop");
  await expect(page).toHaveURL(/device=desktop/);
  await expect(page.getByTestId("funnel-filter-banner")).toContainText("Desktop");
  await expect(page.getByTestId("funnel-kpi-visited")).toContainText("from 2 browsers");
  await expect(page.getByTestId("funnel-download-csv")).toHaveAttribute("href", /section=funnel.*device=desktop/);
  await page.getByTestId("funnel-clear-filter").click();
  await expect(page.getByTestId("funnel-filter-banner")).toHaveCount(0);
  await page.getByTestId("funnel-filter-source").selectOption("google");
  await expect(page.getByTestId("funnel-filter-banner")).toContainText("Google");
  await expect(page.getByTestId("funnel-kpi-visited")).toContainText("from 3 browsers");
  await page.getByTestId("funnel-clear-filter").click();

  // The checklist is kept for the store.
  await page.getByTestId("funnel-action-cart.usability").check();
  await expect(page.getByTestId("funnel-actions-count")).toHaveText("1 of 15 done");
  await page.reload();
  await expect(page.getByTestId("funnel-action-cart.usability")).toBeChecked();

  // The dashboard's old link opens the page, with the dates.
  await page.goto(`/dashboard?preset=custom&from=${DAY}&to=${DAY}&view=shoppers`);
  await expect(page).toHaveURL(/\/funnel\?.*from=2026-09-21/);
  await expect(page.getByTestId("funnel-kpi-visited")).toContainText("from 6 browsers");
});
