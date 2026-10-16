import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV, E2E_MAILPIT_URL } from "../playwright.config";
import { asNewVisitor, signUp, uniqueEmail } from "./helpers";

/**
 * Team & Access through the real app: an owner shares part of the dashboard with someone outside
 * the business, who joins from the emailed link and sees only what was shared; the owner changes
 * and then revokes that access while they are looking, and their screen follows within seconds.
 * The API side (every refusal, redaction and race) is covered by apps/api/test/team.test.ts.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.DATABASE_URL });
test.afterAll(() => db.end());

async function createWorkspace(page: Page, name: string): Promise<string> {
  return page.evaluate(async (n) => {
    const r = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) });
    if (!r.ok) throw new Error(`POST /workspaces failed: ${r.status}`);
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  }, name);
}

async function insertStore(ws: string, shop: string, scopes: string[]) {
  await db.query(
    `INSERT INTO stores (id, workspace_id, shop_domain, status, timezone, currency, granted_scopes, pixel_ingest_key, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, 'active', 'UTC', 'USD', $3, gen_random_uuid()::text, now(), now())`,
    [ws, shop, scopes],
  );
}

async function latestMail(to: string): Promise<{ Subject: string; Text: string }> {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${E2E_MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    const id = ((await r.json()) as { messages?: Array<{ ID: string }> }).messages?.[0]?.ID;
    if (id) return (await (await fetch(`${E2E_MAILPIT_URL}/api/v1/message/${id}`)).json()) as { Subject: string; Text: string };
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`no email to ${to}`);
}

const sidebar = (page: Page) => page.getByRole("complementary").getByRole("navigation", { name: "App" });

/** Open a module of the permission editor (one panel is open at a time). */
async function openModule(page: Page, module: string, label: RegExp) {
  const toggle = page.getByTestId(`module-${module}`).getByRole("button", { name: label }).first();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

test("an owner shares Customers and Products with a client, changes it while they look, then revokes it", async ({ page, browser }) => {
  test.setTimeout(150_000);
  // ---- The owner, their workspace and a store.
  const ownerEmail = uniqueEmail("team-owner");
  await signUp(page, ownerEmail);
  const ws = await createWorkspace(page, "Acme Goods");
  await insertStore(ws, `team-${Date.now()}.myshopify.com`, ["read_orders", "read_products", "read_customers"]);
  await page.goto("/dashboard");
  await sidebar(page).getByRole("link", { name: "Team & Access" }).click();
  await expect(page).toHaveURL(/\/team/);
  await expect(page.getByRole("heading", { name: "Team & Access" })).toBeVisible();
  await expect(page.getByTestId("summary-total")).toContainText("1");

  // ---- Invite: Custom, Customers (list only) and Products (select all), with a message.
  const client = uniqueEmail("team-client");
  await page.getByRole("button", { name: "Invite Member" }).click();
  const panel = page.getByTestId("invite-panel");
  await panel.getByLabel("Email address").fill(client);
  await panel.getByRole("radio", { name: /^Custom/ }).check();
  await expect(panel.getByTestId("access-summary")).toContainText("Selected Access: 0 Modules");
  await openModule(page, "customers", /Customer details/);
  await panel.getByTestId("perm-customers.list").check();
  // Sensitive ones stay unticked: Select all leaves them to be ticked one by one.
  await panel.getByRole("button", { name: "Select all in Product details", exact: true }).click();
  await openModule(page, "products", /Product details/);
  await expect(panel.getByTestId("perm-products.view")).toBeChecked();
  await expect(panel.getByTestId("perm-products.prices")).not.toBeChecked();
  await expect(panel.getByTestId("perm-customers.contact")).not.toBeChecked();
  await expect(panel.getByTestId("access-summary")).toContainText("Selected Access: 2 Modules");
  await expect(panel.getByTestId("access-summary")).toContainText("Customer details • Product details");
  await panel.getByLabel("Message (optional)").fill("Here's the dashboard we discussed.");
  await panel.getByRole("button", { name: "Send Invitation" }).click();
  await expect(page.getByText(`Invitation sent to ${client}.`)).toBeVisible();
  await expect(page.getByTestId("summary-pending")).toContainText("1");
  const row = page.getByTestId("team-row").filter({ hasText: client }).filter({ visible: true });
  // Its email went out, so the list says so.
  await expect(row).toContainText("Sent");
  await expect(row).toContainText("Custom");

  // ---- The email, and its link (the token after #, never sent to a server).
  const mail = await latestMail(client);
  expect(mail.Subject).toBe("You've been invited to access a business dashboard: Acme Goods");
  expect(mail.Text).toContain("Here's the dashboard we discussed.");
  const link = /https?:\/\/\S+\/invite#token=[A-Za-z0-9_-]+/.exec(mail.Text)![0];

  // ---- The client opens it and is on the shared dashboard: no account, sign-up or password, and
  // no Shopify store of their own.
  const ctx = await browser.newContext();
  const guest = await ctx.newPage();
  await asNewVisitor(guest);
  await guest.goto(link);
  await expect(guest).toHaveURL(/\/dashboard/);
  await expect(guest.getByLabel("Email Address")).toHaveCount(0);

  // ---- Their sidebar: the shared areas and their account, nothing else.
  const nav = sidebar(guest);
  await expect(guest.getByTestId("member-badge")).toContainText("Acme Goods");
  await expect(guest.getByTestId("member-badge")).toContainText("Custom");
  await expect(nav.getByRole("link", { name: "Products" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Customers" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Stock" })).toBeVisible();
  // Opened from the link: their notifications, but no account pages (they never signed in to one).
  await expect(nav.getByRole("link", { name: "Notifications" })).toBeVisible();
  await expect(guest.getByTestId("member-badge")).toContainText("no sign-in needed");
  for (const hidden of ["Sales & Orders", "Marketing", "Discounts", "Analytics", "Team & Access", "Settings", "WhatsApp", "Business Overview", "My Account"]) {
    await expect(nav.getByRole("link", { name: hidden, exact: true }), hidden).toHaveCount(0);
  }
  const { rows } = await db.query("SELECT m.role, m.permissions FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1", [client]);
  expect(rows).toEqual([{ role: "custom", permissions: ["customers.list", "products.view", "products.performance", "products.inventory"] }]);

  // ---- Typed-in addresses don't get round it.
  await guest.goto("/team");
  await expect(guest).not.toHaveURL(/\/team/);
  await expect(guest.getByTestId("access-notice")).toContainText("You don't have access to that page.");
  await guest.goto("/dashboard?view=sales");
  await expect(guest).not.toHaveURL(/view=sales/);
  await expect(guest.getByTestId("access-notice")).toContainText("isn't shared with you");
  await guest.goto("/settings/stores");
  await expect(guest).not.toHaveURL(/\/settings\/stores/);
  await guest.goto("/settings/profile");
  await expect(guest).not.toHaveURL(/\/settings\/profile/);

  // ---- The same link on another device opens the dashboard again, with what was shared.
  const ctx2 = await browser.newContext();
  const phone = await ctx2.newPage();
  await asNewVisitor(phone);
  await phone.goto(link);
  await expect(phone).toHaveURL(/\/dashboard/);
  await expect(sidebar(phone).getByRole("link", { name: "Products" })).toBeVisible();
  await ctx2.close();

  // ---- The owner swaps Customers for Marketing; the client's screen follows by itself.
  await guest.goto("/dashboard");
  await expect(nav.getByRole("link", { name: "Customers" })).toBeVisible();
  await page.reload();
  const member = page.getByTestId("team-row").filter({ hasText: client }).filter({ visible: true });
  await expect(member).toContainText("Active");
  await member.getByRole("button", { name: `Actions for ${client}` }).click();
  await page.getByRole("menuitem", { name: "Edit permissions" }).click();
  const edit = page.getByTestId("access-panel");
  await openModule(page, "customers", /Customer details/);
  await edit.getByTestId("perm-customers.list").uncheck();
  await openModule(page, "marketing", /Marketing/);
  await edit.getByTestId("perm-marketing.ads").check();
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(`Access for ${client} updated.`)).toBeVisible();

  await expect(nav.getByRole("link", { name: "Marketing" })).toBeVisible({ timeout: 15_000 });
  await expect(nav.getByRole("link", { name: "Customers" })).toHaveCount(0);
  await expect(guest.getByTestId("access-notice")).toContainText("was just updated");
  // And the API refuses what was taken away, straight away.
  const refused = await guest.evaluate(async (w) => (await fetch(`/api/workspaces/${w}/stores`)).status, ws);
  expect(refused).toBe(200);
  const contacts = await guest.evaluate(async (w) => {
    const stores = (await (await fetch(`/api/workspaces/${w}/stores`)).json()) as { stores: Array<{ id: string }> };
    return (await fetch(`/api/workspaces/${w}/stores/${stores.stores[0]!.id}/contacts`)).status;
  }, ws);
  expect(contacts).toBe(403);

  // ---- Revoked: the client's app says so within seconds, and shows no data.
  await page.reload();
  await page.getByTestId("team-row").filter({ hasText: client }).filter({ visible: true }).getByRole("button", { name: `Actions for ${client}` }).click();
  await page.getByRole("menuitem", { name: "Revoke access" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke access" }).click();
  await expect(page.getByText(`${client} can no longer open this workspace.`)).toBeVisible();
  await expect(guest.getByTestId("access-revoked")).toBeVisible({ timeout: 15_000 });
  await expect(guest.getByRole("heading", { name: "Your access was revoked" })).toBeVisible();
  await ctx.close();
});

test("a member with nothing shared sees No access assigned, and the team page works on phones and tablets", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const ownerEmail = uniqueEmail("team-owner2");
  await signUp(page, ownerEmail);
  const ws = await createWorkspace(page, "Empty Co");
  // A member whose role has nothing ticked yet (made directly, as an invitation accepted would).
  const ctx = await browser.newContext();
  const guest = await ctx.newPage();
  const nobody = uniqueEmail("team-nobody");
  await signUp(guest, nobody);
  await db.query(
    "INSERT INTO memberships (id, workspace_id, user_id, role, permissions, created_at) SELECT gen_random_uuid()::text, $1, id, 'custom', '{}', now() FROM users WHERE email = $2",
    [ws, nobody],
  );
  await guest.goto("/dashboard");
  await expect(guest.getByTestId("no-access")).toContainText("No access assigned");
  await expect(guest.getByTestId("no-access")).toContainText("Empty Co");
  await ctx.close();

  // The owner's team page, at phone, tablet and desktop widths.
  for (const [width, height, cards] of [
    [375, 812, true],
    [768, 1024, true],
    [1366, 900, false],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/team");
    await expect(page.getByRole("heading", { name: "Team & Access" })).toBeVisible();
    await expect(page.getByTestId(cards ? "team-cards" : "team-table")).toBeVisible();
    await expect(page.getByTestId("team-row").filter({ visible: true }).filter({ hasText: nobody })).toBeVisible();
    // Nothing runs off the side of the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.getByRole("button", { name: "Invite Member" }).click();
    await expect(page.getByTestId("invite-panel")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.getByTestId("invite-panel").getByRole("button", { name: "Cancel" }).click();
  }
});
