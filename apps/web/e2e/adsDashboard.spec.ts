import { expect, test } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertAdConnection, insertStore, signUp, uniqueEmail } from "./helpers";

/**
 * The Advertising area with a Meta ad account whose days are stored: the dashboard's old ads panel
 * address opens it with its dates; the overview sets the store's own sales against the spend (sales
 * per unit of spend, cost per order, with the change on whole dates) and compares the spend with the
 * week before; the Meta Ads page draws one figure over the days and credits orders by Shopify's
 * visit record beside Meta's own purchases; the campaign comparison and the reports show the same
 * campaign. Meta itself can't run in e2e: the live report says so and nothing else waits on it.
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

test("the Advertising area sets the store's sales against the spend, compares it with the week before, and shows each platform, campaign and report", async ({ page }) => {
  const email = uniqueEmail("ads-panel");
  await signUp(page, email);
  const ws = await createWorkspace(page, "Ads Panel Co");
  const storeId = await insertStore(db, ws, `ads-panel-${Date.now()}.myshopify.com`);
  const conn = await insertAdConnection(db, { workspaceId: ws, storeId, provider: "meta", accountId: "act_1", accountName: "Shop ads", historyFrom: day(-89), syncedThrough: day(0), lastSyncedAt: new Date() });
  // $10 a day on ads for the last two weeks, each day one purchase Meta credits to them worth $40.
  for (let n = -14; n <= -1; n++) {
    await db.query(
      `INSERT INTO ad_campaign_daily (workspace_id, store_id, connection_id, provider, account_id, campaign_id, campaign_name, day, spend, impressions, clicks, link_clicks, conversions, conversion_value, purchases, purchase_value, leads, currency, updated_at)
       VALUES ($1, $2, $3, 'meta', 'act_1', '1', 'Spring', $4, $5, 1000, 30, 20, 1, 40, 1, 40, 0, 'USD', now())`,
      // The week picked spends $10 a day, the week before $5: twice as much now.
      [ws, storeId, conn, day(n), n >= -7 ? 10 : 5],
    );
  }
  // As the last sync read it at Meta: running.
  await db.query(
    `INSERT INTO ad_campaigns (workspace_id, store_id, connection_id, provider, account_id, campaign_id, name, status, checked_at) VALUES ($1, $2, $3, 'meta', 'act_1', '1', 'Spring', 'ACTIVE', now())`,
    [ws, storeId, conn],
  );
  // The dates picked (the last seven whole days): an order from a Facebook ad and a direct one. The seven before: one direct order.
  await seedOrder(ws, storeId, "F1", day(-5), 100, { source: "facebook", medium: "paid" });
  await seedOrder(ws, storeId, "D1", day(-3), 60, { source: "direct", medium: "direct" });
  await seedOrder(ws, storeId, "P1", day(-14), 50, null);

  // The dashboard's old ads panel opens the Advertising overview, with the dates kept.
  const dates = `preset=custom&from=${day(-7)}&to=${day(-1)}`;
  await page.goto(`/dashboard?${dates}&view=ads`);
  await expect(page).toHaveURL(`/advertising?${dates}`);
  const nav = page.getByRole("complementary").getByRole("navigation", { name: "App" });
  await expect(nav.getByRole("link", { name: "Advertising" })).toHaveAttribute("aria-current", "page");

  // Spend against the week before: $70 now, $35 then, up 100%, and what was compared.
  const spend = page.getByTestId("kpi-spend");
  await expect(spend.getByTestId("kpi-spend-value")).toHaveText("$70.00");
  await expect(spend).toContainText("▲ 100%");
  await expect(spend.getByTestId("kpi-spend-compared")).toContainText("$35.00");
  // Meta's own purchases, named as Meta's count: 7 both weeks.
  await expect(page.getByTestId("kpi-purchases")).toContainText("Platforms' own count");
  await expect(page.getByTestId("kpi-purchases")).toContainText("■ 0%");

  // $160 of sales for $70 of ads: 2.29 per unit of spend; $35 of ads per order. Before: $50 for $35, $35 per order.
  const vs = page.getByTestId("ads-vs-sales");
  await expect(vs).toBeVisible();
  await expect(vs).toContainText("$160.00");
  await expect(vs).toContainText("2.29×");
  await expect(vs).toContainText("$35.00");
  await expect(vs).toContainText("before: 1.43×");
  await expect(page.getByTestId("kpi-mer")).toContainText("2.29×");
  // Shopify credits the order from the Facebook ad to Meta: 1 order, $100, 1.43 per unit of Meta's spend; Meta's own count says 7 purchases worth $280.
  const meta = page.getByTestId("ads-attribution-meta");
  await expect(meta).toContainText("$100.00");
  await expect(meta).toContainText("1.43×");
  await expect(meta).toContainText("$280.00");

  // Meta Ads, from the area's menu: one figure over the days, by platform, picked from the list.
  await page.getByRole("navigation", { name: "Advertising" }).getByRole("link", { name: "Meta Ads" }).click();
  await expect(page).toHaveURL(/\/advertising\/meta\?preset=custom/);
  const trend = page.getByTestId("ads-trend");
  await expect(trend).toHaveAttribute("data-metric", "spend");
  await page.getByRole("combobox", { name: "Figure" }).selectOption("roas");
  await expect(trend).toHaveAttribute("data-metric", "roas");
  await expect(trend.locator("[aria-label*='ROAS (platforms\\' own) per day by platform']")).toBeVisible();
  // One platform's spend isn't set against the whole store's sales.
  await expect(page.getByTestId("ads-vs-sales")).toHaveCount(0);
  // Meta itself can't be asked here (no Meta app in e2e): the live report says it couldn't be loaded instead of breaking the page.
  await expect(page.getByRole("region", { name: "Meta Ads report" })).toContainText("load the Meta Ads report");

  // Every campaign side by side, with its change on the same whole days.
  await page.getByRole("navigation", { name: "Advertising" }).getByRole("link", { name: "Campaign comparison" }).click();
  const row = page.getByTestId("campaign-row").filter({ hasText: "Spring" });
  await expect(row).toContainText("$70.00");
  await expect(row).toContainText("Shop ads");
  await expect(row).toContainText("▲ 100%");
  await expect(row).toContainText("Active");
  // Filtered by status and by name: none paused; found by part of its name; back to every campaign.
  await page.getByRole("combobox", { name: "Campaign status" }).selectOption("paused");
  await expect(page.getByTestId("campaign-row")).toHaveCount(0);
  await expect(page.getByTestId("campaign-filter-empty")).toBeVisible();
  await page.getByRole("button", { name: "Show every campaign" }).click();
  await page.getByTestId("campaign-search").fill("spr");
  await expect(page.getByTestId("campaign-row")).toHaveCount(1);
  await page.getByTestId("campaign-search").fill("summer");
  await expect(page.getByTestId("campaign-row")).toHaveCount(0);
  await page.getByTestId("campaign-search").fill("");

  // Reports: the campaigns table as it downloads, and the download for the same question.
  await page.getByRole("navigation", { name: "Advertising" }).getByRole("link", { name: "Reports" }).click();
  await page.getByTestId("report-ads_campaigns").click();
  await expect(page.getByTestId("report-table")).toContainText("Ad campaigns");
  await expect(page.getByTestId("report-row").filter({ hasText: "Spring" })).toContainText("act_1");
  await expect(page.getByTestId("download-ads_campaigns")).toHaveAttribute("href", new RegExp(`section=ads_campaigns&preset=custom&from=${day(-7)}&to=${day(-1)}`));
});

test("the AdSense page splits the earnings by country and device type from AdSense's live report", async ({ page }) => {
  const email = uniqueEmail("ads-adsense");
  await signUp(page, email);
  const ws = await createWorkspace(page, "AdSense Co");
  const storeId = await insertStore(db, ws, `ads-adsense-${Date.now()}.myshopify.com`);
  const conn = await insertAdConnection(db, { workspaceId: ws, storeId, provider: "adsense", accountId: "pub-77", accountName: "Shop site", historyFrom: day(-89), syncedThrough: day(0), lastSyncedAt: new Date() });
  for (let n = -7; n <= -1; n++) {
    await db.query(
      `INSERT INTO adsense_daily (workspace_id, store_id, connection_id, account_id, site, day, earnings, page_views, impressions, clicks, currency, updated_at)
       VALUES ($1, $2, $3, 'pub-77', '', $4, 2, 1000, 800, 4, 'USD', now())`,
      [ws, storeId, conn, day(n)],
    );
  }
  // AdSense itself can't run in e2e: its live report is answered as the API answers it (apps/api/test/ads.test.ts).
  const totals = (earnings: number, pageViews: number) => ({ earnings, pageViews, impressions: pageViews, clicks: 4, pageRpm: (earnings * 1000) / pageViews, perClick: earnings / 4, ctr: 4 / pageViews });
  const asked: string[] = [];
  await page.route(`**/api/workspaces/${ws}/stores/${storeId}/ads/adsense/report?*`, (route) => {
    const level = new URL(route.request().url()).searchParams.get("level") ?? "country";
    asked.push(level);
    const rows =
      level === "country"
        ? [{ id: "AU", name: "Australia", ...totals(10, 5000) }, { id: "NZ", name: "New Zealand", ...totals(4, 2000) }]
        : level === "ad_unit"
          ? [{ id: "ca-pub-77:1001", name: "Article footer", ...totals(14, 7000), adRequests: 8000, coverage: 0.9, viewability: 0.6 }]
          : [{ id: "HighEndMobile", name: "High-end mobile devices", ...totals(14, 7000) }];
    return route.fulfill({
      json: {
        account: { id: conn, accountId: "pub-77", name: "Shop site" },
        today: day(0),
        cached: false,
        report: { level, since: day(-7), until: day(-1), currency: "USD", rows, totals: totals(14, 7000), truncated: false, sites: [] },
      },
    });
  });

  await page.goto(`/advertising/adsense?preset=custom&from=${day(-7)}&to=${day(-1)}`);
  const table = page.getByTestId("adsense-report-table");
  await expect(table).toContainText("Whole account");
  await expect(table).toContainText("Australia");
  await expect(table).toContainText("New Zealand");
  await expect(table).toContainText("$14.00");
  await page.getByTestId("adsense-report-platform").click();
  await expect(table).toContainText("High-end mobile devices");
  await expect(table).not.toContainText("Australia");
  // By ad unit, with AdSense's ad requests, coverage and viewability beside the earnings.
  await page.getByTestId("adsense-report-ad_unit").click();
  await expect(table).toContainText("Article footer");
  await expect(table).toContainText("8,000");
  await expect(table).toContainText("90%");
  await expect(table).toContainText("60%");
  expect(asked).toEqual(expect.arrayContaining(["country", "platform", "ad_unit"]));
});
