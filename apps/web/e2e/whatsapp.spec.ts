import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV, E2E_EVOLUTION_URL } from "../playwright.config";
import { insertStore, openMenuGroup, signUp, uniqueEmail } from "./helpers";

/**
 * WhatsApp Automation in the browser (docs/whatsapp.md), with e2e/evolution-stub.mjs as Evolution API:
 * the four-step setup end to end. Choosing the QR way only after its disclosure, the QR code the
 * provider issued, "connected" only once the provider's webhook says so, the settings, the test number
 * verified with the code that went out over (the stand-in for) WhatsApp, and the test message's status
 * as WhatsApp reports it. The rules are apps/api/test/whatsapp.test.ts's; this checks the page shows
 * and drives them. The test plays the phone and WhatsApp through the stub's /__control.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.OWNER_DATABASE_URL });
test.afterAll(() => db.end());

async function control<T = unknown>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${E2E_EVOLUTION_URL}/__control/${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  expect(r.status, `${path}: ${text}`).toBe(200);
  return JSON.parse(text) as T;
}
type Sent = { instance: string; number: string; text: string | null; id: string };
const sendsTo = async (number: string) => (await control<Sent[]>("sends")).filter((s) => s.number === number);

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

test("an owner links a phone, configures, verifies their number and sees WhatsApp report the test", async ({ page }) => {
  await ownerWithStore(page);
  const testNumber = `614${String(Date.now()).slice(-8)}`;

  await page.goto("/dashboard");
  await openMenuGroup(page, "marketing");
  await page.getByRole("complementary").getByRole("navigation", { name: "App" }).getByRole("link", { name: "WhatsApp", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/whatsapp-automation\/?/);
  await expect(page.getByRole("heading", { name: /WhatsApp Automation/ }).first()).toBeVisible({ timeout: 15_000 });

  // 1. Nothing connected: the page opens on the setup, and the QR way needs its disclosure ticked.
  await expect(page.getByRole("heading", { name: "1. Choose how to connect" })).toBeVisible();
  const proceed = page.getByRole("button", { name: "Continue" });
  await expect(proceed).toBeDisabled();
  await page.getByRole("radio", { name: /Link a WhatsApp phone with a QR code/ }).check();
  await expect(proceed).toBeDisabled();
  await page.getByRole("checkbox", { name: /the way WhatsApp Web does/ }).check();
  await proceed.click();

  // 2. The QR code is the provider's; the page waits for WhatsApp, and says connected only when it does.
  await page.getByTestId("wa-start-pairing").click();
  const qr = page.getByTestId("wa-qr");
  await expect(qr).toBeVisible();
  expect(await qr.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  await expect(page.getByText(/WhatsApp confirmed/)).toHaveCount(0);
  await control("scan", { phone: "61400000099" });
  await expect(page.getByText(/WhatsApp confirmed the link/)).toBeVisible({ timeout: 15_000 });

  // 3. Configure (the page moves on by itself).
  await expect(page.getByRole("heading", { name: "3. Configure" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("radio", { name: /Customers told at checkout/ }).check();
  await page.getByRole("button", { name: "Save and continue" }).click();

  // 4a. The number is verified with the code that went to it over WhatsApp.
  await expect(page.getByRole("heading", { name: "4a. Verify your own number" })).toBeVisible();
  await page.getByLabel("Your WhatsApp number").fill(`+${testNumber}`);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect.poll(async () => (await sendsTo(testNumber)).length, { timeout: 15_000 }).toBe(1);
  const code = /is (\d{6})\./.exec((await sendsTo(testNumber))[0]!.text ?? "")![1]!;
  await page.getByLabel("The code from WhatsApp").fill(code);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText(/^Verified: \+61/)).toBeVisible();

  // 4b. The test: Evolution taking it isn't "sent"; WhatsApp's report is.
  await page.getByRole("button", { name: "Send test to my number" }).click();
  await expect.poll(async () => (await sendsTo(testNumber)).length, { timeout: 30_000 }).toBe(2);
  await expect(page.getByText("WhatsApp has the message; it reports sent, delivered and read as they happen.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "WhatsApp Automation is set up" })).toHaveCount(0);
  await control("report", { id: (await sendsTo(testNumber))[1]!.id, status: "SERVER_ACK" });
  await expect(page.getByRole("heading", { name: "WhatsApp Automation is set up" })).toBeVisible({ timeout: 20_000 });

  // The overview shows the connection as the provider reported it.
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByText("Connected").first()).toBeVisible();
});

test("the linked phone's own number is verified without a code, and the page says where its tests land", async ({ page }) => {
  await ownerWithStore(page);
  const linked = `614${String(Date.now()).slice(-8)}`;
  await page.goto("/dashboard/whatsapp-automation");
  await page.getByRole("radio", { name: /Link a WhatsApp phone with a QR code/ }).check();
  await page.getByRole("checkbox", { name: /the way WhatsApp Web does/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByTestId("wa-start-pairing").click();
  await expect(page.getByTestId("wa-qr")).toBeVisible();
  await control("scan", { phone: linked });
  await expect(page.getByRole("heading", { name: "3. Configure" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("radio", { name: /Customers told at checkout/ }).check();
  await page.getByRole("button", { name: "Save and continue" }).click();

  await page.getByLabel("Your WhatsApp number").fill(`+${linked}`);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByText(/^Verified: \+61/)).toContainText("Message yourself");
  await expect(page.getByLabel("The code from WhatsApp")).toHaveCount(0);
  expect(await sendsTo(linked)).toHaveLength(0);

  await page.getByRole("button", { name: "Send test to my number" }).click();
  await expect.poll(async () => (await sendsTo(linked)).length, { timeout: 30_000 }).toBe(1);
  await control("report", { id: (await sendsTo(linked))[0]!.id, status: "SERVER_ACK" });
  await expect(page.getByRole("heading", { name: "WhatsApp Automation is set up" })).toBeVisible({ timeout: 20_000 });
});

test("with bizinsights' WhatsApp service switched off, the page says so instead of calling it an outage", async ({ page }) => {
  await ownerWithStore(page);
  await page.goto("/dashboard/whatsapp-automation");
  await page.getByRole("radio", { name: /Link a WhatsApp phone with a QR code/ }).check();
  await page.getByRole("checkbox", { name: /the way WhatsApp Web does/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByTestId("wa-start-pairing").click();
  await expect(page.getByTestId("wa-qr")).toBeVisible();
  await control("scan", { phone: `614${String(Date.now()).slice(-8)}` });
  await expect(page.getByRole("heading", { name: "3. Configure" })).toBeVisible({ timeout: 15_000 });

  // The service goes off (production's AWS_WHATSAPP=off): the API has no service address, says so in
  // the overview, and refuses whatever needs the service with a 503 that names the reason.
  await page.route("**/api/workspaces/*/stores/*/whatsapp", async (route) => {
    const res = await route.fetch();
    const overview = (await res.json()) as { platform: { evolution: boolean } };
    await route.fulfill({ response: res, json: { ...overview, platform: { ...overview.platform, evolution: false } } });
  });
  await page.route("**/api/workspaces/*/stores/*/whatsapp/connection/check", (route) =>
    route.fulfill({ status: 503, json: { error: "provider_not_configured", message: "WhatsApp connections aren't set up on bizinsights yet. Nothing was changed." } }),
  );
  await page.goto("/dashboard/whatsapp-automation");

  const off = page.getByTestId("wa-off");
  await expect(off).toContainText("WhatsApp is switched off on bizinsights at the moment.");
  await expect(off).toContainText("Your automations, templates and message history are kept.");
  await expect(page.getByText("Switched off", { exact: true })).toBeVisible();

  // A button that needs the service: the reason, and nothing about bizinsights being unreachable.
  await page.goto("/dashboard/whatsapp-automation?tab=settings");
  await expect(off).toBeVisible();
  await page.getByRole("button", { name: "Check again" }).first().click();
  await expect(page.getByRole("alert").filter({ hasText: "WhatsApp is switched off on bizinsights at the moment. Nothing was changed." })).toBeVisible();
  await expect(page.getByText(/can't reach bizinsights|keep trying/)).toHaveCount(0);

  // Connecting isn't offered while it is off.
  await page.goto("/dashboard/whatsapp-automation?tab=setup");
  await page.getByRole("list", { name: "Setup steps" }).getByRole("button").first().click();
  await expect(page.locator("#wa-step-connect")).toContainText("Nothing can be connected until it is back on");
});
