import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertAdConnection, insertStore, signUp, uniqueEmail } from "./helpers";

/**
 * Settings → Integrations (a card each for Google Ads, Shopify, WhatsApp, Meta Ads and Google AdSense)
 * and Settings → Advertising (every ad account), through the real app. Google, Meta and AdSense can't run here and
 * e2e/server.env sets none of them up, so Meta and AdSense say Coming soon until an account is
 * connected, while Google Ads offers its demo instead (server.env sets GOOGLE_ADS_DEMO_ENABLED;
 * e2e/adsDemo.spec.ts drives it): Not connected, with Try demo as its only button. Connected accounts
 * are written straight into ad_connections, one per state, and are worded as lib/adConnections.ts says.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.DATABASE_URL });
test.afterAll(() => db.end());

/** A verified owner with a workspace and a connected store. */
async function ownerWithStore(page: Page, prefix: string) {
  const email = uniqueEmail(prefix);
  await signUp(page, email);
  const ws = await createWorkspace(page, "Ads Co");
  const storeId = await insertStore(db, ws, `${prefix}-${Date.now()}.myshopify.com`);
  return { email, ws, storeId };
}

/** The WhatsApp card loads Meta's SDK: answer it with nothing, so no page reaches facebook.net. */
const quietMeta = (page: Page) => page.route("https://connect.facebook.net/**", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));

const platform = (page: Page, testid: string) => page.getByTestId(testid).getByTestId("platform-state");
const account = (page: Page, accountId: string) => page.locator(`[data-testid="ad-account"][data-account="${accountId}"]`);

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

/** Whether this API sends the reason codes and account facts of the 2026-10-19 contract (errorCode, accountStatus, sites…). */
async function apiSendsReasons(page: Page, ws: string, storeId: string): Promise<boolean> {
  return page.evaluate(async ([w, s]) => {
    const r = await fetch(`/api/workspaces/${w}/stores/${s}/ads`);
    const body = (await r.json()) as { connections: Array<Record<string, unknown>> };
    return body.connections.length > 0 && "errorCode" in body.connections[0]! && "availableSites" in body.connections[0]!;
  }, [ws, storeId] as const);
}

test("Integrations shows Google Ads, Shopify, WhatsApp, Meta Ads and Google AdSense; one not set up says Coming soon or offers its demo", async ({ page }) => {
  await ownerWithStore(page, "hub");
  await quietMeta(page);
  await page.goto("/settings/integrations");

  await expect(page.getByRole("heading", { level: 1, name: "Integrations" })).toBeVisible();
  const cards = page.locator('section[data-testid^="int-"]');
  await expect(cards).toHaveCount(5);
  expect(await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")))).toEqual(["int-google", "int-shopify", "int-whatsapp", "int-meta", "int-adsense"]);
  // Signing in with Google is Settings → Security's, not one of the cards.
  await expect(page.getByRole("button", { name: "Continue with Google" })).toHaveCount(0);
  // One Click Setup: Learn more says how, and folds away again.
  const setup = page.getByTestId("one-click-setup");
  await setup.getByRole("button", { name: "Learn more" }).click();
  await expect(setup.getByRole("button", { name: "Learn more" })).toHaveAttribute("aria-expanded", "true");
  await expect(setup.getByRole("listitem")).toHaveCount(3);
  await expect(setup).toContainText("There are no keys or codes to copy");
  await setup.getByRole("button", { name: "Learn more" }).click();
  await expect(setup.getByRole("listitem")).toHaveCount(0);
  await expect(platform(page, "int-shopify")).toHaveText("Connected");
  await expect(page.getByTestId("int-shopify").getByRole("link", { name: "Manage Shopify" })).toHaveAttribute("href", "/settings/stores");
  await expect(platform(page, "int-whatsapp")).toHaveText("Not connected");

  // Meta and AdSense aren't set up on this server and have no demo: "Coming soon", never "Not connected", and nothing to press.
  for (const [id, name] of [
    ["int-meta", "Meta Ads"],
    ["int-adsense", "Google AdSense"],
  ] as const) {
    const card = page.getByTestId(id);
    await expect(card.getByRole("heading", { name })).toBeVisible();
    await expect(platform(page, id)).toHaveText("Coming soon");
    await expect(card).toContainText(`${name} sign-in is being switched on`);
    await expect(card.getByRole("button")).toHaveCount(0);
  }
  await expect(page.getByTestId("int-meta").getByRole("list", { name: "What Meta Ads brings" })).toContainText("Spend & ROAS");
  // Google Ads isn't set up either, but its demo is offered: "Not connected" (never "Coming soon" with
  // a button under it), and Try demo as the only button.
  const google = page.getByTestId("int-google");
  await expect(google.getByRole("heading", { name: "Google Ads" })).toBeVisible();
  await expect(platform(page, "int-google")).toHaveText("Not connected");
  await expect(google.getByRole("button", { name: "Connect Google Ads" })).toHaveCount(0);
  await expect(google.getByRole("button")).toHaveCount(1);
  await expect(google.getByTestId("int-google-try-demo")).toHaveText("Try demo");

  // Settings → Advertising keeps a card per platform, and says what the real sign-in still lacks.
  await page.goto("/settings/ads");
  await expect(platform(page, "ads-provider-google")).toHaveText("Not connected");
  await expect(page.getByTestId("ads-provider-google-not-configured")).toContainText("it still needs GOOGLE_ADS_");
  await expect(page.getByTestId("ads-provider-google").getByTestId("try-demo-google")).toHaveText("Try demo");
  for (const p of ["meta", "adsense"]) await expect(platform(page, `ads-provider-${p}`)).toHaveText("Coming soon");
});

test("Google Ads and Meta Ads say what their screen shows first while their platform still reviews bizinsights; AdSense goes straight to Google", async ({ page }) => {
  const { ws, storeId } = await ownerWithStore(page, "choose");
  await quietMeta(page);
  // This server as if every platform's sign-in were set up, with Google Ads and Meta still under their platform's review.
  await page.route(`**/api/workspaces/${ws}/stores/${storeId}/ads`, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, Record<string, boolean>>;
    await route.fulfill({
      response: res,
      json: { ...body, configured: { google: true, meta: true, adsense: true }, restricted: { google: true, meta: true, adsense: false } },
    });
  });
  const started: string[] = [];
  await page.route(`**/api/workspaces/${ws}/stores/${storeId}/ads/*/nango/session`, (route) => {
    const p = new URL(route.request().url()).pathname.split("/").at(-3)!;
    started.push(p);
    // No Nango here: the sign-in window can't open, which the card says; what matters is that it was started.
    return route.fulfill({ status: 503, json: { error: "nango_busy", message: "x" } });
  });
  await page.goto("/settings/integrations");

  const google = page.getByTestId("int-google");
  await expect(platform(page, "int-google")).toHaveText("Not connected");
  // The real sign-in is set up, so the demo is a line under it, not the button.
  await expect(google.getByTestId("int-google-try-demo")).toBeVisible();
  // Google Ads is still unverified: what Google's screen will say, before going there. Escape closes it.
  await google.getByRole("button", { name: "Connect Google Ads" }).click();
  const beforeGoogle = page.getByRole("dialog", { name: "Before you go to Google" });
  await expect(beforeGoogle.getByTestId("google-unverified")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(beforeGoogle).toHaveCount(0);
  expect(started).toEqual([]);
  await google.getByRole("button", { name: "Connect Google Ads" }).click();
  await beforeGoogle.getByRole("button", { name: "Continue to Google" }).click();
  await expect.poll(() => started).toEqual(["google"]);
  await expect(page.getByText("The Google Ads sign-in window couldn't be opened just now")).toBeVisible();

  // AdSense never meets Google's unverified screen: straight to Google.
  await page.getByTestId("int-adsense").getByRole("button", { name: "Connect Google AdSense" }).click();
  await expect.poll(() => started).toEqual(["google", "adsense"]);

  // Meta: Facebook would show anyone but a tester "Feature Unavailable", so the page says so first.
  await page.getByTestId("int-meta").getByRole("button", { name: "Connect Meta Ads" }).click();
  const before = page.getByRole("dialog", { name: "Before you go to Facebook" });
  await expect(before.getByTestId("meta-testers-only")).toBeVisible();
  await before.getByRole("button", { name: "Continue to Facebook" }).click();
  await expect.poll(() => started).toEqual(["google", "adsense", "meta"]);
});

test("each connected account shows its state, and Integrations the most pressing one per platform", async ({ page }) => {
  const { ws, storeId } = await ownerWithStore(page, "states");
  const at = { workspaceId: ws, storeId };
  await insertAdConnection(db, {
    ...at,
    provider: "google",
    accountId: "111-111-1111",
    accountName: "Brand Search",
    lastSyncedAt: hoursAgo(1),
    syncedThrough: "2026-10-18",
    historyFrom: "2024-09-20",
    grantedScopes: ["https://www.googleapis.com/auth/adwords"],
  });
  // Just connected, so not synced yet, and on another time zone than the store's (UTC).
  await insertAdConnection(db, { ...at, provider: "google", accountId: "222-222-2222", accountName: "New Account", timezone: "America/Los_Angeles", connectedAt: new Date() });
  await insertAdConnection(db, { ...at, provider: "google", accountId: "777-777-7777", accountName: "Old Promo", enabled: false, lastSyncedAt: hoursAgo(5) });
  // Hidden, and worse than anything shown on the Google card: the card mustn't count it.
  await insertAdConnection(db, { ...at, provider: "google", accountId: "999-999-9999", accountName: "Lapsed Promo", enabled: false, status: "reconnect", errorCode: "auth_expired", lastSyncedAt: hoursAgo(400) });
  await insertAdConnection(db, {
    ...at,
    provider: "meta",
    accountId: "act_333",
    accountName: "Shop Ads",
    status: "error",
    errorCode: "provider_error",
    lastError: "(#100) Unsupported get request",
    lastSyncedAt: hoursAgo(30),
  });
  await insertAdConnection(db, { ...at, provider: "meta", accountId: "act_444", accountName: "Agency Ads", status: "permission", errorCode: "no_access" });
  await insertAdConnection(db, { ...at, provider: "meta", accountId: "act_888", accountName: "Lapsed Ads", status: "reconnect", errorCode: "auth_expired" });
  await insertAdConnection(db, { ...at, provider: "adsense", accountId: "pub-555", accountName: "My Site", status: "unavailable", errorCode: "account_not_ready" });

  const expected: Array<[string, string, string]> = [
    ["111-111-1111", "connected", "Connected"],
    ["222-222-2222", "synchronizing", "Synchronizing"],
    ["777-777-7777", "connected", "Connected"],
    ["999-999-9999", "reconnect_required", "Reconnect required"],
    ["act_333", "sync_failed", "Sync failed"],
    ["act_444", "permission_missing", "Permission missing"],
    ["act_888", "reconnect_required", "Reconnect required"],
    ["pub-555", "verification_pending", "Verification pending"],
  ];

  await quietMeta(page);
  // Integrations: each platform shows its most pressing account, and sends there to fix it. Google Ads is
  // Synchronizing: hidden accounts don't count, or Lapsed Promo would outrank them all.
  await page.goto("/settings/integrations");
  await expect(platform(page, "int-google")).toHaveText("Synchronizing");
  await expect(page.getByTestId("int-google-accounts")).toContainText("+3 more");
  await expect(page.getByTestId("int-google").getByRole("link", { name: "Manage Google Ads" })).toHaveAttribute("href", "/settings/ads");
  await expect(platform(page, "int-adsense")).toHaveText("Verification pending");
  await expect(page.getByTestId("int-adsense-accounts")).toContainText("Account: My Site");
  await expect(page.getByTestId("int-adsense").getByRole("link", { name: "Fix Google AdSense" })).toHaveAttribute("href", "/settings/ads");
  await expect(platform(page, "int-meta")).toHaveText("Reconnect required");
  await expect(page.getByTestId("int-meta-accounts")).toContainText("+2 more");
  await expect(page.getByTestId("int-meta").getByRole("link", { name: "Fix Meta Ads" })).toHaveAttribute("href", "/settings/ads");
  await expect(page.getByTestId("ad-account")).toHaveCount(0);

  // Settings → Advertising: every account, each worded as lib/adConnections.ts says.
  await page.goto("/settings/ads");
  await expect(platform(page, "ads-provider-google")).toHaveText("Synchronizing");
  await expect(page.getByTestId("ads-provider-google").getByTestId("platform-hidden")).toHaveCount(0);
  await expect(platform(page, "ads-provider-meta")).toHaveText("Reconnect required");
  await expect(platform(page, "ads-provider-adsense")).toHaveText("Verification pending");
  for (const [id, state, label] of expected) {
    await expect(account(page, id)).toHaveAttribute("data-state", state);
    await expect(account(page, id).getByTestId("account-state")).toHaveText(label);
  }

  // What failed is said in plain words; the platform's own text only behind Details.
  const failed = account(page, "act_333");
  await expect(failed.getByTestId("account-message")).toContainText("Meta refused the last update");
  await expect(failed.getByTestId("account-message")).not.toContainText("#100");
  await failed.locator("summary", { hasText: /^Details/ }).click();
  await expect(failed).toContainText("(#100) Unsupported get request");
  await expect(account(page, "act_444").getByTestId("account-message")).toContainText("can no longer see this ad account");
  await expect(account(page, "act_888").getByTestId("account-message")).toContainText("Press Reconnect");

  const connected = account(page, "111-111-1111");
  await expect(connected).toContainText("1 hour ago");
  await expect(connected).toContainText("Read Google Ads reports");
  await expect(connected).toContainText("Google has no read-only permission for Google Ads; bizinsights only reads.");
  await expect(connected).toContainText("Data through");
  await expect(account(page, "222-222-2222").getByTestId("timezone-note")).toContainText("America/Los_Angeles");
  await expect(account(page, "777-777-7777")).toContainText("Hidden from the dashboard");
  // Every row's controls are named for their account.
  await expect(page.getByRole("checkbox", { name: "Show on dashboard: Brand Search" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Show on dashboard: Old Promo" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Disconnect Agency Ads" })).toBeVisible();
});

test("reasons only the newer API sends: authorization, permission taken back, closed, under review, a requested sync, AdSense sites", async ({ page }) => {
  const { ws, storeId } = await ownerWithStore(page, "reasons");
  const at = { workspaceId: ws, storeId };
  await insertAdConnection(db, { ...at, provider: "google", accountId: "100-000-0001", accountName: "Left Behind", status: "reconnect", errorCode: "connector_left" });
  await insertAdConnection(db, { ...at, provider: "meta", accountId: "act_101", accountName: "Unticked", status: "reconnect", errorCode: "scope_missing" });
  await insertAdConnection(db, { ...at, provider: "google", accountId: "100-000-0003", accountName: "Closed One", status: "unavailable", errorCode: "account_closed", lastSyncedAt: hoursAgo(48) });
  await insertAdConnection(db, { ...at, provider: "google", accountId: "100-000-0004", accountName: "Suspended", status: "unavailable", errorCode: "account_disabled" });
  await insertAdConnection(db, { ...at, provider: "meta", accountId: "act_105", accountName: "In Review", accountStatus: "under_review", lastSyncedAt: hoursAgo(2) });
  await insertAdConnection(db, { ...at, provider: "meta", accountId: "act_106", accountName: "Not Yet Approved", status: "error", errorCode: "not_approved" });
  await insertAdConnection(db, {
    ...at,
    provider: "adsense",
    accountId: "pub-107",
    accountName: "Earning Site",
    lastSyncedAt: hoursAgo(3),
    syncRequestedAt: new Date(),
    sites: ["shop.example"],
  });
  await page.goto("/settings/ads");
  await expect(page.getByTestId("ad-account")).toHaveCount(7);
  test.skip(!(await apiSendsReasons(page, ws, storeId)), "This API doesn't send errorCode, accountStatus or availableSites yet (the API workstream's contract adds them).");

  for (const [id, state] of [
    ["100-000-0001", "authorization_required"],
    ["act_101", "permission_missing"],
    ["100-000-0003", "disconnected"],
    ["100-000-0004", "sync_failed"],
    ["act_105", "verification_pending"],
    ["act_106", "verification_pending"],
    ["pub-107", "synchronizing"],
  ] as const) {
    await expect(account(page, id)).toHaveAttribute("data-state", state);
  }
  await expect(account(page, "100-000-0001").getByTestId("account-message")).toContainText("Someone with access to the account needs to press Reconnect");

  // AdSense: counted for one site; back to every site.
  const sites = account(page, "pub-107").getByTestId("adsense-sites");
  await expect(sites).toContainText("Sites counted for this store: shop.example");
  await sites.locator("summary").click();
  await sites.getByLabel("Every site, including sites added later").check();
  await sites.getByTestId("adsense-sites-save").click();
  await expect(account(page, "pub-107").getByTestId("adsense-sites")).toContainText("Sites counted for this store: Every site");
  const { rows } = await db.query("SELECT sites FROM ad_connections WHERE account_id = 'pub-107' AND store_id = $1", [storeId]);
  expect(rows[0].sites).toEqual([]);
});

test("an account hidden before its first sync isn't Synchronizing and nothing looks again for it; a first sync that never landed says so", async ({ page }) => {
  const { ws, storeId } = await ownerWithStore(page, "hidden");
  const at = { workspaceId: ws, storeId };
  // Unticked in the picker just after connecting: never synced, and the worker skips hidden accounts.
  await insertAdConnection(db, { ...at, provider: "google", accountId: "456-000-0001", accountName: "Unticked New", enabled: false, connectedAt: new Date() });
  // On the dashboard, connected three days ago, and its first sync never landed.
  await insertAdConnection(db, { ...at, provider: "meta", accountId: "act_4561", accountName: "Stalled Ads" });
  const adsPath = `/api/workspaces/${ws}/stores/${storeId}/ads`;
  let looks = 0;
  page.on("request", (r) => {
    if (r.method() === "GET" && new URL(r.url()).pathname === adsPath) looks++;
  });
  await quietMeta(page);
  // The page's own clock, so its 5-second look-again can be run through without waiting.
  await page.clock.install();

  for (const path of ["/settings/integrations", "/settings/ads"]) {
    await page.goto(path);
    const hub = path === "/settings/integrations";
    await expect(platform(page, hub ? "int-google" : "ads-provider-google")).toHaveText("Connected");
    await expect(platform(page, hub ? "int-meta" : "ads-provider-meta")).toHaveText("Sync failed");
    if (!hub) {
      await expect(page.getByTestId("ads-provider-google").getByTestId("platform-hidden")).toBeVisible();
      const hidden = account(page, "456-000-0001");
      await expect(hidden).toHaveAttribute("data-state", "connected");
      await expect(hidden.getByTestId("account-message")).toHaveText("Nothing fetched yet: bizinsights fetches this account's figures once it's shown on the dashboard.");
      await expect(account(page, "act_4561").getByTestId("account-message")).toContainText("The first update hasn't come through yet");
    }

    const before = looks;
    await page.clock.runFor(16_000);
    await page.waitForTimeout(500);
    expect(looks, `${path} looked again with nothing synchronizing`).toBe(before);
  }

  // The control (the same wait, well short of 5 real seconds): an account just connected to the
  // dashboard is Synchronizing, and the page looks again by itself.
  await insertAdConnection(db, { ...at, provider: "adsense", accountId: "pub-4562", accountName: "Fresh Site", connectedAt: new Date() });
  await page.reload();
  await expect(account(page, "pub-4562")).toHaveAttribute("data-state", "synchronizing");
  const before = looks;
  await page.clock.runFor(16_000);
  await page.waitForTimeout(500);
  expect(looks).toBeGreaterThan(before);
});

test("a look again sent before a change and answered after it doesn't undo the change", async ({ page }) => {
  const { ws, storeId } = await ownerWithStore(page, "order");
  // Just connected, so Synchronizing: the page looks again every 5 seconds.
  await insertAdConnection(db, { workspaceId: ws, storeId, provider: "google", accountId: "789-000-0001", accountName: "Fresh Search", connectedAt: new Date() });
  const adsPath = `/api/workspaces/${ws}/stores/${storeId}/ads`;
  let gets = 0;
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  let answered = () => {};
  const polled = new Promise<void>((r) => (answered = r));
  await page.route(`**${adsPath}`, async (route) => {
    if (route.request().method() !== "GET" || ++gets !== 2) return route.continue();
    // The first look again: answered by the server now, before the change, and delivered after it.
    const res = await route.fetch();
    answered();
    await held;
    await route.fulfill({ response: res });
  });
  await page.clock.install();
  await page.goto("/settings/ads");
  const box = page.getByRole("checkbox", { name: "Show on dashboard: Fresh Search" });
  await expect(box).toBeChecked();
  await page.clock.runFor(5_500);
  await polled;

  await box.click();
  await expect(box).not.toBeChecked();
  await expect(account(page, "789-000-0001")).toContainText("Hidden from the dashboard");
  release();
  await page.waitForTimeout(1_000);
  // Read at once, not waited for: the next look again would put a wrong answer right within seconds.
  expect(await box.isChecked()).toBe(false);
  expect(await account(page, "789-000-0001").textContent()).toContain("Hidden from the dashboard");
  const { rows } = await db.query("SELECT enabled FROM ad_connections WHERE account_id = '789-000-0001' AND store_id = $1", [storeId]);
  expect(rows[0].enabled).toBe(false);
});

test("a member who may only view integrations gets no buttons; Manage integrations brings them", async ({ page }) => {
  const { email, ws, storeId } = await ownerWithStore(page, "member");
  await insertAdConnection(db, { workspaceId: ws, storeId, provider: "google", accountId: "123-000-0001", accountName: "Shop Search", lastSyncedAt: hoursAgo(1) });
  const grant = (permissions: string[]) =>
    db.query("UPDATE memberships SET role = 'custom', permissions = $3 WHERE workspace_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)", [ws, email, permissions]);
  await quietMeta(page);

  await grant(["integrations.status"]);
  await page.goto("/settings/integrations");
  await expect(platform(page, "int-google")).toHaveText("Connected");
  await expect(page.getByTestId("int-google-accounts")).toContainText("Account: Shop Search");
  await expect(page.getByText("needs the Manage integrations permission")).toBeVisible();
  await expect(platform(page, "int-whatsapp")).toHaveText("Not connected");
  await expect(page.getByTestId("wa-connect")).toHaveCount(0);
  await page.goto("/settings/ads");
  await expect(account(page, "123-000-0001").getByTestId("account-state")).toHaveText("Connected");
  await expect(page.getByText("needs the Manage integrations permission")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Show on dashboard: Shop Search" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Disconnect Shop Search" })).toHaveCount(0);

  // "Manage integrations" without being an owner or admin: the WhatsApp and ad buttons (the API allows them too).
  await grant(["integrations.status", "integrations.manage"]);
  await page.goto("/settings/integrations");
  await expect(page.getByTestId("wa-connect")).toBeVisible();
  await expect(page.getByText("needs the Manage integrations permission")).toHaveCount(0);
  await page.goto("/settings/ads");
  await expect(page.getByRole("checkbox", { name: "Show on dashboard: Shop Search" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Disconnect Shop Search" })).toBeVisible();
});

test("disconnecting asks first, then says bizinsights couldn't hand the access back and where to remove it", async ({ page }) => {
  const { ws, storeId } = await ownerWithStore(page, "disconnect");
  const otherStore = await insertStore(db, ws, `disconnect-other-${Date.now()}.myshopify.com`);
  await insertAdConnection(db, { workspaceId: ws, storeId, provider: "google", accountId: "321-000-0001", accountName: "Only Account", lastSyncedAt: hoursAgo(1) });
  await page.goto("/settings/ads");
  await page.getByTestId("store-switcher").selectOption(storeId);
  await page.getByRole("button", { name: "Disconnect Only Account" }).click();
  const dialog = page.getByRole("dialog", { name: "Disconnect Only Account?" });
  await expect(dialog).toContainText("every figure it fetched for it");
  // Keyboard: the dialog opens on Cancel, and Escape closes it.
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.getByRole("button", { name: "Disconnect Only Account" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Disconnect" }).click();
  // Its placeholder token can't reach Google, so bizinsights can't give the access back itself.
  const note = page.getByRole("status").filter({ hasText: "Only Account is disconnected" });
  await expect(note).toContainText("couldn't hand its access back to Google");
  const removeAccess = note.getByRole("link", { name: "your Google Account's third-party connections" });
  await expect(removeAccess).toHaveAttribute("href", "https://myaccount.google.com/permissions");
  // The row (and its Disconnect button) is gone: the keyboard focus is on the note, and Tab reaches its link.
  await expect(page.getByTestId("action-note")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(removeAccess).toBeFocused();
  await expect(platform(page, "ads-provider-google")).toHaveText("Disconnected");
  const { rows } = await db.query("SELECT count(*)::int AS n FROM ad_connections WHERE store_id = $1", [storeId]);
  expect(rows[0].n).toBe(0);

  // Another store chosen at the top (the page stays): the note and "Disconnected" were about the first
  // one. Nothing is connected for this store, so the card is back to offering the demo.
  await page.getByTestId("store-switcher").selectOption(otherStore);
  await expect(platform(page, "ads-provider-google")).toHaveText("Not connected");
  await expect(page.getByTestId("action-note")).toHaveCount(0);
});

test("the account picker: search, a count, hidden and closed accounts left unticked, and a note when the list was cut short", async ({ page }) => {
  const { ws, storeId } = await ownerWithStore(page, "picker");
  const nonce = "e2e-pending-nonce-0001";
  const accounts = Array.from({ length: 24 }, (_, i) => ({
    accountId: `act_${1000 + i}`,
    name: i === 0 ? "Northwind Shop" : `Client ${i}`,
    currency: "USD",
    timezone: "UTC",
    connected: i < 2,
    enabled: i < 2 ? i === 0 : null,
    status: i === 2 ? "closed" : null,
    statusDetail: null,
  }));
  // The list a sign-in leaves waiting can't be made here (it lives in the server's memory): answer it as the API would.
  await page.route(`**/api/workspaces/${ws}/stores/${storeId}/ads/pending/${nonce}`, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { provider: "meta", expiresAt: new Date(Date.now() + 600_000).toISOString(), truncated: true, accounts } })
      : route.fulfill({ json: { ok: true } }),
  );
  await page.goto(`/settings/ads?choose=${nonce}&store=${storeId}`);
  const picker = page.getByTestId("ads-choose");
  await expect(picker.getByRole("heading", { name: /Choose Meta Ads accounts/ })).toBeVisible();
  // While choosing, the Meta card says so.
  await expect(platform(page, "ads-provider-meta")).toHaveText("Connecting");
  await expect(picker).toContainText("more accounts for this login than bizinsights could list");
  // Reconnecting keeps what was shown on the dashboard: the hidden account isn't ticked again.
  await expect(picker.getByTestId("ads-choose-count")).toHaveText("1 selected");
  const tick = (id: string) => picker.locator("li", { hasText: id }).getByRole("checkbox");
  await expect(tick("act_1000")).toBeChecked();
  await expect(tick("act_1001")).not.toBeChecked();
  // Closed at the platform: not ticked for anyone.
  await expect(tick("act_1002")).not.toBeChecked();
  await expect(picker.getByText("connected, hidden from the dashboard")).toBeVisible();
  await expect(picker.getByText("Closed", { exact: true })).toBeVisible();

  await picker.getByLabel("Find an account").fill("client 2");
  await expect(picker.getByRole("checkbox")).toHaveCount(5); // Client 2, 20-23
  await picker.getByRole("button", { name: "Select all shown" }).click();
  await expect(picker.getByTestId("ads-choose-count")).toHaveText("6 selected · 5 of 24 shown");
  await picker.getByLabel("Find an account").fill("");
  await expect(tick("act_1000")).toBeChecked();
  await expect(picker.getByTestId("ads-choose-confirm")).toHaveText("Connect 6 accounts");

  await picker.getByRole("button", { name: "Cancel" }).click();
  await expect(picker).toHaveCount(0);
  await expect(platform(page, "ads-provider-meta")).toHaveText("Coming soon");
});

test("the account picker on a first connection ticks every account that runs, and leaves closed and disabled ones unticked", async ({ page }) => {
  const { ws, storeId } = await ownerWithStore(page, "picker-first");
  const nonce = "e2e-pending-nonce-0002";
  const accounts = [
    { accountId: "123-000-1001", name: "Main Store", status: "active" },
    { accountId: "123-000-1002", name: "Second Store", status: null },
    { accountId: "123-000-1003", name: "Old Brand", status: "closed" },
    { accountId: "123-000-1004", name: "Paused Brand", status: "disabled" },
  ].map((a) => ({ ...a, currency: "USD", timezone: "UTC", connected: false, enabled: null, statusDetail: null }));
  await page.route(`**/api/workspaces/${ws}/stores/${storeId}/ads/pending/${nonce}`, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { provider: "google", expiresAt: new Date(Date.now() + 600_000).toISOString(), truncated: false, accounts } })
      : route.fulfill({ json: { ok: true } }),
  );
  await page.goto(`/settings/ads?choose=${nonce}&store=${storeId}`);
  const picker = page.getByTestId("ads-choose");
  await expect(picker.getByRole("heading", { name: /Choose Google Ads accounts/ })).toBeVisible();
  const tick = (id: string) => picker.locator("li", { hasText: id }).getByRole("checkbox");
  await expect(tick("123-000-1001")).toBeChecked();
  await expect(tick("123-000-1002")).toBeChecked();
  await expect(tick("123-000-1003")).not.toBeChecked();
  await expect(tick("123-000-1004")).not.toBeChecked();
  await expect(picker.getByTestId("ads-choose-count")).toHaveText("2 selected");
  await expect(picker.locator("li", { hasText: "123-000-1003" })).toContainText("Closed");
  await expect(picker.locator("li", { hasText: "123-000-1004" })).toContainText("Disabled by Google Ads");
  // A short list: no search box, and nothing said about a list cut short.
  await expect(picker.getByLabel("Find an account")).toHaveCount(0);
  await expect(picker).not.toContainText("more accounts for this login");
});

test("a sign-in that came back with a problem is explained, whatever the code", async ({ page }) => {
  const { storeId } = await ownerWithStore(page, "callback");
  await page.goto(`/settings/ads?error=rate_limited&provider=google&store=${storeId}`);
  await expect(page.getByRole("alert").filter({ hasText: "You started connecting several times in the last few minutes" })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/ads$/);
  await page.goto(`/settings/ads?error=not_approved&provider=google&store=${storeId}`);
  await expect(page.getByRole("alert").filter({ hasText: "Google is still approving bizinsights" })).toBeVisible();
  // Anything else typed into the address: the general sentence, never "undefined" or code.
  await page.goto(`/settings/ads?error=constructor&provider=google&store=${storeId}`);
  await expect(page.locator(".alert[role=alert]")).toHaveText("Connecting didn't work. Please try again.");
});

test("the data deletion page shows a Meta deletion request's status, and the privacy policy explains removing bizinsights in Facebook", async ({ page }) => {
  await page.goto("/data-deletion");
  await expect(page.getByTestId("deletion-status")).toHaveCount(0);
  await expect(page.locator("main")).toContainText("send Facebook's data deletion request");

  // Each answer GET /api/meta/data-deletion/:code can give (the route itself: the next test).
  const code = "0123456789abcdef0123";
  const status = page.getByTestId("deletion-status");
  const answering = async (reply: { status: number; json: object }) => {
    await page.unroute("**/api/meta/data-deletion/**");
    await page.route("**/api/meta/data-deletion/**", (route) => route.fulfill(reply));
  };
  await answering({ status: 200, json: { status: "done", at: "2026-10-18T09:30:00.000Z" } });
  await page.goto(`/data-deletion?code=${code}`);
  await expect(status).toContainText("Deletion complete");
  await expect(status).toContainText(`Deletion request ${code} is done: completed on`);
  await answering({ status: 200, json: { status: "unknown" } });
  await page.reload();
  await expect(status).toContainText(`no deletion request with the code ${code}`);
  // A 404 is a route that isn't there, not an unknown request: never "no deletion request".
  await answering({ status: 404, json: { error: "not_found" } });
  await page.reload();
  await expect(status).toContainText(`We couldn't check deletion request ${code} just now`);
  await page.unroute("**/api/meta/data-deletion/**");
  let asked = false;
  await page.route("**/api/meta/data-deletion/**", (route) => {
    asked = true;
    return route.fulfill({ status: 200, json: { status: "unknown" } });
  });
  await page.goto(`/data-deletion?code=${encodeURIComponent("<script>")}`);
  await expect(status).toContainText("isn't a confirmation code bizinsights gives");
  expect(asked).toBe(false);
  await page.unroute("**/api/meta/data-deletion/**");

  await page.goto("/privacy");
  await expect(page.locator("main")).toContainText("Business integrations");
  await expect(page.locator("main")).toContainText("stops reading your Meta ad accounts: at once when Facebook lets it know");
  // Google's Limited Use statement stays as it is.
  await expect(page.locator("main")).toContainText("including the Limited Use requirements");
});

test("a deletion request's status comes from the API: an unknown code is a 200 'unknown' (the newer API)", async ({ page }) => {
  // The route ships with the API of the 2026-10-19 contract: told apart by the reasons GET .../ads sends.
  const { ws, storeId } = await ownerWithStore(page, "deletion");
  await insertAdConnection(db, { workspaceId: ws, storeId, provider: "meta", accountId: "act_9001", accountName: "Any Ads", lastSyncedAt: hoursAgo(1) });
  test.skip(!(await apiSendsReasons(page, ws, storeId)), "This API doesn't implement the 2026-10-19 contract yet (the API workstream adds GET /api/meta/data-deletion/:code with it).");

  const code = "fedcba9876543210fedc";
  const res = await page.request.get(`/api/meta/data-deletion/${code}`);
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: "unknown" });
  await page.goto(`/data-deletion?code=${code}`);
  await expect(page.getByTestId("deletion-status")).toContainText(`no deletion request with the code ${code}`);
});
