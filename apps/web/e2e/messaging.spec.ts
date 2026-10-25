import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { insertStore, signedWebhook, signUp, uniqueEmail } from "./helpers";

/**
 * Customer Messaging in the browser, against the local server's stand-in for AWS (apps/aws
 * local.ts: a shared sender LOCALTEST, texts that never leave the machine, "delivered" a moment
 * later through the delivery-events queue). The rules are covered by apps/api/test/sms.test.ts and
 * apps/worker/test/sms.test.ts; this checks the pages show and drive them.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.DATABASE_URL });
test.afterAll(() => db.end());

async function ownerWithStore(page: Page) {
  await signUp(page, uniqueEmail("sms"));
  const ws = await page.evaluate(async () => {
    const r = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Green Leaf" }) });
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  });
  const shop = `sms-${Date.now()}.myshopify.com`;
  const store = await insertStore(db, ws, shop);
  await db.query(`UPDATE stores SET name = 'Green Leaf', last_synced_at = now() WHERE id = $1`, [store]);
  return { ws, store, shop, base: `/api/workspaces/${ws}/stores/${store}/sms` };
}

/** A JSON call from the page (its session cookie and origin). */
const call = (page: Page, method: string, url: string, body?: unknown) =>
  page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u as string, { method: m as string, headers: { "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
      return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, never> };
    },
    [method, url, body] as const,
  );

test("an owner sets up a sender, verifies a test number, writes a template and texts it to themself", async ({ page }) => {
  const { base } = await ownerWithStore(page);

  await page.goto("/dashboard");
  await page.getByRole("complementary").getByRole("navigation", { name: "App" }).getByRole("link", { name: "Customer Messaging" }).click();
  await expect(page).toHaveURL(/\/messaging\/?$/);
  // The heading comes with the overview's first load, which outlasted 5 s on the PC runner on battery.
  await expect(page.getByRole("heading", { name: /Customer Messaging/ }).first()).toBeVisible({ timeout: 15_000 });

  // The sender, checked with (the stand-in for) AWS.
  const saved = await call(page, "PUT", `${base}/sender`, { senderType: "sender_id", originationIdentity: "LOCALTEST", countries: ["AU"], monthlyBudgetUsd: 5, hardStop: true, transactionalBasis: "checkout_notice", quietStart: 0, quietEnd: 0, maxPerCustomerDay: 3, maxMarketingPerWeek: 2 });
  expect(saved.status).toBe(200);
  await page.goto("/messaging/sender");
  await page.getByRole("button", { name: "Check with AWS" }).click();
  await expect(page.getByText("Verified with AWS").first()).toBeVisible();

  // A test number, verified with the code AWS "texted" it.
  const added = await call(page, "POST", `${base}/test-numbers`, { number: "0412 345 678", country: "AU" });
  expect(added.status).toBe(201);
  const id = (added.json as { testNumber: { id: string } }).testNumber.id;
  expect((await call(page, "POST", `${base}/test-numbers/${id}/verify`, { code: "123456" })).status).toBe(200);

  // A template, written in the editor's API and seen in its list with its parts.
  const t = await call(page, "POST", `${base}/templates`, { name: "Order confirmed", category: "transactional", body: "Hi {{customer_name}}, {{store_name}} got order {{order_number}}." });
  expect(t.status).toBe(201);
  await page.goto("/messaging/templates");
  await expect(page.getByText("Order confirmed").first()).toBeVisible();

  // The test text: sent to (the stand-in for) AWS, then delivered (the stand-in's delivery event).
  await page.goto("/messaging/send");
  await page.getByText("Send yourself a test").click();
  // Options read "<name> · <category> · <state>": pick it by its id.
  await page.getByLabel("Message to test").selectOption((t.json as { template: { id: string } }).template.id);
  await page.getByLabel("Test recipient").selectOption({ index: 1 });
  await expect(page.getByText("Hi Sam, Acme Outfitters got order #1042.")).toBeVisible();
  await page.getByRole("button", { name: "Send test" }).click();
  await expect(page.getByText(/Sent: the delivery report|Delivered/).first()).toBeVisible();
  await expect
    .poll(async () => ((await call(page, "GET", `${base}/messages?purpose=test`)).json as { messages: Array<{ status: string }> }).messages[0]?.status, { timeout: 15_000 })
    .toBe("delivered");
  await page.goto("/messaging/history");
  // (The status filter lists "Delivered" too, as a hidden option.)
  await expect(page.getByText("Delivered", { exact: true }).filter({ visible: true }).first()).toBeVisible();
});

test("an owner goes through Set up SMS: connect, sender name, message, a delivered test, and order confirmations on", async ({ page }) => {
  await ownerWithStore(page);
  await page.goto("/messaging/setup");
  await expect(page.getByRole("heading", { name: "Set up SMS" })).toBeVisible();

  // 1. Connect (the local server's stand-in for AWS answers).
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  // 2. The sender name: checked as it is typed, asked for, and the shared sender used meanwhile.
  await page.getByLabel("Business name").fill("IKOREX");
  await page.getByLabel("Where are most of your customers?").selectOption("AU");
  await page.getByLabel("Sender name", { exact: true }).fill("IKOREX STORE");
  await expect(page.getByText(/can't have spaces/)).toBeVisible();
  await page.getByLabel("Sender name", { exact: true }).fill("IKOREX");
  await expect(page.getByTestId("preview-sender")).toHaveText("IKOREX");
  await expect(page.getByText("Sender name not approved yet")).toBeVisible();
  await page.getByRole("button", { name: "Register sender name" }).click();
  await expect(page.getByText("Requested", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /Use bizinsights' shared sender/ }).click();
  await expect(page.getByText(/Texts now come from/)).toBeVisible();
  await expect(page.getByTestId("preview-sender")).toHaveText("LOCALTEST");
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  // 3. The message, with the business's name in the preview.
  await expect(page.getByTestId("preview-text")).toHaveText("Hi Sarah, your order #1042 has been confirmed. Thank you for shopping with IKOREX!");
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  // 4. A test text to a verified number, followed to the phone's receipt.
  await page.getByLabel("Mobile number").fill("0412 345 678");
  await page.getByRole("button", { name: "Text me a code" }).click();
  await page.getByPlaceholder("Code").fill("123456");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Verified", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send Test SMS" }).click();
  await expect(page.getByRole("button", { name: /Send again in/ })).toBeDisabled();
  await expect(page.getByText("Delivered: the phone confirmed it arrived.")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  // 5. Spending limit and consent, then order confirmations on (confirmed first), then the master switch.
  await page.getByText("My checkout tells customers order updates come by text").click();
  await page.getByRole("button", { name: "Save limit and consent" }).click();
  await expect(page.getByText("Saved.").first()).toBeVisible();
  await page.getByRole("switch", { name: "New order confirmed" }).click();
  await expect(page.getByRole("dialog")).toContainText("bizinsights is in test mode");
  await page.getByRole("dialog").getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByRole("switch", { name: "New order confirmed" })).toBeChecked();
  await page.getByRole("switch", { name: "Enable Automatic SMS" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByRole("switch", { name: "Enable Automatic SMS" })).toBeChecked();

  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page).toHaveURL(/\/messaging\/settings/);
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  // What's set up, in plain words: the limit and how customers agreed are done.
  await expect(page.getByRole("heading", { name: "SMS setup" })).toBeVisible();
  await expect(page.getByRole("region", { name: "SMS setup" }).getByText("Monthly messaging limit", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Enable Automatic SMS" })).toBeChecked();
});

test("an owner creates an SMS automation from one button: when, who, the message, a delivered test, then activates it", async ({ page }) => {
  const { base } = await ownerWithStore(page);
  // A sender the provider approved (the local stand-in's shared one), a verified test number, and a segment.
  expect((await call(page, "PUT", `${base}/sender`, { senderType: "sender_id", originationIdentity: "LOCALTEST", countries: ["AU"], monthlyBudgetUsd: 5, hardStop: true, transactionalBasis: "checkout_notice", quietStart: 0, quietEnd: 0, maxPerCustomerDay: 3, maxMarketingPerWeek: 2 })).status).toBe(200);
  expect((await call(page, "POST", `${base}/sender/verify`, {})).status).toBe(200);
  const added = await call(page, "POST", `${base}/test-numbers`, { number: "0412 345 678", country: "AU" });
  expect((await call(page, "POST", `${base}/test-numbers/${(added.json as { testNumber: { id: string } }).testNumber.id}/verify`, { code: "123456" })).status).toBe(200);
  expect((await call(page, "POST", `${base}/segments`, { name: "Big spenders", filter: { countries: [], minSpent: 50 } })).status).toBe(201);

  // The overview: one status in a word, and the one button.
  await page.goto("/messaging");
  await expect(page.getByTestId("messaging-status")).toHaveText(/Setup required|Action required|Ready/, { timeout: 15_000 });
  await page.getByRole("link", { name: "Create SMS Automation" }).click();
  await expect(page).toHaveURL(/\/messaging\/automations\/edit/);

  // 1. When: only what Shopify sends for the store can be chosen; the timing is here too.
  await expect(page.getByRole("radio", { name: /Custom event/ })).toBeDisabled();
  await page.getByRole("radio", { name: /Order shipped or fulfilled/ }).click();
  await expect(page.getByText(/Shopify sends bizinsights this event for your store/)).toBeVisible();
  await expect(page.getByLabel("Automation name")).toHaveValue("Order shipped or fulfilled SMS");
  await page.getByLabel("Automation name").fill("Shipping update");
  await page.getByText("After a delay", { exact: true }).click();
  await page.getByLabel("How long to wait").fill("2");
  await page.getByLabel("Minutes, hours or days").selectOption("hours");
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  // 2. Who: the event's customer, narrowed to a segment, with the API's count.
  await expect(page.getByText("Recipients: 1 customer per event")).toBeVisible();
  await page.getByText("Customer segment", { exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText(/Recipients: choose a segment/)).toBeVisible();
  await page.getByLabel("Select customer segment").selectOption({ label: "Big spenders" });
  await expect(page.getByText(/Recipients: 0 customers/)).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  // 3. The message: a live preview, other tools' variables fixed, a detail its trigger can't fill refused in words.
  await expect(page.getByTestId("preview-text")).toHaveText("Good news Sarah! Your Green Leaf order #1042 is on its way. Track it: https://track.example.com/AB123");
  await page.getByLabel("Message", { exact: true }).fill("Hi {{customer_name}}, finish here: {{checkout_url}}");
  await expect(page.getByText(/make this a marketing message/)).toBeVisible();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByText(/Fix the message first/)).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Hi {{customer.first_name}}, order {{order.number}} is on its way: {{tracking_url}}");
  await page.getByRole("button", { name: "Fix them" }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Hi {{customer_name}}, order {{order_number}} is on its way: {{tracking_url}}");
  await expect(page.getByTestId("preview-text")).toHaveText("Hi Sarah, order #1042 is on its way: https://track.example.com/AB123");
  await page.getByRole("button", { name: "Personalize" }).click();
  await expect(page.getByRole("group", { name: "Insert a detail" }).getByRole("button", { name: /Tracking link/ })).toBeVisible();
  await page.getByRole("button", { name: "Shipped, with tracking" }).click();
  await expect(page.getByText(/Estimated SMS segments: 1/)).toBeVisible();
  await page.getByRole("button", { name: "Save and continue" }).click();

  // 4. A test text to the approved number, followed to the phone's receipt.
  await expect(page.getByText(/still being verified/).first()).toBeVisible();
  await page.getByRole("button", { name: "Send Test", exact: true }).click();
  await expect(page.getByText("Delivered: the phone confirmed it arrived.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("✓ Test message sent")).toBeVisible();
  await page.getByRole("button", { name: "Continue to review" }).click();

  // 5. The review: the flow, each part editable, the checks, then activate (asked first).
  await expect(page.getByRole("button", { name: "Edit who gets it" })).toContainText(`if they're in "Big spenders"`);
  await expect(page.getByRole("button", { name: "Edit the timing" })).toContainText("2 hours after the event");
  await expect(page.getByText("Ready to activate")).toBeVisible();
  await page.getByRole("button", { name: "Activate Automation" }).click();
  await expect(page.getByRole("dialog")).toContainText("still being verified");
  await page.getByRole("dialog").getByRole("button", { name: "Activate", exact: true }).click();
  await expect(page.getByText("✓ Active").first()).toBeVisible();

  // The list: its real state, then a copy opened ready to change, deleted again, and its history.
  await page.getByRole("link", { name: "All automations" }).click();
  const card = page.getByRole("listitem", { name: "Shipping update", exact: true });
  await expect(card.getByText("✓ Active", { exact: true })).toBeVisible();
  await expect(card.getByRole("switch")).toBeChecked();
  await card.getByRole("button", { name: "More for Shipping update" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page).toHaveURL(/step=review/);
  await expect(page.getByRole("heading", { name: /Shipping update — Copy/ })).toBeVisible();
  await page.getByRole("link", { name: "All automations" }).click();
  const copy = page.getByRole("listitem", { name: "Shipping update — Copy", exact: true });
  await expect(copy.getByText("Draft", { exact: true })).toBeVisible();
  await copy.getByRole("button", { name: "More for Shipping update — Copy" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(copy).toHaveCount(0);
  await card.getByRole("button", { name: "More for Shipping update" }).click();
  await page.getByRole("menuitem", { name: "View history" }).click();
  await expect(page).toHaveURL(/\/messaging\/history\?ruleId=/);
  await expect(page.getByText(/Showing/)).toContainText("Shipping update");
});

test("the opt-out page says so for a link that names nothing", async ({ page }) => {
  await page.goto("/stop?c=Nothing1234");
  await expect(page.getByText(/isn't valid any more/)).toBeVisible();
});

test("an owner texts chosen customers in four steps (Send SMS) and follows the texts", async ({ page }) => {
  const { base, shop } = await ownerWithStore(page);
  expect((await call(page, "PUT", `${base}/sender`, { senderType: "sender_id", originationIdentity: "LOCALTEST", countries: ["AU"], monthlyBudgetUsd: 5, hardStop: true, transactionalBasis: "checkout_notice", quietStart: 0, quietEnd: 0, maxPerCustomerDay: 3, maxMarketingPerWeek: 2 })).status).toBe(200);
  expect((await call(page, "POST", `${base}/sender/verify`)).status).toBe(200);
  // Two customers, from their Shopify orders (the store's webhooks, signed as Shopify signs them).
  for (const [i, name] of ["Ana", "Ben"].entries()) {
    const order = { id: 7000 + i, name: `#70${i}`, currency: "AUD", created_at: new Date().toISOString(), total_price: "20.00", customer: { id: 900 + i, first_name: name }, shipping_address: { country_code: "AU", phone: `0412 000 50${i}` }, line_items: [] };
    expect((await signedWebhook("orders/create", shop, order, `wh-send-${Date.now()}-${i}`)).status).toBe(200);
  }
  await expect.poll(async () => ((await call(page, "GET", `${base}/sends/customers`)).json as { customers?: unknown[] }).customers?.length ?? 0, { timeout: 20_000 }).toBe(2);

  await page.goto("/messaging");
  await page.getByRole("link", { name: "Send SMS" }).first().click();
  await expect(page).toHaveURL(/\/messaging\/send/);

  // 1. Who: two customers, checked for what they may receive.
  await page.getByLabel(/^Ana,/).check();
  await page.getByLabel(/^Ben,/).check();
  await expect(page.getByTestId("send-chosen")).toHaveText("2 customers chosen");
  await page.getByRole("button", { name: "Next" }).click();

  // 2. What: a new message, with its length and parts as it is typed.
  await page.getByRole("radio", { name: "Write a new message" }).check();
  await page.getByLabel("Message", { exact: true }).fill("Hi {{customer_name}}, we're closed on {{date}}. {{business_name}}");
  await expect(page.getByText(/characters · 1 SMS part/)).toBeVisible();
  await page.getByRole("button", { name: "Preview message" }).click();

  // 3. Check: the first customer's own text, and who gets it.
  await expect(page.getByTestId("preview-text")).toHaveText(/^Hi Ana, we're closed on \w{3} \d{1,2} \w{3}\. Green Leaf$/);
  await expect(page.getByTestId("send-going")).toContainText("2 customers will get it");
  await page.getByRole("button", { name: "Next" }).click();

  // 4. When: now, after saying yes; then followed (test mode here: recorded, not sent).
  await page.getByRole("button", { name: "Send SMS" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("send-progress")).toBeVisible();
  await expect(page.getByTestId("send-progress")).toContainText("Practice run · 2");
  await expect(page.getByRole("heading", { name: "Recorded in test mode" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your sends" })).toBeVisible();
  const [m] = ((await call(page, "GET", `${base}/messages?purpose=manual`)).json as { messages: Array<{ status: string; statusLabel: string }> }).messages;
  expect(m).toMatchObject({ status: "dry_run", statusLabel: "Practice run" });
});
