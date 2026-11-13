import { expect, test } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertStore, signUp, uniqueEmail } from "./helpers";

/**
 * Advertising with no ad account connected: the store's own Shopify orders stand in. The home card,
 * the Advertising overview and the Meta Ads page show the sales whose visit came from Facebook and
 * Instagram (Meta) or Google and YouTube (Google Ads), the tagged-ad part, the campaigns named in the
 * links, each with the way to connect the platform for its spend.
 * AdSense has nothing in the orders: its page still only offers to connect it.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.OWNER_DATABASE_URL });
test.afterAll(() => db.end());

/** Today (UTC, the store's zone here) plus `n` days, as YYYY-MM-DD. */
const day = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** One paid order of `price` on `on` (one a day) with the visit before it, as the pipeline stores it: the order, its product sale, the day's totals. */
async function seedOrder(ws: string, storeId: string, id: string, on: string, price: number, traffic: { source: string; medium: string; campaign?: string }) {
  const order = (
    await db.query(
      `INSERT INTO orders (id, workspace_id, store_id, shopify_id, name, currency, local_day, shopify_created_at, shopify_updated_at, subtotal, total_discounts, total_tax, total_shipping, total_price, sales_updated_at, traffic_source, traffic_medium, traffic_campaign)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'USD', $5, ($5 || 'T12:00:00')::timestamp, ($5 || 'T12:00:00')::timestamp, $6, 0, 0, 0, $6, now(), $7, $8, $9) RETURNING id`,
      [ws, storeId, id, `#${id}`, on, price, traffic.source, traffic.medium, traffic.campaign ?? null],
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

test("with no ad account connected, Advertising shows Meta's and Google's sales from the Shopify orders, and the way to connect each", async ({ page }) => {
  const email = uniqueEmail("ads-shopify");
  await signUp(page, email);
  const ws = await createWorkspace(page, "Ads From Shopify Co");
  const storeId = await insertStore(db, ws, `ads-shopify-${Date.now()}.myshopify.com`);
  // Orders imported from long before the dates, so the week before compares.
  await db.query(`UPDATE stores SET orders_history_from = now() - interval '60 days' WHERE id = $1`, [storeId]);
  // The dates picked (the last seven whole days): a Facebook ad's order, an Instagram post's, a Google ad's and a direct one.
  await seedOrder(ws, storeId, "F1", day(-5), 100, { source: "facebook", medium: "paid", campaign: "Spring sale" });
  await seedOrder(ws, storeId, "I1", day(-4), 40, { source: "instagram", medium: "unpaid" });
  await seedOrder(ws, storeId, "G1", day(-3), 60, { source: "google", medium: "paid", campaign: "Brand search" });
  await seedOrder(ws, storeId, "D1", day(-2), 50, { source: "direct", medium: "direct" });
  // The week before: one Facebook ad's order of $70.
  await seedOrder(ws, storeId, "F0", day(-10), 70, { source: "facebook", medium: "paid", campaign: "Spring sale" });
  const dates = `preset=custom&from=${day(-7)}&to=${day(-1)}`;

  // The dashboard's advertising card: a tab each, both from the orders and labelled so, not an empty "connect" box.
  await page.goto(`/dashboard?${dates}`);
  const card = page.getByTestId("home-advertising");
  await expect(card.getByRole("tab", { name: "Meta Ads" })).toHaveAttribute("aria-selected", "true");
  const metaTab = card.getByTestId("home-ads-meta");
  await expect(metaTab).toHaveAttribute("data-source", "shopify");
  await expect(metaTab.getByTestId("ad-source-badge")).toHaveText("Shopify attribution");
  await expect(metaTab).toContainText("$140.00");
  await expect(metaTab).toContainText("Top campaign: Spring sale");
  // No spend is known without Meta itself: no ad spend or ROAS figure, never a $0.
  await expect(metaTab.getByText("Ad spend", { exact: true })).toHaveCount(0);
  await expect(metaTab.getByText("ROAS", { exact: true })).toHaveCount(0);
  await expect(metaTab.getByRole("link", { name: "Connect Meta Ads" })).toBeVisible();
  // Meta, found through Shopify: seen in these orders (the three of the last 90 days), and said not to be authorized for bizinsights.
  const found = metaTab.getByTestId("meta-discovery");
  await expect(found).toHaveAttribute("data-state", "CONNECTED_IN_SHOPIFY");
  await expect(found).toHaveAttribute("data-marker", "CONNECTED_IN_SHOPIFY_BUT_NOT_AUTHORIZED_FOR_OUR_APP");
  await expect(found).toContainText("Not authorized for bizinsights yet");
  await expect(found).toContainText("3 orders from Facebook and Instagram in the last 90 days");
  await expect(found).toContainText("Shopify doesn't share its own Meta access with other apps");
  await card.getByRole("tab", { name: "Google Ads" }).click();
  const googleTab = card.getByTestId("home-ads-google");
  await expect(googleTab).toHaveAttribute("data-source", "shopify");
  await expect(googleTab).toContainText("$60.00");
  await expect(googleTab.getByRole("link", { name: "Connect Google Ads" })).toBeVisible();

  // The Advertising overview: both platforms from the orders, under one line saying none is connected.
  await page.goto(`/advertising?${dates}`);
  await expect(page.getByTestId("advertising-not-connected")).toContainText("No ad accounts are connected to this store");
  await expect(page.getByTestId("advertising-not-connected").getByRole("link", { name: "Connect advertising accounts" })).toBeVisible();
  const meta = page.getByTestId("shopify-ads-meta");
  await expect(meta.getByTestId("ad-source-badge")).toHaveText("Shopify attribution");
  // $140, of the store's $250: 56%. The week before had $70: no change on it is shown.
  await expect(meta.getByTestId("shopify-meta-sales-value")).toHaveText("$140.00");
  await expect(meta.getByTestId("shopify-meta-sales")).not.toContainText("100%");
  await expect(meta.getByTestId("shopify-meta-orders-value")).toHaveText("2");
  await expect(meta.getByTestId("shopify-meta-share-value")).toHaveText("56%");
  // The tagged-ad part, and the campaign its link named.
  await expect(meta.getByTestId("shopify-meta-tagged-value")).toHaveText("$100.00");
  await expect(meta.getByTestId("shopify-meta-campaigns")).toContainText("Spring sale");
  await expect(meta).toContainText("Instagram");
  await expect(meta.locator("[aria-label*='Sales from Facebook and Instagram by day']")).toBeVisible();
  const google = page.getByTestId("shopify-ads-google");
  await expect(google.getByTestId("shopify-google-sales-value")).toHaveText("$60.00");
  await expect(google.getByTestId("shopify-google-campaigns")).toContainText("Brand search");
  await expect(page.getByTestId("ads-from-shopify-about")).toContainText("last click");

  // Meta Ads' own page: Meta alone, with its connect button.
  await page.getByRole("navigation", { name: "Advertising" }).getByRole("link", { name: "Meta Ads" }).click();
  await expect(page).toHaveURL(/\/advertising\/meta\?preset=custom/);
  await expect(page.getByTestId("advertising-not-connected").getByRole("link", { name: "Connect Meta Ads" })).toBeVisible();
  await expect(page.getByTestId("shopify-meta-sales-value")).toHaveText("$140.00");
  await expect(page.getByTestId("shopify-ads-google")).toHaveCount(0);
  await expect(page.getByTestId("meta-discovery")).toHaveAttribute("data-state", "CONNECTED_IN_SHOPIFY");

  // AdSense: what a site earns from ads isn't in the orders, so there's only the way to connect it.
  await page.getByRole("navigation", { name: "Advertising" }).getByRole("link", { name: "AdSense" }).click();
  await expect(page.getByTestId("advertising-not-connected")).toContainText("Shopify doesn't record them");
  await expect(page.getByTestId("ads-from-shopify")).toHaveCount(0);
  await expect(page.getByTestId("meta-discovery")).toHaveCount(0);
});
