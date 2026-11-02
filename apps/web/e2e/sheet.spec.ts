import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertAdConnection, insertStore, signUp, uniqueEmail } from "./helpers";

/**
 * The Profit sheet (/sheet): every figure a column per day, the days added up first; a business
 * event marked with the pencil on a day shows under the days it runs on, narrows the sheet to its
 * days and sets them against the others; weeks add the days up; the download is the sheet as on
 * screen; the event comes off again; and the page fits a phone (the sheet scrolls, not the page).
 */

const db = new pg.Pool({ connectionString: E2E_ENV.OWNER_DATABASE_URL });
test.afterAll(() => db.end());

/** Today (UTC, the store's zone here) plus `n` days, as YYYY-MM-DD. */
const day = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Six days, the k-th (1…6) with k orders, all from new customers: k × $100 net sales, k × $110
 * total sales ($10 tax), 2k items; 100 visits a day; $50 a day on Meta.
 */
async function seed(ws: string, storeId: string) {
  await db.query("UPDATE stores SET pixel_installed = true, pixel_installed_at = $2::timestamp, last_synced_at = now(), orders_history_from = 'epoch' WHERE id = $1", [storeId, `${day(-30)}T00:00:00`]);
  for (let k = 1; k <= 6; k++) {
    const on = day(k - 7);
    await db.query(
      `INSERT INTO daily_store_metrics (workspace_id, store_id, day, gross_sales, discounts, refunds, shipping, taxes, total_sales, orders, order_value, units, orders_with_customer, returning_customer_orders, refunded_orders)
       VALUES ($1, $2, $3, $4, 0, 0, 0, $5, $6, $7, $4, $8, $7, 0, 0)`,
      [ws, storeId, on, 100 * k, 10 * k, 110 * k, k, 2 * k],
    );
    await db.query(
      `INSERT INTO funnel_visits (workspace_id, store_id, day, visitor, furthest_step, entered_at)
       SELECT $1, $2, $3, 'v' || n, 1, ($3 || 'T10:00:00')::timestamp FROM generate_series(1, 100) AS n`,
      [ws, storeId, on],
    );
  }
  const conn = await insertAdConnection(db, { workspaceId: ws, storeId, provider: "meta", accountId: "act_1", accountName: "Shop ads", currency: "USD", historyFrom: day(-89), syncedThrough: day(0), lastSyncedAt: new Date() });
  for (let n = -6; n <= -1; n++) {
    await db.query(
      `INSERT INTO ad_campaign_daily (workspace_id, store_id, connection_id, provider, account_id, campaign_id, campaign_name, day, spend, impressions, clicks, link_clicks, conversions, conversion_value, purchases, purchase_value, leads, currency, updated_at)
       VALUES ($1, $2, $3, 'meta', 'act_1', '1', 'Spring', $4, 50, 1000, 30, 20, 1, 40, 1, 40, 0, 'USD', now())`,
      [ws, storeId, conn, day(n)],
    );
  }
}

const totalOf = (page: Page, row: string) => page.getByTestId(`sheet-row-${row}`).getByTestId("sheet-total-cell");

test("lays the store out day by day, and marks, filters and compares business events", async ({ page }) => {
  const email = uniqueEmail("sheet");
  await signUp(page, email);
  const ws = await createWorkspace(page, "Sheet Co");
  const storeId = await insertStore(db, ws, `sheet-${Date.now()}.myshopify.com`, ["read_orders", "read_products", "read_customers", "write_pixels", "read_customer_events"]);
  await seed(ws, storeId);

  await page.goto(`/sheet?preset=custom&from=${day(-6)}&to=${day(-1)}`);
  await expect(page.getByRole("heading", { name: "Profit sheet" })).toBeVisible();
  const cols = page.getByTestId("sheet-col");
  // Six days: a column each (days are the columns for dates this short), the six added up first.
  await expect(cols).toHaveCount(6);
  await expect(totalOf(page, "orders")).toHaveText("21");
  await expect(totalOf(page, "total_sales")).toHaveText("$2,310.00");
  await expect(totalOf(page, "sales_ex_tax")).toHaveText("$2,100.00");
  await expect(totalOf(page, "tax_rate")).toHaveText("10.00%");
  await expect(totalOf(page, "new_customer_share")).toHaveText("100.00%");
  await expect(totalOf(page, "visits")).toHaveText("600");
  await expect(totalOf(page, "conversion_rate")).toHaveText("3.50%");
  await expect(totalOf(page, "spend_meta")).toHaveText("$300.00");
  // $300 of ads on $2,100 of net sales.
  await expect(totalOf(page, "ads_share")).toHaveText("14.29%");
  await expect(totalOf(page, "mer")).toHaveText("7.00×");
  await expect(totalOf(page, "after_ads")).toHaveText("$1,800.00");
  await expect(page.getByTestId("sheet-no-events")).toBeVisible();

  // Profit and loss: revenue on the sheet's own rows; no costs list marked complete yet, so no
  // operating profit, and the section above says what is missing rather than show a figure.
  await expect(totalOf(page, "revenue")).toHaveText("$2,100.00");
  await expect(totalOf(page, "operating_profit")).toHaveText("—");
  await expect(page.getByTestId("profit-daily")).toBeVisible();
  await expect(page.getByTestId("profit-day-operating")).toContainText("Missing data");
  await expect(page.getByTestId("profit-missing")).toContainText("Your costs list isn't marked complete");
  await expect(page.getByTestId("profit-cash-flow")).toContainText("Not connected");

  // A sale over the last two days, marked with the pencil on the first of them.
  await page.locator(`[data-testid="sheet-col"][data-key="${day(-2)}"]`).getByTestId("sheet-add-event").click();
  const form = page.getByTestId("event-form");
  await expect(form.getByTestId("event-from")).toHaveValue(day(-2));
  await form.getByTestId("event-title").fill("Spring sale");
  await form.getByTestId("event-to").fill(day(-1));
  await form.getByTestId("event-save").click();
  await expect(form).toBeHidden();
  await expect(page.getByTestId("sheet-event-chip")).toHaveCount(2);
  await expect(page.getByTestId("sheet-event-list")).toContainText("Spring sale");
  // Its days ($500 and $600) against the four others ($100 to $400): $550 a day against $250.
  const comparison = page.getByTestId("sheet-event-comparison");
  await expect(comparison).toContainText("$550.00");
  await expect(comparison).toContainText("$250.00");
  await expect(comparison).toContainText("120%");

  // Only the days with an event: two columns, and the total is theirs.
  await page.getByTestId("sheet-events").selectOption("with");
  await expect(cols).toHaveCount(2);
  await expect(page.getByTestId("sheet-total-head")).toContainText("2 days");
  await expect(totalOf(page, "orders")).toHaveText("11");
  await expect(page).toHaveURL(/events=with/);
  // And the days without one.
  await page.getByTestId("sheet-events").selectOption("without");
  await expect(cols).toHaveCount(4);
  await expect(totalOf(page, "orders")).toHaveText("10");
  await page.getByTestId("sheet-clear-filter").click();
  await expect(cols).toHaveCount(6);

  // One weekday only: the day the sale ended on.
  const weekday = (new Date(`${day(-1)}T00:00:00Z`).getUTCDay() + 6) % 7;
  await page.getByTestId("sheet-days").selectOption("pick");
  await page.getByTestId("sheet-weekdays").getByRole("button").nth(weekday).click();
  await expect(cols).toHaveCount(1);
  await expect(totalOf(page, "orders")).toHaveText("6");
  await page.getByTestId("sheet-clear-filter").click();

  // Weeks: the same six days, added up by Monday-to-Sunday weeks.
  await page.getByTestId("sheet-grain").getByRole("button", { name: "Weeks" }).click();
  await expect(page).toHaveURL(/by=week/);
  expect(await cols.count()).toBeLessThanOrEqual(2);
  await expect(totalOf(page, "orders")).toHaveText("21");
  await expect(page.getByTestId("sheet-row-ads_share_3d")).toHaveCount(0);

  // The download is the sheet on screen.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("sheet-download-csv").click()]);
  const csv = await readFile((await download.path())!, "utf8");
  expect(csv).toContain("Spring sale");
  expect(csv).toMatch(/Orders,21,/);
  expect(csv).toMatch(/Ads as share of sales,14\.29%,/);

  // The event comes off again.
  await page.getByTestId("sheet-grain").getByRole("button", { name: "Days" }).click();
  await page.getByTestId("sheet-event-chip").first().click();
  await expect(page.getByTestId("event-title")).toHaveValue("Spring sale");
  await page.getByTestId("event-remove").click();
  await page.getByRole("dialog", { name: "Remove this event?" }).getByRole("button", { name: "Remove" }).click();
  await expect(page.getByTestId("sheet-event-chip")).toHaveCount(0);
  await expect(page.getByTestId("sheet-no-events")).toBeVisible();

  // On a phone the sheet scrolls sideways inside its card; the page itself doesn't.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(totalOf(page, "orders")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
