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

const db = new pg.Pool({ connectionString: E2E_ENV.OWNER_DATABASE_URL });
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
  // As the last sync read it at Meta: running, on a budget of its own of $10 a day.
  await db.query(
    `INSERT INTO ad_campaigns (workspace_id, store_id, connection_id, provider, account_id, campaign_id, name, status, budget_period, budget_amount, checked_at)
     VALUES ($1, $2, $3, 'meta', 'act_1', '1', 'Spring', 'ACTIVE', 'DAILY', 10, now())`,
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
  // Ads is one of Sales' tabs: the sidebar lights up Sales, the tabs Ads.
  const nav = page.getByRole("complementary").getByRole("navigation", { name: "App" });
  await expect(nav.getByRole("link", { name: "Sales" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("area-tabs-sales").getByRole("link", { name: "Ads", exact: true })).toHaveAttribute("aria-current", "page");

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
  await page.getByRole("navigation", { name: "Ads", exact: true }).getByRole("link", { name: "Meta Ads" }).click();
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
  await page.getByRole("navigation", { name: "Ads", exact: true }).getByRole("link", { name: "Campaign comparison" }).click();
  const row = page.getByTestId("campaign-row").filter({ hasText: "Spring" });
  await expect(row).toContainText("$70.00");
  await expect(row).toContainText("Shop ads");
  await expect(row).toContainText("▲ 100%");
  await expect(row).toContainText("Active");
  // Its budget as the last sync stored it; Meta has no campaign type.
  await expect(row.getByTestId("campaign-budget")).toHaveText("$10.00 a day");
  await expect(row.getByTestId("campaign-type")).toHaveText("—");
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
  await page.getByRole("navigation", { name: "Ads", exact: true }).getByRole("link", { name: "Reports" }).click();
  await page.getByTestId("report-ads_campaigns").click();
  await expect(page.getByTestId("report-table")).toContainText("Ad campaigns");
  await expect(page.getByTestId("report-row").filter({ hasText: "Spring" })).toContainText("act_1");
  await expect(page.getByTestId("download-ads_campaigns")).toHaveAttribute("href", new RegExp(`section=ads_campaigns&preset=custom&from=${day(-7)}&to=${day(-1)}`));

  // The dashboard: paid vs organic from the same orders' last visits, $100 from the tagged Facebook ad and $60 direct.
  await page.goto(`/dashboard?${dates}`);
  const split = page.getByTestId("home-paid-organic");
  await expect(split).toContainText("62.5%");
  await expect(split.getByTestId("traffic-split-paid")).toContainText("$100.00");
  await expect(split.getByTestId("traffic-split-direct")).toContainText("$60.00");
  await expect(split.getByTestId("traffic-split-organic")).toContainText("$0.00");
  await expect(split).toContainText("Last click");
});

test("a real Google Ads account's campaigns show Google's type, delivery and budget as the last sync stored them, on Campaign comparison and Account analytics", async ({ page }) => {
  const email = uniqueEmail("ads-facts");
  await signUp(page, email);
  const ws = await createWorkspace(page, "Ads Facts Co");
  const storeId = await insertStore(db, ws, `ads-facts-${Date.now()}.myshopify.com`);
  const conn = await insertAdConnection(db, { workspaceId: ws, storeId, provider: "google", accountId: "1234567890", accountName: "Real Google", historyFrom: day(-89), syncedThrough: day(0), lastSyncedAt: new Date() });
  for (let n = -7; n <= -1; n++) {
    for (const [id, name, spend] of [["7", "Search - brand", 8], ["8", "PMax launch", 20]] as const) {
      await db.query(
        `INSERT INTO ad_campaign_daily (workspace_id, store_id, connection_id, provider, account_id, campaign_id, campaign_name, day, spend, impressions, clicks, link_clicks, conversions, conversion_value, purchases, purchase_value, leads, currency, updated_at)
         VALUES ($1, $2, $3, 'google', '1234567890', $4, $5, $6, $7, 500, 20, 20, 1, 30, 0, 0, 0, 'USD', now())`,
        [ws, storeId, conn, id, name, day(n), spend],
      );
    }
  }
  // As the last sync stored them: a Search campaign held back by its $10 daily budget, a Performance Max one on a $500 campaign total.
  await db.query(
    `INSERT INTO ad_campaigns (workspace_id, store_id, connection_id, provider, account_id, campaign_id, name, status, channel_type, primary_status, primary_status_reasons, budget_period, budget_amount, checked_at) VALUES
       ($1, $2, $3, 'google', '1234567890', '7', 'Search - brand', 'ENABLED', 'SEARCH', 'LIMITED', ARRAY['BUDGET_CONSTRAINED'], 'DAILY', 10, now()),
       ($1, $2, $3, 'google', '1234567890', '8', 'PMax launch', 'ENABLED', 'PERFORMANCE_MAX', 'ELIGIBLE', ARRAY[]::text[], 'CUSTOM_PERIOD', 500, now())`,
    [ws, storeId, conn],
  );
  const dates = `preset=custom&from=${day(-7)}&to=${day(-1)}`;

  await page.goto(`/advertising/campaigns?${dates}`);
  const search = page.getByTestId("campaign-row").filter({ hasText: "Search - brand" });
  await expect(search.getByTestId("campaign-primary-status")).toHaveText("Limited");
  await expect(search).toContainText("limited by budget");
  await expect(search.getByTestId("campaign-type")).toHaveText("Search");
  await expect(search.getByTestId("campaign-budget")).toHaveText("$10.00 a day");
  const pmax = page.getByTestId("campaign-row").filter({ hasText: "PMax launch" });
  await expect(pmax.getByTestId("campaign-primary-status")).toHaveText("Eligible");
  await expect(pmax.getByTestId("campaign-type")).toHaveText("Performance Max");
  await expect(pmax.getByTestId("campaign-budget")).toHaveText("$500.00 total");

  // Account analytics for the same account: the table's delivery and budget, and spend against today's daily budget ($56 of 7 × $10).
  await page.goto(`/advertising/google/analytics?${dates}&connection=${conn}`);
  const row = page.getByTestId("ga-campaign-row").filter({ hasText: "Search - brand" });
  await expect(row).toContainText("Limited");
  await expect(row).toContainText("limited by budget");
  await expect(row).toContainText("budget $10.00 a day");
  await expect(page.getByTestId("ga-campaign-row").filter({ hasText: "PMax launch" })).toContainText("budget $500.00 total");
  const budgets = page.getByTestId("ga-budget-table");
  await expect(budgets).toContainText("$70.00");
  await expect(budgets).toContainText("80%");
  // A campaign total covers the campaign's own dates: stated, never paced over these.
  await expect(budgets).not.toContainText("PMax launch");
  await expect(page.getByTestId("ga-budget-note")).toContainText("as Google states it now");
});

test("trend charts group by week and month, the week presets run Monday to Sunday, and the Advertising pages print", async ({ page }) => {
  const email = uniqueEmail("ads-periods");
  await signUp(page, email);
  const ws = await createWorkspace(page, "Ads Periods Co");
  const storeId = await insertStore(db, ws, `ads-periods-${Date.now()}.myshopify.com`);
  const conn = await insertAdConnection(db, { workspaceId: ws, storeId, provider: "meta", accountId: "act_2", accountName: "Shop ads", historyFrom: day(-89), syncedThrough: day(0), lastSyncedAt: new Date() });
  for (let n = -34; n <= -1; n++) {
    await db.query(
      `INSERT INTO ad_campaign_daily (workspace_id, store_id, connection_id, provider, account_id, campaign_id, campaign_name, day, spend, impressions, clicks, link_clicks, conversions, conversion_value, purchases, purchase_value, leads, currency, updated_at)
       VALUES ($1, $2, $3, 'meta', 'act_2', '1', 'Autumn', $4, 10, 1000, 30, 20, 1, 40, 1, 40, 0, 'USD', now())`,
      [ws, storeId, conn, day(n)],
    );
  }
  await seedOrder(ws, storeId, "W1", day(-30), 50, null);
  await seedOrder(ws, storeId, "W2", day(-10), 50, null);
  // 34 days always reach into a second calendar month, so weeks and months are both offered.
  const dates = `preset=custom&from=${day(-34)}&to=${day(-1)}`;

  // The Advertising overview's charts: per day, then added up per week (Monday to Sunday) and per month.
  await page.goto(`/advertising?${dates}`);
  const money = page.getByTestId("ads-money-chart");
  await expect(money).toContainText("Ad spend per day");
  const group = page.getByRole("combobox", { name: "Ad charts group" });
  await group.selectOption("week");
  await expect(money).toContainText("Ad spend per week");
  await expect(money).toContainText("Weeks run Monday to Sunday");
  await expect(money.locator("[aria-label*='Ad spend per week']")).toBeVisible();
  await group.selectOption("month");
  await expect(money).toContainText("Ad spend per month");
  // Clicks, reach and store visits are said to be different counts, never added together; the page prints.
  await expect(page.getByTestId("measures-differ")).toContainText("never added together");
  await expect(page.getByTestId("ad-print")).toBeVisible();

  // The Meta Ads page's trend, by week.
  await page.getByRole("navigation", { name: "Ads", exact: true }).getByRole("link", { name: "Meta Ads" }).click();
  await page.getByRole("combobox", { name: "Trend groups" }).selectOption("week");
  await expect(page.getByTestId("ads-trend").locator("[aria-label*='per week by platform']")).toBeVisible();

  // The dashboard's sales chart, by week and by month.
  await page.goto(`/dashboard?${dates}`);
  const sales = page.getByTestId("trend-sales");
  await expect(sales.getByRole("heading")).toContainText("daily");
  const salesGroup = page.getByRole("combobox", { name: "Sales chart groups" });
  await salesGroup.selectOption("week");
  await expect(sales.getByRole("heading")).toContainText("weekly");
  await expect(sales).toContainText("weeks run Monday to Sunday");
  await salesGroup.selectOption("month");
  await expect(sales.getByRole("heading")).toContainText("monthly");

  // Last week and this week: calendar weeks from Monday, in the store's zone (UTC here). A week has
  // nothing to group by week or month, so the chart is back to days.
  await page.getByLabel("Dates").selectOption("lastweek");
  await expect(page).toHaveURL(/preset=lastweek/);
  await expect(sales.getByRole("heading")).toContainText("daily");
  await expect(salesGroup).toHaveCount(0);
  await page.getByLabel("Dates").selectOption("wtd");
  await expect(page).toHaveURL(/preset=wtd/);
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
  // The last seven days always reach past the last month AdSense has finalized: estimated.
  const glance = page.getByTestId("module-d-adsense-glance").getByTestId("adsense-final");
  await expect(glance).toHaveAttribute("data-final", "false");
  await expect(glance).toHaveText("Estimated");
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

test("the AdSense page says a refresh someone asked for is on its way, and offers to try again an account whose syncs fail", async ({ page }) => {
  const email = uniqueEmail("ads-refresh");
  await signUp(page, email);
  const ws = await createWorkspace(page, "AdSense Refresh Co");
  const storeId = await insertStore(db, ws, `ads-refresh-${Date.now()}.myshopify.com`);
  const at = { workspaceId: ws, storeId, provider: "adsense" as const };
  // Synced an hour ago, and someone just pressed Sync data now: its figures are that sync's meanwhile.
  await insertAdConnection(db, { ...at, accountId: "pub-81", accountName: "Shop site", historyFrom: day(-89), syncedThrough: day(0), lastSyncedAt: new Date(Date.now() - 60 * 60_000), syncRequestedAt: new Date() });
  // Its syncs fail, none ever worked, and the last one was tried an hour ago.
  const failing = await insertAdConnection(db, { ...at, accountId: "pub-82", accountName: "Blog site", status: "error", errorCode: "temporary" });
  await db.query(`UPDATE ad_connections SET last_sync_attempt_at = (now() at time zone 'utc') - interval '1 hour' WHERE id = $1`, [failing]);
  // AdSense itself can't run in e2e, and its live report isn't what this is about.
  await page.route(`**/api/workspaces/${ws}/stores/${storeId}/ads/adsense/report?*`, (route) => route.fulfill({ status: 404, json: { error: "Not found" } }));

  await page.goto(`/advertising/adsense?preset=custom&from=${day(-7)}&to=${day(-1)}`);
  await expect(page.getByTestId("ads-refreshing")).toContainText("Synchronizing Shop site (Google AdSense), last synced 1 hour ago");
  const status = (name: string) => page.getByTestId("module-d-adsense-accounts").locator("li").filter({ hasText: name }).getByTestId("ad-account-status");
  await expect(status("Shop site")).toHaveText("Synchronizing · last synced 1 hour ago");
  await expect(status("Blog site")).toHaveText("Sync problem · last tried 1 hour ago");
  // The owner may manage integrations: Sync data now in Settings tries it again.
  await expect(page.getByTestId("ads-try-again").getByRole("link", { name: "Try again in Settings" })).toHaveAttribute("href", "/settings/ads");

  // Someone pressed Sync data now for it too: the page, looking again every 5 s while a refresh runs, says so by itself.
  await db.query(`UPDATE ad_connections SET sync_requested_at = now() at time zone 'utc' WHERE id = $1`, [failing]);
  await expect(status("Blog site")).toHaveText("Synchronizing", { timeout: 15_000 });
  await expect(page.getByTestId("ads-status-notes")).toContainText("Nothing could be read from it yet. Trying again now.");
  await expect(page.getByTestId("ads-try-again")).toHaveCount(0);
});
