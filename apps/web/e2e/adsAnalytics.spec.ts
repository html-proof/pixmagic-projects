import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertStore, signUp, uniqueEmail } from "./helpers";

/**
 * The Google Ads report on /advertising/google and the analytics page's downloads, on the Google Ads
 * demo (docs/ads-demo.md): its figures are generated from a seed, so nothing here reaches Google, and
 * e2e/server.env already turns the demo on (GOOGLE_ADS_DEMO_ENABLED). Each test connects its own demo
 * the way "Try demo" does (POST …/ads/google/demo/connect; adsDemo.spec.ts drives the dialog itself)
 * and waits for the local server's queue to store its first days. Covered: each campaign's delivery as
 * Google would rate it (the demo's "Search Advertising" is limited by its daily budget), a campaign
 * opened to its ad groups and an ad group to its ads (kept in the address bar), a Performance Max
 * campaign to its asset groups, also from a link; keywords and search terms for the whole account,
 * one campaign and one ad group; and the CSV files, which say on their first row that they are
 * simulated. Meta's report needs a Meta stand-in and isn't covered here.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.DATABASE_URL });
test.afterAll(() => db.end());

/** The demo's default seed (DEMO_DEFAULT_SEED in @app/shared/adsDemo): the same figures every run, so a failure can be replayed. */
const SEED = 20261020;

/**
 * A new owner with a workspace and a store (UTC, USD), the Google Ads demo connected to it, and its
 * first sync stored; the demo connection's id.
 */
async function demoStore(page: Page, prefix: string): Promise<{ connection: string }> {
  await signUp(page, uniqueEmail(prefix));
  const ws = await createWorkspace(page, "Ads Analytics Co");
  const storeId = await insertStore(db, ws, `${prefix}-${Date.now()}.myshopify.com`);
  const answer = await page.evaluate(
    async ({ path, seed }) => {
      const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seed }) });
      return { status: r.status, body: await r.text() };
    },
    { path: `/api/workspaces/${ws}/stores/${storeId}/ads/google/demo/connect`, seed: SEED },
  );
  expect(answer.status, answer.body).toBe(200);
  const { rows } = await db.query("SELECT id FROM ad_connections WHERE store_id = $1 AND provider = 'google' AND is_demo", [storeId]);
  expect(rows).toHaveLength(1);
  const connection = rows[0].id as string;
  // The local server runs the queue: the demo is settled ("Demo connected") once its days are stored and no sync is on its way.
  await expect
    .poll(
      async () => (await db.query("SELECT status, last_synced_at IS NOT NULL AS synced, sync_requested_at IS NULL AS idle FROM ad_connections WHERE id = $1", [connection])).rows[0],
      { timeout: 45_000, message: "the demo's first sync to land" },
    )
    .toEqual({ status: "active", synced: true, idle: true });
  return { connection };
}

/** The Google Ads report panel on /advertising/google, and the parts of it every test reads. */
function googleReport(page: Page) {
  const panel = page.getByRole("region", { name: "Google Ads report" });
  const rows = panel.getByTestId("google-report-row");
  return {
    panel,
    rows,
    /** The table's first column heading: what one row is (Campaign, Ad group, Ad, Asset group, Keyword, Search term). */
    heading: panel.getByTestId("google-report-table").locator("thead th").first(),
    /** The top row's name: the whole account's, or what an opened campaign or ad group adds up to. */
    whole: panel.getByTestId("google-report-whole").locator("td").first(),
    crumbs: panel.getByTestId("google-report-crumbs"),
    /** A row's name that opens what is under it (a campaign's ad groups or asset groups, an ad group's ads). */
    opener: (name: string) => panel.getByTestId("google-report-open").filter({ hasText: name }),
    /** A row that opens nothing (keywords, search terms): its name is a span titled with it. */
    named: (name: string) => rows.filter({ has: page.getByTitle(name, { exact: true }) }),
  };
}

/** Press a "Download CSV" and read the file it saves: its name and its lines (without Excel's BOM). */
async function downloaded(page: Page, button: Locator): Promise<{ name: string; lines: string[] }> {
  const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
  const text = (await readFile(await download.path(), "utf8")).replace(/^\uFEFF/, "");
  return { name: download.suggestedFilename(), lines: text.split("\r\n") };
}

const DAY = String.raw`\d{4}-\d{2}-\d{2}`;

test("the Google Ads report rates each campaign's delivery, opens a campaign to its ad groups and an ad group to its ads, and a Performance Max campaign to its asset groups, from a link too", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { connection } = await demoStore(page, "gads-drill");
  await page.goto("/advertising/google");
  const g = googleReport(page);

  // Campaigns: Google's own rating of whether each can show ads now, why, its type and its daily budget.
  await expect(g.heading).toHaveText("Campaign", { timeout: 20_000 });
  await expect(g.whole).toHaveText("Whole ad account");
  await expect(g.panel).toContainText("generated by bizinsights for the demo account (simulated, nothing read from Google)");
  const search = g.rows.filter({ hasText: "Search Advertising" });
  await expect(search).toHaveCount(1);
  await expect(search.getByText("Limited", { exact: true })).toBeVisible();
  await expect(search).toContainText(/limited by budget · Search · budget [^·]*60\.00 a day/);
  await expect(g.rows.filter({ hasText: "Brand Awareness" }).getByText("Eligible", { exact: true })).toBeVisible();
  await expect(g.rows.filter({ hasText: "Conversion Optimization" })).toContainText("Performance Max");
  await expect(g.panel).toContainText("A campaign's status is Google's own rating of whether it can show ads now");
  await expect(g.crumbs).toHaveCount(0);

  // A Search campaign opens to its ad groups, kept in the address; the top row adds them up.
  await g.opener("Search Advertising").click();
  await expect(page).toHaveURL(/[?&]campaign=demo-c2(&|$)/);
  await expect(g.heading).toHaveText("Ad group", { timeout: 20_000 });
  await expect(g.crumbs.getByRole("button")).toHaveText(["All campaigns"]);
  await expect(g.crumbs.locator('[aria-current="page"]')).toHaveText("Search Advertising");
  await expect(g.whole).toHaveText("All ad groups in this campaign");
  await expect(g.panel).toContainText("The top row adds up the ad groups Google reported for these dates");
  await expect(g.panel.getByTestId("google-report-campaign")).toHaveCount(0);
  await expect(g.panel.getByTestId("google-report-view-rows")).toHaveText("Ad groups");
  await expect(g.rows).toHaveCount(2);
  await expect(g.opener("Search Advertising · Core")).toHaveCount(1);
  await expect(g.opener("Search Advertising · Broad")).toHaveCount(1);

  // An ad group opens to its ads (named by their type and Google's id: responsive search ads have no name of their own).
  await g.opener("Search Advertising · Core").click();
  await expect(page).toHaveURL(/[?&]adgroup=demo-c2-core(&|$)/);
  await expect(page).toHaveURL(/[?&]campaign=demo-c2(&|$)/);
  await expect(g.heading).toHaveText("Ad", { timeout: 20_000 });
  await expect(g.crumbs.getByRole("button")).toHaveText(["All campaigns", "Search Advertising"]);
  await expect(g.crumbs.locator('[aria-current="page"]')).toHaveText("Search Advertising · Core");
  await expect(g.whole).toHaveText("All ads in this ad group");
  await expect(g.panel.getByTestId("google-report-view-rows")).toHaveText("Ads");
  await expect(g.rows.first().locator("td").first()).toContainText(/^Responsive search ad \d{12}/);
  expect(await g.rows.count()).toBeGreaterThanOrEqual(2);
  await expect(g.panel.getByTestId("google-report-open")).toHaveCount(0);

  // Back up the breadcrumb: to the campaign's ad groups, then to every campaign.
  await g.crumbs.getByRole("button", { name: "Search Advertising", exact: true }).click();
  await expect(g.heading).toHaveText("Ad group", { timeout: 20_000 });
  await expect(page).not.toHaveURL(/adgroup=/);
  await expect(page).toHaveURL(/[?&]campaign=demo-c2(&|$)/);
  await g.crumbs.getByRole("button", { name: "All campaigns", exact: true }).click();
  await expect(g.heading).toHaveText("Campaign", { timeout: 20_000 });
  await expect(g.crumbs).toHaveCount(0);
  await expect(g.panel.getByTestId("google-report-campaign")).toHaveAttribute("aria-selected", "true");
  await expect(page).not.toHaveURL(/campaign=/);

  // Performance Max has asset groups instead of ad groups, and no keywords.
  await expect(g.opener("Conversion Optimization")).toHaveAttribute("title", "Conversion Optimization: view its asset groups");
  await g.opener("Conversion Optimization").click();
  await expect(page).toHaveURL(/[?&]campaign=demo-c7(&|$)/);
  await expect(g.heading).toHaveText("Asset group", { timeout: 20_000 });
  await expect(g.crumbs.locator('[aria-current="page"]')).toHaveText("Conversion Optimization");
  await expect(g.whole).toHaveText("All asset groups in this campaign");
  await expect(g.panel.getByTestId("google-report-view-rows")).toHaveText("Asset groups");
  await expect(g.panel.getByTestId("google-report-view-search_term")).toHaveText("Search terms");
  await expect(g.panel.getByTestId("google-report-view-keyword")).toHaveCount(0);
  await expect(g.rows).toHaveCount(2);
  await expect(g.rows.filter({ hasText: "Conversion Optimization · All products" })).toHaveCount(1);
  await expect(g.rows.filter({ hasText: "Conversion Optimization · Best sellers" })).toHaveCount(1);
  await expect(g.panel.getByTestId("google-report-open")).toHaveCount(0);

  // A link with the account and the campaign opens its asset groups straight away (its type looked up on the campaign list).
  await page.goto(`/advertising/google?account=${connection}&campaign=demo-c7`);
  await expect(g.heading).toHaveText("Asset group", { timeout: 20_000 });
  await expect(g.crumbs.locator('[aria-current="page"]')).toHaveText("Conversion Optimization");
  await expect(g.whole).toHaveText("All asset groups in this campaign");
  await expect(g.rows).toHaveCount(2);
  await expect(page).toHaveURL(new RegExp(`[?&]account=${connection}(&|$)`));
  await expect(page).toHaveURL(/[?&]campaign=demo-c7(&|$)/);
});

test("keywords and search terms: the whole account's, an opened Search campaign's and one ad group's, each under its own top row", async ({ page }) => {
  test.setTimeout(120_000);
  await demoStore(page, "gads-kw");
  await page.goto("/advertising/google");
  const g = googleReport(page);
  await expect(g.heading).toHaveText("Campaign", { timeout: 20_000 });

  // The whole account's keywords: the Search campaigns' only, each with its ad group, match type and Quality Score.
  await expect(g.panel.getByTestId("google-report-keyword")).toHaveText("Keywords");
  await g.panel.getByTestId("google-report-keyword").click();
  await expect(g.panel.getByTestId("google-report-keyword")).toHaveAttribute("aria-selected", "true");
  await expect(g.heading).toHaveText("Keyword", { timeout: 20_000 });
  await expect(g.whole).toHaveText("Whole ad account");
  await expect(g.named("running shoes")).toHaveCount(1);
  await expect(g.named("running shoes")).toContainText(/Search Advertising · Core · Exact match · Quality Score \d+\/10/);
  await expect(g.named("custom shoe fitting")).toContainText("Lead Generation · Lead Generation · Core · Exact match");
  await expect(g.named("trail running shoes")).toContainText("Broad match");
  await expect(g.panel).toContainText("Quality Score is Google's rating of a keyword now (1 to 10)");

  // The whole account's search terms: Performance Max's product searches among them.
  await expect(g.panel.getByTestId("google-report-search_term")).toHaveText("Search terms");
  await g.panel.getByTestId("google-report-search_term").click();
  await expect(g.heading).toHaveText("Search term", { timeout: 20_000 });
  await expect(g.whole).toHaveText("Whole ad account");
  await expect(g.named("sports shoes")).toContainText("Conversion Optimization · Performance Max");
  await expect(g.panel).toContainText("Search terms are what people typed before your ad showed");

  // One Search campaign: its ad groups, keywords and search terms; the top row is the campaign's own.
  await g.panel.getByTestId("google-report-campaign").click();
  await expect(g.heading).toHaveText("Campaign", { timeout: 20_000 });
  await g.opener("Search Advertising").click();
  await expect(g.heading).toHaveText("Ad group", { timeout: 20_000 });
  await expect(g.panel.getByTestId("google-report-view-rows")).toHaveText("Ad groups");
  await expect(g.panel.getByTestId("google-report-view-keyword")).toHaveText("Keywords");
  await expect(g.panel.getByTestId("google-report-view-search_term")).toHaveText("Search terms");
  await g.panel.getByTestId("google-report-view-keyword").click();
  await expect(g.heading).toHaveText("Keyword", { timeout: 20_000 });
  await expect(g.whole).toHaveText("Whole campaign");
  await expect(g.named("running shoes")).toContainText(/Search Advertising · Core · Exact match · Quality Score \d+\/10/);
  await expect(g.named("trail running shoes")).toContainText("Search Advertising · Broad · Broad match");
  await expect(g.named("custom shoe fitting")).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]campaign=demo-c2(&|$)/);
  await g.panel.getByTestId("google-report-view-search_term").click();
  await expect(g.heading).toHaveText("Search term", { timeout: 20_000 });
  await expect(g.whole).toHaveText("Whole campaign");
  await expect(g.named("running shoes online")).toHaveCount(1);
  await expect(g.named("sports shoes")).toHaveCount(0);

  // One ad group: its ads and its own keywords (Google gives search terms by campaign, so none here).
  await g.panel.getByTestId("google-report-view-rows").click();
  await expect(g.heading).toHaveText("Ad group", { timeout: 20_000 });
  await g.opener("Search Advertising · Core").click();
  await expect(g.heading).toHaveText("Ad", { timeout: 20_000 });
  await expect(g.panel.getByTestId("google-report-view-rows")).toHaveText("Ads");
  await expect(g.panel.getByTestId("google-report-view-search_term")).toHaveCount(0);
  await g.panel.getByTestId("google-report-view-keyword").click();
  await expect(g.heading).toHaveText("Keyword", { timeout: 20_000 });
  await expect(g.whole).toHaveText("Whole ad group");
  await expect(g.named("running shoes")).toContainText(/Exact match · Quality Score \d+\/10/);
  // The ad group opened isn't named again on each of its keywords.
  await expect(g.named("running shoes")).not.toContainText("Search Advertising · Core");
  await expect(g.named("trail running shoes")).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]adgroup=demo-c2-core(&|$)/);
});

test("downloads: the live report's CSV is marked simulated at the top and inside a campaign, and the analytics page prints and downloads its sections", async ({ page }) => {
  test.setTimeout(120_000);
  await demoStore(page, "gads-csv");
  await page.goto("/advertising/google");
  const g = googleReport(page);
  await expect(g.heading).toHaveText("Campaign", { timeout: 20_000 });
  await expect(page.getByTestId("ad-print")).toHaveText("Print or save as PDF");

  // The campaigns as the page shows them; the file's name and its first row say the figures are simulated.
  const campaigns = await downloaded(page, g.panel.getByTestId("google-report-csv"));
  expect(campaigns.name).toMatch(new RegExp(`^bizinsights-google-ads-demo-simulated-DEMO-ADS-001-campaign-${DAY}-to-${DAY}\\.csv$`));
  expect(campaigns.lines[0]).toMatch(/^"Campaign","Google id","Campaign type","Status now \(simulated\)","Delivery now \(simulated\)","Why","Daily budget now \(USD\)"/);
  expect(campaigns.lines[1]).toMatch(/^"Simulated data","Simulated data generated by bizinsights/);
  expect(campaigns.lines[2]).toMatch(/^"Whole ad account",/);
  expect(campaigns.lines.find((l) => l.startsWith('"Search Advertising",'))).toContain('"Search Advertising","demo-c2","Search","ENABLED","Limited","limited by budget",60,');

  // Inside a campaign: the asset groups on screen, named after the campaign opened, under their sum.
  await g.opener("Conversion Optimization").click();
  await expect(g.heading).toHaveText("Asset group", { timeout: 20_000 });
  const assetGroups = await downloaded(page, g.panel.getByTestId("google-report-csv"));
  expect(assetGroups.name).toMatch(new RegExp(`^bizinsights-google-ads-demo-simulated-DEMO-ADS-001-asset_group-campaign-demo-c7-${DAY}-to-${DAY}\\.csv$`));
  expect(assetGroups.lines[0]).toMatch(/^"Asset group","Google id","Campaign",/);
  expect(assetGroups.lines[1]).toMatch(/^"Simulated data",/);
  expect(assetGroups.lines[2]).toMatch(/^"All asset groups in this campaign",/);
  expect(assetGroups.lines.some((l) => l.startsWith('"Conversion Optimization · All products","demo-c7-ag1","Conversion Optimization",'))).toBe(true);

  // The analytics page: print, and each section's CSV (every one for an owner of a demo).
  await page.goto("/advertising/google/analytics");
  await expect(page.getByRole("heading", { level: 1, name: /Google Ads Analytics/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("ga-disclaimer")).toContainText("Simulated data generated by bizinsights");
  await expect(page.getByTestId("ad-print")).toHaveText("Print or save as PDF");
  const part = page.getByTestId("ga-csv-part");
  await expect(part.locator("option")).toHaveText([
    "Overview",
    "Campaigns",
    "Spending and conversions by day",
    "Spending and conversions by week",
    "Spending and conversions by month",
    "Devices",
    "Audience",
    "Recommendations",
    "Demo store and ad spend",
  ]);
  await expect(part).toHaveValue("overview");
  const overview = await downloaded(page, page.getByTestId("ga-csv"));
  expect(overview.name).toMatch(new RegExp(`^bizinsights-google-ads-demo-simulated-DEMO-ADS-001-overview-${DAY}-to-${DAY}\\.csv$`));
  expect(overview.lines[0]).toMatch(/^"Measure","Value",/);
  expect(overview.lines[1]).toMatch(/^"Simulated data",/);
  await part.selectOption("campaigns");
  const stored = await downloaded(page, page.getByTestId("ga-csv"));
  expect(stored.name).toMatch(new RegExp(`^bizinsights-google-ads-demo-simulated-DEMO-ADS-001-campaigns-${DAY}-to-${DAY}\\.csv$`));
  expect(stored.lines[0]).toMatch(/^"Campaign","Google id","Campaign type","Status",/);
  expect(stored.lines[1]).toMatch(/^"Simulated data",/);
  expect(stored.lines.some((l) => l.startsWith('"Search Advertising","demo-c2",'))).toBe(true);
});
