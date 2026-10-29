import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_BASE_URL, E2E_ENV, E2E_GRAPH_URL } from "../playwright.config";
import { insertStore, signUp, uniqueEmail } from "./helpers";

/**
 * WhatsApp Automation in the browser (docs/whatsapp.md): the four-step setup end to end on Meta's
 * WhatsApp Business Platform, the only way to connect. Meta's JavaScript SDK is stubbed here (its
 * FB.login finishes Embedded Signup at once, with the message Meta's window posts), and Meta's Graph
 * API is e2e/meta-graph-stub.mjs, where the local server sends Meta's calls: nothing reaches Meta. The
 * rules are apps/api/test/whatsapp.test.ts's; this checks the page shows and drives them: one way to
 * connect, "connected" only once the server heard it from Meta, the test number verified with the
 * code that went out, the test's status as Meta reports it, and a phone linked with a QR code before
 * 2026-10-28 shown as retired.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.OWNER_DATABASE_URL });
test.afterAll(() => db.end());

async function control<T = unknown>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${E2E_GRAPH_URL}/__control/${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  expect(r.status, `${path}: ${text}`).toBe(200);
  return JSON.parse(text) as T;
}
type Sent = { id: string; phoneNumberId: string; to: string; type: string; text: string | null };
type Signup = { code: string; wabaId: string; phoneNumberId: string; businessId: string };
const sendsTo = async (number: string) => (await control<Sent[]>("sends")).filter((s) => s.to === number);

/**
 * Meta's SDK as the page loads it: FB.login posts what Meta's window posts when the business finishes
 * (from facebook.com) and hands back the code, which the stand-in for the Graph API exchanges.
 */
async function stubMetaWindow(page: Page, s: Signup) {
  const finish = JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { phone_number_id: s.phoneNumberId, waba_id: s.wabaId, business_id: s.businessId } });
  const sdk = `
    window.FB = {
      init: function () {},
      login: function (cb, opts) {
        window.__fbLogin = opts;
        setTimeout(function () {
          window.dispatchEvent(new MessageEvent("message", { origin: "https://www.facebook.com", data: ${JSON.stringify(finish)} }));
          cb({ authResponse: { code: ${JSON.stringify(s.code)} }, status: "connected" });
        }, 200);
      },
    };
    if (window.fbAsyncInit) window.fbAsyncInit();
  `;
  await page.route("https://connect.facebook.net/**", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: sdk }));
}

async function ownerWithStore(page: Page) {
  await signUp(page, uniqueEmail("wa"));
  const ws = await page.evaluate(async () => {
    const r = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Green Leaf" }) });
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  });
  const store = await insertStore(db, ws, `wa-${Date.now()}.myshopify.com`);
  await db.query(`UPDATE stores SET name = 'Green Leaf', last_synced_at = now() WHERE id = $1`, [store]);
  return { ws, store };
}

test("an owner connects WhatsApp Business through Meta's window, configures, verifies their number and sees Meta report the test", async ({ page }) => {
  await ownerWithStore(page);
  const testNumber = `614${String(Date.now()).slice(-8)}`;
  const signup = await control<Signup>("signup", {});
  await stubMetaWindow(page, signup);

  await page.goto("/dashboard");
  await page.getByRole("complementary").getByRole("navigation", { name: "App" }).getByRole("link", { name: "WhatsApp", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/whatsapp-automation\/?/);
  await expect(page.getByRole("heading", { name: /WhatsApp Automation/ }).first()).toBeVisible({ timeout: 15_000 });

  // 1. One way to connect: no choice, no QR code, no box to tick.
  await expect(page.getByRole("heading", { name: "1. Connect WhatsApp Business" })).toBeVisible();
  await expect(page.getByText("Know before you connect")).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByText(/QR code/)).toHaveCount(0);
  await page.getByTestId("wa-cloud-connect").click();

  // 2. Connected only once the server heard it from Meta (the stand-in for its Graph API).
  await expect(page.getByText(/Meta confirmed that bizinsights may send for/)).toBeVisible({ timeout: 20_000 });
  expect(await page.evaluate(() => (window as unknown as { __fbLogin?: { config_id?: string; response_type?: string } }).__fbLogin)).toMatchObject({ config_id: "e2e_config", response_type: "code" });
  await page.getByRole("button", { name: "Continue to settings" }).click();

  // 3. Configure.
  await expect(page.getByRole("heading", { name: "3. Configure" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("radio", { name: /Customers told at checkout/ }).check();
  await page.getByRole("button", { name: "Save and continue" }).click();

  // 4a. The number is verified with the code that went to it from the connected number.
  await expect(page.getByRole("heading", { name: "4a. Verify your own number" })).toBeVisible();
  await expect(page.getByText(/send that number any WhatsApp message from your phone/)).toBeVisible();
  await page.getByLabel("Your WhatsApp number").fill(`+${testNumber}`);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect.poll(async () => (await sendsTo(testNumber)).length, { timeout: 15_000 }).toBe(1);
  const [codeMessage] = await sendsTo(testNumber);
  expect(codeMessage).toMatchObject({ phoneNumberId: signup.phoneNumberId, type: "text" });
  const code = /is (\d{6})\./.exec(codeMessage!.text ?? "")![1]!;
  await page.getByLabel("The code from WhatsApp").fill(code);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText(/^Verified: \+61/)).toBeVisible();

  // 4b. The test: Meta taking it isn't "sent"; Meta's report is.
  await page.getByRole("button", { name: "Send test to my number" }).click();
  await expect.poll(async () => (await sendsTo(testNumber)).length, { timeout: 30_000 }).toBe(2);
  await expect(page.getByText("Meta has the message; it reports sent, delivered and read as they happen.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "WhatsApp Automation is set up" })).toHaveCount(0);
  await control("status", { id: (await sendsTo(testNumber))[1]!.id, status: "sent", webhook: `${E2E_BASE_URL}/api/webhooks/whatsapp` });
  await expect(page.getByRole("heading", { name: "WhatsApp Automation is set up" })).toBeVisible({ timeout: 20_000 });

  // The overview shows the connection as Meta reported it.
  await page.goto("/dashboard/whatsapp-automation?tab=overview");
  await expect(page.getByText("Connection health")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Connected").first()).toBeVisible();
  await expect(page.getByText(/· WhatsApp Business Platform$/)).toBeVisible();
});

test("a store whose phone was linked with a QR code is told plainly that it was retired, and connects Meta instead", async ({ page }) => {
  const { ws, store } = await ownerWithStore(page);
  await db.query(
    `INSERT INTO wapp_connections (id, workspace_id, store_id, provider, status, shard, phone_masked, connected_at, created_at, updated_at) VALUES ($1, $2, $3, 'qr', 'connected', 'a', '+61 ••• ••• 077', now(), now(), now())`,
    [`e2eqr${Date.now()}`, ws, store],
  );
  const signup = await control<Signup>("signup", {});
  await stubMetaWindow(page, signup);

  await page.goto("/dashboard/whatsapp-automation?tab=overview");
  const notice = page.getByText("QR-code linking was retired.");
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/no longer links a WhatsApp phone with a QR code/).first()).toBeVisible();
  await page.getByRole("link", { name: "Connect WhatsApp Business" }).first().click();

  await expect(page.getByRole("heading", { name: "1. Connect WhatsApp Business" })).toBeVisible();
  await expect(page.getByText("QR-code linking was retired.")).toBeVisible();
  await page.getByTestId("wa-cloud-connect").click();
  await expect(page.getByText(/Meta confirmed that bizinsights may send for/)).toBeVisible({ timeout: 20_000 });

  const rows = await db.query<{ provider: string; status: string }>(`SELECT provider, status FROM wapp_connections WHERE store_id = $1`, [store]);
  expect(rows.rows).toEqual([{ provider: "cloud_api", status: "connected" }]);
  const audit = await db.query(`SELECT 1 FROM audit_logs WHERE workspace_id = $1 AND action = 'whatsapp.qr_linking_retired'`, [ws]);
  expect(audit.rowCount).toBe(1);
});
