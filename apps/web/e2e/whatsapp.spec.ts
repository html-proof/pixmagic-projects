import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertStore, signUp, uniqueEmail } from "./helpers";

/**
 * WhatsApp Automation (/whatsapp) in the browser: the real page, app and API, with Meta's side
 * stubbed. Meta's SDK (connect.facebook.net) is replaced by a small script that behaves like
 * FB.login, and Meta's own page by one on www.facebook.com that posts Embedded Signup's
 * WA_EMBEDDED_SIGNUP message to the window, as Meta's does. What runs for real is bizinsights: the
 * button and its states, the origin check on Meta's message, the start (a nonce from the API) and
 * what the finish sends. The server's side of the exchange (code, token, ids, Nango, registration) is
 * covered by apps/api/test against fake Graph and Nango APIs; a real Meta sign-in can only be checked
 * by hand with bizinsights' Meta app. A connected number is written straight into wa_connections.
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

/** WhatsApp Automation's own menu of tabs (the app's sidebar has a Settings link of its own). */
const tabs = (page: Page) => page.getByRole("navigation", { name: "WhatsApp" });

const scenario = (page: Page, s: Scenario) => page.evaluate((x) => ((window as unknown as { __fbScenario: Scenario }).__fbScenario = x), s);

/** A verified owner with a workspace and a store. */
async function ownerWithStore(page: Page, prefix: string) {
  await signUp(page, uniqueEmail(prefix));
  const ws = await createWorkspace(page, "WA Co");
  const storeId = await insertStore(db, ws, `${prefix}-${Date.now()}.myshopify.com`);
  return { ws, storeId };
}

/** A number connected to the store, as the finish would have saved it. */
async function connect(ws: string, storeId: string, opts: { status?: string; step?: string | null; detail?: string | null } = {}) {
  await db.query(
    `INSERT INTO wa_connections (id, workspace_id, store_id, status, step, status_detail, nango_connection_id, signup_flow, waba_id, waba_name, phone_number_id,
       display_phone_number, verified_name, quality_rating, messaging_limit_tier, registered, subscribed_at, connected_at, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 'wa-' || $2, 'cloud_api', '1111111111', 'Spices WABA', $6, '+61 400 000 000', 'Kerala Spices', 'GREEN', 'TIER_1K', $7, now(), now(), now(), now())`,
    [ws, storeId, opts.status ?? "active", opts.step ?? null, opts.detail ?? null, `${Date.now()}${Math.floor(Math.random() * 1000)}`, (opts.status ?? "active") === "active"],
  );
}

const FINISH = { type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { waba_id: "1111111111", phone_number_id: "2222222222", business_id: "9999999" } };

test("not connected: the real state, the button and what Meta asks; a blocked or closed Meta window connects nothing", async ({ page }) => {
  await ownerWithStore(page, "wa-onboard");
  await stubMeta(page);
  await page.goto("/whatsapp");
  await expect(page.getByRole("heading", { level: 1, name: /WhatsApp Automation/ })).toBeVisible();
  // The same tiles as when connected, with what is true now: nothing connected, nothing running.
  const tiles = page.getByTestId("wa-status");
  await expect(tiles).toContainText("Not connected");
  await expect(tiles).toContainText("Disconnected");
  await expect(tiles).toContainText("None yet");
  await expect(page.getByRole("heading", { name: "Connect WhatsApp Business" })).toBeVisible();
  await expect(page.getByText("Sign in with Meta")).toBeVisible();
  await expect(page.getByText("bizinsights sets it up")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What Meta will ask you for" })).toBeVisible();
  // Connecting is set up in this environment: no "not available" note.
  await expect(page.getByTestId("wa-not-available")).toHaveCount(0);
  // Only the onboarding until a number is connected.
  await expect(tabs(page).getByRole("link", { name: "Automated workflows" })).toHaveCount(0);

  const button = page.getByTestId("wa-connect");
  const status = page.getByTestId("wa-connect-status");
  await expect(button).toHaveText(/Connect WhatsApp/);
  await scenario(page, { kind: "blocked" });
  await button.click();
  await expect(status).toContainText("Meta's window didn't open. Allow pop-ups");
  await expect(button).toHaveText(/Try again/);
  // The SDK was started with bizinsights' app and the Embedded Signup configuration, asking for a code.
  expect(await page.evaluate(() => (window as unknown as { __fbInit: { appId: string } }).__fbInit.appId)).toBe("e2e_meta_app");
  expect(await page.evaluate(() => (window as unknown as { __fbLoginOpts: Record<string, unknown> }).__fbLoginOpts)).toMatchObject({ config_id: "e2e_config", response_type: "code", override_default_response_type: true });

  await scenario(page, { kind: "window", message: { type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { current_step: "PHONE_NUMBER_SETUP" } } });
  await button.click();
  await expect(status).toContainText("Finish the steps in Meta's window.");
  await expect(button).toBeDisabled();
  await expect(status).toContainText("closed while adding the phone number before the setup finished. Nothing was connected.");
  await expect(button).toBeEnabled();
  // Past the portfolio: nothing about Meta's limits on it.
  await expect(page.getByTestId("wa-meta-limit")).toHaveCount(0);

  // Closed on the portfolio (Meta's window can crash there on its own limit screen): where to see and lift Meta's limits.
  await scenario(page, { kind: "window", message: { type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { current_step: "BUSINESS_ACCOUNT_SELECTION" } } });
  await button.click();
  await expect(status).toContainText("closed while choosing the business portfolio before the setup finished.");
  const limit = page.getByTestId("wa-meta-limit");
  await expect(limit).toContainText("an unverified business can create only a few WhatsApp Business accounts");
  await expect(limit.getByRole("link", { name: /Business Support Home/ })).toHaveAttribute("href", "https://business.facebook.com/business-support-home/");
});

test("Meta's finish (only from facebook.com) is sent to the server with the nonce; its refusal is shown and nothing is claimed", async ({ page }) => {
  await ownerWithStore(page, "wa-finish");
  await stubMeta(page);
  await page.goto("/whatsapp");
  const sent: Array<Record<string, unknown>> = [];
  let answer: { status: number; body: unknown } = { status: 400, body: { error: "code_rejected", message: "Meta's sign-in expired before bizinsights could finish it. Press Connect WhatsApp again." } };
  await page.route("**/api/workspaces/*/stores/*/whatsapp/connect/finish", async (route) => {
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
  });

  // Someone else's page posting a look-alike message: not from facebook.com, so it is ignored.
  await page.evaluate(() => window.postMessage(JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { waba_id: "1", phone_number_id: "2" } }), "*"));

  await scenario(page, { kind: "window", message: FINISH, code: "es-code-from-meta" });
  await page.getByTestId("wa-connect").click();
  await expect(page.getByRole("alert").filter({ hasText: "Meta's sign-in expired" })).toBeVisible();
  await expect(page.getByTestId("wa-connect")).toHaveText(/Try again/);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ code: "es-code-from-meta", flow: "cloud_api", wabaId: "1111111111", phoneNumberId: "2222222222", businessId: "9999999" });
  expect(String(sent[0]!.nonce)).toMatch(/^[0-9a-f-]{36}$/);

  // The server's own answer is the only success.
  answer = { status: 200, body: { connection: { status: "active", verifiedName: "Kerala Spices", displayPhoneNumber: "+61 400 000 000" } } };
  await scenario(page, { kind: "window", message: FINISH, code: "es-code-again" });
  await page.getByTestId("wa-connect").click();
  await expect(page.getByRole("status").filter({ hasText: "WhatsApp is connected: Kerala Spices can send messages." })).toBeVisible();
  expect(sent).toHaveLength(2);
});

test("connected: the overview, the tabs, and choosing how customers agree", async ({ page }) => {
  const { ws, storeId } = await ownerWithStore(page, "wa-connected");
  await connect(ws, storeId);
  await page.goto("/whatsapp");
  await expect(page.getByRole("heading", { name: /Kerala Spices/ })).toBeVisible();
  await expect(page.getByText("+61 400 000 000 · Spices WABA")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Finish setting up/ })).toBeVisible();
  await expect(page.getByText("Choose how customers agree to updates.", { exact: false })).toBeVisible();
  // Meta's ids, the connection's health and automation's real state (connected, nothing switched on).
  await expect(page.getByText("1111111111", { exact: true })).toBeVisible();
  await expect(page.getByTestId("wa-health")).toContainText("Replies and delivery reports reach bizinsights");
  await expect(page.getByTestId("wa-automation")).toContainText("No workflow on");
  // A test needs the merchant's own number first.
  await page.getByTestId("wa-send-test-open").click();
  await expect(page.getByTestId("wa-send-test")).toContainText("Tests go only to your own WhatsApp number");
  await page.getByTestId("wa-send-test").getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("wa-send-test")).toHaveCount(0);

  // Pause all automation, confirmed; then resume.
  const automation = page.getByTestId("wa-automation");
  await automation.getByRole("button", { name: "Pause all automation" }).click();
  await page.getByRole("button", { name: "Pause automation" }).click();
  await expect(automation).toContainText("Paused");
  await expect(automation.getByRole("button", { name: "Resume automation" })).toBeVisible();
  const paused = await db.query("SELECT automation_paused_at FROM wa_settings WHERE store_id = $1", [storeId]);
  expect(paused.rows[0]?.automation_paused_at).toBeTruthy();
  await automation.getByRole("button", { name: "Resume automation" }).click();
  await expect(automation).toContainText("No workflow on");

  await tabs(page).getByRole("link", { name: "Automated workflows" }).click();
  await expect(page.getByRole("button", { name: /Order confirmation/ })).toBeVisible();
  await expect(page.getByText("No workflows yet")).toBeVisible();

  await tabs(page).getByRole("link", { name: "Message templates" }).click();
  await expect(page.getByText("No templates yet")).toBeVisible();

  await tabs(page).getByRole("link", { name: "Settings" }).click();
  await page.getByRole("radio", { name: /My checkout tells customers/ }).check();
  const save = page.getByRole("button", { name: "Save" }).first();
  await expect(save).toBeDisabled();
  await page.getByRole("checkbox", { name: /My checkout or terms tell customers/ }).check();
  await save.click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  const row = await db.query("SELECT order_updates FROM wa_settings WHERE store_id = $1", [storeId]);
  expect(row.rows[0]?.order_updates).toBe("checkout_notice");
});

test("a number with its own PIN asks for it, in six digits", async ({ page }) => {
  const { ws, storeId } = await ownerWithStore(page, "wa-pin");
  await connect(ws, storeId, { status: "action_required", step: "pin_required", detail: "Your number already has a two-step verification PIN. Enter that 6-digit PIN to finish registering it." });
  await page.goto("/whatsapp");
  const step = page.getByTestId("wa-step");
  await expect(step).toContainText("One more step");
  await expect(step).toContainText("Enter that 6-digit PIN");
  const register = step.getByRole("button", { name: "Register the number" });
  await expect(register).toBeDisabled();
  await step.getByLabel("Two-step verification PIN").fill("12ab34");
  await expect(step.getByLabel("Two-step verification PIN")).toHaveValue("1234");
  await step.getByLabel("Two-step verification PIN").fill("123456");
  await expect(register).toBeEnabled();
});
