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

/** The password `signUp` gives every account it creates. */
const PASSWORD = "correct-horse-battery";

const workspaceCount = async (email: string) =>
  Number(
    (
      await db.query("SELECT count(*)::int AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1", [email])
    ).rows[0].n,
  );

test("unauthenticated users are sent to log in, and come back to the page they opened", async ({ page }) => {
  await page.goto("/settings/members");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  // Google, Apple, email and password, and a way to sign up. Shopify is connected from inside the app only.
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Apple" })).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
  await expect(page.getByText("Continue with Shopify")).toHaveCount(0);

  // Signing in finishes on the page that sent them here, not on a generic one.
  const email = uniqueEmail("deeplink");
  await signUp(page, email);
  await verifyEmail(page, email);
  await createWorkspace(page, "Deep Co");
  await page.context().clearCookies();
  await page.goto("/settings/members");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/members/);
});

test("the homepage introduces Insights, and Log in and Sign up open their own pages", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /Your store is talking/ })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
  await expect(nav.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
  // The landing page sells; the auth pages hold the forms.
  await expect(page.locator("input, textarea, select")).toHaveCount(0);

  await nav.getByRole("link", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/signup/);
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(page.getByLabel("Your name")).toBeVisible();

  await page.goto("/");
  await nav.getByRole("link", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  await expect(page.getByLabel("Your name")).toHaveCount(0);

  // And each page leads to the other.
  await page.getByRole("link", { name: "Sign up" }).click();
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await page.getByRole("link", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
});

test("signing up checks the form, refuses a taken email, and the session survives a refresh", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByText("Continue with Shopify")).toHaveCount(0);
  await page.getByLabel("Your name").fill("E2E User");
  await page.getByLabel("Email").fill("not-an-email");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(alert(page)).toContainText("valid email");
  await page.getByLabel("Email").fill(uniqueEmail("short"));
  await page.getByLabel("Password").fill("short");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(alert(page)).toContainText("at least 8 characters");

  const email = uniqueEmail("persist");
  await signUp(page, email);
  // Refreshing right after signing up keeps the account signed in.
  await page.reload();
  await expect(page).toHaveURL(/verify-email/);
  await verifyEmail(page, email);
  await createWorkspace(page, "Persist Co");
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard/);
  await page.reload();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();

  // The same email can't be signed up twice.
  await page.context().clearCookies();
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Someone Else");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("another-password-1");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(alert(page)).toContainText("already exists");
  await expect(alert(page).getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
});

test("logging in with a password survives a refresh; signing out ends it", async ({ page }) => {
  const email = uniqueEmail("login");
  await signUp(page, email);
  await verifyEmail(page, email);
  await createWorkspace(page, "Login Co");
  await page.goto("/dashboard");
  await page.getByRole("button", { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/login/);

  // Wrong password: a plain message, still signed out.
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(alert(page)).toContainText("don't match");

  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await page.reload();
  await expect(page).toHaveURL(/\/dashboard/);
  await page.goto("/settings/profile");
  await page.reload();
  await expect(page).toHaveURL(/\/settings\/profile/);

  // Signing out ends this session; the dashboard is closed to it afterwards.
  await page.getByRole("button", { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
});

test.describe("social sign-in through the Auth emulator's provider popup", () => {
  // The emulator's stand-in provider page now and then drops the "Sign in with" click (about one
  // run in six, with nothing reaching our app): retry that, and only that.
  test.describe.configure({ retries: 2 });
  for (const provider of ["Google", "Apple"] as const) {
    test(`Continue with ${provider} signs in, and the session survives a refresh`, async ({ page }) => {
      // The Auth emulator stands in for the provider's own screen: a popup where an account is made up.
      await page.goto("/login");
      const popup = page.waitForEvent("popup");
      await page.getByRole("button", { name: `Continue with ${provider}` }).click();
      const idp = await popup;
      // The emulator's form differs by provider: Google offers "Auto-generate", Apple asks for an email.
      // Its page can take the first click before its script is listening, so click until the form opens.
      const autogen = idp.locator("#autogen-button");
      const email = idp.locator("#email-input");
      await expect(async () => {
        await idp.getByRole("button", { name: "Add new account" }).click({ timeout: 2_000 });
        await expect(idp.locator("#autogen-button:visible, #email-input:visible").first()).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 20_000 });
      if (await autogen.isVisible()) await autogen.click();
      else await email.fill(uniqueEmail(provider.toLowerCase()));
      // Only once the made-up account is filled in; the popup closes when the emulator has signed it in.
      await expect(email).not.toHaveValue("");
      await Promise.all([idp.waitForEvent("close"), idp.getByRole("button", { name: /^sign in with/i }).click()]);
      // A brand-new account has no workspace yet: the app sends it to connect a store. The popup
      // closing is only the start: the session is then made server-side, which takes a moment.
      await expect(page).toHaveURL(/\/onboarding/, { timeout: 20_000 });
      await expect(page.getByRole("button", { name: "Continue with Shopify" })).toBeVisible();
      await page.reload();
      await expect(page).toHaveURL(/\/onboarding/);
      await expect(page.getByRole("button", { name: "Continue with Shopify" })).toBeVisible();
    });
  }
});

test("/start, the old Shopify sign-up address, forwards into the new flow", async ({ page }) => {
  await page.goto("/start");
  await expect(page).toHaveURL(/\/signup/);
  // With a store: the in-app connect page, which asks a visitor to log in first.
  await page.goto("/start?shop=e2e-old.myshopify.com");
  await expect(page).toHaveURL(/\/login/);
});

test("opening the app from the Shopify admin without an account: sign up, then the store connects", async ({ page }) => {
  await stubShopify(page);
  await page.goto(signedLaunchUrl("e2e-launch.myshopify.com"));
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole("link", { name: "Sign up" }).click();
  const email = uniqueEmail("launch");
  await page.getByLabel("Your name").fill("E2E User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/verify-email/);
  await verifyEmailInEmulator(email);
  // Verified: back to the connect page for that store, which goes straight to Shopify's OAuth screen.
  const authorize = page.waitForRequest((r) => r.url().startsWith("https://e2e-launch.myshopify.com/admin/oauth/authorize"));
  await page.getByRole("button", { name: /verified my email/ }).click();
  const url = new URL((await authorize).url());
  expect(url.searchParams.get("client_id")).toBe("e2e_key");
  expect(url.searchParams.get("state")).toBeTruthy();
  expect(url.searchParams.get("redirect_uri")).toContain("/api/shopify/callback");
});

test("Shopify is connected from Settings, through Shopify's OAuth screen", async ({ page }) => {
  await stubShopify(page);
  const email = uniqueEmail("connect");
  await signUp(page, email);
  await verifyEmail(page, email);
  await createWorkspace(page, "Connect Co");
  await page.goto("/settings/stores");
  await expect(page.getByRole("heading", { name: "Shopify stores" })).toBeVisible();
  const card = page.getByTestId("shopify-connect");

  // Like onboarding: "Continue with Shopify" first, the address field one click away.
  await expect(card.getByRole("button", { name: "Continue with Shopify" })).toBeVisible();
  const field = card.getByLabel("Store address, store ID or Shopify email");
  const connect = card.getByRole("button", { name: "Connect this store" });
  await expect(field).toHaveCount(0);
  await card.getByRole("button", { name: "Enter store address instead" }).click();
  await field.fill("not a shop!");
  await connect.click();
  await expect(alert(page)).toContainText("myshopify.com");

  // The admin's own address works as well as the store ID or myshopify.com address.
  const authorize = page.waitForRequest((r) => r.url().startsWith("https://e2e-settings.myshopify.com/admin/oauth/authorize"));
  await field.fill("https://admin.shopify.com/store/e2e-settings/orders");
  await connect.click();
  const url = new URL((await authorize).url());
  expect(url.searchParams.get("client_id")).toBe("e2e_key");
  expect(url.searchParams.get("state")).toBeTruthy();

  // A Shopify login email goes to Shopify's own store picker, like "Continue with Shopify".
  await page.goto("/settings/stores");
  const install = page.waitForRequest((r) => r.url().startsWith("https://admin.shopify.com/oauth/install"));
  await card.getByRole("button", { name: "Enter store address instead" }).click();
  await field.fill("owner@example.com");
  await expect(card).toContainText("log in with owner@example.com");
  await connect.click();
  expect(new URL((await install).url()).searchParams.get("client_id")).toBe("e2e_key");

  // Shopify's errors come back to Settings in plain words.
  await page.goto("/settings/stores?error=state_expired");
  await expect(alert(page)).toContainText("expired");
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
