import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { asNewVisitor, fillCode, fillSignUp, latestCode, latestMailCode, latestMailSender, logIn, mailSubjects, newestMailId, PASSWORD, poolMfa, signOutFromMenu, signUp, totpCode, uniqueEmail, verifiedOnConfirm } from "./helpers";

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
  const confirmed = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/signup/confirm");
  await fillCode(page, await latestCode(email));
  // The code came with the password chosen here: the answer is the signed-in account.
  const res = await confirmed;
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { user?: { email: string } }).user?.email).toBe(email.toLowerCase());
  await expect(page).toHaveURL(/\/onboarding/);
  expect(logins).toEqual([]);
  await page.reload();
  await expect(page).toHaveURL(/\/onboarding/);
});

test("signing in: the password, then the code emailed to the address, with its minute counted down (and kept across a reload)", async ({ page }) => {
  const email = uniqueEmail("login-code");
  await signUp(page, email);
  await createWorkspace(page, "Code Co");
  await page.goto("/dashboard");
  await signOutFromMenu(page);
  await expect(page).toHaveURL(/\/login/);

  await asNewVisitor(page);
  await page.getByLabel("Email Address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  const before = await newestMailId(email);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  // The password alone signs nobody in: the code step, with no session behind it yet.
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByText(email.toLowerCase())).toBeVisible();
  const boxes = page.getByRole("group", { name: "Verification code" }).getByRole("textbox");
  await expect(boxes).toHaveCount(6);
  await expect(page.getByTestId("code-expires-in")).toHaveText(/^00:[0-5]\d$/);
  await expect(page.getByTestId("code-resend-in")).toContainText(/Resend code in 00:[0-5]\d/);
  await expect(page.getByRole("button", { name: "Resend verification code" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Paste code" })).toBeVisible();
  const shown = await page.getByTestId("code-expires-in").textContent();
  // A reload comes back to the same code and the same countdown (the server's clock, not the page's).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const afterReload = await page.getByTestId("code-expires-in").textContent();
  const secs = (t: string | null) => Number(t!.split(":")[0]) * 60 + Number(t!.split(":")[1]);
  expect(secs(afterReload)).toBeLessThanOrEqual(secs(shown));
  expect(secs(afterReload)).toBeGreaterThan(secs(shown) - 15);

  const code = await latestMailCode(email, before);
  expect((await mailSubjects(email.toLowerCase()))[0]).toBe("Your bizinsights verification code");
  // A wrong code is refused; typing moves from box to box, Backspace moves back.
  await boxes.first().click();
  await page.keyboard.type(code === "000000" ? "111111" : "000000");
  await expect(alert(page)).toContainText("The verification code is incorrect");
  await expect(page).toHaveURL(/\/login/);
  await page.keyboard.press("Backspace");
  await expect(boxes.nth(5)).toHaveValue("");
  // Pasting the whole code fills every box and sends it.
  await boxes.first().click();
  await page.evaluate((c) => navigator.clipboard.writeText(c), code).catch(() => undefined);
  await fillCode(page, code);
  await expect(page).toHaveURL(/\/dashboard/);
  await page.reload();
  await expect(page).toHaveURL(/\/dashboard/);
});

test("on a phone: Paste code takes the code copied from the email, and says what to do when the clipboard can't be read", async ({ page, context }) => {
  const email = uniqueEmail("paste-code");
  await signUp(page, email);
  await createWorkspace(page, "Paste Co");
  await page.goto("/dashboard");
  await signOutFromMenu(page);
  await expect(page).toHaveURL(/\/login/);

  await page.setViewportSize({ width: 375, height: 812 });
  await asNewVisitor(page);
  await page.getByLabel("Email Address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  const before = await newestMailId(email);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const code = await latestMailCode(email, before);
  // The code comes from the support sender; the email says how long it lasts.
  expect(await latestMailSender(email.toLowerCase())).toEqual({ address: "support@bizinsights.io", name: "BizInsights Support" });

  // Everything the step needs fits the phone's width: the boxes, Paste code, the countdowns.
  const paste = page.getByRole("button", { name: "Paste code" });
  const boxes = page.getByRole("group", { name: "Verification code" }).getByRole("textbox");
  await expect(paste).toBeInViewport();
  await expect(boxes.last()).toBeInViewport();
  await expect(page.getByTestId("code-expires-in")).toHaveText(/^00:[0-5]\d$/);
  await expect(page.getByTestId("code-resend-in")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // The browser refuses to read the clipboard (permission denied): nothing is filled, and the
  // person is told how to paste by hand.
  await page.evaluate(() => {
    navigator.clipboard.readText = () => Promise.reject(new DOMException("Read permission denied.", "NotAllowedError"));
  });
  await paste.click();
  await expect(page.getByRole("status").filter({ hasText: "didn't let bizinsights read the clipboard" })).toBeVisible();
  await expect(boxes.first()).toHaveValue("");
  await expect(page).toHaveURL(/\/login/);

  // Allowed, but what was copied holds no code.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(async () => {
    delete (navigator.clipboard as { readText?: unknown }).readText;
    await navigator.clipboard.writeText("Order #1048291 is on its way");
  });
  await paste.click();
  await expect(page.getByRole("status").filter({ hasText: "There's no 6-digit code on your clipboard" })).toBeVisible();
  await expect(boxes.first()).toHaveValue("");

  // The email's text, copied whole: the code goes into the boxes and signs in, as if typed.
  await page.evaluate(async (c) => navigator.clipboard.writeText(`Use the verification code below to continue.\n\n    ${c}\n\nThis code expires in 60 seconds.`), code);
  const checked = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/login/code");
  await paste.click();
  expect(JSON.parse((await checked).request().postData() ?? "{}")).toEqual({ code });
  await expect(page).toHaveURL(/\/dashboard/);
});

test.describe("two-step verification", () => {
  test.beforeAll(() => poolMfa(true));
  test.afterAll(() => poolMfa(false));

  test("set up in Settings, it asks for the authenticator app's code at the next sign-in", async ({ page }) => {
    const email = uniqueEmail("totp");
    await signUp(page, email);
    await createWorkspace(page, "Two Step Co");
    await page.goto("/settings/security");
    await section(page, "Two-step verification").getByRole("button", { name: "Set up", exact: true }).click();
    const twoStep = page.getByRole("dialog", { name: "Two-step verification" });
    await twoStep.getByLabel("Current password", { exact: true }).fill(PASSWORD);
    await twoStep.getByRole("button", { name: "Set up two-step verification" }).click();
    const key = (await twoStep.getByLabel("Your authenticator key").textContent())!;
    await fillCode(twoStep, totpCode(key));
    await expect(page.getByText("Two-step verification is on.")).toBeVisible();
    await expect(section(page, "Two-step verification").getByText("Enabled", { exact: true })).toBeVisible();

    await page.goto("/dashboard");
    await signOutFromMenu(page);
    await expect(page).toHaveURL(/\/login/);
    await logIn(page, email);
    // The password was right: now the app's code, on its own step.
    await expect(page.getByRole("heading", { name: "Two-step verification" })).toBeVisible();
    const now = totpCode(key);
    await fillCode(page, now === "000000" ? "111111" : "000000");
    await expect(alert(page)).toContainText("isn't right");
    await fillCode(page, totpCode(key));
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
  await expect(section(page, "Password")).toContainText("You sign in with Google only");
  await section(page, "Password").getByRole("button", { name: "Add", exact: true }).click();
  const password = page.getByRole("dialog", { name: "Add a password" });
  await password.getByLabel("Password", { exact: true }).fill("a-new-password-1");
  await password.getByLabel("Confirm password", { exact: true }).fill("a-new-password-1");
  await password.getByRole("button", { name: "Add a password" }).click();
  await expect(page.getByText("Password added.")).toBeVisible();
  expect((await methodsOf(email)).map((m) => m.method)).toEqual(["google", "password"]);

  await page.context().clearCookies();
  await page.goto("/login");
  await logIn(page, email, "a-new-password-1");
  await expect(page).toHaveURL(/\/dashboard/);
});

test("Settings → Security: deleting the account takes DELETE and a code emailed to its address, never a password", async ({ page }) => {
  const email = uniqueEmail("delete-me");
  await signUp(page, email);
  await createWorkspace(page, "Delete Me Co");
  await page.goto("/settings/security");
  await section(page, "Delete account").getByRole("button", { name: "Delete my account" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete your account?" });
  // No password box: beside one, the browser's password manager filled the address into the DELETE box.
  await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
  const typed = dialog.getByLabel("Type DELETE to confirm");
  await expect(typed).toHaveValue("");
  await expect(typed).toHaveAttribute("autocomplete", "off");
  const send = dialog.getByRole("button", { name: "Email me a code" });
  await expect(send).toBeDisabled();
  await typed.fill("DELETE");

  // The workspace's only owner hears why before any code is emailed.
  await send.click();
  await expect(dialog.getByRole("alert")).toContainText("You're the only owner of Delete Me Co");
  await db.query("UPDATE memberships SET role = 'admin' WHERE user_id = (SELECT id FROM users WHERE email = $1)", [email]);

  const before = await newestMailId(email, /Confirm deleting/);
  await send.click();
  const code = await latestMailCode(email, before, /Confirm deleting/);
  await expect(dialog.getByText(/Code expires in 00:[0-5]\d/)).toBeVisible();
  await expect(dialog).not.toContainText(email);
  const remove = dialog.getByRole("button", { name: "Delete account" });
  await expect(remove).toBeDisabled();
  await dialog.getByRole("group", { name: "Code from the email" }).getByRole("textbox").first().fill(code);
  await expect(typed).toHaveValue("DELETE");
  await remove.click();
  await expect(page).toHaveURL(/\/login\?deleted=1/);
  expect((await db.query("SELECT 1 FROM users WHERE email = $1", [email])).rowCount).toBe(0);
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
