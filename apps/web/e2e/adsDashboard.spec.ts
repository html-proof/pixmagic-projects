import { expect, test } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertAdConnection, insertStore, signUp, uniqueEmail } from "./helpers";

/**
 * The dashboard's Ads panel with a Meta ad account whose days are stored: the store's own sales set
 * against the spend (sales per unit of spend, cost per order, with the change on whole dates), the
 * orders Shopify's visit record credits to Meta's ads beside Meta's own purchases, and one figure
 * drawn over the days. Meta itself can't run in e2e: the live report says so and nothing else waits on it.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.DATABASE_URL });
test.afterAll(() => db.end());

/** Today (UTC, the store's zone here) plus `n` days, as YYYY-MM-DD. */
const day = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** One paid order of `price` on `on`, as the pipeline stores it: the order, its product sale, and the day's totals. */
async function seedOrder(ws: string, storeId: string, id: string, on: string, price: number, traffic: { source: string; medium: string } | null) {
  const order = (
    await db.query(
      `INSERT INTO orders (id, workspace_id, store_id, shopify_id, name, currency, local_day, shopify_created_at, shopify_updated_at, subtotal, total_discounts, total_tax, total_shipping, total_price, sales_updated_at, traffic_source, traffic_medium)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'USD', $5, ($5 || 'T12:00:00')::timestamp, ($5 || 'T12:00:00')::timestamp, $6, 0, 0, 0, $6, now(), $7, $8) RETURNING id`,
      [ws, storeId, id, `#${id}`, on, price, traffic?.source ?? null, traffic?.medium ?? null],
    )
  ).rows[0].id as string;
  await db.query(
    `INSERT INTO order_sales (id, workspace_id, store_id, order_id, shopify_id, local_day, happened_at, action_type, line_type, quantity, amount, discount, tax)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, ($5 || 'T12:00:00')::timestamp, 'order', 'product', 1, $6, 0, 0)`,
    [ws, storeId, order, `${id}-0`, on, price],
  );
  await db.query(
    `INSERT INTO daily_store_metrics (workspace_id, store_id, day, gross_sales, discounts, refunds, shipping, taxes, total_sales, orders, units, orders_with_customer, returning_customer_orders, refunded_orders)
     VALUES ($1, $2, $3, $4, 0, 0, 0, 0, $4, 1, 1, 0, 0, 0)`,
    [ws, storeId, on, price],
  );
}

test("the Ads panel sets the store's sales against the spend, credits orders by Shopify's visit record, and draws a figure over the days", async ({ page }) => {
  const email = uniqueEmail("ads-panel");
  await signUp(page, email);
  const ws = await createWorkspace(page, "Ads Panel Co");
  const storeId = await insertStore(db, ws, `ads-panel-${Date.now()}.myshopify.com`);
  const conn = await insertAdConnection(db, { workspaceId: ws, storeId, provider: "meta", accountId: "act_1", accountName: "Shop ads", historyFrom: day(-89), syncedThrough: day(0), lastSyncedAt: new Date() });
  // $10 a day on ads for the last two weeks, each day one purchase Meta credits to them worth $40.
  for (let n = -14; n <= -1; n++) {
    await db.query(
      `INSERT INTO ad_campaign_daily (workspace_id, store_id, connection_id, provider, account_id, campaign_id, campaign_name, day, spend, impressions, clicks, link_clicks, conversions, conversion_value, purchases, purchase_value, leads, currency, updated_at)
       VALUES ($1, $2, $3, 'meta', 'act_1', '1', 'Spring', $4, 10, 1000, 30, 20, 1, 40, 1, 40, 0, 'USD', now())`,
      [ws, storeId, conn, day(n)],
    );
  }
  // The dates picked (the last seven whole days): an order from a Facebook ad and a direct one. The seven before: one direct order.
  await seedOrder(ws, storeId, "F1", day(-5), 100, { source: "facebook", medium: "paid" });
  await seedOrder(ws, storeId, "D1", day(-3), 60, { source: "direct", medium: "direct" });
  await seedOrder(ws, storeId, "P1", day(-14), 50, null);

  await page.goto(`/dashboard?preset=custom&from=${day(-7)}&to=${day(-1)}&view=ads`);
  const vs = page.getByTestId("ads-vs-sales");
  await expect(vs).toBeVisible();
  // $160 of sales for $70 of ads: 2.29 per unit of spend; $35 of ads per order. Before: $50 for $70, $70 per order.
  await expect(vs).toContainText("$160.00");
  await expect(vs).toContainText("2.29×");
  await expect(vs).toContainText("$35.00");
  await expect(vs).toContainText("before: 0.71×");
  await expect(vs).toContainText("▼ 50% vs");
  await expect(vs).toContainText("before: $70.00");
  // Shopify credits the order from the Facebook ad to Meta: 1 order, $100, 1.43 per unit of Meta's spend; Meta's own count says 7 purchases worth $280.
  const meta = page.getByTestId("ads-attribution-meta");
  await expect(meta).toContainText("$100.00");
  await expect(meta).toContainText("1.43×");
  await expect(meta).toContainText("$280.00");
  // One figure over the days, by platform, picked from the list.
  const trend = page.getByTestId("ads-trend");
  await expect(trend).toHaveAttribute("data-metric", "spend");
  await page.getByRole("combobox", { name: "Figure" }).selectOption("roas");
  await expect(trend).toHaveAttribute("data-metric", "roas");
  await expect(trend.locator("[aria-label*='ROAS (platforms\\' own) per day by platform']")).toBeVisible();
  // Meta itself can't be asked here (no Meta app in e2e): the live report says it couldn't be loaded instead of breaking the panel.
  await expect(page.getByRole("region", { name: "Meta Ads report" })).toContainText("load the Meta Ads report");
});
