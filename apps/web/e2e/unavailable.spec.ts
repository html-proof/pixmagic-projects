import { expect, test } from "@playwright/test";

/**
 * CloudFront serves the /unavailable page, as a 503, at whatever page address the server couldn't
 * answer (infra/cdk/lib/app-stack.ts). It has to work there: stay put, come alive, and reload the real
 * page. Against the static export, as CloudFront serves it: under `next dev` (playwright.errors.config)
 * a page served at another address never hydrates, so this file isn't in that suite.
 */
test("while the server can't answer, any page shows the unavailable page, which brings the page back", async ({ page }) => {
  const outage = await (await page.request.get("/unavailable")).text();
  await page.route("**/dashboard?from=outage", (route) => route.fulfill({ status: 503, contentType: "text/html; charset=utf-8", body: outage }));
  await page.goto("/dashboard?from=outage");
  await expect(page.getByRole("heading", { name: "Service temporarily unavailable" })).toBeVisible();
  await expect(page.getByText("Error 503")).toBeVisible();
  await expect(page.getByRole("link", { name: "Email support" })).toHaveAttribute("href", /^mailto:.+@/);
  await expect(page).toHaveURL(/\/dashboard\?from=outage$/);
  // Hydrated: its button works.
  await expect.poll(() => page.evaluate(() => Object.keys(document.querySelector("main button")!).some((k) => k.startsWith("__react")))).toBe(true);
  await page.unroute("**/dashboard?from=outage");
  const reload = page.waitForRequest((r) => r.isNavigationRequest() && r.url().endsWith("/dashboard?from=outage"));
  await page.getByRole("button", { name: "Try again" }).click();
  await reload;
  await expect(page.getByRole("heading", { name: "Service temporarily unavailable" })).toHaveCount(0);
});
