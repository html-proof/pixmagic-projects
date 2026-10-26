import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertStore, signUp, uniqueEmail } from "./helpers";

/**
 * Google AdSense (Settings → Integrations) through Nango's Connect UI (docs/nango.md), through the real app and the
 * real @nangohq/frontend SDK. Nango can't run here: its Connect UI page (connect.nango.dev, framed by the
 * SDK) is answered with a stand-in that speaks the SDK's messages, and the API's Nango answers (which need
 * a Nango environment) are answered as the API would. What is tested is the card: the session, the frame,
 * what it does with "connect", "close" and a refused finish.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.DATABASE_URL });
test.afterAll(() => db.end());

async function ownerWithStore(page: Page, prefix: string) {
  await signUp(page, uniqueEmail(prefix));
  const ws = await createWorkspace(page, "Nango Co");
  const storeId = await insertStore(db, ws, `${prefix}-${Date.now()}.myshopify.com`);
  return { ws, storeId };
}

const NONCE = "e2e-nango-session-nonce-01";

/** Settings → Integrations: Google AdSense's Connect. Its card, for what follows. */
async function chooseAdsense(page: Page) {
  const card = page.getByTestId("int-adsense");
  await card.getByRole("button", { name: "Connect Google AdSense" }).click();
  return card;
}

/**
 * This server as if Nango were set up for AdSense, and Nango's Connect UI as a page that does what the
 * real one does once the person authorizes (`then: "connect"`) or closes it (`then: "close"`).
 */
async function nangoHere(page: Page, ws: string, storeId: string, then: "connect" | "close") {
  const base = `**/api/workspaces/${ws}/stores/${storeId}/ads`;
  await page.route(base, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, Record<string, boolean>>;
    await route.fulfill({ response: res, json: { ...body, configured: { ...body.configured, adsense: true } } });
  });
  const calls: Array<{ path: string; body: unknown }> = [];
  await page.route(`${base}/adsense/nango/*`, async (route) => {
    const path = new URL(route.request().url()).pathname.split("/").pop()!;
    calls.push({ path, body: route.request().postDataJSON() });
    if (path === "session") return route.fulfill({ json: { token: "nango_connect_session_e2e", expiresAt: null, nonce: NONCE } });
    if (path === "cancel") return route.fulfill({ json: { ok: true } });
    return route.fulfill({ status: 409, json: { error: "permission_missing", message: "x" } });
  });
  // The Connect UI: says it's ready, takes the session token the SDK posts, then connects or closes.
  await page.route("https://connect.nango.dev/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body>Connect UI stand-in<script>
        window.addEventListener("message", (e) => {
          if (e.data && e.data.type === "session_token" && e.data.sessionToken === "nango_connect_session_e2e") {
            ${then === "connect" ? `parent.postMessage({ type: "connect", payload: { providerConfigKey: "bizinsights-google-adsense", connectionId: "conn-e2e-1" } }, "*");` : `parent.postMessage({ type: "close" }, "*");`}
          }
        });
        parent.postMessage({ type: "ready" }, "*");
      </script></body></html>`,
    }),
  );
  return calls;
}

test("Google AdSense's Connect opens Nango's Connect UI over the page and lands on the dashboard once connected", async ({ page }) => {
  const { ws, storeId } = await ownerWithStore(page, "nango-ok");
  const calls = await nangoHere(page, ws, storeId, "connect");
  await page.route(`**/api/workspaces/${ws}/stores/${storeId}/ads/adsense/nango/finish`, (route) => {
    calls.push({ path: "finish", body: route.request().postDataJSON() });
    return route.fulfill({ json: { connected: 1, provider: "adsense" } });
  });
  await page.goto("/settings/integrations");
  await chooseAdsense(page);
  await page.waitForURL(/\/dashboard/);
  expect(calls.map((c) => c.path)).toEqual(["session", "finish"]);
  // Only the session's nonce and the connection's id go back: never a token.
  expect(calls[1]!.body).toEqual({ nonce: NONCE, connectionId: "conn-e2e-1" });
});

test("closing the Connect UI ends the session and leaves the card as it was", async ({ page }) => {
  const { ws, storeId } = await ownerWithStore(page, "nango-close");
  const calls = await nangoHere(page, ws, storeId, "close");
  await page.goto("/settings/integrations");
  const card = await chooseAdsense(page);
  await expect.poll(() => calls.map((c) => c.path)).toEqual(["session", "cancel"]);
  expect(calls[1]!.body).toEqual({ nonce: NONCE });
  await expect(page.locator("iframe#connect-ui")).toHaveCount(0);
  await expect(card.getByTestId("platform-state")).toHaveText("Not connected");
  await expect(card.getByRole("button", { name: "Connect Google AdSense" })).toBeEnabled();
});

test("a refused finish says why, and nothing is connected", async ({ page }) => {
  const { ws, storeId } = await ownerWithStore(page, "nango-refused");
  await nangoHere(page, ws, storeId, "connect");
  await page.goto("/settings/integrations");
  const card = await chooseAdsense(page);
  await expect(page.getByText("The permission to read reports wasn't granted")).toBeVisible();
  await expect(card.getByTestId("platform-state")).toHaveText("Not connected");
});

/**
 * Meta Ads with a Facebook login that reaches no ad account yet (core's logins.ts): connected, never an
 * error. The waiting login is seeded as the finish keeps it; the cards and the Meta page say "Connected".
 */
test("a Facebook login with no ad account yet reads as connected on every page, with no error", async ({ page }) => {
  const { ws, storeId } = await ownerWithStore(page, "nango-waiting");
  await db.query(
    // Times in UTC, as Prisma writes them (the column has no time zone; now() would be this machine's local time).
    `INSERT INTO ad_logins (id, workspace_id, store_id, provider, source_login_id, nango_integration_key, external_user_id, login_name, reason, checked_at, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, 'meta', 'conn-e2e-waiting', 'bizinsights-meta-ads', '5550001', 'Sebastian Thomas', 'no_ads_account',
             now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`,
    [ws, storeId],
  );
  // As if this server could connect Meta (Nango can't run here): the card's buttons show.
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
  const { ws, storeId } = await ownerWithStore(page, "nango-meta-wait");
  const base = `**/api/workspaces/${ws}/stores/${storeId}/ads`;
  await page.route(base, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, Record<string, boolean>>;
    await route.fulfill({ response: res, json: { ...body, configured: { ...body.configured, meta: true } } });
  });
  await page.route(`${base}/meta/nango/*`, async (route) => {
    const path = new URL(route.request().url()).pathname.split("/").pop()!;
    if (path === "session") return route.fulfill({ json: { token: "nango_connect_session_e2e", expiresAt: null, nonce: NONCE } });
    if (path === "finish") return route.fulfill({ json: { connected: 0, waiting: true, reason: "no_ads_account", provider: "meta" } });
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("https://connect.nango.dev/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body>Connect UI stand-in<script>
        window.addEventListener("message", (e) => {
          if (e.data && e.data.type === "session_token") parent.postMessage({ type: "connect", payload: { providerConfigKey: "bizinsights-meta-ads", connectionId: "conn-e2e-meta" } }, "*");
        });
        parent.postMessage({ type: "ready" }, "*");
      </script></body></html>`,
    }),
  );
  await page.goto("/settings/ads");
  await page.getByTestId("connect-meta").click();
  await expect(page.getByText("Meta Ads is connected. Its ad accounts appear here by themselves")).toBeVisible();
  await expect(page.getByText(/can't reach any ad account|nothing was connected/)).toHaveCount(0);
});
