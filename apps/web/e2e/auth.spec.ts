import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { asNewVisitor, fillSignUp, latestCode, logIn, mailSubjects, PASSWORD, poolMfa, signOutFromMenu, signUp, totpCode, uniqueEmail, verifiedOnConfirm } from "./helpers";

/**
 * Sign-in and Settings → Security as a person meets them: the sign-up code that signs in by
 * itself, the authenticator app's code at sign-in, linking and removing Google (through the
 * stand-in for the user pool's managed login), adding a password to a Google-only account, and
 * the sign-in pages without Google when the deployment doesn't offer it.
 */

/** The app's own alerts (Next.js also renders an empty role="alert" route announcer). */
const alert = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');
const section = (page: Page, heading: string) => page.locator("section", { has: page.getByRole("heading", { name: heading, exact: true }) });

const db = new pg.Pool({ connectionString: E2E_ENV.DATABASE_URL });
test.afterAll(() => db.end());

const methodsOf = async (email: string) =>
  (await db.query("SELECT i.method, i.email FROM users u JOIN auth_identities i ON i.user_id = u.id WHERE u.email = $1 ORDER BY i.created_at", [email])).rows as Array<{ method: string; email: string }>;

/** A workspace, as onboarding makes one (the app sends an account without one to onboarding, Settings included). */
async function createWorkspace(page: Page, name: string) {
  await page.evaluate(async (n) => {
    const r = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) });
    if (!r.ok) throw new Error(`POST /workspaces failed: ${r.status}`);
  }, name);
}

/** "Continue with Google" on the stand-in: the person types which Google account they are. */
async function chooseGoogleAccount(page: Page, email: string) {
  await expect(page.getByRole("heading", { name: "Sign in with Google (test)" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
}

test("signing up: the emailed code signs the new account in by itself", async ({ page }) => {
  const email = uniqueEmail("direct");
  const logins: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/auth/login") logins.push(r.url());
  });
  await asNewVisitor(page);
  await page.goto("/signup");
  await fillSignUp(page, email);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
  await verifiedOnConfirm(email);
  await page.getByLabel("Verification code").fill(await latestCode(email));
  const confirmed = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/signup/confirm");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  // The code came with the password chosen here: the answer is the signed-in account.
  const res = await confirmed;
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { user?: { email: string } }).user?.email).toBe(email.toLowerCase());
  await expect(page).toHaveURL(/\/onboarding/);
  expect(logins).toEqual([]);
  await page.reload();
  await expect(page).toHaveURL(/\/onboarding/);
});

test.describe("two-step verification", () => {
  test.beforeAll(() => poolMfa(true));
  test.afterAll(() => poolMfa(false));

  test("set up in Settings, it asks for the authenticator app's code at the next sign-in", async ({ page }) => {
    const email = uniqueEmail("totp");
    await signUp(page, email);
    await createWorkspace(page, "Two Step Co");
    await page.goto("/settings/security");
    const twoStep = section(page, "Two-step verification");
    await twoStep.getByLabel("Current password", { exact: true }).fill(PASSWORD);
    await twoStep.getByRole("button", { name: "Set up two-step verification" }).click();
    const key = (await twoStep.getByLabel("Your authenticator key").textContent())!;
    await twoStep.getByLabel("Verification code").fill(totpCode(key));
    await twoStep.getByRole("button", { name: "Turn on two-step verification" }).click();
    await expect(twoStep.getByText("Two-step verification is on.")).toBeVisible();

    await page.goto("/dashboard");
    await signOutFromMenu(page);
    await expect(page).toHaveURL(/\/login/);
    await logIn(page, email);
    // The password was right: now the app's code, on its own step.
    await expect(page.getByRole("heading", { name: "Two-step verification" })).toBeVisible();
    const now = totpCode(key);
    await page.getByLabel("Verification code").fill(now === "000000" ? "111111" : "000000");
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(alert(page)).toContainText("isn't right");
    await page.getByLabel("Verification code").fill(totpCode(key));
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    // "Back to sign in" from the code step starts again from the password.
    await signOutFromMenu(page);
    await logIn(page, email);
    await expect(page.getByRole("heading", { name: "Two-step verification" })).toBeVisible();
    await page.getByRole("button", { name: "Back to sign in" }).click();
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  });
});

test("Settings → Security: link a Google account (Google's chooser), then remove it; the account's address hears of both", async ({ page }) => {
  const email = uniqueEmail("link");
  const personal = uniqueEmail("link-personal");
  await signUp(page, email);
  await createWorkspace(page, "Linked Google Co");
  await page.goto("/settings/security");
  const methods = section(page, "How you sign in");
  await methods.getByRole("button", { name: "Link Google account" }).click();
  // Started by this page (a POST), and Google is asked to show its account chooser.
  await expect(page.getByRole("heading", { name: "Sign in with Google (test)" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("prompt")).toBe("select_account");
  await chooseGoogleAccount(page, personal);
  await expect(page).toHaveURL(/\/settings\/security$/, { timeout: 20_000 });
  await expect(methods.getByText("Google is linked.")).toBeVisible();
  await expect(methods.getByText(personal.toLowerCase())).toBeVisible();
  expect((await methodsOf(email)).map((m) => m.method)).toEqual(["password", "google"]);

  const google = methods.getByRole("listitem").filter({ hasText: personal.toLowerCase() });
  await google.getByRole("button", { name: "Remove" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("won't be able to sign in to your account any more");
  await dialog.getByLabel("Your password", { exact: true }).fill(PASSWORD);
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(methods.getByText("Google is no longer a way to sign in to your account.")).toBeVisible();
  expect((await methodsOf(email)).map((m) => m.method)).toEqual(["password"]);
  await expect.poll(() => mailSubjects(email.toLowerCase())).toEqual(
    expect.arrayContaining(["Google sign-in was added to your bizinsights account", "Google sign-in was removed from your bizinsights account"]),
  );
});

test("an old link that would start linking Google from elsewhere goes back to Settings and links nothing", async ({ page }) => {
  const email = uniqueEmail("stale-link");
  await signUp(page, email);
  await createWorkspace(page, "Stale Link Co");
  await page.goto("/api/auth/oauth/google/start?link=1&returnTo=%2Fsettings%2Fsecurity");
  await expect(page).toHaveURL(/\/settings\/security$/);
  await expect(section(page, "How you sign in").getByText("Please start linking Google again from this page.")).toBeVisible();
  expect((await methodsOf(email)).map((m) => m.method)).toEqual(["password"]);
});

test("a Google-only account adds a password in Settings, then signs in with it", async ({ page }) => {
  const email = uniqueEmail("google-only");
  await asNewVisitor(page);
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await chooseGoogleAccount(page, email);
  await expect(page).toHaveURL(/\/onboarding/, { timeout: 20_000 });
  await createWorkspace(page, "Google Only Co");
  await page.goto("/settings/security");
  const password = section(page, "Password");
  await expect(password).toContainText("You sign in with Google only");
  await password.getByLabel("Password", { exact: true }).fill("a-new-password-1");
  await password.getByLabel("Confirm password", { exact: true }).fill("a-new-password-1");
  await password.getByRole("button", { name: "Add a password" }).click();
  await expect(password.getByText("Password added.")).toBeVisible();
  expect((await methodsOf(email)).map((m) => m.method)).toEqual(["google", "password"]);

  await page.context().clearCookies();
  await page.goto("/login");
  await logIn(page, email, "a-new-password-1");
  await expect(page).toHaveURL(/\/dashboard/);
});

test("without Google offered, the sign-in pages show no Google button (and keep it when the settings can't be read)", async ({ page }) => {
  await page.route("**/api/auth/config", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ providers: { google: false }, emailOtp: false }) }));
  for (const path of ["/login", "/signup"]) {
    await page.goto(path);
    await expect(page.getByLabel("Email Address")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with Google" })).toHaveCount(0);
    await expect(page.getByText(/OR (CONTINUE|SIGN UP) WITH/)).toHaveCount(0);
  }
  // Settings unreadable: the button stays (the server's own page says if Google isn't set up).
  await page.unroute("**/api/auth/config");
  await page.route("**/api/auth/config", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) }));
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
});
