import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { fillCode, fillSignUp, insertStore, latestCode, logIn, PASSWORD, signedLaunchUrl, signedWebhook, signOutFromMenu, signUp, stubShopify, uniqueEmail, verifyEmail } from "./helpers";

/** The app's own alerts (Next.js also renders an empty role="alert" route announcer). */
const alert = (page: import("@playwright/test").Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

const db = new pg.Pool({ connectionString: E2E_ENV.OWNER_DATABASE_URL });
test.afterAll(() => db.end());

/** Onboarding creates the workspace when the user clicks connect; tests that skip Shopify create it directly. */
async function createWorkspace(page: Page, name: string) {
  await page.evaluate(async (n) => {
    const r = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) });
    if (!r.ok) throw new Error(`POST /workspaces failed: ${r.status}`);
  }, name);
}

const workspaceCount = async (email: string) =>
  Number(
    (
      await db.query("SELECT count(*)::int AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1", [email])
    ).rows[0].n,
  );

test("unauthenticated users are sent to sign in, and come back to the page they opened", async ({ page }) => {
  // The one 401 from /me reaches two handlers: the sign-in page's data is still fetched only once.
  let signInFetches = 0;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/login.txt") signInFetches++;
  });
  await page.goto("/settings/notifications");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Welcome Back" })).toBeVisible();
  expect(signInFetches).toBeLessThanOrEqual(1);
  await expect(page.getByText("Sign in to your account to continue to your dashboard.")).toBeVisible();
  // Email and password, Google, and a way to create an account. Shopify is connected from inside the app only.
  await expect(page.getByLabel("Email Address")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Forgot Password?" })).toHaveAttribute("href", "/forgot-password");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Continue with Apple" })).toHaveCount(0);
  await expect(page.getByLabel("Keep me signed in")).toBeChecked();
  // In the top bar and under the form.
  const createAccount = page.getByRole("link", { name: "Create Account" });
  await expect(createAccount).toHaveCount(2);
  for (const link of await createAccount.all()) await expect(link).toHaveAttribute("href", "/signup");
  await expect(page.getByText("Continue with Shopify")).toHaveCount(0);

  // The password field shows and hides what's typed.
  const pw = page.getByLabel("Password", { exact: true });
  await pw.fill("peek-a-boo");
  await expect(pw).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(pw).toHaveAttribute("type", "text");

  // Signing in finishes on the page that sent them here, not on a generic one.
  const email = uniqueEmail("deeplink");
  await signUp(page, email);
  await createWorkspace(page, "Deep Co");
  await page.context().clearCookies();
  await page.goto("/settings/notifications");
  await expect(page).toHaveURL(/\/login/);
  await logIn(page, email);
  await expect(page).toHaveURL(/\/settings\/notifications/);
});

test("the homepage introduces bizinsights, and Log in and Sign up open their own pages", async ({ page }) => {
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
  await expect(page.getByLabel("Full name")).toBeVisible();

  await page.goto("/");
  await nav.getByRole("link", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Welcome Back" })).toBeVisible();
  await expect(page.getByLabel("Full name")).toHaveCount(0);

  // And each page leads to the other (from the top bar and from under the form).
  await page.getByRole("link", { name: "Create Account" }).first().click();
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign In", exact: true })).toHaveCount(2);
  await page.getByRole("link", { name: "Sign In", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "Welcome Back" })).toBeVisible();
});

test("signing up checks the form, confirms the emailed code, refuses a taken email, and the session survives a refresh", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByText("Continue with Shopify")).toHaveCount(0);
  // Create Account stays locked until every field is filled in correctly and the terms are accepted.
  const create = page.getByRole("button", { name: "Create Account" });
  await expect(create).toBeDisabled();
  await expect(create).toHaveAccessibleDescription(/Fill in every field/);
  await page.getByLabel(/I agree to the Terms/).check();
  await expect(create).toBeDisabled();
  // Each problem shows on its own field once it's left, keeps the button locked, and goes away as soon as it's fixed.
  await fillSignUp(page, "not-an-email");
  await expect(create).toBeDisabled();
  await expect(page.getByLabel("Email Address")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Email Address")).toHaveAccessibleDescription(/valid email/);
  await expect(page.getByLabel("Full name")).not.toHaveAttribute("aria-invalid");
  await fillSignUp(page, uniqueEmail("short"), "short");
  await expect(create).toBeDisabled();
  await expect(page.getByLabel("Email Address")).not.toHaveAttribute("aria-invalid");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAccessibleDescription(/at least 8 characters/);
  await fillSignUp(page, uniqueEmail("mismatch"));
  await expect(create).toBeEnabled();
  await page.getByLabel("Confirm password", { exact: true }).fill("something-else-1");
  await expect(create).toBeDisabled();
  await expect(page.getByLabel("Confirm password", { exact: true })).toHaveAccessibleDescription(/don't match/);
  await fillSignUp(page, uniqueEmail("terms"));
  await expect(create).toBeEnabled();
  await expect(page.getByText("Fill in every field")).toHaveCount(0);
  // Un-ticking the terms locks the button again and says why.
  await page.getByLabel(/I agree to the Terms/).uncheck();
  await expect(create).toBeDisabled();
  await expect(page.getByLabel(/I agree to the Terms/)).toHaveAccessibleDescription(/Terms of Service/);

  // A wrong code is refused; the right one signs the new account in.
  const email = uniqueEmail("persist");
  await fillSignUp(page, email);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
  // The six boxes send the code by themselves once the sixth digit is in; the minute it lasts is counted down.
  await expect(page.getByTestId("code-expires-in")).toHaveText(/^00:[0-5]\d$/);
  const code = await latestCode(email);
  await fillCode(page, code === "000000" ? "111111" : "000000");
  await expect(alert(page)).toContainText("The verification code is incorrect");
  await fillCode(page, code);
  await verifyEmail(page, email);
  await expect(page).toHaveURL(/onboarding/);
  // Refreshing keeps the account signed in.
  await page.reload();
  await expect(page).toHaveURL(/onboarding/);
  await createWorkspace(page, "Persist Co");
  await page.goto("/dashboard");
  await page.reload();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
  const user = await db.query("SELECT i.method FROM users u JOIN auth_identities i ON i.user_id = u.id WHERE u.email = $1", [email]);
  expect(user.rows).toEqual([{ method: "password" }]);

  // The same email can't be signed up twice.
  await page.context().clearCookies();
  await page.goto("/signup");
  await fillSignUp(page, email, "another-password-1", "Someone Else");
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(alert(page)).toContainText("already exists");
  await expect(alert(page).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
});

test("signing in with a password survives a refresh; signing out ends it", async ({ page }) => {
  const email = uniqueEmail("login");
  await signUp(page, email);
  await createWorkspace(page, "Login Co");
  await page.goto("/dashboard");
  await signOutFromMenu(page);
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText("You've been signed out.")).toBeVisible();

  // Wrong password: a plain message that doesn't say whether the account exists, still signed out.
  await logIn(page, email, "not-the-password");
  await expect(alert(page)).toContainText("don't match");
  await logIn(page, uniqueEmail("nobody"), "not-the-password");
  await expect(alert(page)).toContainText("don't match");

  await logIn(page, email);
  await expect(page).toHaveURL(/\/dashboard/);
  await page.reload();
  await expect(page).toHaveURL(/\/dashboard/);
  // Signed in: the sign-in page sends them straight back into the app.
  await page.goto("/login");
  await expect(page).toHaveURL(/\/dashboard/);
  await page.goto("/settings/profile");
  await page.reload();
  await expect(page).toHaveURL(/\/settings\/profile/);

  // Signing out ends this session; the dashboard is closed to it afterwards.
  await signOutFromMenu(page);
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
});

test("forgot password: a code by email, a new password, then signing in with it", async ({ page }) => {
  const email = uniqueEmail("forgot");
  await signUp(page, email);
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByRole("link", { name: "Forgot Password?" }).click();
  await expect(page.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();
  await page.getByLabel("Email Address").fill(email);
  await page.getByRole("button", { name: "Send reset code" }).click();
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await fillCode(page, await latestCode(email));
  await page.getByLabel("New password", { exact: true }).fill("a-brand-new-password");
  await page.getByLabel("Confirm new password", { exact: true }).fill("a-brand-new-password");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page).toHaveURL(/\/login\?reset=1/);
  await expect(page.getByText("Your password has been changed")).toBeVisible();
  await logIn(page, email, PASSWORD);
  await expect(alert(page)).toContainText("don't match");
  await logIn(page, email, "a-brand-new-password");
  await expect(page).toHaveURL(/onboarding/);
});

test.describe("Continue with Google (through the user pool's managed login)", () => {
  const methodsOf = async (email: string) =>
    (await db.query("SELECT i.method FROM users u JOIN auth_identities i ON i.user_id = u.id WHERE u.email = $1 ORDER BY i.created_at", [email.toLowerCase()])).rows.map((r) => r.method as string);
  const userCount = async (email: string) => Number((await db.query("SELECT count(*) FROM users WHERE email = $1", [email.toLowerCase()])).rows[0].count);

  test("Continue with Google signs a new person up and in with no form, the session survives a refresh, and the same button signs them back in", async ({ page }) => {
    // The stand-in sends a picture for "pic-" addresses; Google's image host, answered here.
    await page.route("https://lh3.googleusercontent.com/**", (route) =>
      route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") }),
    );
    await page.goto("/login");
    await page.getByRole("button", { name: "Continue with Google" }).click();
    // The provider's own screen (here: the stand-in), reached with PKCE and a nonce.
    await expect(page.getByRole("heading", { name: "Sign in with Google (test)" })).toBeVisible();
    const authorize = new URL(page.url());
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("nonce")).toBeTruthy();
    const email = uniqueEmail("pic-google");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    // Back on /auth/callback, which finishes the sign-in: a brand-new account goes to connect a store.
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Continue with Shopify" })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/\/onboarding/);
    expect(await methodsOf(email)).toEqual(["google"]);
    const made = (await db.query("SELECT display_name, email_verified, avatar_url FROM users WHERE email = $1", [email.toLowerCase()])).rows[0];
    expect(made).toEqual({ display_name: "Social Person", email_verified: true, avatar_url: expect.stringMatching(/^https:\/\/lh3\.googleusercontent\.com\//) });

    // With a workspace, the account menu shows the Google picture; signed out, the same button on
    // the create-account page signs in to the same account, straight to its dashboard.
    await createWorkspace(page, "Google Co");
    await page.goto("/dashboard");
    await expect(page.getByRole("button", { name: "Account menu" }).locator("img")).toHaveAttribute("src", made.avatar_url);
    await signOutFromMenu(page);
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/signup");
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
    expect(await userCount(email)).toBe(1);
    expect(await workspaceCount(email)).toBe(1);
  });

  test("a cancelled Google sign-in goes back to the sign-in page and creates nothing", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await expect(page.getByRole("heading", { name: "Sign in with Google (test)" })).toBeVisible();
    await page.getByRole("link", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/\/login\?googleCancelled=1/, { timeout: 20_000 });
    await expect(page.getByText("Google sign-in was cancelled. Nothing was changed and no account was created.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
  });

  test("Google with an existing password account's address: sign in to that account once to link it, then Google signs straight in", async ({ page }) => {
    const email = uniqueEmail("linked");
    await signUp(page, email);
    await createWorkspace(page, "Linked Co");
    await page.context().clearCookies();

    await page.goto("/login");
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    // Not a second account, and not linked by the address alone: the account's own sign-in first.
    await expect(page).toHaveURL(/\/login\?link=google/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Link your Google account" })).toBeVisible();
    await expect(page.getByText("You already have a bizinsights account with")).toContainText(email.toLowerCase());
    await expect(page.getByLabel("Email Address")).toHaveValue(email.toLowerCase());
    await expect(page.getByRole("button", { name: "Continue with Google" })).toHaveCount(0);
    expect(await methodsOf(email)).toEqual(["password"]);
    expect(await userCount(email)).toBe(1);

    // The password and its emailed code, as at any sign-in: then Google is one of the account's ways in.
    await logIn(page, email);
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
    expect(await workspaceCount(email)).toBe(1);
    expect(await methodsOf(email)).toEqual(["password", "google"]);

    // From now on the same button signs straight in to it.
    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
    expect(await userCount(email)).toBe(1);
  });
});

test("Account Security: change the password, see how the account signs in, sign out everywhere", async ({ page, browser }) => {
  const email = uniqueEmail("security");
  await signUp(page, email);
  await createWorkspace(page, "Secure Co");
  // A second device, signed in too.
  const other = await browser.newPage();
  await other.goto("/login");
  await logIn(other, email);
  await expect(other).toHaveURL(/\/dashboard/);

  await page.goto("/settings/security");
  await expect(page.getByRole("heading", { name: "Sign-in & security", exact: true })).toBeVisible();
  await expect(page.getByText("Email and password", { exact: true })).toBeVisible();
  // Both devices are listed, this one first; the other can be signed out from here.
  const devices = page.locator("section", { has: page.getByRole("heading", { name: "Your sign-in devices", exact: true }) });
  await expect(devices.getByText("Current device").filter({ visible: true })).toHaveCount(1);
  await devices.getByRole("button", { name: /^Remove / }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(devices.getByText(/is signed out\.$/)).toBeVisible();
  await expect(devices.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  await other.goto("/dashboard");
  await expect(other).toHaveURL(/\/login/);
  await logIn(other, email);
  await expect(other).toHaveURL(/\/dashboard/);
  // Its sign-ins are in the activity.
  await page.reload();
  const activity = page.locator("section", { has: page.getByRole("heading", { name: "Recent sign-in activity", exact: true }) });
  await expect(activity.getByText("Success").filter({ visible: true })).toHaveCount(3);

  await page.locator("section", { has: page.getByRole("heading", { name: "Password", exact: true }) }).getByRole("button", { name: "Change", exact: true }).click();
  const passwordDialog = page.getByRole("dialog", { name: "Change password" });
  await passwordDialog.getByLabel("Current password", { exact: true }).fill(PASSWORD);
  await passwordDialog.getByLabel("New password", { exact: true }).fill("changed-password-9");
  await passwordDialog.getByLabel("Confirm new password", { exact: true }).fill("changed-password-9");
  await passwordDialog.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Password changed.")).toBeVisible();
  // This device stays signed in; the other one is out.
  await page.reload();
  await expect(page).toHaveURL(/\/settings\/security/);
  await other.goto("/dashboard");
  await expect(other).toHaveURL(/\/login/);

  await page.getByRole("button", { name: "Sign out of all devices" }).first().click();
  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
  await logIn(page, email, "changed-password-9");
  await expect(page).toHaveURL(/\/dashboard/);
});

test("/start, the old Shopify sign-up address, forwards into the new flow", async ({ page }) => {
  await page.goto("/start");
  await expect(page).toHaveURL(/\/signup/);
  // With a store: the in-app connect page, which asks a visitor to log in first.
  await page.goto("/start?shop=e2e-old.myshopify.com");
  await expect(page).toHaveURL(/\/login/);
});

test("installing from Shopify authorizes at once, before any sign-in", async ({ page }) => {
  // App Store requirements 2.3.2-2.3.4: OAuth first, whoever is (or isn't) signed in. Where the
  // store goes once Shopify answers is covered by apps/api/test/shopifyInstall.test.ts.
  await stubShopify(page);
  const authorize = page.waitForRequest((r) => r.url().startsWith("https://e2e-launch.myshopify.com/admin/oauth/authorize"));
  await page.goto(signedLaunchUrl("e2e-launch.myshopify.com"));
  const url = new URL((await authorize).url());
  expect(url.searchParams.get("client_id")).toBe("e2e_key");
  expect(url.searchParams.get("state")).toBeTruthy();
  expect(url.searchParams.get("redirect_uri")).toContain("/api/shopify/callback");
});

test("the page that adds an installed store to an account explains an expired link", async ({ page }) => {
  await page.goto("/claim");
  await expect(page.getByRole("heading", { name: "Open bizinsights from Shopify" })).toBeVisible();
  await expect(page.getByText("Shopify admin")).toBeVisible();
  await page.goto("/claim?error=exchange_failed");
  await expect(alert(page)).toContainText("Shopify didn't complete the connection");
});

/** The API's answer when Shopify's store picker can't reach the app serving this merchant. */
async function requireShopAddress(page: Page) {
  await page.route(/\/api\/workspaces\/[^/]+\/shopify\/start$/, (route) =>
    route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "shop_required", message: "Enter your store address" }) }),
  );
}

test("Shopify is connected from Settings, through Shopify's OAuth screen", async ({ page }) => {
  await stubShopify(page);
  const email = uniqueEmail("connect");
  await signUp(page, email);
  await createWorkspace(page, "Connect Co");
  await page.goto("/settings/stores");
  await expect(page.getByRole("heading", { name: "Shopify stores" })).toBeVisible();
  const card = page.getByTestId("shopify-connect");

  // Shopify picks the store: nobody is asked to type its address (App Store requirement 2.3.1).
  const field = card.getByLabel("Store address or store ID");
  const connect = card.getByRole("button", { name: "Connect this store" });
  await expect(field).toHaveCount(0);
  await expect(card.getByText("Enter store address instead")).toHaveCount(0);
  const install = page.waitForRequest((r) => r.url().startsWith("https://admin.shopify.com/oauth/install"));
  await card.getByRole("button", { name: "Continue with Shopify" }).click();
  expect(new URL((await install).url()).searchParams.get("client_id")).toBe("e2e_key");

  // Only when the picker can't reach this merchant's app does the address field appear.
  await page.goto("/settings/stores");
  await requireShopAddress(page);
  await card.getByRole("button", { name: "Continue with Shopify" }).click();
  await expect(field).toBeVisible();
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

  // Shopify's errors come back to Settings in plain words.
  await page.goto("/settings/stores?error=state_expired");
  await expect(alert(page)).toContainText("expired");
});

test("sign up with a password, verify email, connect from onboarding", async ({ page }) => {
  await stubShopify(page);
  const email = uniqueEmail("signup");
  await signUp(page, email);

  // Shopify's store picker first; no address field.
  await expect(page.getByLabel("Your store address")).toHaveCount(0);
  await expect(page.getByText("Enter store address instead")).toHaveCount(0);
  const install = page.waitForRequest((r) => r.url().startsWith("https://admin.shopify.com/oauth/install"));
  await page.getByRole("button", { name: "Continue with Shopify" }).click();
  expect(new URL((await install).url()).searchParams.get("client_id")).toBe("e2e_key");

  // When the picker can't be used, the address form appears. Invalid domains get a plain answer.
  await page.goto("/onboarding");
  await requireShopAddress(page);
  await page.getByRole("button", { name: "Continue with Shopify" }).click();
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

  // The workspace was created on the first click and reused on the retries.
  expect(await workspaceCount(email)).toBe(1);
});

test("connecting a store another account has opens the dashboard instead, which offers another store", async ({ page }) => {
  await stubShopify(page);
  const email = uniqueEmail("taken");
  await signUp(page, email);
  // The store lives in a workspace someone else's account has claimed.
  const shop = `e2e-taken-${Date.now()}.myshopify.com`;
  const theirs = (await db.query("INSERT INTO workspaces (id, name) VALUES (gen_random_uuid()::text, 'Theirs') RETURNING id")).rows[0].id as string;
  const takenId = await insertStore(db, theirs, shop);

  // One click: Shopify comes back with that store (the launch it opens after the install).
  const install = page.waitForRequest((r) => r.url().startsWith("https://admin.shopify.com/oauth/install"));
  await page.getByRole("button", { name: "Continue with Shopify" }).click();
  await install;
  await page.goto(signedLaunchUrl(shop));
  await expect(page).toHaveURL(/\/dashboard$/);
  const note = page.getByRole("status").filter({ hasText: "already connected to another bizinsights account" });
  await expect(note).toContainText(shop);
  await expect(page.getByRole("heading", { name: "Connect your first store" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with Shopify" })).toBeVisible();

  // With a store of its own, the store switcher offers the next one.
  const mine = (await db.query("SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1", [email])).rows[0].workspace_id as string;
  await insertStore(db, mine, `e2e-mine-${Date.now()}.myshopify.com`);
  await page.goto("/dashboard");
  await page.getByTestId("store-switcher").selectOption({ label: "+ Connect another store" });
  await expect(page).toHaveURL(/\/settings\/stores$/);
  await expect(page.getByTestId("shopify-connect")).toBeVisible();

  // A member of the store's workspace connecting it from another one: no message, its dashboard opens.
  const userId = (await db.query("SELECT id FROM users WHERE email = $1", [email])).rows[0].id as string;
  await db.query("INSERT INTO memberships (id, workspace_id, user_id, role) VALUES (gen_random_uuid()::text, $1, $2, 'owner')", [theirs, userId]);
  const fresh = await page.evaluate(async () => {
    const r = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Fresh" }) });
    const ws = ((await r.json()) as { workspace: { id: string } }).workspace.id;
    await fetch(`/api/workspaces/${ws}/shopify/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    return ws;
  });
  expect(fresh).toBeTruthy();
  await page.goto(signedLaunchUrl(shop));
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId("store-switcher")).toHaveValue(takenId);
  await expect(page.getByLabel("Workspace")).toHaveValue(theirs);
  await expect(page.getByText("already connected to another bizinsights account")).toHaveCount(0);
});

test("dashboard shows webhook-driven metrics and only granted modules", async ({ page }) => {
  const email = uniqueEmail("dash");
  await signUp(page, email);
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
    await expect(page.getByTestId("metric-Total sales")).toContainText("$100.00", { timeout: 5000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByTestId("metric-Orders")).toContainText("1");
  await expect(page.getByTestId("metric-Average order value")).toContainText("$100.00");
  await expect(page.getByRole("heading", { name: "Top products" })).toHaveCount(0);

  await page.getByLabel("Dates").selectOption({ label: "Last 7 days" });
  await expect(page.getByTestId("metric-Total sales")).toContainText("$100.00");

  // The daily check against Shopify, as the worker records it (Shopify's side can't run in CI):
  // its outcome beside the store's status, its figures under "About this data" for the owner. One
  // order Shopify no longer shares (placed over 60 days ago) had a US$37 edit in the window: set aside.
  const { rows: st } = await db.query("SELECT id FROM stores WHERE shop_domain = $1", [shop]);
  const { rows: rec } = await db.query(
    `INSERT INTO reconciliations (id, workspace_id, store_id, source, trigger, from_day, to_day, timezone, currency, status, orders_checked, findings, actions, started_at, finished_at)
     VALUES (gen_random_uuid()::text, $1, $2, 'shopify_records', 'scheduled', '2026-10-10', '2026-10-16', 'UTC', 'USD', 'repaired', 1,
             '{"missing":{"count":1,"orders":[{"id":"42","name":"#42"}]},"not_listed":{"count":1,"orders":[{"id":"7","name":"#7"}]}}'::jsonb,
             '{"repaired":1,"removed":0,"setAside":{"orders":1,"totals":{"orders":0,"grossSales":33.64,"discounts":0,"returns":0,"netSales":33.64,"shipping":0,"taxes":3.36,"totalSales":37,"units":1}}}'::jsonb,
             now(), now())
     RETURNING id`,
    [rows[0].workspace_id, st[0].id],
  );
  await db.query(
    `INSERT INTO reconciliation_results (id, workspace_id, reconciliation_id, metric, shopify_value, before_value, after_value, status, cause)
     VALUES (gen_random_uuid()::text, $1, $2, 'orders', 1, 0, 1, 'repaired', 'missing'), (gen_random_uuid()::text, $1, $2, 'totalSales', 100, 37, 137, 'repaired', 'missing')`,
    [rows[0].workspace_id, rec[0].id],
  );
  await page.goto("/dashboard");
  await expect(page.getByTestId("shopify-check")).toContainText("Matches Shopify");
  await expect(page.getByTestId("shopify-check")).toHaveAttribute("title", /excluding 1 order Shopify no longer shares/);
  await page.getByTestId("about-data").getByText("About this data").click();
  await expect(page.getByTestId("check-details")).toContainText("2 of 2 figures match Shopify");
  await expect(page.getByTestId("check-details")).toContainText("excluding $37.00 of sales from 1 order Shopify no longer shares.");
  await expect(page.getByTestId("check-details")).toContainText("It found: 1 order was missing.");
  await expect(page.getByTestId("check-table")).toContainText("Total sales");
  await expect(page.getByTestId("check-table")).toContainText("Excluded");
  await expect(page.getByTestId("check-table")).toContainText("$37.00");
  // This store has no token here, so its sync stopped ("error"): no "Check now" until it is connected.
  await expect(page.getByTestId("check-now")).toHaveCount(0);

  await page.goto("/settings/stores");
  // The store card's title (the name also appears in the store switcher and the details line).
  await expect(page.locator("p").getByText(shop, { exact: true })).toBeVisible();
  await page.goto("/settings/audit");
  await expect(page.getByText("created the workspace")).toBeVisible();
});

test("a workspace installed from the App Store shows only what the listing describes", async ({ page }) => {
  const email = uniqueEmail("listed");
  await signUp(page, email);
  await createWorkspace(page, "Listed Co");
  // A store installed through the App Store app (Shopify's side can't run in CI).
  const { rows } = await db.query("SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1", [email]);
  await db.query(
    `INSERT INTO stores (id, workspace_id, shop_domain, shopify_app_key, status, timezone, currency, granted_scopes, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, 'appstore', 'active', 'UTC', 'USD', ARRAY['read_orders','read_products'], now(), now())`,
    [rows[0].workspace_id, `listed-${Date.now()}.myshopify.com`],
  );

  // No WhatsApp, Staff or advertising in the menu, and no Advertising section on the dashboard.
  await page.goto("/dashboard");
  const nav = page.getByRole("navigation", { name: "App" });
  await expect(nav.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Sales" })).toBeVisible();
  for (const name of ["Marketing", "Staff"]) await expect(nav.getByRole("link", { name, exact: true })).toHaveCount(0);
  await expect(page.getByTestId("about-data")).toBeVisible();
  await expect(page.getByTestId("ads-onboarding")).toHaveCount(0);

  // Settings: Shopify, without the advertising, email and WhatsApp connections.
  await page.goto("/settings/integrations");
  await expect(page.getByTestId("int-shopify")).toBeVisible();
  for (const id of ["int-whatsapp", "int-google", "int-meta", "int-adsense", "int-zapier"]) await expect(page.getByTestId(id)).toHaveCount(0);
  const settings = page.getByRole("navigation", { name: "Settings" });
  await expect(settings.getByRole("link", { name: "Connections" })).toHaveAttribute("aria-current", "page");
  for (const name of ["Ad accounts", "Email"]) await expect(settings.getByRole("link", { name, exact: true })).toHaveCount(0);

  // Their pages are closed as well, typed in or bookmarked.
  for (const path of ["/whatsapp", "/messaging", "/automations", "/staff", "/settings/ads", "/settings/email", "/advertising"]) {
    await page.goto(path);
    await expect(page.getByTestId("access-notice")).toContainText("You don't have access to that page.");
    await expect(page).toHaveURL(/\/dashboard/);
  }

  // Team & Access offers no Staff or advertising permissions.
  await page.goto("/team");
  await page.getByRole("button", { name: "Invite Member" }).click();
  await expect(page.getByTestId("module-analytics")).toBeVisible();
  await expect(page.getByTestId("module-staff")).toHaveCount(0);
  await page.getByRole("button", { name: "Expand all" }).click();
  await expect(page.getByText("View advertising analytics")).toHaveCount(0);
  await expect(page.getByTestId("module-marketing")).toContainText("View conversion attribution");
});

/**
 * The dynamic optional-scope request flow, end to end through the real app.
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

/**
 * Shopify's own report figures (packages/core/src/reports/shopify.ts) for a store that granted its
 * reports: the kept answers show as Shopify's sessions, its gross profit with what has no cost
 * recorded, and the sales figures checked against Shopify's line by line.
 */
test("shows Shopify's own sessions and gross profit, and checks the sales figures against Shopify's", async ({ page }) => {
  const email = uniqueEmail("shopifyql");
  await signUp(page, email);
  await createWorkspace(page, "Reports Co");
  await stubShopify(page);
  const { rows } = await db.query("SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1", [email]);
  const ws = rows[0].workspace_id as string;
  const shop = `reports-${Date.now()}.myshopify.com`;
  const store = await db.query(
    `INSERT INTO stores (id, workspace_id, shop_domain, status, timezone, currency, granted_scopes, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, 'active', 'UTC', 'AUD', ARRAY['read_orders','read_products','read_reports'], now(), now()) RETURNING id`,
    [ws, shop],
  );
  const storeId = store.rows[0].id as string;
  await db.query(
    `INSERT INTO daily_store_metrics (workspace_id, store_id, day, gross_sales, discounts, refunds, shipping, taxes, total_sales, orders, units, orders_with_customer, returning_customer_orders, refunded_orders)
     VALUES ($1, $2, '2026-09-21', 1699.08, 54.53, 45.50, 34.54, 167.91, 1801.50, 5, 6, 5, 0, 1)`,
    [ws, storeId],
  );
  const keep = (dataset: string, window: string, values: Record<string, number>) =>
    db.query(`INSERT INTO shopify_reports (id, workspace_id, store_id, dataset, time_window, "values", fetched_at) VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, now())`, [ws, storeId, dataset, window, JSON.stringify(values)]);
  // Every figure the sales report is asked for, duties and additional fees included: an answer kept
  // without them is one from before they were asked, read as not reported (and fetched again).
  await keep("sales", "2026-09-21|2026-09-21|", { grossSales: 1699.08, discounts: -54.53, salesReversals: -45.5, netSales: 1599.05, shipping: 34.54, duties: 0, additionalFees: 0, taxes: 167.91, totalSales: 1801.5, orders: 5 });
  await keep("profit", "2026-09-21|2026-09-21|", { grossProfit: 900, costOfGoodsSold: -650, netSalesWithCost: 1500, netSalesWithoutCost: 99.05 });
  await keep("profit", "2026-09-20|2026-09-20|", { grossProfit: 450, costOfGoodsSold: -300, netSalesWithCost: 700, netSalesWithoutCost: 0 });
  await keep("sessions", "2026-09-21|2026-09-21|", { sessions: 200, visitors: 150, cartSessions: 20, checkoutSessions: 10, completedSessions: 5, pageviews: 600 });
  await keep("sessions", "2026-09-20|2026-09-20|", { sessions: 100, visitors: 90, cartSessions: 10, checkoutSessions: 5, completedSessions: 2, pageviews: 300 });

  await page.goto("/dashboard?preset=custom&from=2026-09-21&to=2026-09-21&view=sales");
  // The comparison names its dates, as Shopify's comparison chip does, so a Shopify screen set to
  // other dates can't pass for the same comparison ("vs Previous period" beside "Mar 14, 2026").
  await expect(page.getByTestId("compare-dates")).toHaveText(/^vs (Sep 20, 2026|20 Sept? 2026)$/);
  await expect(page.getByTestId("compare-dates")).not.toContainText("Previous period");
  const check = page.getByTestId("module-shopify-check");
  await expect(check).toContainText("All match");
  await expect(check.getByTestId("shopify-check-table")).toContainText("Net sales");
  const profit = page.getByTestId("module-profit");
  await expect(profit).toContainText("Gross profit (Shopify)");
  await expect(profit).toContainText("Not available");
  await expect(profit.getByTestId("profit-missing-cost")).toContainText("had no cost recorded in Shopify");

  await page.goto("/dashboard?preset=custom&from=2026-09-21&to=2026-09-21&view=shoppers");
  const sessions = page.getByTestId("module-shopify-sessions");
  await expect(sessions).toContainText("Sessions and visitors (Shopify)");
  await expect(sessions).toContainText("200");
  await expect(sessions).toContainText("2.5%");
});
