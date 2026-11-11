import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { insertStore, openMenuGroup, signUp, uniqueEmail } from "./helpers";

/**
 * The Automations hub in the browser: the four-step setup for SMS against the local server's
 * stand-in for AWS (apps/aws local.ts: a shared sender LOCALTEST, texts that never leave the
 * machine, "delivered" a moment later through the delivery-events queue), then the list, the
 * message history and the audit log. The rules are covered by apps/api/test/automations.test.ts;
 * this checks the pages drive them.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.OWNER_DATABASE_URL });
test.afterAll(() => db.end());

/** A JSON call from the page (its session cookie and origin). */
const call = (page: Page, method: string, url: string, body?: unknown) =>
  page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u as string, { method: m as string, headers: { "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
      return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, never> };
    },
    [method, url, body] as const,
  );

async function ownerWithSender(page: Page) {
  await signUp(page, uniqueEmail("hub"));
  const ws = await page.evaluate(async () => {
    const r = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Green Leaf" }) });
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  });
  const store = await insertStore(db, ws, `hub-${Date.now()}.myshopify.com`);
  await db.query(`UPDATE stores SET name = 'Green Leaf', last_synced_at = now() WHERE id = $1`, [store]);
  const sms = `/api/workspaces/${ws}/stores/${store}/sms`;
  // The sender and a verified test number (Set up SMS's job; its own spec drives those pages).
  expect((await call(page, "PUT", `${sms}/sender`, { senderType: "sender_id", originationIdentity: "LOCALTEST", countries: ["AU"], monthlyBudgetUsd: 5, hardStop: true, transactionalBasis: "checkout_notice", quietStart: 0, quietEnd: 0, maxPerCustomerDay: 3, maxMarketingPerWeek: 2 })).status).toBe(200);
  expect((await call(page, "POST", `${sms}/sender/verify`)).status).toBe(200);
  const added = await call(page, "POST", `${sms}/test-numbers`, { number: "0412 345 678", country: "AU" });
  const id = (added.json as { testNumber: { id: string } }).testNumber.id;
  expect((await call(page, "POST", `${sms}/test-numbers/${id}/verify`, { code: "123456" })).status).toBe(200);
  return { ws, store, hub: `/api/workspaces/${ws}/automations` };
}

test("an owner creates an SMS automation in four steps, tests it on themself and turns it on", async ({ page }) => {
  const { hub, store } = await ownerWithSender(page);

  await page.goto("/dashboard");
  await openMenuGroup(page, "marketing");
  await page.getByRole("complementary").getByRole("navigation", { name: "App" }).getByRole("link", { name: "Automations" }).click();
  await expect(page).toHaveURL(/\/automations\/?$/);
  await expect(page.getByRole("heading", { name: "Automations", level: 1 })).toBeVisible();
  await expect(page.getByTestId("channel-whatsapp")).toContainText("On its own page");
  await page.getByRole("link", { name: "Create automation" }).first().click();

  // 1. Connect: SMS, checked with (the stand-in for) AWS.
  const smsCard = page.getByTestId("channel-sms");
  await smsCard.getByRole("button", { name: "Connect SMS" }).click();
  await expect(smsCard.getByRole("button", { name: "Test connection" })).toBeVisible();
  await smsCard.getByRole("button", { name: "Use SMS" }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  // 2. Trigger: one Shopify sends for this store.
  await page.getByRole("button", { name: /Order shipped or fulfilled/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  // 3. Message: a ready-made one, previewed with the sample customer, checked as typed.
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(/tracking_url/);
  await expect(page.getByText(/Good news Sarah!/).first()).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Hi {{customer_name}}, order {{order_number}} is on its way: {{checkout_url}}");
  await expect(page.getByText(/have no checkout link|checkout_url/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Save and continue" })).toBeDisabled();
  await page.getByLabel("Message", { exact: true }).fill("Hi {{customer_name}}, {{business_name}} shipped order {{order_number}}: {{tracking_url}}");
  await page.getByRole("button", { name: "Save and continue" }).click();

  // 4. Review: the saved draft, a test text followed to its delivery, then on (after saying yes).
  await expect(page.getByRole("heading", { name: /4\. Review/ })).toBeVisible();
  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Send test text" }).click();
  await expect(page.getByText(/^Test:/).first()).toBeVisible();
  await expect
    .poll(async () => ((await call(page, "GET", `${hub}/messages?storeId=${store}`)).json as { messages: Array<{ kind: string; status: string }> }).messages.find((m) => m.kind === "test")?.status, { timeout: 15_000 })
    .toBe("delivered");
  const turnOn = page.getByRole("button", { name: "Turn on", exact: true });
  await expect(turnOn).toBeDisabled();
  await page.getByLabel(/I understand/).check();
  await turnOn.click();
  await expect(page.getByRole("heading", { name: "It's on" })).toBeVisible();

  // The list shows it running, with the channel's real state.
  await page.goto("/automations");
  const card = page.getByRole("listitem", { name: /Order shipped or fulfilled|Shipping|Order shipped/ }).filter({ hasText: "SMS" }).first();
  await expect(card.getByText("Active", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: /^Pause / })).toBeVisible();

  // The history keeps "accepted" and "delivered" apart, and says which is which.
  await page.goto("/automations/history");
  await expect(page.getByRole("heading", { name: "Message history" })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "Delivered" }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByRole("dialog").getByText(/delivery report confirmed/)).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

  // The audit log names the change and who made it.
  await page.goto("/automations/audit");
  await expect(page.getByText(/Turned an automation on/).first()).toBeVisible();
});

test("pausing and resuming from the list, with a confirmation each time", async ({ page }) => {
  const { hub, store } = await ownerWithSender(page);
  const made = await call(page, "POST", `${hub}/items/sms?storeId=${store}`, { name: "Order thanks", trigger: "order_created", body: "Thanks {{customer_name}}, we got order {{order_number}}.", delayMinutes: 0, conditions: [] });
  expect(made.status).toBe(201);
  const id = (made.json as { automation: { id: string } }).automation.id;
  expect((await call(page, "POST", `${hub}/items/sms/${id}/activate?storeId=${store}`, { confirm: true })).status).toBe(200);

  await page.goto("/automations");
  await page.getByRole("button", { name: "Pause Order thanks" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume Order thanks" })).toBeVisible();
  await page.getByRole("button", { name: "Resume Order thanks" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("button", { name: "Pause Order thanks" })).toBeVisible();
});
