import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { signUp, uniqueEmail } from "./helpers";

/**
 * The Total sales breakdown and Custom sales in the browser: the lines add up to Shopify's total
 * sales, switching lines off changes Custom sales at once and never Shopify's figure, a saved and
 * applied calculation shows across the dashboard (named: the month-by-month card measures it too)
 * and comes back on the next visit, and the card fits a phone.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.DATABASE_URL });
test.afterAll(() => db.end());

async function createWorkspace(page: Page, name: string) {
  await page.evaluate(async (n) => {
    const r = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) });
    if (!r.ok) throw new Error(`POST /workspaces failed: ${r.status}`);
  }, name);
}

/**
 * A store with one international order today (UTC): items US$1,000 + US$100 tax, shipping 50 + 5,
 * duties 40 + 4 and a 10 + 1 additional fee, as Shopify's sales records, and the day's totals the
 * pipeline would compute from them.
 */
async function seedStore(email: string) {
  const { rows } = await db.query("SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1", [email]);
  const ws = rows[0].workspace_id as string;
  const shop = `breakdown-${Date.now()}.myshopify.com`;
  const store = (
    await db.query(
      `INSERT INTO stores (id, workspace_id, shop_domain, status, timezone, currency, granted_scopes, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, 'active', 'UTC', 'USD', ARRAY['read_orders'], now(), now()) RETURNING id`,
      [ws, shop],
    )
  ).rows[0].id as string;
  const day = new Date().toISOString().slice(0, 10);
  const order = (
    await db.query(
      `INSERT INTO orders (id, workspace_id, store_id, shopify_id, name, currency, local_day, shopify_created_at, shopify_updated_at, subtotal, total_discounts, total_tax, total_shipping, total_price, sales_updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, '9001', '#9001', 'USD', $3, now() - interval '1 minute', now(), 1000, 0, 110, 50, 1210, now()) RETURNING id`,
      [ws, store, day],
    )
  ).rows[0].id as string;
  const lines: Array<[string, number, number]> = [
    ["product", 1100, 100],
    ["shipping", 55, 5],
    ["duty", 44, 4],
    ["additional_fee", 11, 1],
  ];
  for (const [i, [lineType, amount, tax]] of lines.entries()) {
    await db.query(
      `INSERT INTO order_sales (id, workspace_id, store_id, order_id, shopify_id, local_day, happened_at, action_type, line_type, quantity, amount, discount, tax)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, now() - interval '1 minute', 'order', $6, $7, $8, 0, $9)`,
      [ws, store, order, `9001-${i}`, day, lineType, lineType === "product" ? 1 : null, amount, tax],
    );
  }
  await db.query(
    `INSERT INTO daily_store_metrics (workspace_id, store_id, day, gross_sales, discounts, refunds, shipping, taxes, duties, additional_fees, total_sales, orders, order_value, units)
     VALUES ($1, $2, $3, 1000, 0, 0, 50, 110, 40, 10, 1210, 1, 1000, 1)`,
    [ws, store, day],
  );
}

test("total sales line by line, Custom sales from it, saved and shown across the dashboard", async ({ page }) => {
  const email = uniqueEmail("breakdown");
  await signUp(page, email);
  await createWorkspace(page, "Breakdown Co");
  await seedStore(email);

  await page.goto("/dashboard?preset=today");
  await expect(page.getByTestId("metric-Total sales")).toContainText("$1,210.00");
  await page.getByTestId("metric-Total sales").click();

  const card = page.getByTestId("module-d-sales-breakdown");
  await expect(card).toBeVisible();
  // Every line of Shopify's total sales, and by default Custom sales is the same figure.
  await expect(page.getByTestId("breakdown-line-netSales")).toContainText("$1,000.00");
  await expect(page.getByTestId("breakdown-line-additionalFees")).toContainText("$10.00");
  await expect(page.getByTestId("breakdown-line-duties")).toContainText("$40.00");
  await expect(page.getByTestId("breakdown-line-shipping")).toContainText("$50.00");
  await expect(page.getByTestId("breakdown-line-taxes")).toContainText("$110.00");
  await expect(page.getByTestId("breakdown-shopify-total")).toContainText("$1,210.00");
  await expect(page.getByTestId("breakdown-custom")).toContainText("$1,210.00");
  await expect(page.getByTestId("breakdown-difference")).toContainText("$0.00");

  // Taxes and duties off: Custom sales follows at once; Shopify's figure doesn't move.
  await page.getByRole("switch", { name: "Count Taxes in Custom sales" }).uncheck();
  await page.getByRole("switch", { name: "Count Duties in Custom sales" }).uncheck();
  await expect(page.getByTestId("breakdown-custom")).toContainText("$1,060.00");
  await expect(page.getByTestId("breakdown-shopify-total")).toContainText("$1,210.00");
  await expect(page.getByTestId("breakdown-difference")).toContainText("$150.00");
  await expect(page.getByTestId("breakdown-mode")).toHaveText("Sales excluding tax and duties");
  // An excluded line says so, which a line of nothing doesn't.
  await expect(page.getByTestId("breakdown-line-taxes")).toContainText("Excluded");
  await expect(page.getByTestId("breakdown-line-taxes")).toHaveAttribute("data-included", "no");

  await page.getByRole("button", { name: "View calculation details" }).click();
  await expect(page.getByTestId("breakdown-details")).toContainText("Custom sales (Sales excluding tax and duties) = Net sales $1,000.00 + Additional fees $10.00 + Shipping charges $50.00 = $1,060.00");

  // Apply it: saved for the store and shown, named, beside Shopify's figures.
  await page.getByRole("button", { name: "Apply to dashboard" }).click();
  await expect(card).toContainText('Shown on the dashboard as "Custom sales · Sales excluding tax and duties"');
  await page.getByRole("button", { name: "Close details" }).click();
  await expect(page.getByTestId("tile-custom-sales")).toContainText("Custom sales $1,060.00");
  await expect(page.getByTestId("tile-custom-sales")).toContainText("Sales excluding tax and duties");
  await expect(page.getByTestId("metric-Total sales")).toContainText("$1,210.00");
  await expect(page.getByLabel("Sales chart shows")).toHaveValue("custom");

  // Restored on the next visit, from the store's saved calculation.
  await page.reload();
  await expect(page.getByTestId("tile-custom-sales")).toContainText("$1,060.00");

  // This year month by month measures it too, named, with Shopify's net sales beside it; net
  // sales is one pick away.
  await page.getByTestId("metric-Total sales").click();
  const monthly = page.getByTestId("monthly-sales");
  await expect(monthly.getByLabel("Sales card shows")).toHaveValue("custom");
  await expect(monthly).toContainText("$1,060.00");
  await expect(monthly.getByTestId("custom-measure")).toContainText("Custom sales · Sales excluding tax and duties");
  await expect(monthly.getByTestId("custom-measure")).toContainText("$1,000.00");
  await monthly.getByLabel("Sales card shows").selectOption("net");
  await expect(monthly.getByTestId("custom-measure")).toHaveCount(0);
  await expect(monthly).not.toContainText("$1,060.00");
  await page.getByRole("button", { name: "Close details" }).click();

  // On a phone the card fits the screen: no sideways scrolling.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByTestId("metric-Total sales").click();
  await expect(card).toBeVisible();
  const overflow = await page.getByTestId("detail-panel").evaluate((el) => {
    const scroller = el.querySelector("[data-print-scroll]") as HTMLElement;
    return scroller.scrollWidth - scroller.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);

  // Back to Shopify's own: nothing but Shopify's figures again.
  await page.getByRole("button", { name: "Reset to Shopify default" }).click();
  await expect(page.getByTestId("breakdown-custom")).toContainText("$1,210.00");
  await page.getByRole("button", { name: "Stop showing on dashboard" }).click();
  await expect(card).toContainText("The dashboard shows Shopify's figures only.");
});
