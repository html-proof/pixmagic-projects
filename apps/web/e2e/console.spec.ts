import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_BASE_URL, E2E_ENV } from "../playwright.config";
import { createWorkspace, insertStore, signUp, uniqueEmail } from "./helpers";

/**
 * The browser console stays free of errors (a refused request, an uncaught exception), and of two
 * things that once filled it:
 * - "preloaded using link preload but not used". Prefetching a page in other fonts (Geist: the
 *   landing, sign-in and legal pages; Geist Mono: the landing alone) preloads that page's fonts and
 *   stylesheet on the current one (docs/architecture.md, "Fonts and prefetch"). Chrome lists every
 *   unused preload again a few seconds after each later request, so on the polling dashboard three
 *   of them became hundreds.
 * - Content-Security-Policy violations (public/_headers: enforced, so one is something the page
 *   needed and the browser refused).
 *
 * One test per page and viewport, signed out and in. Each opens its page once, so the suite's
 * slowest machine (the PC runner under load runs it 2-3x slower) can't push one test past its
 * budget, and a failure names the page. The signed-in tests share one account, created once.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.OWNER_DATABASE_URL });
test.afterAll(() => db.end());

const PRELOAD_WARNING = /preloaded using link preload but not used/;
/**
 * Playwright's trace recorder (the config records every test) runs a script in each frame, and a
 * sandboxed frame such as the email preview (EmailPreviewFrame) refuses it. No browser outside a
 * recorded test runs that script.
 */
const RECORDER_REFUSED = /^Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed/;

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

/**
 * Wait for React to take over the page's links. An exported page shows its heading before then, and
 * a link scrolled into view or hovered before hydration prefetches nothing.
 */
const hydrated = (page: Page) =>
  page.waitForFunction(() => {
    const a = document.querySelector("a[href]");
    return !a || Object.keys(a).some((k) => k.startsWith("__reactFiber"));
  });

/** Scroll to the bottom and back, so the links further down (a footer's) come into view and prefetch too. */
const scrollThrough = (page: Page) =>
  page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight * 0.8) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 150));
    }
    scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((r) => setTimeout(r, 500));
    scrollTo(0, 0);
  });

/**
 * Open a page, give every link on it (menus included) the chance to prefetch, then look: at the
 * preloads in the page, at the policy reports the page saw, and at Chrome's own warnings.
 */
async function check(page: Page, path: string, heading: RegExp) {
  const where = `${path} at ${page.viewportSize()?.width}px`;
  const warnings: string[] = [];
  const errors: string[] = [];
  page.on("console", (m) => {
    if (PRELOAD_WARNING.test(m.text())) warnings.push(`${page.url()}: ${m.text()}`);
    // Chrome logs every response of 400 or more this way, a signed-out visitor's 401 included.
    if (m.type() === "error" && !RECORDER_REFUSED.test(m.text())) errors.push(`${page.url()}: ${m.text()} (${m.location().url})`);
  });
  page.on("pageerror", (e) => errors.push(`${page.url()}: uncaught ${e.message}`));
  await page.addInitScript(() => {
    const w = window as unknown as { cspViolations: string[] };
    w.cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => w.cspViolations.push(`${e.disposition} ${e.effectiveDirective} ${e.blockedURI}`));
  });

  await page.goto(path);
  await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
  await hydrated(page);
  await scrollThrough(page);
  await hoverLinks(page);
  // The account menu, the notifications panel and (on a phone) the navigation drawer hold links too.
  for (const menu of [page.getByRole("button", { name: "Account menu" }), page.getByTestId("notifications-bell"), page.getByRole("button", { name: "Open navigation" })]) {
    if (!(await menu.isVisible())) continue;
    await menu.click();
    await hoverLinks(page);
    await page.keyboard.press("Escape");
  }
  // Prefetches start on hover and finish in the background. Chrome runs its own unused-preload
  // check about 3 s after the page's last request (the menus' included), so it has reported by now.
  await page.waitForTimeout(3_500);
  expect(await unusedPreloads(page), `unused preloads on ${where}`).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations), `CSP violations on ${where}`).toEqual([]);
  expect(warnings, `Chrome's preload warnings on ${where}`).toEqual([]);
  expect(errors, `console errors on ${where}`).toEqual([]);
}

const title = (path: string) => `${path} logs no error, preloads nothing it doesn't use and breaks no content policy`;

// Signed out: the landing page, the sign-in and legal pages (Geist), and the plain account pages
// (AuthCard) an invitation or a failed sign-in opens.
test.describe("signed out", () => {
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
    // App pages, signed out: off to sign in, without a refused request on the way (getMe).
    ["/dashboard", /Welcome Back/],
    ["/portal", /Welcome Back/],
  ];
  for (const [path, heading] of publicPages) test(title(path), ({ page }) => check(page, path, heading));
});

test.describe("signed in", () => {
  // One account with a workspace and a store, created before the first test; every test's browser
  // context starts from its session (the API's cookie), so none has to sign in itself.
  let signedIn: Awaited<ReturnType<BrowserContext["storageState"]>> | undefined;
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage({ baseURL: E2E_BASE_URL });
    await signUp(page, uniqueEmail("console"));
    const ws = await createWorkspace(page, "Console Co");
    await insertStore(db, ws, `console-${Date.now()}.myshopify.com`);
    signedIn = await page.context().storageState();
    await page.context().close();
  });
  // (A fixture's first parameter is its dependency list, empty here; `provide` is Playwright's `use`.)
  // eslint-disable-next-line no-empty-pattern
  test.use({ storageState: async ({}, provide) => provide(signedIn) });

  const appPages: ReadonlyArray<readonly [string, RegExp]> = [
    ["/dashboard", /./],
    ["/team", /Team & Access/],
    ["/settings/members", /./],
    ["/settings/security", /./],
    ["/settings/profile", /Profile/],
    ["/staff", /./],
    ["/whatsapp", /./],
    ["/messaging", /./],
    ["/automations", /./],
    // A new email template: its live preview renders before it has a name.
    ["/settings/email/templates/edit", /./],
  ];
  for (const [name, viewport] of [
    ["on desktop", { width: 1366, height: 860 }],
    ["on a phone", { width: 390, height: 844 }],
  ] as const) {
    test.describe(name, () => {
      test.use({ viewport });
      for (const [path, heading] of appPages) test(title(path), ({ page }) => check(page, path, heading));
    });
  }
});
