import { expect, test } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertStore, signUp, uniqueEmail } from "./helpers";

/**
 * Settings → Costs: the owner adds a cost, sees it in the list and in this month's total, marks the
 * list complete, and the dashboard's profit card counts it as "Your costs". Shopify's profit report
 * can't run in e2e (no read_reports), so the card says why it isn't net profit instead of giving one.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.DATABASE_URL });
test.afterAll(() => db.end());

/** Today (UTC, the store's zone here). */
const today = () => new Date().toISOString().slice(0, 10);

test("the owner keeps the store's costs, and the dashboard counts them without calling it net profit", async ({ page }) => {
  await signUp(page, uniqueEmail("costs"));
  const ws = await createWorkspace(page, "Costs Co");
  const storeId = await insertStore(db, ws, `costs-${Date.now()}.myshopify.com`);
  // A day of sales this month, so the dashboard has its sales panels.
  await db.query(
    `INSERT INTO daily_store_metrics (workspace_id, store_id, day, gross_sales, discounts, refunds, shipping, taxes, total_sales, orders, units, orders_with_customer, returning_customer_orders, refunded_orders)
     VALUES ($1, $2, $3, 500, 0, 0, 0, 0, 500, 2, 2, 0, 0, 0)`,
    [ws, storeId, today()],
  );

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

  // The dashboard's profit card takes the cost off; Shopify's product costs aren't known here, so it isn't net profit.
  await page.goto("/dashboard?preset=mtd");
  const profit = page.getByTestId("home-profit");
  await expect(page.getByTestId("profit-what")).toContainText("your costs");
  await expect(page.getByTestId("profit-left")).toHaveText("$380.00");
  await expect(page.getByTestId("profit-note")).toContainText("Not net profit");
  await expect(page.getByTestId("profit-note")).toContainText("Shopify's profit report");
  // The legend's row (the ring's slice carries the same name as its <title>).
  await expect(profit.getByRole("listitem").filter({ hasText: /^Your costs/ })).toContainText("$120.00");

  // Removed: it stops counting.
  await page.goto("/settings/costs");
  await page.getByRole("button", { name: "Remove Label printer" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("No costs yet")).toBeVisible();
});
