import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route("**/api/auth/login/code", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ pending: false }) }));
  await page.route("**/api/auth/config", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ providers: { google: false }, emailOtp: false, loginCode: false }) }));
  await page.route("**/api/auth/whoami", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: null }) }));
});

test("missing invitation has an actionable dedicated state", async ({ page }) => {
  await page.goto("/invite");
  await expect(page.getByRole("heading", { name: "This link doesn't work" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept invitation" })).toHaveCount(0);
});

test("session recovery explains why sign-in is needed", async ({ page }) => {
  await page.goto("/login?reason=session_expired");
  await expect(page.getByRole("status")).toContainText("Session expired");
});

test("invalid fields are associated with inline validation messages", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  const email = page.getByLabel("Email Address", { exact: true });
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#email-error")).toHaveText("Enter your email address.");
  await email.fill("merchant@example.com");
  await email.blur();
  await expect(email).not.toHaveAttribute("aria-invalid");
});

test("offline banner clears when connectivity returns on mobile", async ({ page, context }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/login");
  await context.setOffline(true);
  await expect(page.getByRole("status").filter({ hasText: "Connection lost" })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText("Connection lost", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const [status, title] of [[403, "Access denied"], [500, "Something went wrong"], [503, "Service temporarily unavailable"]] as const) {
  test(`API ${status} keeps its meaning and shows a safe support reference`, async ({ page }) => {
    await page.route("**/api/me", (route) => route.fulfill({ status, contentType: "application/json", headers: { "x-request-id": "test-ref-123" }, body: JSON.stringify({ error: "failure", message: "private-database-password" }) }));
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.getByText("Support reference: test-ref-123")).toBeVisible();
    await expect(page.getByText("private-database-password")).toHaveCount(0);
    await expect(page).toHaveURL(/dashboard/);
    if (status === 403) {
      await expect(page.getByRole("link", { name: "Return to dashboard" })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("access-desktop.png") });
      await page.setViewportSize({ width: 375, height: 812 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath("access-mobile.png") });
    }
    if (status >= 500) await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });
}

test("unknown paths keep the 404 status and dashboard recovery", async ({ page }) => {
  const response = await page.goto("/this-page-does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page Not Found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to Dashboard", exact: true })).toHaveAttribute("href", "/dashboard");
});

test("an expired invitation preserves the current shared-link flow", async ({ page }) => {
  await page.route("**/api/invitations/preview*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "expired" }) }));
  await page.goto("/invite?token=expired-invitation-example");
  await expect(page.getByRole("heading", { name: "Invitation expired" })).toBeVisible();
  await expect(page.getByText(/Ask the person who invited you to renew it/)).toBeVisible();
});

test("billing failure offers status recovery without submitting a second charge", async ({ page }) => {
  const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/me", (route) => route.fulfill(json({ user: { id: "u", email: "owner@example.com", emailVerified: true, displayName: "Owner", timezone: "UTC" }, workspaces: [{ id: "ws", name: "Demo", role: "owner", permissions: [], accessStatus: "active" }] })));
  await page.route("**/api/workspaces/ws/stores", (route) => route.fulfill(json({ stores: [{ id: "store", name: "Demo store", shopDomain: "demo.myshopify.com", status: "active", timezone: "UTC", currency: "USD", grantedScopes: [], revocableScopes: [], pixelInstalled: true, lastSyncedAt: null }] })));
  await page.route("**/api/workspaces/ws/billing", (route) => route.fulfill(json({ subscription: { plan: "free", status: "active" }, plans: [{ id: "free", name: "Free", priceUsd: 0, features: [] }, { id: "pro", name: "Pro", priceUsd: 29, features: [] }] })));
  let submissions = 0;
  await page.route("**/api/workspaces/ws/billing/subscribe", (route) => { submissions++; return route.fulfill({ status: 400, ...json({ error: "billing_error", message: "private payment details" }) }); });
  await page.goto("/settings/billing");
  await page.waitForURL(/settings\/(billing|profile)/);
  if (page.url().includes("/profile")) { test.skip(true, "Billing is disabled in this build"); return; }
  await page.getByRole("button", { name: "Upgrade to Pro" }).click();
  await expect(page.getByRole("heading", { name: "Payment failed" })).toBeVisible();
  await expect(page.getByText("private payment details")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("payment-recovery.png") });
  await page.getByRole("button", { name: "Check billing status" }).click();
  await expect(page.getByRole("heading", { name: "Payment failed" })).toHaveCount(0);
  expect(submissions).toBe(1);
});

test("retrying a service outage requests the page again", async ({ page }) => {
  let unavailable = true;
  await page.route("**/api/me", (route) => { return route.fulfill({ status: unavailable ? 503 : 403, contentType: "application/json", body: "{}" }); });
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Service temporarily unavailable" })).toBeVisible();
  unavailable = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
});

for (const [status, title] of [[408, "Request timed out"], [409, "This item has changed"], [410, "This link is no longer available"], [413, "Request is too large"], [429, "Too many requests"], [502, "Upstream service unavailable"], [504, "Service took too long to respond"]] as const) {
  test(`HTTP ${status} has its own recovery state`, async ({ page }) => {
    await page.route("**/api/me", (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ message: "private response" }) }));
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.getByText("private response")).toHaveCount(0);
    await expect(page).toHaveURL(/dashboard/);
  });
}

for (const path of ["track", "review"]) {
  test(`${path} expired links offer customer recovery without merchant links`, async ({ page }) => {
    await page.route(`**/api/public/${path}/*`, (route) => route.fulfill({ status: 410, contentType: "application/json", body: JSON.stringify({ message: "private link token" }) }));
    await page.goto(`/${path}?t=expired-example`);
    await expect(page.getByRole("heading", { name: "This link is no longer available" })).toBeVisible();
    await expect(page.getByRole("link", { name: /dashboard/i })).toHaveCount(0);
    await expect(page.getByText("private link token")).toHaveCount(0);
  });
}

test("customer tracking retries network failure in place", async ({ page }) => {
  let failed = true;
  await page.route("**/api/public/track/*", (route) => failed ? route.abort() : route.fulfill({ status: 410, contentType: "application/json", body: "{}" }));
  await page.goto("/track?t=example");
  await expect(page.getByRole("heading", { name: "We couldn't load this page" })).toBeVisible();
  failed = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "This link is no longer available" })).toBeVisible();
});

test("failed review submission keeps the customer's draft", async ({ page }) => {
  await page.route("**/api/public/review/*", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "private provider stack trace" }) })
    : route.fulfill({ contentType: "application/json", body: JSON.stringify({ store: { name: "Demo store" }, order: { name: "#1001", placedAt: "2026-10-01", deliveredAt: "2026-10-05", cancelled: false }, products: [], existing: [], canEdit: true }) }));
  await page.goto("/review?t=example");
  await page.getByRole("radio", { name: "5 stars" }).press("Space");
  await page.locator("#rv-body").fill("My draft review");
  await page.getByRole("button", { name: "Send my review" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "try again" })).toBeVisible();
  await expect(page.locator("#rv-body")).toHaveValue("My draft review");
  await expect(page.getByText("private provider stack trace")).toHaveCount(0);
});

test("server retry delay disables manual retries and pauses automatic requests", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/me", (route) => { requests++; return route.fulfill({ status: 429, contentType: "application/json", headers: { "retry-after": "10" }, body: "{}" }); });
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Too many requests" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Try again in/ })).toBeDisabled();
  const before = requests;
  await page.clock.install();
  await page.clock.fastForward(3000);
  expect(requests).toBe(before);
});

test("password reset reports a delivery outage without claiming an email was sent", async ({ page }) => {
  await page.route("**/api/auth/password/forgot", (route) => route.abort());
  await page.goto("/forgot-password");
  await page.getByLabel("Email Address", { exact: true }).fill("merchant@example.com");
  await page.getByRole("button", { name: "Send reset code" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /try again|connection|sign-in/i })).toBeVisible();
  await expect(page.getByText(/a reset link is on its way/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send reset code" })).toBeEnabled();
});
