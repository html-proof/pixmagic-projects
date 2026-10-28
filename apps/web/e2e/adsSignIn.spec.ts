import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertStore, signUp, uniqueEmail } from "./helpers";

/**
 * "Continue with …" for an ad platform (docs/ads-setup.md), through the real app: the browser leaves for
 * the platform's own sign-in and comes back to bizinsights' callback, which sends it on to the dashboard,
 * the account choice, or Settings → Advertising with what happened. No platform can run here: the API's
 * start of the sign-in is answered with an address on this site, standing in for the callback's
 * redirect, so what is tested is what the pages do with each way back.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.DATABASE_URL });
test.afterAll(() => db.end());

async function ownerWithStore(page: Page, prefix: string) {
  await signUp(page, uniqueEmail(prefix));
  const ws = await createWorkspace(page, "Sign-in Co");
  const storeId = await insertStore(db, ws, `${prefix}-${Date.now()}.myshopify.com`);
  return { ws, storeId };
}

/**
 * This server as if `provider`'s sign-in were set up, and its start answering with `back` (what the
 * callback would redirect to) instead of the platform's sign-in. Returns the starts it saw.
 */
async function signInComesBackTo(page: Page, ws: string, storeId: string, provider: "meta" | "adsense", back: (storeId: string) => string) {
  const base = `**/api/workspaces/${ws}/stores/${storeId}/ads`;
  await page.route(base, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, Record<string, boolean>>;
    await route.fulfill({ response: res, json: { ...body, configured: { ...body.configured, [provider]: true } } });
  });
  const started: string[] = [];
  await page.route(`${base}/${provider}/connect`, (route) => {
    started.push(route.request().method());
    return route.fulfill({ json: { url: back(storeId) } });
  });
  return started;
}

test("Google AdSense's Connect leaves for the sign-in and lands on the dashboard once connected", async ({ page }) => {
  const { ws, storeId } = await ownerWithStore(page, "signin-ok");
  const started = await signInComesBackTo(page, ws, storeId, "adsense", (s) => `/dashboard?${new URLSearchParams({ adsConnected: "adsense", accounts: "1", store: s })}`);
  await page.goto("/settings/integrations");
  await page.getByTestId("int-adsense").getByRole("button", { name: "Connect Google AdSense" }).click();
  await page.waitForURL(/\/dashboard/);
  expect(started).toEqual(["POST"]);
  // The trip back is tidied away, and the dashboard says what was connected.
  await expect.poll(() => new URL(page.url()).search).toBe("");
});

test("a sign-in that comes back refused says why on Settings → Advertising, and nothing is connected", async ({ page }) => {
  const { ws, storeId } = await ownerWithStore(page, "signin-refused");
  await signInComesBackTo(page, ws, storeId, "adsense", (s) => `/settings/ads?${new URLSearchParams({ error: "permission_missing", provider: "adsense", store: s })}`);
  await page.goto("/settings/integrations");
  await page.getByTestId("int-adsense").getByRole("button", { name: "Connect Google AdSense" }).click();
  await page.waitForURL(/\/settings\/ads/);
  await expect(page.getByText("The permission to read reports wasn't granted")).toBeVisible();
  await expect(page.getByTestId("ads-provider-adsense").getByTestId("platform-state")).toHaveText("Not connected");
  await expect.poll(() => new URL(page.url()).search).toBe("");
});

/**
 * Meta Ads with a Facebook login that reaches no ad account yet (core's logins.ts): connected, never an
 * error. The waiting login is seeded as the callback keeps it; the cards and the Meta page say "Connected".
 */
test("a Facebook login with no ad account yet reads as connected on every page, with no error", async ({ page }) => {
  const { ws, storeId } = await ownerWithStore(page, "signin-waiting");
  await db.query(
    // Times in UTC, as Prisma writes them (the column has no time zone; now() would be this machine's local time).
    // A sealed token's shape, never read here: the page only shows who is connected.
    `INSERT INTO ad_logins (id, workspace_id, store_id, provider, access_token_enc, external_user_id, login_name, reason, checked_at, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, 'meta', 'v1.e2e.e2e.e2e', '5550001', 'Sebastian Thomas', 'no_ads_account',
             now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`,
    [ws, storeId],
  );
  // As if this server could connect Meta: the card's buttons show.
  await page.route(`**/api/workspaces/${ws}/stores/${storeId}/ads`, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, Record<string, boolean>>;
    await route.fulfill({ response: res, json: { ...body, configured: { ...body.configured, meta: true } } });
  });

  await page.goto("/settings/ads");
  const card = page.getByTestId("ads-provider-meta");
  await expect(card.getByTestId("platform-state")).toHaveText("Connected");
  await expect(card.getByTestId("ads-provider-meta-login")).toContainText("Sebastian Thomas");
  await expect(card.getByTestId("ads-provider-meta-login-text")).toContainText("Your Facebook login is connected");
  await expect(card.getByRole("button", { name: "Check for ad accounts" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Choose ad accounts" })).toBeVisible();
  // No message of ours on the page (Next.js's route announcer is an empty alert of its own).
  await expect(page.getByRole("alert").and(page.locator(":not(#__next-route-announcer__)"))).toHaveCount(0);
  await card.screenshot({ path: "test-results/meta-waiting-login-card.png" });

  await page.goto("/settings/integrations");
  const row = page.getByTestId("int-meta");
  await expect(row).toContainText("Connected");
  await expect(row.getByTestId("int-meta-login")).toContainText("Sebastian Thomas");

  await page.goto("/advertising/meta");
  await expect(page.getByTestId("advertising-waiting")).toContainText("Meta Ads is connected");
  await expect(page.getByTestId("advertising-not-connected")).toHaveCount(0);
});

test("Continue with Meta Ads on a login with no ad account yet says it's connected, not an error", async ({ page }) => {
  const { ws, storeId } = await ownerWithStore(page, "signin-meta-wait");
  await signInComesBackTo(page, ws, storeId, "meta", (s) => `/settings/ads?${new URLSearchParams({ waiting: "no_ads_account", provider: "meta", store: s })}`);
  await page.goto("/settings/ads");
  await page.getByTestId("connect-meta").click();
  await expect(page.getByText("Meta Ads is connected. Its ad accounts appear here by themselves")).toBeVisible();
  await expect(page.getByText(/can't reach any ad account|nothing was connected/)).toHaveCount(0);
});
