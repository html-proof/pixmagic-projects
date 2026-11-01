import { expect, test } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertStore, signUp, uniqueEmail } from "./helpers";

/**
 * Settings → Costs: the owner adds a cost, sees it in the list and in this month's total, marks the
 * list complete, and the dashboard's profit card counts it as "Your costs". Shopify's profit report
 * can't run in e2e (no read_reports), so the product costs are the items sold at their cost per item;
 * one sold has none, so the card says why it isn't net profit instead of giving one.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.OWNER_DATABASE_URL });
test.afterAll(() => db.end());

/** Today (UTC, the store's zone here). */
const today = () => new Date().toISOString().slice(0, 10);

test("the owner keeps the store's costs, and the dashboard counts them without calling it net profit", async ({ page }) => {
  await signUp(page, uniqueEmail("costs"));
  const ws = await createWorkspace(page, "Costs Co");
  const storeId = await insertStore(db, ws, `costs-${Date.now()}.myshopify.com`);
  // A day of sales this month, so the dashboard has its sales panels: a tee with a cost per item in
  // Shopify ($90) and a custom item without one.
  await db.query(
    `INSERT INTO daily_store_metrics (workspace_id, store_id, day, gross_sales, discounts, refunds, shipping, taxes, total_sales, orders, units, orders_with_customer, returning_customer_orders, refunded_orders)
     VALUES ($1, $2, $3, 500, 0, 0, 0, 0, 500, 2, 2, 0, 0, 0)`,
    [ws, storeId, today()],
  );
  await db.query(
    `INSERT INTO product_variants (id, workspace_id, store_id, product_shopify_id, shopify_id, title, sku, price, unit_cost, inventory_quantity, shopify_updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, 'p1', 'v1', 'Default Title', 'TEE', 300, 90, 10, now() at time zone 'utc')`,
    [ws, storeId],
  );
  for (const [n, amount, variant] of [["1", 300, "v1"], ["2", 200, null]] as const) {
    const { rows } = await db.query(
      `INSERT INTO orders (id, workspace_id, store_id, shopify_id, name, currency, local_day, shopify_created_at, shopify_updated_at, sales_updated_at, subtotal, total_discounts, total_tax, total_shipping, total_price)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'USD', $5, now() at time zone 'utc', now() at time zone 'utc', now() at time zone 'utc', $6, 0, 0, 0, $6) RETURNING id`,
      [ws, storeId, `costs-${n}`, `#${n}`, today(), amount],
    );
    await db.query(
      `INSERT INTO order_line_items (id, workspace_id, store_id, order_id, shopify_id, product_shopify_id, variant_shopify_id, sku, title, quantity, price, discount)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, NULL, 'Item', 1, $7, 0)`,
      [ws, storeId, rows[0].id, `line-${n}`, variant ? "p1" : null, variant, amount],
    );
    await db.query(
      `INSERT INTO order_sales (id, workspace_id, store_id, order_id, shopify_id, local_day, happened_at, action_type, line_type, line_item_shopify_id, quantity, amount, discount, tax)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, now() at time zone 'utc', 'order', 'product', $6, 1, $7, 0, 0)`,
      [ws, storeId, rows[0].id, `sale-${n}`, today(), `line-${n}`, amount],
    );
  }

  await page.goto("/settings/costs");
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Costs" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("No costs yet")).toBeVisible();

  // A cost paid once today: all of it is this month's.
  await page.getByTestId("cost-add").click();
  const form = page.getByTestId("cost-form");
  await form.getByLabel("Name").fill("Label printer");
  await form.getByLabel("What it is for").selectOption("shipping");
  await form.getByLabel("Amount (USD)").fill("120");
  await form.getByLabel("How often").selectOption("once");
  await form.getByLabel("Paid on").fill(today());
  await form.getByRole("button", { name: "Add" }).click();
  const row = page.getByTestId("cost-row").filter({ hasText: "Label printer" });
  await expect(row).toContainText("$120.00 once");
  await expect(row).toContainText("Shipping and packaging");
  await expect(page.getByTestId("costs-this-month")).toContainText("$120.00");

  // The list holds every cost from the first of this month.
  const complete = page.getByTestId("costs-complete");
  await expect(complete).toContainText("Not marked complete");
  await complete.getByRole("checkbox").check();
  await complete.getByRole("button", { name: "Save" }).click();
  await expect(complete).toContainText("Marked complete from");

  // The dashboard's profit card takes the cost off, and the product costs: Shopify's profit report
  // can't run here, so they are the items sold at their cost per item. The custom item has none, so
  // it isn't net profit.
  await page.goto("/dashboard?preset=mtd");
  const profit = page.getByTestId("home-profit");
  await expect(page.getByTestId("profit-what")).toContainText("product costs and your costs");
  await expect(page.getByTestId("profit-left")).toHaveText("$290.00");
  await expect(page.getByTestId("profit-note")).toContainText("Not net profit");
  await expect(page.getByTestId("profit-note")).toContainText("$200.00 of sales had no cost recorded in Shopify");
  await expect(page.getByTestId("profit-note")).toContainText("their cost per item in Shopify");
  // The legend's rows (the ring's slice carries the same name as its <title>).
  await expect(profit.getByRole("listitem").filter({ hasText: /^Your costs/ })).toContainText("$120.00");
  await expect(profit.getByRole("listitem").filter({ hasText: /^Product costs/ })).toContainText("$90.00");
  // Expenses breakdown: the same product costs, no longer "Not available".
  const breakdown = page.getByTestId("home-expenses");
  await expect(breakdown.getByRole("listitem").filter({ hasText: /^Product costs/ })).toContainText("$90.00");
  await expect(breakdown.getByTestId("expenses-note")).toContainText("their cost per item in Shopify");

  // Removed: it stops counting.
  await page.goto("/settings/costs");
  await page.getByRole("button", { name: "Remove Label printer" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("No costs yet")).toBeVisible();
});
