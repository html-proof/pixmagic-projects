import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { latestOtp, signedLaunchUrl, signedWebhook, signUp, stubShopify, uniqueEmail, verifyEmailInEmulator } from "./helpers";

/** The app's own alerts (Next.js also renders an empty role="alert" route announcer). */
const alert = (page: import("@playwright/test").Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

const db = new pg.Pool({ connectionString: E2E_ENV.DATABASE_URL });
test.afterAll(() => db.end());

/** After email/password sign-up: verify, then land on the connect step (no workspace form any more). */
async function verifyEmail(page: Page, email: string) {
  await verifyEmailInEmulator(email);
  await page.getByRole("button", { name: /verified my email/ }).click();
  await expect(page).toHaveURL(/onboarding/);
  await expect(page.getByRole("button", { name: "Continue with Shopify" })).toBeVisible();
}

/** Onboarding creates the workspace when the user clicks connect; tests that skip Shopify create it directly. */
async function createWorkspace(page: Page, name: string) {
  await page.evaluate(async (n) => {
    const r = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) });
    if (!r.ok) throw new Error(`POST /workspaces failed: ${r.status}`);
  }, name);
}

/** Fill the first /start panel and move on to "Continue with Shopify". */
async function enterEmail(page: Page, email: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("button", { name: "Continue with Shopify" })).toBeVisible();
  await expect(page.getByTestId("start-email")).toHaveText(email);
}

const workspaceCount = async (email: string) =>
  Number(
    (
      await db.query("SELECT count(*)::int AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1", [email])
    ).rows[0].n,
  );

test("unauthenticated users are sent to sign in", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with Shopify" })).toHaveAttribute("href", "/start");
});

test("new visitors start with email, then Continue with Shopify (managed install)", async ({ page, context }) => {
  await stubShopify(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/start/);
  await expect(page.getByRole("heading", { name: /numbers in minutes/ })).toBeVisible();

  // Plain-language validation before anything is sent.
  await page.getByLabel("Email").fill("not-an-email");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(alert(page)).toContainText("valid email");

  const email = uniqueEmail("start");
  await enterEmail(page, email);
  await expect(page.getByText("Read-only access")).toBeVisible();

  // "Change" goes back with the email kept.
  await page.getByRole("button", { name: "Change" }).click();
  await expect(page.getByLabel("Email")).toHaveValue(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  // The email survives a reload (and so the round trip to Shopify).
  await page.reload();
  await expect(page.getByTestId("start-email")).toHaveText(email);

  // No store address: Shopify's managed install lets the merchant sign in and pick a store.
  const nav = page.waitForRequest((r) => r.url().startsWith("https://admin.shopify.com/oauth/install"));
  await page.getByRole("button", { name: "Continue with Shopify" }).click();
  expect(new URL((await nav).url()).searchParams.get("client_id")).toBe("e2e_key");
  // Let that navigation land before simulating Shopify's next redirect.
  await page.waitForURL(/admin\.shopify\.com/);
  const signup = (await context.cookies()).find((c) => c.name === "shopify_signup");
  expect(signup?.httpOnly).toBe(true);

  // Shopify then opens our App URL for the chosen store, which continues with the per-user grant.
  const grant = page.waitForRequest((r) => r.url().startsWith("https://e2e-shop.myshopify.com/admin/oauth/authorize"));
  await page.goto(signedLaunchUrl("e2e-shop.myshopify.com"));
  const url = new URL((await grant).url());
  expect(url.searchParams.get("client_id")).toBe("e2e_key");
  expect(url.searchParams.get("state")).toBeTruthy();
  expect(url.searchParams.getAll("grant_options[]")).toContain("per-user");
  expect(url.searchParams.get("redirect_uri")).toContain("/api/shopify/callback");
});

test("Continue with Shopify with a known store address", async ({ page }) => {
  await stubShopify(page);
  await page.goto("/start");
  await enterEmail(page, uniqueEmail("shop"));

  await page.getByRole("button", { name: "Know your store address?" }).click();
  await page.getByLabel("Store address").fill("not a shop!");
  await page.getByRole("button", { name: "Continue with Shopify" }).click();
  await expect(alert(page)).toContainText("myshopify.com");

  const nav = page.waitForRequest((r) => r.url().startsWith("https://e2e-shop.myshopify.com/admin/oauth/authorize"));
  await page.getByLabel("Store address").fill("e2e-shop");
  await page.getByRole("button", { name: "Continue with Shopify" }).click();
  const url = new URL((await nav).url());
  expect(url.searchParams.get("client_id")).toBe("e2e_key");
  expect(url.searchParams.get("state")).toBeTruthy();
  expect(url.searchParams.getAll("grant_options[]")).toContain("per-user");
});

test("opening the app from the Shopify admin without an account starts sign-up for that store", async ({ page }) => {
  await page.goto(signedLaunchUrl("e2e-launch.myshopify.com"));
  await expect(page).toHaveURL(/\/start\?shop=e2e-launch\.myshopify\.com/);
  await expect(page.getByRole("status")).toContainText("e2e-launch.myshopify.com");
  await enterEmail(page, uniqueEmail("launch"));
  await expect(page.getByLabel("Store address")).toHaveValue("e2e-launch");
});

test("Shopify errors and expired sign-ups are explained, with a way to start again", async ({ page }) => {
  const email = uniqueEmail("err");
  await page.goto("/start");
  await enterEmail(page, email);

  await page.goto("/start?error=state_expired");
  await expect(page.getByTestId("start-email")).toHaveText(email);
  await expect(alert(page)).toContainText("expired");

  await page.goto("/start?error=something_new");
  await expect(alert(page)).toContainText("Shopify didn't complete the connection");

  // Back from Shopify, but this browser has no sign-up in progress.
  await page.goto("/start?step=finish");
  await expect(alert(page)).toContainText("took a little too long");
  await page.getByRole("button", { name: "Start again" }).click();
  await expect(page).toHaveURL(/\/start\/?$/);
  await expect(page.getByLabel("Email")).toBeVisible();
});

test("sign up with a password, verify email, connect from onboarding", async ({ page }) => {
  await stubShopify(page);
  const email = uniqueEmail("signup");
  await signUp(page, email);
  await verifyEmail(page, email);

  // Invalid domains are rejected with a plain-language message.
  await page.getByRole("button", { name: "Enter store address instead" }).click();
  await page.getByLabel("Your store address").fill("not a shop!");
  await page.getByRole("button", { name: "Connect this store" }).click();
  await expect(alert(page)).toContainText("myshopify.com");

  // A valid shop redirects to Shopify's OAuth screen with our client id and state.
  const nav = page.waitForRequest((r) => r.url().startsWith("https://e2e-shop.myshopify.com/admin/oauth/authorize"));
  await page.getByLabel("Your store address").fill("e2e-shop");
  await page.getByRole("button", { name: "Connect this store" }).click();
  const url = new URL((await nav).url());
  expect(url.searchParams.get("client_id")).toBe("e2e_key");
  expect(url.searchParams.get("state")).toBeTruthy();
  expect(url.searchParams.get("redirect_uri")).toContain("/api/shopify/callback");

  // The workspace was created on the first click and reused on the retry.
  expect(await workspaceCount(email)).toBe(1);
});

test("email one-time code sign-in", async ({ page }) => {
  const email = uniqueEmail("otp");
  await page.goto("/login");
  await page.getByRole("tab", { name: "Email me a code" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send me a code" }).click();
  await expect(page.getByRole("status")).toContainText("6-digit code");
  const code = await latestOtp(email);
  await page.getByLabel("6-digit code").fill(code === "000000" ? "111111" : "000000");
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await expect(alert(page)).toContainText("invalid or has expired");
  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  // The code proves inbox ownership, so the user skips separate email verification.
  await expect(page).toHaveURL(/onboarding/);
  await expect(page.getByRole("button", { name: "Continue with Shopify" })).toBeVisible();
});

test("dashboard shows webhook-driven metrics and only granted modules", async ({ page }) => {
  const email = uniqueEmail("dash");
  await signUp(page, email);
  await verifyEmail(page, email);
  await createWorkspace(page, "Dash Co");

  // Simulate a completed OAuth install (Shopify's side can't run in CI).
  const { rows } = await db.query(
    "SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1",
    [email],
  );
  const shop = `dash-${Date.now()}.myshopify.com`;
  await db.query(
    `INSERT INTO stores (id, workspace_id, shop_domain, status, timezone, currency, granted_scopes, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, 'active', 'UTC', 'USD', ARRAY['read_orders'], now(), now())`,
    [rows[0].workspace_id, shop],
  );

  await page.goto("/dashboard");
  await expect(page.getByText("No orders in this period")).toBeVisible();
  await expect(page.getByTestId("locked-top_products")).toContainText("access to your products");

  const now = new Date().toISOString();
  const res = await signedWebhook(
    "orders/create",
    shop,
    {
      id: 42, name: "#42", currency: "USD", created_at: now, updated_at: now,
      subtotal_price: "100.00", total_discounts: "20.00", total_tax: "0", total_price: "100.00",
      line_items: [{ id: 1, product_id: 9, title: "Mug", quantity: 2, price: "60.00", total_discount: "20.00" }],
    },
    `e2e-${Date.now()}`,
  );
  expect(res.status).toBe(200);

  await expect(async () => {
    await page.reload();
    // Each reload has to get through /me, the store list and the overview before the tile exists;
    // on a loaded machine that chain alone took ~1.6 s, so a 1.5 s wait could never succeed.
    await expect(page.getByTestId("metric-Net sales")).toContainText("$100.00", { timeout: 5000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByTestId("metric-Orders")).toContainText("1");
  await expect(page.getByTestId("metric-Average order value")).toContainText("$100.00");
  await expect(page.getByRole("heading", { name: "Top products" })).toHaveCount(0);

  await page.getByLabel("Dates").selectOption({ label: "Last 7 days" });
  await expect(page.getByTestId("metric-Net sales")).toContainText("$100.00");

  await page.goto("/settings/stores");
  // The store card's title (the name also appears in the store switcher and the details line).
  await expect(page.locator("p").getByText(shop, { exact: true })).toBeVisible();
  await page.goto("/settings/audit");
  await expect(page.getByText("created the workspace")).toBeVisible();
});

/**
 * The dynamic optional-scope request flow, end to end through the real Worker.
 *
 * The e2e env declares exactly one optional scope (`SHOPIFY_OPTIONAL_SCOPES=read_customers`), so
 * one dashboard shows all three reasons a module can be locked — and, importantly, that each one
 * offers only the action that can actually work. An earlier version of this UI told merchants to
 * wait for Shopify approval even when the scope was one the app asks for at install, which would
 * have stranded anyone whose grant was merely stale.
 */
test("locked modules offer only the action that can work, and Enable reaches Shopify", async ({ page }) => {
  const email = uniqueEmail("scopes");
  await signUp(page, email);
  await verifyEmail(page, email);
  await createWorkspace(page, "Scopes Co");
  await stubShopify(page);

  // A store that granted only read_orders: read_products is declared but ungranted (stale grant).
  const { rows } = await db.query(
    "SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1",
    [email],
  );
  const shop = `scopes-${Date.now()}.myshopify.com`;
  await db.query(
    `INSERT INTO stores (id, workspace_id, shop_domain, status, timezone, currency, granted_scopes, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, 'active', 'UTC', 'USD', ARRAY['read_orders'], now(), now())`,
    [rows[0].workspace_id, shop],
  );

  await page.goto("/dashboard");

  // 1. Declared at install but not granted → reconnect, which really does re-ask.
  const inventory = page.getByTestId("locked-inventory");
  await expect(inventory).toContainText("Reconnect the store to grant it");
  await expect(inventory.getByRole("link", { name: "Reconnect" })).toBeVisible();

  // 2. Declared optional → the merchant can be asked now.
  const customers = page.getByTestId("locked-customers");
  await expect(customers).toContainText("Needs your permission in Shopify");
  await expect(customers).not.toContainText("waiting on Shopify");

  // 3. Declared nowhere → no action at all; the merchant cannot move this.
  const funnel = page.getByTestId("locked-funnel");
  await expect(funnel).toContainText("waiting on Shopify to approve");
  await expect(funnel.getByRole("button", { name: "Enable" })).toHaveCount(0);
  await expect(funnel.getByRole("link", { name: "Reconnect" })).toHaveCount(0);

  // Enable sends the merchant to Shopify's optional-scope screen for exactly the missing scope.
  await customers.getByRole("button", { name: "Enable" }).click();
  await expect(page).toHaveURL(/admin\.shopify\.com\/store\/scopes-\d+\/oauth\/install\?.*optional_scopes=read_customers/);
  expect(page.url()).toContain("client_id=e2e_key");
  // No state and no redirect_uri: Shopify accepts neither, and the grant comes back by webhook
  // or by .../scopes/refresh (see packages/core/src/scopes.ts).
  expect(page.url()).not.toContain("state=");
  expect(page.url()).not.toContain("redirect_uri=");

  // The request is auditable, which is what makes "granted but never used" answerable later.
  await expect(async () => {
    const n = await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'store.scopes_requested'");
    expect(Number(n.rows[0].n)).toBe(1);
  }).toPass({ timeout: 10_000 });
});
