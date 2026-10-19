import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertAdConnection, insertStore, signUp, uniqueEmail } from "./helpers";

/**
 * Settings → Connect your business and Settings → Advertising, through the real app. Google, Meta
 * and AdSense can't run here and e2e/server.env sets none of them up, so their cards say Coming soon
 * until an account is connected; connected accounts are written straight into ad_connections, one
 * per state, and both pages must word each the same (lib/adConnections.ts).
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

test("Connect your business lists every card, Google Account first, and ad platforms not set up say Coming soon", async ({ page }) => {
  await ownerWithStore(page, "hub");
  await quietMeta(page);
  await page.goto("/settings/integrations");

  const cards = page.locator('section[data-testid^="int-"]');
  await expect(cards).toHaveCount(6);
  expect(await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")))).toEqual([
    "int-google-account",
    "int-shopify",
    "int-whatsapp",
    "int-google-ads",
    "int-meta-ads",
    "int-adsense-ads",
  ]);
  await expect(platform(page, "int-google-account")).toHaveText("Not linked");
  await expect(page.getByTestId("int-google-account").getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(platform(page, "int-shopify")).toHaveText("Connected");
  await expect(platform(page, "int-whatsapp")).toHaveText("Not connected");

  // Not set up on this server: "Coming soon", never "Not connected", and no button to press.
  for (const [testid, name, button] of [
    ["int-google-ads", "Google Ads", "Connect Google Ads"],
    ["int-meta-ads", "Meta Ads", "Continue with Meta Ads"],
    ["int-adsense-ads", "Google AdSense", "Connect Google AdSense"],
  ] as const) {
    const card = page.getByTestId(testid);
    await expect(card.getByRole("heading", { name })).toBeVisible();
    await expect(platform(page, testid)).toHaveText("Coming soon");
    await expect(card).toContainText(`shows a “${button}” button`);
    await expect(card.getByRole("button")).toHaveCount(0);
  }

  // Settings → Advertising has the same three cards, in the same words.
  await page.goto("/settings/ads");
  for (const p of ["google", "meta", "adsense"]) await expect(platform(page, `ads-provider-${p}`)).toHaveText("Coming soon");
});

test("each connected account shows its state, the same way on both pages", async ({ page }) => {
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
  // Never synced yet, and on another time zone than the store's (UTC).
  await insertAdConnection(db, { ...at, provider: "google", accountId: "222-222-2222", accountName: "New Account", timezone: "America/Los_Angeles" });
  await insertAdConnection(db, { ...at, provider: "google", accountId: "777-777-7777", accountName: "Old Promo", enabled: false, lastSyncedAt: hoursAgo(5) });
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
    ["act_333", "sync_failed", "Sync failed"],
    ["act_444", "permission_missing", "Permission missing"],
    ["act_888", "reconnect_required", "Reconnect required"],
    ["pub-555", "verification_pending", "Verification pending"],
  ];

  await page.route("https://connect.facebook.net/**", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  for (const [path, prefix] of [
    ["/settings/integrations", "int-"],
    ["/settings/ads", "ads-provider-"],
  ] as const) {
    await page.goto(path);
    const card = (p: string) => (prefix === "int-" ? `int-${p}-ads` : `ads-provider-${p}`);
    // A card shows its most pressing account: hidden accounts don't count.
    await expect(platform(page, card("google"))).toHaveText("Synchronizing");
    await expect(platform(page, card("meta"))).toHaveText("Reconnect required");
    await expect(platform(page, card("adsense"))).toHaveText("Verification pending");
    for (const [id, state, label] of expected) {
      await expect(account(page, id)).toHaveAttribute("data-state", state);
      await expect(account(page, id).getByTestId("account-state")).toHaveText(label);
    }

    // What failed is said in plain words; the platform's own text only behind Details.
    const failed = account(page, "act_333");
    await expect(failed.getByTestId("account-message")).toContainText("Meta refused the last update");
    await expect(failed.getByTestId("account-message")).not.toContainText("#100");
    await failed.getByText("Details").click();
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
  }
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

test("a member who may only view integrations gets no buttons; Manage integrations brings them", async ({ page }) => {
  const { email, ws, storeId } = await ownerWithStore(page, "member");
  await insertAdConnection(db, { workspaceId: ws, storeId, provider: "google", accountId: "123-000-0001", accountName: "Shop Search", lastSyncedAt: hoursAgo(1) });
  const grant = (permissions: string[]) =>
    db.query("UPDATE memberships SET role = 'custom', permissions = $3 WHERE workspace_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)", [ws, email, permissions]);
  await quietMeta(page);

  await grant(["integrations.status"]);
  for (const path of ["/settings/integrations", "/settings/ads"]) {
    await page.goto(path);
    await expect(account(page, "123-000-0001").getByTestId("account-state")).toHaveText("Connected");
    await expect(page.getByText("needs the Manage integrations permission")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Show on dashboard: Shop Search" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Disconnect Shop Search" })).toHaveCount(0);
  }
  await page.goto("/settings/integrations");
  await expect(platform(page, "int-whatsapp")).toHaveText("Not connected");
  await expect(page.getByTestId("wa-connect")).toHaveCount(0);

  // "Manage integrations" without being an owner or admin: the WhatsApp and ad buttons (the API allows them too).
  await grant(["integrations.status", "integrations.manage"]);
  await page.goto("/settings/integrations");
  await expect(page.getByTestId("wa-connect")).toBeVisible();
  await expect(page.getByText("needs the Manage integrations permission")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Show on dashboard: Shop Search" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Disconnect Shop Search" })).toBeVisible();
  await page.goto("/settings/ads");
  await expect(page.getByRole("button", { name: "Disconnect Shop Search" })).toBeVisible();
});

test("disconnecting asks first, then says bizinsights couldn't hand the access back and where to remove it", async ({ page }) => {
  const { ws, storeId } = await ownerWithStore(page, "disconnect");
  await insertAdConnection(db, { workspaceId: ws, storeId, provider: "google", accountId: "321-000-0001", accountName: "Only Account", lastSyncedAt: hoursAgo(1) });
  await quietMeta(page);
  await page.goto("/settings/integrations");
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
  await expect(note.getByRole("link", { name: "your Google Account's third-party connections" })).toHaveAttribute("href", "https://myaccount.google.com/permissions");
  await expect(platform(page, "int-google-ads")).toHaveText("Disconnected");
  const { rows } = await db.query("SELECT count(*)::int AS n FROM ad_connections WHERE store_id = $1", [storeId]);
  expect(rows[0].n).toBe(0);
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

test("Google Account: Continue with Google links it from Connect your business, and the page says so on return", async ({ page }) => {
  const email = uniqueEmail("hublink");
  await signUp(page, email);
  await createWorkspace(page, "Link Co");
  await quietMeta(page);
  await page.goto("/settings/integrations");
  const card = page.getByTestId("int-google-account");
  await expect(platform(page, "int-google-account")).toHaveText("Not linked");
  await card.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page.getByRole("heading", { name: "Sign in with Google (test)" })).toBeVisible();
  const google = uniqueEmail("hublink-google");
  await page.getByLabel("Email").fill(google);
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page).toHaveURL(/\/settings\/integrations$/, { timeout: 20_000 });
  await expect(page.getByRole("status").filter({ hasText: "Google is linked" })).toBeVisible();
  await expect(platform(page, "int-google-account")).toHaveText("Linked");
  await expect(card).toContainText(google);
  await expect(card.getByRole("button", { name: "Continue with Google" })).toHaveCount(0);
  await expect(card.getByRole("link", { name: "Manage sign-in methods" })).toHaveAttribute("href", "/settings/security");

  // A link that came back refused is worded, then cleared from the address.
  await page.goto("/settings/integrations?link_error=google_in_use");
  await expect(page.getByRole("alert").filter({ hasText: "already signs in to another bizinsights account" })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/integrations$/);
});

test("the data deletion page shows a Meta deletion request's status, and the privacy policy explains removing bizinsights in Facebook", async ({ page }) => {
  await page.goto("/data-deletion");
  await expect(page.getByTestId("deletion-status")).toHaveCount(0);
  await expect(page.locator("main")).toContainText("send Facebook's data deletion request");

  await page.goto("/data-deletion?code=e2eunknowncode1");
  await expect(page.getByTestId("deletion-status")).toContainText("no deletion request with the code e2eunknowncode1");
  await page.goto(`/data-deletion?code=${encodeURIComponent("<script>")}`);
  await expect(page.getByTestId("deletion-status")).toContainText("isn't a confirmation code bizinsights gives");

  await page.goto("/privacy");
  await expect(page.locator("main")).toContainText("Business integrations");
  await expect(page.locator("main")).toContainText("stops reading your Meta ad accounts straight away");
  // Google's Limited Use statement stays as it is.
  await expect(page.locator("main")).toContainText("including the Limited Use requirements");
});
