import { expect, test } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertStore, signUp, uniqueEmail } from "./helpers";

/**
 * Ad spend the store's marketing apps report to Shopify (ShopifyQL marketing_engagements, kept by the
 * worker): with no ad account connected, Meta's spend, clicks and ROAS come from what the Facebook &
 * Instagram app reported, badged "Reported to Shopify", on the Advertising overview and the dashboard's
 * card; Google, whose app reported nothing, says its data is unavailable rather than showing $0.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.OWNER_DATABASE_URL });
test.afterAll(() => db.end());

const day = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function report(ws: string, storeId: string, on: string, campaign: string, spend: number, clicks: number, sales: number) {
  await db.query(
    `INSERT INTO shopify_marketing_days (workspace_id, store_id, day, channel, app, campaign, spend, impressions, clicks, orders, sales, new_customers, currency, fetched_at)
     VALUES ($1, $2, $3, 'Meta Ads', 'Facebook & Instagram', $4, $5, $6, $7, 2, $8, 1, 'USD', now())`,
    [ws, storeId, on, campaign, spend, clicks * 40, clicks, sales],
  );
}

test("with no ad account connected, Meta's spend comes from what its app reports to Shopify, and Google says it has none", async ({ page }) => {
  const email = uniqueEmail("ads-marketing");
  await signUp(page, email);
  const ws = await createWorkspace(page, "Shopify Marketing Co");
  const storeId = await insertStore(db, ws, `ads-marketing-${Date.now()}.myshopify.com`, ["read_orders", "read_products", "read_reports"]);
  await db.query(
    `INSERT INTO shopify_marketing_syncs (store_id, workspace_id, covered_from, synced_through, backfilled, last_synced_at, last_attempt_at, updated_at)
     VALUES ($1, $2, $3, $4, true, now(), now(), now())`,
    [storeId, ws, day(-200), day(0)],
  );
  // The channel's whole days, and one campaign's part of them.
  await report(ws, storeId, day(-3), "", 40, 200, 320);
  await report(ws, storeId, day(-2), "", 60, 300, 480);
  await report(ws, storeId, day(-2), "Spring sale", 60, 300, 480);
  await report(ws, storeId, day(0), "", 25, 100, 0);
  const dates = `preset=custom&from=${day(-7)}&to=${day(-1)}`;

  await page.goto(`/advertising?${dates}`);
  const card = page.getByTestId("shopify-marketing");
  // Today's and this month's spend, whatever the dates: Meta's from the report, Google's not reported, never $0.
  const tiles = card.getByTestId("marketing-spend-tiles");
  await expect(tiles.getByTestId("marketing-spend-today-meta")).toHaveAttribute("data-state", "reported");
  await expect(tiles.getByTestId("marketing-spend-today-meta")).toContainText("$25.00");
  await expect(tiles.getByTestId("marketing-spend-today-google")).toHaveAttribute("data-state", "unavailable");
  await expect(tiles.getByTestId("marketing-spend-today-google")).toContainText("Not reported by Shopify");
  await expect(tiles.getByTestId("marketing-spend-today-total")).toContainText("$25.00");
  const thisMonth = day(0).slice(0, 7);
  const monthSpend = 25 + (day(-3).startsWith(thisMonth) ? 40 : 0) + (day(-2).startsWith(thisMonth) ? 60 : 0);
  await expect(tiles.getByTestId("marketing-spend-month-total")).toContainText(`$${monthSpend}.00`);
  await expect(tiles.getByTestId("marketing-spend-month-google")).toContainText("Not reported by Shopify");
  await expect(tiles.getByTestId("marketing-spend-about")).toContainText("time zone (UTC)");
  await expect(card.getByTestId("marketing-spend-chart")).toBeVisible();
  await expect(card.getByTestId("marketing-total-value")).toHaveText("$100.00");
  await expect(card.getByTestId("marketing-total-meta")).toHaveAttribute("data-from", "marketing");
  // No platform shown from its own API here: nothing left out, the total is whole.
  await expect(card.getByTestId("marketing-total")).not.toHaveAttribute("data-partial");
  await expect(card.getByTestId("marketing-total-left-out")).toHaveCount(0);
  await expect(card.getByTestId("marketing-meta")).toHaveAttribute("data-availability", "reported");
  await expect(card.getByTestId("marketing-meta-spend")).toContainText("$100.00");
  await expect(card.getByTestId("marketing-meta-clicks")).toContainText("500");
  await expect(card.getByTestId("marketing-meta-roas")).toContainText("8×");
  await expect(card.getByTestId("marketing-source-meta")).toContainText("Facebook & Instagram, reported to Shopify");
  await expect(card.getByTestId("marketing-source-meta")).toContainText("USD");
  await expect(card.getByTestId("marketing-campaigns")).toContainText("Spring sale");
  // Google's app reported nothing: unavailable, never $0.
  await expect(card.getByTestId("marketing-google")).toHaveAttribute("data-availability", "unavailable");
  await expect(card.getByTestId("marketing-google-unavailable")).toContainText("Data unavailable");

  // Meta's card takes its figures from the report, badged so, with the way to connect Meta for its own.
  const meta = page.getByTestId("ads-card-meta");
  await expect(meta.getByTestId("ad-source-badge").first()).toHaveText("Reported to Shopify");
  await expect(meta.getByTestId("ads-card-meta-marketing-spend")).toContainText("$100.00");
  await expect(meta.getByRole("link", { name: "Connect Meta Ads" })).toBeVisible();

  // Meta Ads' own page: the same figures in a card of their own.
  await page.getByRole("navigation", { name: "Advertising" }).getByRole("link", { name: "Meta Ads" }).click();
  await expect(page).toHaveURL(/\/advertising\/meta\?preset=custom/);
  await expect(page.getByTestId("marketing-page-meta").getByTestId("ads-card-meta-marketing-spend")).toContainText("$100.00");

  // The dashboard's card opens on Meta, from the report.
  await page.goto(`/dashboard?${dates}`);
  const home = page.getByTestId("home-advertising");
  await expect(home.getByRole("tab", { name: "Meta Ads" })).toHaveAttribute("aria-selected", "true");
  const tab = home.getByTestId("home-ads-meta");
  await expect(tab).toHaveAttribute("data-marketing", "true");
  await expect(tab.getByTestId("ad-source-badge")).toHaveText("Reported to Shopify");
  await expect(tab).toContainText("$100.00");
});
