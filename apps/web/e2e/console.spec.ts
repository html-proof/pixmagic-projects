import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { signUp, uniqueEmail } from "./helpers";

/**
 * The browser console stays free of two things that once filled it:
 * - "preloaded using link preload but not used". Prefetching a page in other fonts (Geist: the
 *   landing, sign-in and legal pages; Geist Mono: the landing alone) preloads that page's fonts and
 *   stylesheet on the current one (docs/architecture.md, "Fonts and prefetch"). Chrome lists every
 *   unused preload again a few seconds after each later request, so on the polling dashboard three
 *   of them became hundreds.
 * - Content-Security-Policy violations, the Report-Only policy's included (public/_headers).
 */

const db = new pg.Pool({ connectionString: E2E_ENV.DATABASE_URL });
test.afterAll(() => db.end());

const PRELOAD_WARNING = /preloaded using link preload but not used/;

/**
 * This page's preloads that nothing uses, counted the way Chrome counts them: a stylesheet that
 * isn't applied, a font no applied @font-face declares, a script that never ran.
 */
const unusedPreloads = (page: Page) =>
  page.evaluate(() => {
    const sheets = new Set([...document.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet]")].map((l) => l.href));
    const scripts = new Set([...document.scripts].map((s) => s.src));
    const fonts = new Set<string>();
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (!(rule instanceof CSSFontFaceRule)) continue;
        for (const [, url] of rule.style.getPropertyValue("src").matchAll(/url\("?([^")]+)"?\)/g)) fonts.add(new URL(url, sheet.href ?? location.href).href);
      }
    }
    const used = (l: HTMLLinkElement) => (l.as === "style" ? sheets.has(l.href) : l.as === "font" ? fonts.has(l.href) : l.as === "script" ? scripts.has(l.href) : false);
    return [...document.querySelectorAll<HTMLLinkElement>("link[rel=preload]")].filter((l) => !used(l)).map((l) => `${l.as} ${new URL(l.href).pathname}`);
  });

/**
 * Hover every link on screen: Next prefetches a link's page when it comes into view, and on hover.
 * (Events, not the mouse: links under an open menu can't be hovered for real.)
 */
const hoverLinks = (page: Page) =>
  page.evaluate(() => {
    for (const a of document.querySelectorAll("a[href]")) if (a.getClientRects().length) a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });

/** Open a page, give every link on it (menus included) the chance to prefetch, then look. */
async function check(page: Page, path: string, heading: RegExp, where: string) {
  await page.goto(path);
  await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
  await hoverLinks(page);
  // The account menu, the notifications panel and (on a phone) the navigation drawer hold links too.
  for (const menu of [page.getByRole("button", { name: "Account menu" }), page.getByTestId("notifications-bell"), page.getByRole("button", { name: "Open navigation" })]) {
    if (!(await menu.isVisible())) continue;
    await menu.click();
    await hoverLinks(page);
    await page.keyboard.press("Escape");
  }
  // Prefetches start on hover and finish in the background.
  await page.waitForTimeout(1_500);
  expect(await unusedPreloads(page), `unused preloads on ${path} ${where}`).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations), `CSP violations on ${path} ${where}`).toEqual([]);
}

test("pages preload nothing they don't use and break no content policy, signed out and in, on desktop and phone", async ({ page }) => {
  test.setTimeout(180_000);
  const warnings: string[] = [];
  page.on("console", (m) => {
    if (PRELOAD_WARNING.test(m.text())) warnings.push(`${page.url()}: ${m.text()}`);
  });
  await page.addInitScript(() => {
    const w = window as unknown as { cspViolations: string[] };
    w.cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => w.cspViolations.push(`${e.disposition} ${e.effectiveDirective} ${e.blockedURI}`));
  });

  // Signed out: the landing page, the sign-in and legal pages (Geist), and the plain account pages
  // (AuthCard) an invitation or a failed sign-in opens.
  const publicPages: ReadonlyArray<readonly [string, RegExp]> = [
    ["/", /./],
    ["/login", /Welcome Back/],
    ["/signup", /Create your account/],
    ["/forgot-password", /Forgot your password/],
    ["/support", /./],
    ["/privacy", /./],
    ["/terms", /./],
    ["/data-deletion", /./],
    ["/invite?token=not-a-real-invitation", /./],
    ["/auth/error", /couldn't sign you in/],
  ];
  for (const [path, heading] of publicPages) await check(page, path, heading, "signed out");

  await signUp(page, uniqueEmail("console"));
  const ws = await page.evaluate(async () => {
    const r = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Console Co" }) });
    if (!r.ok) throw new Error(`POST /workspaces failed: ${r.status}`);
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  });
  await db.query(
    `INSERT INTO stores (id, workspace_id, shop_domain, status, timezone, currency, granted_scopes, pixel_ingest_key, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, 'active', 'UTC', 'USD', $3, gen_random_uuid()::text, now(), now())`,
    [ws, `console-${Date.now()}.myshopify.com`, ["read_orders", "read_products"]],
  );

  const appPages: ReadonlyArray<readonly [string, RegExp]> = [
    ["/dashboard", /./],
    ["/team", /Team & Access/],
    ["/settings/members", /./],
    ["/settings/security", /./],
    ["/settings/profile", /Profile/],
    ["/staff", /./],
    ["/whatsapp", /./],
  ];
  for (const viewport of [
    { width: 1366, height: 860 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const [path, heading] of appPages) await check(page, path, heading, `at ${viewport.width}px`);
  }
  // Chrome's own check runs a few seconds after load and again after later requests.
  await page.waitForTimeout(3_500);
  expect(warnings).toEqual([]);
});
