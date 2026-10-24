import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { signUp, uniqueEmail } from "./helpers";

/**
 * "Continue with WhatsApp" in the browser: the real page and app, with Meta's side stubbed.
 *
 * Meta's SDK (connect.facebook.net) is replaced by a small script that behaves like FB.login, and
 * Meta's own page by one on www.facebook.com that posts Embedded Signup's WA_EMBEDDED_SIGNUP message
 * to the window, as Meta's does. What runs for real is bizinsights: the button, the states it shows,
 * the origin check on Meta's message, and what it sends the server. The server's side of the
 * exchange (code, token, ids, registration) is covered by apps/api/test/whatsapp.test.ts against a
 * fake Graph API; a real Meta sign-in can only be checked by hand with bizinsights' Meta app.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.DATABASE_URL });
test.afterAll(() => db.end());

type Scenario =
  /** FB.login answers at once with no code: the browser never opened Meta's window. */
  | { kind: "blocked" }
  /** Meta's window posts `message` (if any), then FB.login answers after `delay` ms with `code` (or none). */
  | { kind: "window"; message?: Record<string, unknown>; code?: string; delay?: number };

const FAKE_SDK = `
window.FB = {
  init: function (o) { window.__fbInit = o; },
  login: function (cb, opts) {
    window.__fbLoginOpts = opts;
    var s = window.__fbScenario || { kind: "blocked" };
    if (s.kind === "blocked") { cb({ authResponse: null, status: "unknown" }); return; }
    if (s.message) {
      var f = document.createElement("iframe");
      f.style.display = "none";
      f.src = "https://www.facebook.com/__e2e_embedded_signup?" + new URLSearchParams({ msg: JSON.stringify(s.message) });
      document.body.appendChild(f);
    }
    setTimeout(function () { cb(s.code ? { authResponse: { code: s.code }, status: "connected" } : { authResponse: null, status: "unknown" }); }, s.delay || 1500);
  }
};
if (window.fbAsyncInit) window.fbAsyncInit();
`;

async function stubMeta(page: Page) {
  await page.route("https://connect.facebook.net/**", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: FAKE_SDK }));
  await page.route("https://www.facebook.com/__e2e_embedded_signup**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><script>parent.postMessage(new URLSearchParams(location.search).get("msg"), "*")</script>` }),
  );
}

const scenario = (page: Page, s: Scenario) => page.evaluate((x) => ((window as unknown as { __fbScenario: Scenario }).__fbScenario = x), s);

/** A verified owner with a workspace and a store, on Connect WhatsApp. */
async function onConnectPage(page: Page) {
  const email = uniqueEmail("wa");
  await signUp(page, email);
  const ws = await page.evaluate(async () => {
    const r = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "WA Co" }) });
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  });
  const { rows } = await db.query(
    `INSERT INTO stores (id, workspace_id, shop_domain, status, timezone, currency, granted_scopes, pixel_ingest_key, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, 'active', 'UTC', 'INR', ARRAY['read_orders'], gen_random_uuid()::text, now(), now()) RETURNING id`,
    [ws, `wa-${Date.now()}.myshopify.com`],
  );
  await stubMeta(page);
  await page.goto("/whatsapp/connect");
  const button = page.getByTestId("wa-connect");
  await expect(button).toHaveText(/Continue with WhatsApp/);
  return { ws, storeId: rows[0].id as string, button, status: page.getByTestId("wa-connect-status") };
}

const FINISH = { type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { waba_id: "1111111111", phone_number_id: "2222222222", business_id: "9999999" } };

test("a blocked Meta window, or one closed part-way, says so and connects nothing", async ({ page }) => {
  const { button, status, ws, storeId } = await onConnectPage(page);

  await scenario(page, { kind: "blocked" });
  await button.click();
  await expect(status).toContainText("Meta's window didn't open. Allow pop-ups");
  await expect(button).toHaveText(/Try again/);
  // The SDK was started with bizinsights' app and the Embedded Signup configuration, asking for a code.
  expect(await page.evaluate(() => (window as unknown as { __fbInit: { appId: string } }).__fbInit.appId)).toBe("e2e_meta_app");
  expect(await page.evaluate(() => (window as unknown as { __fbLoginOpts: Record<string, unknown> }).__fbLoginOpts)).toMatchObject({ config_id: "e2e_config", response_type: "code", override_default_response_type: true });

  await scenario(page, { kind: "window", message: { type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { current_step: "PHONE_NUMBER_SETUP" } } });
  await button.click();
  await expect(status).toContainText("Complete the setup in the Meta window.");
  await expect(button).toBeDisabled();
  await expect(status).toContainText("Meta's window was closed while adding the phone number before the setup finished. Nothing was connected.");
  await expect(button).toBeEnabled();

  const n = await db.query("SELECT count(*)::int AS n FROM whatsapp_connections WHERE store_id = $1", [storeId]);
  expect(n.rows[0].n).toBe(0);
  expect(ws).toBeTruthy();
});

test("a message that isn't from Meta is ignored; Meta's finish is sent to the server, and its refusal is shown", async ({ page }) => {
  const { button, status } = await onConnectPage(page);
  const sent: unknown[] = [];
  await page.route("**/api/workspaces/*/stores/*/whatsapp/embedded", async (route) => {
    sent.push(route.request().postDataJSON());
    await new Promise((r) => setTimeout(r, 800));
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "exchange_failed", message: "Meta didn't accept the sign-in (it expires after 30 seconds). Please press Connect again." }) });
  });

  // Someone else's page posting a look-alike message: not from facebook.com, so nothing happens.
  await page.evaluate(() => window.postMessage(JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { waba_id: "1", phone_number_id: "2" } }), "*"));

  await scenario(page, { kind: "window", message: FINISH, code: "es-code-from-meta" });
  await button.click();
  await expect(status).toContainText("Connecting your WhatsApp Business account…");
  await expect(page.getByRole("alert").filter({ hasText: "Meta didn't accept the sign-in" })).toBeVisible();
  await expect(button).toHaveText(/Try again/);
  expect(sent).toEqual([{ code: "es-code-from-meta", wabaId: "1111111111", phoneNumberId: "2222222222", businessId: "9999999", event: "FINISH" }]);
});

test("a finished sign-up shows the connection, and a number with its own PIN is asked for it", async ({ page }) => {
  const { button } = await onConnectPage(page);
  let registration = "registered";
  await page.route("**/api/workspaces/*/stores/*/whatsapp/embedded", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connection: {}, registration }) }),
  );

  await scenario(page, { kind: "window", message: FINISH, code: "es-code-from-meta" });
  await button.click();
  await expect(page.getByRole("status").filter({ hasText: "WhatsApp Business connected successfully" })).toBeVisible();

  registration = "pin_needed";
  await scenario(page, { kind: "window", message: FINISH, code: "es-code-again" });
  await button.click();
  await expect(page.getByRole("status").filter({ hasText: "Action required" })).toBeVisible();
});

test("Meta finishing without a phone number connects nothing and says what to do", async ({ page }) => {
  const { button, status } = await onConnectPage(page);
  let called = false;
  await page.route("**/api/workspaces/*/stores/*/whatsapp/embedded", (route) => {
    called = true;
    return route.abort();
  });
  await scenario(page, { kind: "window", message: { type: "WA_EMBEDDED_SIGNUP", event: "FINISH_ONLY_WABA", data: { waba_id: "1111111111" } }, code: "es-code-from-meta" });
  await button.click();
  await expect(status).toContainText("finished without a phone number");
  expect(called).toBe(false);
});

test("the manual connect's token can be added in Nango's window, and the connect then sends only its handle", async ({ page }) => {
  const { ws, storeId } = await onConnectPage(page);
  const base = `**/api/workspaces/${ws}/stores/${storeId}/whatsapp`;
  // This server as if Nango held the WhatsApp integration (docs/whatsapp.md "Through Nango").
  await page.route(base, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { platform: Record<string, unknown> };
    await route.fulfill({ response: res, json: { ...body, platform: { ...body.platform, nango: true } } });
  });
  const calls: Array<{ path: string; body: unknown }> = [];
  await page.route(`${base}/nango/*`, (route) => {
    const path = new URL(route.request().url()).pathname.split("/").pop()!;
    calls.push({ path, body: route.request().postDataJSON() });
    if (path === "session") return route.fulfill({ json: { token: "nango_connect_session_wa", expiresAt: null, nonce: "e2e-wa-nango-nonce-0001" } });
    return route.fulfill({
      json: {
        appId: "777",
        accounts: [{ id: "1111111111", name: "Green Leaf WABA", numbers: [{ id: "2222222222", displayPhoneNumber: "+91 98765 00000", verifiedName: "Green Leaf", registered: true }] }],
        tokenHandle: "e2e-held-token-handle-0001",
      },
    });
  });
  await page.route(`${base}/manual`, (route) => {
    calls.push({ path: "manual", body: route.request().postDataJSON() });
    return route.fulfill({ status: 400, json: { error: "wrong_app_secret", message: "That app secret belongs to a different app." } });
  });
  // Nango's Connect UI: ready, takes the session token, then says the token was saved.
  await page.route("https://connect.nango.dev/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body>Connect UI stand-in<script>
        window.addEventListener("message", (e) => {
          if (e.data && e.data.type === "session_token" && e.data.sessionToken === "nango_connect_session_wa") {
            parent.postMessage({ type: "connect", payload: { providerConfigKey: "whatsapp-business", connectionId: "conn-e2e-wa" } }, "*");
          }
        });
        parent.postMessage({ type: "ready" }, "*");
      </script></body></html>`,
    }),
  );
  await page.reload();

  await page.getByRole("button", { name: "Use your own Meta app instead" }).click();
  await expect(page.getByLabel("Access token")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Paste it here instead" })).toBeVisible();
  await page.getByRole("button", { name: "Add your token" }).click();
  await expect(page.getByText("+91 98765 00000")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a different token" })).toBeVisible();

  await page.getByLabel("App secret").fill("0123456789abcdef0123456789abcdef");
  await page.getByRole("button", { name: "Connect WhatsApp" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "That app secret belongs to a different app." })).toBeVisible();
  expect(calls).toEqual([
    { path: "session", body: {} },
    { path: "finish", body: { nonce: "e2e-wa-nango-nonce-0001", connectionId: "conn-e2e-wa" } },
    { path: "manual", body: { wabaId: "1111111111", phoneNumberId: "2222222222", tokenHandle: "e2e-held-token-handle-0001", appSecret: "0123456789abcdef0123456789abcdef" } },
  ]);
});
