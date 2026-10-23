import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertStore, signUp, uniqueEmail } from "./helpers";

/**
 * The Google Ads demo through the real app (docs/ads-demo.md): Try demo on the Google Ads card, the
 * five-screen connection flow, the demo's own sync (the local server runs the queue, so its figures
 * really land), the analytics page, the dashboard's demo marks, and the way out. e2e/server.env sets
 * no Google credentials, so the real sign-in isn't offered, and nothing here reaches Google.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.DATABASE_URL });
test.afterAll(() => db.end());

const quietMeta = (page: Page) => page.route("https://connect.facebook.net/**", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));

async function ownerWithStore(page: Page, prefix: string) {
  const email = uniqueEmail(prefix);
  await signUp(page, email);
  const ws = await createWorkspace(page, "Demo Co");
  const storeId = await insertStore(db, ws, `${prefix}-${Date.now()}.myshopify.com`);
  return { email, ws, storeId };
}

test("Try demo: the connection flow, a demo that syncs by itself, the analytics page, the dashboard, and disconnecting", async ({ page }) => {
  test.setTimeout(120_000);
  const { storeId } = await ownerWithStore(page, "gdemo");
  await quietMeta(page);
  await page.goto("/settings/integrations");
  const card = page.getByTestId("int-google");
  // Google Ads isn't set up on this server: its card offers the demo instead of "Coming soon".
  await expect(card.getByTestId("platform-state")).toHaveText("Not connected");
  await expect(card.getByRole("button", { name: "Connect Google Ads" })).toHaveCount(0);

  // The five screens: no Google page, no password, a real request on the fourth.
  await card.getByTestId("int-google-try-demo").click();
  const dialog = page.getByTestId("google-ads-demo-dialog");
  await expect(dialog).toHaveAttribute("data-screen", "1");
  await expect(dialog).toContainText("No Google account authentication");
  await dialog.getByRole("button", { name: "Continue with Demo" }).click();
  await expect(dialog).toHaveAttribute("data-screen", "2");
  await expect(dialog).toContainText("DEMO-ADS-001");
  await expect(dialog).toContainText("Demo Business Marketing");
  await expect(dialog).toContainText("USD");
  await dialog.getByRole("button", { name: "Connect Demo Account" }).click();
  await expect(dialog).toHaveAttribute("data-screen", "3");
  await expect(dialog.getByTestId("demo-permissions").getByRole("listitem")).toHaveCount(8);
  await expect(dialog).toContainText("not Google OAuth scopes");
  let connectCalls = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/ads/google/demo/connect")) connectCalls++;
  });
  await dialog.getByRole("button", { name: "Authorize Demo Access" }).click();
  await expect(dialog).toHaveAttribute("data-screen", "5", { timeout: 20_000 });
  expect(connectCalls).toBe(1);
  await expect(dialog.getByTestId("demo-status")).toHaveText("Demo Connected");
  await expect(dialog.getByTestId("demo-verification")).toHaveText("Simulated — Not verified by Google");
  await expect(dialog.getByRole("link", { name: "Open Demo Dashboard" })).toHaveAttribute("href", "/advertising/google/analytics");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);

  // A demo, never plain "Connected"; the local server's queue runs its sync, so it settles by itself.
  await expect(card.getByTestId("platform-state")).toHaveText("Demo connected", { timeout: 45_000 });
  await expect(card.getByTestId("int-google-accounts")).toContainText("Account: Demo Business Marketing (demo)");
  await expect(card.getByTestId("int-google-try-demo")).toHaveCount(0);

  // Its row, on Settings → Advertising (Manage).
  await card.getByRole("link", { name: "Manage Google Ads" }).click();
  await expect(page).toHaveURL(/\/settings\/ads$/);
  const row = page.locator('[data-testid="ad-account"][data-account="DEMO-ADS-001"]');
  await expect(row).toBeVisible();
  await expect(row.getByTestId("demo-badge")).toHaveText("Simulated — Not verified by Google");
  await expect(row.getByTestId("account-state")).toHaveText("Demo connected");
  await expect(row).toContainText("Demo advertising account (simulated)");
  await expect(row).toContainText("Fictional application permissions");
  await expect(row.getByTestId("demo-actions")).toBeVisible();
  const { rows } = await db.query("SELECT is_demo, demo_seed, access_token_enc, last_synced_at FROM ad_connections WHERE store_id = $1", [storeId]);
  expect(rows).toHaveLength(1);
  expect(rows[0].is_demo).toBe(true);
  expect(rows[0].access_token_enc).toBe("");
  expect(rows[0].last_synced_at).not.toBeNull();
  const days = await db.query("SELECT count(*)::int AS n FROM ad_campaign_daily WHERE store_id = $1", [storeId]);
  expect(days.rows[0].n).toBeGreaterThan(400);

  // The analytics page: every section marked as demo, the campaign table searched and paged.
  await row.getByRole("link", { name: "Open demo dashboard" }).click();
  await expect(page).toHaveURL(/\/advertising\/google\/analytics/);
  await expect(page.getByRole("heading", { name: /Google Ads Analytics/ })).toBeVisible();
  await expect(page.getByTestId("ga-disclaimer")).toContainText("Simulated");
  await expect(page.getByTestId("ga-overview-cards")).toBeVisible();
  const badges = page.getByTestId("demo-data-badge");
  await expect(badges.first()).toBeVisible();
  expect(await badges.count()).toBeGreaterThanOrEqual(8);
  await expect(page.getByTestId("ga-campaign-count")).toHaveText("7 campaigns · page 1 of 2");
  await expect(page.getByTestId("ga-campaign-row")).toHaveCount(5);
  await page.getByTestId("ga-campaign-next").click();
  await expect(page.getByTestId("ga-campaign-row")).toHaveCount(2);
  await page.getByTestId("ga-campaign-search").fill("shopping");
  await expect(page.getByTestId("ga-campaign-count")).toHaveText("1 campaign · page 1 of 1");
  await expect(page.getByTestId("ga-campaign-row")).toContainText("Shopping Campaign");
  await page.getByTestId("ga-campaign-search").fill("");
  await page.getByTestId("ga-campaign-status").selectOption("PAUSED");
  await expect(page.getByTestId("ga-campaign-row")).toContainText("Website Traffic");
  await page.getByTestId("ga-campaign-status").selectOption("");
  // Dates: the page asks again for the dates picked, kept in the address.
  await page.getByLabel("Dates").selectOption("7d");
  await expect(page).toHaveURL(/preset=7d/);
  await expect(page.getByTestId("ga-spend-total")).not.toHaveText("");
  await page.getByTestId("ga-spend-week").click();
  await expect(page.getByTestId("ga-spend-chart")).toHaveAttribute("data-granularity", "week");
  await expect(page.getByTestId("ga-devices-table").getByRole("row")).toHaveCount(4);
  await expect(page.getByTestId("ga-audience-age")).toBeVisible();
  await expect(page.getByTestId("ga-recommendations-simulated")).toContainText("Derived from simulated data");
  await expect(page.getByTestId("ga-combined-totals")).toBeVisible();
  await expect(page.getByTestId("ga-combined-spend-vs-revenue")).toBeVisible();

  // Advertising (the dashboard's old ads panel address opens it): the demo's figures are marked, and never set against the store's own sales.
  await page.goto("/dashboard?preset=7d&view=ads");
  await expect(page).toHaveURL(/\/advertising\?preset=7d$/);
  await expect(page.getByTestId("ads-demo-note")).toBeVisible();
  await expect(page.getByTestId("ads-vs-sales")).toHaveCount(0);
  await expect(page.getByTestId("kpi-mer")).toContainText("Not with the demo's simulated spend");
  await expect(page.getByTestId("ads-card-google").getByTestId("demo-chip")).toBeVisible();
  await page.getByTestId("ads-card-google-details").click();
  await expect(page).toHaveURL(/\/advertising\/google/);
  await expect(page.getByTestId("ads-demo-note")).toBeVisible();

  // Sync and reset from the card; then the way out.
  await page.goto("/settings/ads");
  const row2 = page.locator('[data-testid="ad-account"][data-account="DEMO-ADS-001"]');
  await row2.getByTestId("demo-sync").click();
  await expect(page.getByTestId("action-note")).toContainText("Syncing the demo data");
  await row2.getByTestId("demo-reset").click();
  await expect(page.getByTestId("action-note")).toContainText("Demo data reset");
  await expect(row2.getByTestId("account-state")).toHaveText("Demo connected", { timeout: 45_000 });
  await page.getByRole("button", { name: "Disconnect Demo Business Marketing" }).click();
  const confirm = page.getByRole("dialog", { name: "Disconnect Demo Business Marketing?" });
  await expect(confirm).toContainText("nothing to hand back");
  await confirm.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByTestId("action-note")).toContainText("is disconnected");
  await expect(page.getByTestId("ads-provider-google").getByTestId("platform-state")).toHaveText("Demo disconnected");
  const after = await db.query("SELECT count(*)::int AS n FROM ad_connections WHERE store_id = $1", [storeId]);
  expect(after.rows[0].n).toBe(0);
});

test("a member who may only view sees the demo as a demo and gets no buttons", async ({ page }) => {
  const { email, storeId, ws } = await ownerWithStore(page, "gdemo-view");
  await quietMeta(page);
  await page.goto("/settings/integrations");
  await page.getByTestId("int-google").getByTestId("int-google-try-demo").click();
  const dialog = page.getByTestId("google-ads-demo-dialog");
  await dialog.getByRole("button", { name: "Continue with Demo" }).click();
  await dialog.getByRole("button", { name: "Connect Demo Account" }).click();
  await dialog.getByRole("button", { name: "Authorize Demo Access" }).click();
  await expect(dialog).toHaveAttribute("data-screen", "5", { timeout: 20_000 });
  await dialog.getByRole("button", { name: "Done" }).click();
  await db.query("UPDATE memberships SET role = 'custom', permissions = $3 WHERE workspace_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)", [ws, email, ["integrations.status", "marketing.ads"]]);
  await page.goto("/settings/integrations");
  await expect(page.getByTestId("int-google").getByTestId("platform-state")).toHaveText(/^Demo /);
  await expect(page.getByTestId("int-google-try-demo")).toHaveCount(0);
  await page.goto("/settings/ads");
  const row = page.locator('[data-testid="ad-account"][data-account="DEMO-ADS-001"]');
  await expect(row.getByTestId("demo-badge")).toBeVisible();
  await expect(row.getByTestId("demo-sync")).toHaveCount(0);
  // The page's old address still opens it, in the Advertising area.
  await page.goto("/ads/google");
  await expect(page).toHaveURL(/\/advertising\/google\/analytics/);
  await expect(page.getByTestId("ga-disclaimer")).toBeVisible();
  await expect(page.getByText("Campaign figures need the", { exact: false })).toBeVisible();
  expect((await db.query("SELECT is_demo FROM ad_connections WHERE store_id = $1", [storeId])).rows[0].is_demo).toBe(true);
});
