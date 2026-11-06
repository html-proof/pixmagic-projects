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

const db = new pg.Pool({ connectionString: E2E_ENV.OWNER_DATABASE_URL });
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
  await expect(page.getByTestId("summary-total")).toContainText("1 member in the team");

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
  // Its email went out, so the list says so (sent, not "delivered": only the provider can say that).
  await expect(row).toContainText("Email sent");
  await expect(row).toContainText("Custom");
  await expect(row).toContainText("60 days left");
  // Who can see a section: the client for Customer details, nobody but the owner for Finance.
  const section = page.getByLabel("Section filter");
  await section.selectOption({ label: "Can see Customer details" });
  await expect(row).toBeVisible();
  await section.selectOption({ label: "Can see Finance" });
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId("team-row").filter({ hasText: ownerEmail }).filter({ visible: true })).toHaveCount(1);
  await section.selectOption({ label: "All sections" });
  await expect(row).toBeVisible();

  // ---- The email, and its link (the token after #, never sent to a server).
  const mail = await latestMail(client);
  expect(mail.Subject).toBe("You've been invited to view a bizinsights dashboard");
  expect(mail.Text).toContain("No account registration or password is required.");
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
  // The token left the address bar before anything else on the page ran.
  expect(guest.url()).not.toContain("token=");

  // ---- Their sidebar: the shared areas and their account, nothing else.
  const nav = sidebar(guest);
  await expect(guest.getByTestId("member-badge")).toContainText("Acme Goods");
  await expect(guest.getByTestId("member-badge")).toContainText("View only");
  await expect(nav.getByRole("link", { name: "Products" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Customers" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Stock" })).toBeVisible();
  // Opened from the link: their notifications, but no account pages (they never signed in to one).
  await expect(nav.getByRole("link", { name: "Notifications" })).toBeVisible();
  await expect(guest.getByTestId("member-badge")).toContainText("no sign-in needed");
  for (const hidden of ["Sales & Orders", "Advertising", "Discounts", "Analytics", "Team & Access", "Settings", "WhatsApp", "Business Overview", "My Account"]) {
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
  // Every owner's and admin's page, and the pages of areas that weren't shared: the page never shows.
  for (const path of ["/settings/api-keys", "/settings/billing", "/settings/audit", "/settings/workspace", "/settings/integrations", "/staff", "/inventory/movements"]) {
    await guest.goto(path);
    await expect(guest, path).not.toHaveURL(new RegExp(`${path}$`));
    await expect(guest.getByTestId("access-notice"), path).toContainText("You don't have access to that page.");
  }
  // An address with no page at all is the not-found page, outside the app: nothing of the workspace.
  await guest.goto("/dashboard/setting");
  await expect(guest.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(sidebar(guest).getByRole("link", { name: "Products" })).toHaveCount(0);
  // And their APIs refuse the shared session outright, whatever the page would have done.
  const adminApis = await guest.evaluate(
    async (w) => Promise.all(["team", "members", "api-keys", "audit-logs", "billing", "privacy-requests", "staff/employees", "email/accounts"].map(async (p) => [p, (await fetch(`/api/workspaces/${w}/${p}`)).status] as const)),
    ws,
  );
  expect(adminApis.filter(([, status]) => status !== 403)).toEqual([]);

  // ---- The same link on another device opens the dashboard again, with what was shared.
  const ctx2 = await browser.newContext();
  const phone = await ctx2.newPage();
  await asNewVisitor(phone);
  await phone.goto(link);
  await expect(phone).toHaveURL(/\/dashboard/);
  await expect(sidebar(phone).getByRole("link", { name: "Products" })).toBeVisible();
  await ctx2.close();

  // ---- The owner swaps Customers for Marketing (advertising); the client's screen follows by itself.
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

  await expect(nav.getByRole("link", { name: "Advertising" })).toBeVisible({ timeout: 15_000 });
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

test("a browser signed in to another account opens a shared link: the account stays as it was, the shared tab is view-only, and the link follows expiry and renewal", async ({ page, browser }) => {
  test.setTimeout(150_000);
  // ---- An owner shares Products only.
  const ownerEmail = uniqueEmail("share-owner");
  await signUp(page, ownerEmail);
  const ws = await createWorkspace(page, "Shared Co");
  await insertStore(ws, `share-${Date.now()}.myshopify.com`, ["read_orders", "read_products"]);
  const client = uniqueEmail("share-client");
  const sent = await page.evaluate(
    async ({ w, email }) => {
      const r = await fetch(`/api/workspaces/${w}/team/invitations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, role: "custom", permissions: ["products.view"] }) });
      return (await r.json()) as { emailed: boolean; invitationId: string };
    },
    { w: ws, email: client },
  );
  expect(sent.emailed).toBe(true);
  const link = /https?:\/\/\S+\/invite#token=[A-Za-z0-9_-]+/.exec((await latestMail(client)).Text)![0];

  // ---- The client's browser is signed in to a bizinsights account of their own (another address),
  // with their own business.
  const ctx = await browser.newContext();
  const own = await ctx.newPage();
  const personal = uniqueEmail("share-personal");
  await asNewVisitor(own);
  await signUp(own, personal);
  const theirs = await createWorkspace(own, "Client's Own Shop");

  // ---- They open the link in another tab of the same browser: the shared dashboard, view-only.
  const shared = await ctx.newPage();
  await shared.goto(link);
  await expect(shared).toHaveURL(/\/dashboard/);
  await expect(shared.getByTestId("member-badge")).toContainText("Shared Co");
  await expect(shared.getByTestId("member-badge")).toContainText("View only");
  const nav = sidebar(shared);
  await expect(nav.getByRole("link", { name: "Products" })).toBeVisible();
  for (const hidden of ["Sales & Orders", "Customers", "Advertising", "Team & Access", "Settings"]) await expect(nav.getByRole("link", { name: hidden, exact: true }), hidden).toHaveCount(0);
  // Nothing can be changed from it, whatever is tried.
  const tryInvite = await shared.evaluate(async (w) => {
    const r = await fetch(`/api/workspaces/${w}/team/invitations`, { method: "POST", headers: { "content-type": "application/json", "x-bi-context": "shared" }, body: JSON.stringify({ email: "x@example.com", role: "viewer", permissions: [] }) });
    return r.status;
  }, ws);
  expect(tryInvite).toBe(403);

  // ---- Their own tab is still their own account: not switched, not signed out, nothing merged.
  await own.goto("/dashboard");
  await expect(own.getByTestId("member-badge")).toHaveCount(0);
  const me = await own.evaluate(async () => (await (await fetch("/api/me")).json()) as { user: { email: string }; shared: unknown; workspaces: Array<{ id: string }> });
  expect(me.user.email).toBe(personal);
  expect(me.shared).toBeNull();
  expect(me.workspaces.map((w) => w.id)).toEqual([theirs]);

  // ---- The owner copies the same link again (it doesn't break the one sent).
  await page.goto("/team");
  const row = page.getByTestId("team-row").filter({ hasText: client }).filter({ visible: true });
  await expect(row).toContainText("Link opened");
  await row.getByRole("button", { name: `Actions for ${client}` }).click();
  await page.getByRole("menuitem", { name: "Copy link" }).click();
  await expect(page.getByTestId("link-panel").getByTestId("invite-link")).toHaveValue(link);
  await page.getByTestId("link-panel").getByRole("button", { name: "Done" }).click();

  // ---- The access reaches its end date: the shared tab says so by itself and shows no data.
  await db.query("UPDATE memberships SET access_expires_at = (now() at time zone 'utc') - interval '1 minute' WHERE workspace_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)", [ws, client]);
  await db.query("UPDATE invitations SET expires_at = (now() at time zone 'utc') - interval '1 minute' WHERE workspace_id = $1 AND email = $2", [ws, client]);
  // The check runs while the tab is in view (and the moment it comes back into view).
  await shared.bringToFront();
  await expect(shared.getByTestId("access-expired")).toBeVisible({ timeout: 15_000 });
  await expect(shared.getByRole("heading", { name: "Your shared access has ended" })).toBeVisible();

  // ---- Renewed by the owner: the same link opens the dashboard again.
  await page.reload();
  const expired = page.getByTestId("team-row").filter({ hasText: client }).filter({ visible: true });
  await expect(expired).toContainText("Expired");
  await expired.getByRole("button", { name: `Actions for ${client}` }).click();
  await page.getByRole("menuitem", { name: "Renew access (60 days)" }).click();
  await expect(page.getByText(`Access for ${client} renewed`)).toBeVisible();
  await shared.goto(link);
  await expect(shared).toHaveURL(/\/dashboard/);
  await expect(sidebar(shared).getByRole("link", { name: "Products" })).toBeVisible();

  // ---- Closing the shared dashboard leaves their own account signed in. The tab goes to the
  // homepage, which sends a signed-in browser straight on to its own dashboard: so this one ends
  // on the client's own (store-less) dashboard, with nothing of Shared Co in it, as their own
  // account, and the shared-link session is over. (The homepage is passed through too quickly to
  // be asserted on: only where the tab ends up is.)
  // The link opened straight onto the Products page (the one topic shared with them), a page of
  // its own with the account menu beside it.
  await shared.bringToFront();
  await expect(shared.getByTestId("detail-panel")).toBeVisible({ timeout: 15_000 });
  await shared.getByRole("button", { name: "Account menu" }).click();
  await shared.getByRole("button", { name: "Close the shared dashboard" }).click();
  await expect(shared.getByRole("heading", { name: "Connect your first store" })).toBeVisible({ timeout: 15_000 });
  await expect(shared).toHaveURL(/\/dashboard/);
  await expect(shared.getByTestId("member-badge")).toHaveCount(0);
  const after = await shared.evaluate(async () => ({
    own: (await (await fetch("/api/me")).json()) as { user: { email: string }; shared: unknown },
    link: (await fetch("/api/me", { headers: { "x-bi-context": "shared" } })).status,
  }));
  expect(after.own.user.email).toBe(personal);
  expect(after.own.shared).toBeNull();
  expect(after.link).toBe(401);
  const still = await own.evaluate(async () => (await fetch("/api/me")).status);
  expect(still).toBe(200);
  await ctx.close();
});
