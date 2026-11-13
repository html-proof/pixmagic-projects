import { expect, test } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertStore, signUp, uniqueEmail } from "./helpers";

/**
 * Profit & Loss (/profit): its four figures and its Overview (what stands out, the statement against
 * the dates compared with); then the owner adds an expense, sees it in the expenses table and in the
 * statement's own row (the Detailed Table), copies it, removes both at once, adds a recurring cost
 * and a category of the store's own, and the statement follows each change.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.OWNER_DATABASE_URL });
test.afterAll(() => db.end());

/** Today (UTC, the store's zone here). */
const today = () => new Date().toISOString().slice(0, 10);

test("the owner manages the store's expenses on Profit & Loss, and the statement follows", async ({ page }) => {
  await signUp(page, uniqueEmail("profit"));
  const ws = await createWorkspace(page, "Profit Co");
  const storeId = await insertStore(db, ws, `profit-${Date.now()}.myshopify.com`);
  // Its whole order history imported: every day's sales are known.
  await db.query("UPDATE stores SET orders_history_from = to_timestamp(0) WHERE id = $1", [storeId]);
  // A day of sales today: $500 with $50 of tax, two orders.
  await db.query(
    `INSERT INTO daily_store_metrics (workspace_id, store_id, day, gross_sales, discounts, refunds, shipping, taxes, total_sales, orders, units, orders_with_customer, returning_customer_orders, refunded_orders)
     VALUES ($1, $2, $3, 500, 0, 0, 0, 50, 550, 2, 3, 0, 0, 0)`,
    [ws, storeId, today()],
  );

  const tab = (id: "overview" | "revenue" | "expenses" | "analysis" | "table") => page.getByTestId(`pl-tab-${id}`).click();
  /** The statement's own row for a category, in the Detailed Table. */
  const packaging = page.getByTestId("pl-row-cat-packaging");

  await page.goto("/profit?preset=today");
  await expect(page.getByRole("heading", { name: "Profit & Loss", exact: true })).toBeVisible();
  await expect(page.getByTestId("pl-card-total-sales-value")).toHaveText("$550.00");
  await expect(page.getByTestId("pl-card-revenue-value")).toHaveText("$500.00");
  // No costs list marked complete yet: profit isn't given, and the page says what is missing.
  await expect(page.getByTestId("pl-card-profit-value")).toHaveText("Missing data");
  await expect(page.getByTestId("pl-complete")).toBeVisible();
  // The Overview: what stands out, and the statement against the dates compared with.
  await expect(page.getByTestId("pl-tab-overview")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("pl-insight-ads")).toContainText("No advertising spend in this period.");
  await expect(page.getByTestId("pl-sum-total_sales").getByTestId("pl-sum-now")).toHaveText("$550.00");
  await expect(page.getByTestId("pl-sum-taxes").getByTestId("pl-sum-now")).toHaveText("$50.00");
  await expect(page.getByTestId("pl-sum-orders").getByTestId("pl-sum-now")).toHaveText("2");
  // "View Details" opens the Detailed Table: the statement period by period, then the day-by-day sheet.
  await page.getByTestId("pl-view-details").click();
  await expect(page).toHaveURL(/tab=table/);
  await expect(page.getByTestId("pl-row-revenue").getByTestId("pl-total-cell")).toHaveText("$500.00");
  await expect(page.getByTestId("sheet-row-orders").getByTestId("sheet-total-cell")).toHaveText("2");

  await tab("expenses");
  await expect(page.getByTestId("pl-expenses-empty")).toBeVisible();

  // A one-time variable expense today.
  await page.getByTestId("pl-add-expense").click();
  const form = page.getByTestId("pl-expense-form");
  await form.getByLabel("Expense name").fill("Packing tape");
  await form.getByRole("button", { name: "Variable costs" }).click();
  await form.getByLabel("Category").selectOption("packaging");
  await form.getByLabel("Amount (USD)").fill("25");
  await form.getByLabel("Payment frequency").selectOption("once");
  await form.getByLabel("Expense date").fill(today());
  await form.getByTestId("pl-expense-save").click();
  await expect(form).toBeHidden();
  const tape = page.getByTestId("pl-expense-row").filter({ hasText: "Packing tape" });
  await expect(tape).toContainText("$25.00");
  await tab("table");
  await expect(packaging.getByTestId("pl-total-cell")).toHaveText("$25.00");
  await tab("expenses");

  // Copied: a second one, then both removed at once.
  await tape.getByTestId("pl-expense-duplicate").click();
  await expect(form.getByLabel("Expense name")).toHaveValue("Packing tape (copy)");
  await form.getByTestId("pl-expense-save").click();
  await expect(form).toBeHidden();
  await tab("table");
  await expect(packaging.getByTestId("pl-total-cell")).toHaveText("$50.00");
  await tab("expenses");
  await page.getByRole("checkbox", { name: "Select every expense shown" }).check();
  await page.getByTestId("pl-expenses-bulk-delete").click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByTestId("pl-expenses-empty")).toBeVisible();
  await tab("table");
  await expect(page.getByTestId("pl-statement")).toBeVisible();
  await expect(packaging).toHaveCount(0);
  await tab("expenses");

  // A category of the store's own, and a monthly cost in it: it shows among the recurring expenses.
  await page.getByTestId("pl-categories-open").click();
  await page.getByTestId("pl-category-add").click();
  await page.getByTestId("pl-category-name").fill("Warehouse");
  await page.getByRole("dialog").getByRole("button", { name: "Add category" }).click();
  await expect(page.getByTestId("pl-category-row")).toContainText("Warehouse");
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

  await page.getByTestId("pl-add-expense").click();
  await form.getByLabel("Expense name").fill("Storage unit");
  await form.getByLabel("Category").selectOption({ label: "Warehouse" });
  await form.getByLabel("Amount (USD)").fill("300");
  await form.getByLabel("First payment (start date)").fill(today());
  await form.getByTestId("pl-expense-save").click();
  await expect(form).toBeHidden();
  const storage = page.getByTestId("pl-recurring-row").filter({ hasText: "Storage unit" });
  await expect(storage).toContainText("$300.00 every month");
  await expect(storage).toContainText("Active");
  await tab("table");
  await expect(page.locator('[data-testid^="pl-row-cat-custom:"]')).toHaveCount(1);
});
