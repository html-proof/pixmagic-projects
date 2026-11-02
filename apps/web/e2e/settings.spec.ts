import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV, E2E_MAILPIT_URL } from "../playwright.config";
import { signedWebhook, signUp, uniqueEmail } from "./helpers";

/**
 * Settings, invitations, billing and the public pages, driven through the real app.
 * Added by the full test pass (2026-10-06): none of these pages had e2e coverage, and each case
 * below pins a defect that pass fixed.
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

/** A signed-in, verified owner with one workspace. */
async function owner(page: Page, prefix: string, workspace = "Acme") {
  const email = uniqueEmail(prefix);
  await signUp(page, email);
  const ws = await createWorkspace(page, workspace);
  return { email, ws };
}

async function insertStore(ws: string, shop: string, scopes: string[]) {
  const { rows } = await db.query(
    `INSERT INTO stores (id, workspace_id, shop_domain, status, timezone, currency, granted_scopes, pixel_ingest_key, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, 'active', 'UTC', 'USD', $3, gen_random_uuid()::text, now(), now()) RETURNING id`,
    [ws, shop, scopes],
  );
  return rows[0].id as string;
}

/** The plain-text body of the newest Mailpit message to `email`. */
async function latestMailText(email: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${E2E_MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    const id = ((await r.json()) as { messages?: Array<{ ID: string }> }).messages?.[0]?.ID;
    if (id) return ((await (await fetch(`${E2E_MAILPIT_URL}/api/v1/message/${id}`)).json()) as { Text: string }).Text;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`no email to ${email}`);
}

test("/settings opens the profile, which shows the account's UTC time zone", async ({ page }) => {
  await owner(page, "tz");
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/profile/);
  // Browsers leave "UTC" out of their zone list, so the select used to display Africa/Abidjan.
  await expect(page.getByLabel("Your time zone")).toHaveValue("UTC");
  await expect(page.getByRole("link", { name: "Profile", exact: true })).toHaveAttribute("aria-current", "page");
});

test("renaming after switching workspaces renames the one selected", async ({ page }) => {
  await owner(page, "rename", "Alpha");
  const beta = await createWorkspace(page, "Beta");
  await page.goto("/settings/workspace");
  const field = page.getByLabel("Name", { exact: true });
  await expect(field).toHaveValue("Alpha");

  await page.getByLabel("Workspace", { exact: true }).selectOption({ label: "Beta" });
  // The page stays mounted across the switch; the field used to keep "Alpha", and Save then
  // renamed Beta to Alpha.
  await expect(field).toHaveValue("Beta");
  await field.fill("Beta Renamed");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  const { rows } = await db.query("SELECT id, name FROM workspaces WHERE id = $1", [beta]);
  expect(rows[0].name).toBe("Beta Renamed");
});

test("invitations: emailed, handed over as a link when email fails, and kept across sign-in", async ({ page, browser }) => {
  const { ws } = await owner(page, "inviter", "Team Co");
  await page.goto("/team");
  const invite = async (email: string) => {
    await page.getByRole("button", { name: "Invite Member" }).click();
    const panel = page.getByTestId("invite-panel");
    await panel.getByLabel("Email address").fill(email);
    await panel.getByRole("radio", { name: /^Analyst/ }).check();
    await panel.getByRole("button", { name: "Send Invitation" }).click();
    return panel;
  };
  const invitee = uniqueEmail("invitee");
  await invite(invitee);
  await expect(page.getByText(`Invitation sent to ${invitee}.`)).toBeVisible();
  await expect(page.getByTestId("team-row").filter({ visible: true }).filter({ hasText: invitee })).toContainText("Email sent");

  // When the email can't be sent the API still saves the invitation and returns its link. The
  // page used to say "sent" anyway and drop the link.
  await page.route("**/api/workspaces/*/team/invitations", (route) =>
    route.fulfill({ json: { ok: true, emailed: false, url: "http://localhost/invite#token=handed-over-token", emailProblem: "not_allowed", replaced: 0 } }),
  );
  const unmailable = uniqueEmail("unmailable");
  const panel = await invite(unmailable);
  await expect(panel.getByTestId("invite-link")).toHaveValue("http://localhost/invite#token=handed-over-token");
  // Says why, so a refusal by the mail service doesn't read as a broken feature.
  await expect(panel.getByTestId("email-problem")).toContainText("can't send to this address yet");
  await expect(page.getByText(`Invitation sent to ${unmailable}`)).toHaveCount(0);
  await page.unroute("**/api/workspaces/*/team/invitations");
  await panel.getByRole("button", { name: "Done" }).click();

  // The invitee opens the emailed link: straight onto the dashboard, no sign-in or sign-up.
  const link = /https?:\/\/\S+\/invite#token=[A-Za-z0-9_-]+/.exec(await latestMailText(invitee))![0];
  const ctx = await browser.newContext();
  const guest = await ctx.newPage();
  await guest.goto(link);
  await expect(guest).toHaveURL(/\/dashboard/);
  // Joined the inviter's workspace, and did not get one of their own on the way.
  const { rows } = await db.query(
    "SELECT m.workspace_id, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1",
    [invitee],
  );
  expect(rows).toEqual([{ workspace_id: ws, role: "analyst" }]);
  // This tab is the shared dashboard's (its calls use the shared-link session); an account's
  // saved workspace in this browser is left alone.
  expect(await guest.evaluate(() => sessionStorage.getItem("bi:context"))).toBe("shared");
  await ctx.close();
});

test("store permissions say which are optional for every role, and Disconnect removes the store", async ({ page }) => {
  const { email, ws } = await owner(page, "perms");
  const shop = `perms-${Date.now()}.myshopify.com`;
  const storeId = await insertStore(ws, shop, ["read_orders", "read_customers"]);
  await page.goto("/settings/stores");
  // e2e declares read_customers optional (SHOPIFY_OPTIONAL_SCOPES in server.env).
  const optionalRow = page.getByRole("listitem").filter({ has: page.getByTestId("revoke-read_customers") });
  await expect(optionalRow).toContainText("Optional");
  // Named for the permission and the store, not a bare "Remove" repeated down the page.
  expect(await page.getByTestId("revoke-read_customers").getAttribute("aria-label")).toMatch(/^Remove .+ permission for /);
  expect(await page.getByTestId("revoke-read_customers").getAttribute("aria-label")).toContain(shop);

  // As an analyst: no Remove button, but the permission is still optional. It used to read "Required".
  await db.query("UPDATE memberships SET role = 'analyst', permissions = ARRAY['integrations.status'] WHERE workspace_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)", [ws, email]);
  await page.reload();
  await expect(page.getByTestId("revoke-read_customers")).toHaveCount(0);
  await expect(page.locator("li", { hasText: "Optional" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: `Disconnect ${shop}` })).toHaveCount(0);

  await db.query("UPDATE memberships SET role = 'owner' WHERE workspace_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)", [ws, email]);
  await page.reload();
  let dialogText = "";
  page.once("dialog", (d) => {
    dialogText = d.message();
    void d.accept();
  });
  await page.getByRole("button", { name: `Disconnect ${shop}` }).click();
  await expect(async () => {
    const { rows } = await db.query("SELECT status FROM stores WHERE id = $1", [storeId]);
    expect(rows[0].status).toBe("uninstalled");
  }).toPass({ timeout: 10_000 });
  // Honest about what Disconnect does not do.
  expect(dialogText).toContain("uninstall the app from your Shopify admin");
});

// Settings → Billing is hidden until paid plans launch (src/lib/features.ts), but the e2e build
// shows it (NEXT_PUBLIC_E2E_BILLING, playwright.config.ts), so these run before launch.
test("billing shows the plan in force, and a change awaiting Shopify as pending", async ({ page }) => {
  const { ws } = await owner(page, "billing");
  await page.goto("/settings/billing");
  await expect(page.getByText(/Current plan:\s*Free\./)).toBeVisible();
  await expect(page.getByRole("button", { name: "Upgrade to Growth" })).toBeVisible();
  // Nothing to switch away from on Free.
  await expect(page.getByRole("button", { name: "Switch to Free" })).toHaveCount(0);

  await db.query("UPDATE subscriptions SET pending_plan = 'growth', pending_charge_id = 'gid://shopify/AppSubscription/9' WHERE workspace_id = $1", [ws]);
  await page.reload();
  await expect(page.getByText(/Current plan:\s*Free\./)).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "waiting for approval in Shopify" })).toBeVisible();
  // The pending plan can be reopened; it used to hide its button as though it were already active.
  await expect(page.getByRole("button", { name: "Approve Growth in Shopify" })).toBeVisible();
});

test("an owner on a paid plan switches to Free from the billing page, without contacting anyone", async ({ page }) => {
  const { ws } = await owner(page, "downgrade");
  // Paid through a store Shopify has since uninstalled the app from (uninstalled, and never
  // disconnected in bizinsights: no disconnected_at), which cancelled the charge, so the API
  // settles it without reaching Shopify (which e2e can't); the cancellation in Shopify, and a
  // store only disconnected here (below), are apps/api/test/billing.test.ts.
  const storeId = await insertStore(ws, `downgrade-${Date.now()}.myshopify.com`, ["read_orders"]);
  await db.query("UPDATE stores SET status = 'uninstalled', disconnected_at = NULL WHERE id = $1", [storeId]);
  await db.query("UPDATE subscriptions SET plan = 'growth', shopify_charge_id = 'gid://shopify/AppSubscription/7', billing_store_id = $2 WHERE workspace_id = $1", [ws, storeId]);

  await page.goto("/settings/billing");
  await expect(page.getByText(/Current plan:\s*Growth\./)).toBeVisible();
  await expect(page.getByRole("button", { name: "Upgrade to Scale" })).toBeVisible();
  await page.getByRole("button", { name: "Switch to Free" }).click();
  const dialog = page.getByRole("dialog", { name: "Switch to Free?" });
  await expect(dialog).toContainText("cancelled in Shopify now");
  await dialog.getByRole("button", { name: "Switch to Free" }).click();

  await expect(page.getByText(/Current plan:\s*Free\./)).toBeVisible();
  await expect(page.getByText("You're on the Free plan now.")).toBeVisible();
  const { rows } = await db.query("SELECT plan, shopify_charge_id FROM subscriptions WHERE workspace_id = $1", [ws]);
  expect(rows[0]).toEqual({ plan: "free", shopify_charge_id: null });
});

// Disconnecting leaves the app, and its charge, installed in Shopify, with nothing left here to
// cancel it: the store that pays stays, and each page says what ends the charge instead of the
// generic "This item has changed".
test("the store that pays for the plan isn't disconnected, and Settings → Stores says why", async ({ page }) => {
  const { ws } = await owner(page, "billedstore");
  const shop = `billed-${Date.now()}.myshopify.com`;
  const storeId = await insertStore(ws, shop, ["read_orders"]);
  await db.query("UPDATE subscriptions SET plan = 'growth', shopify_charge_id = 'gid://shopify/AppSubscription/8', billing_store_id = $2 WHERE workspace_id = $1", [ws, storeId]);

  await page.goto("/settings/stores");
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: `Disconnect ${shop}` }).click();
  await expect(page.getByRole("alert").filter({ hasText: `${shop} pays for this workspace's plan through its Shopify bill. Switch to Free in Settings → Billing first` })).toBeVisible();
  await expect(page.getByRole("button", { name: `Disconnect ${shop}` })).toBeVisible();
  const { rows } = await db.query("SELECT status, disconnected_at FROM stores WHERE id = $1", [storeId]);
  expect(rows[0]).toEqual({ status: "active", disconnected_at: null });
});

test("Switch to Free for a plan billed through a store disconnected here says to uninstall the app in Shopify", async ({ page }) => {
  const { ws } = await owner(page, "disconnectedbill");
  const shop = `kept-${Date.now()}.myshopify.com`;
  // Disconnected in bizinsights before Disconnect refused a store that pays: the charge runs on.
  const storeId = await insertStore(ws, shop, ["read_orders"]);
  await db.query("UPDATE stores SET status = 'uninstalled', disconnected_at = now() WHERE id = $1", [storeId]);
  await db.query("UPDATE subscriptions SET plan = 'growth', shopify_charge_id = 'gid://shopify/AppSubscription/9', billing_store_id = $2 WHERE workspace_id = $1", [ws, storeId]);

  await page.goto("/settings/billing");
  await page.getByRole("button", { name: "Switch to Free" }).click();
  await page.getByRole("dialog", { name: "Switch to Free?" }).getByRole("button", { name: "Switch to Free" }).click();
  await expect(page.getByRole("alert").filter({ hasText: `Uninstall bizinsights from ${shop} in your Shopify admin` })).toBeVisible();
  // Still the billing page (not "Payment failed"), still on the plan Shopify bills.
  await expect(page.getByText(/Current plan:\s*Growth\./)).toBeVisible();
  const { rows } = await db.query("SELECT plan, shopify_charge_id FROM subscriptions WHERE workspace_id = $1", [ws]);
  expect(rows[0]).toEqual({ plan: "growth", shopify_charge_id: "gid://shopify/AppSubscription/9" });
});

test("the privacy and support pages describe what the product actually does", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Deleting your workspace deletes");
  await expect(page.locator("main")).not.toContainText("rotated automatically");
  await page.goto("/support");
  await expect(page.locator("main")).not.toContainText("delete the workspace from Settings");
  await expect(page.locator("main")).not.toContainText("deliberately do not ask for");
  await expect(page.locator("main")).toContainText("Enable button");
});

test("a webhook too big for a queue message is stored and processed", async ({ page }) => {
  const { ws } = await owner(page, "bigwebhook");
  const shop = `big-${Date.now()}.myshopify.com`;
  const storeId = await insertStore(ws, shop, ["read_orders", "read_products"]);
  // A payload over the inline limit goes to the payload store (S3 on AWS, memory locally).
  // Webhook bodies may be 5 MB; this one is ~3 MB.
  const filler = createHash("sha256").update("x").digest("hex").repeat(3 * 1024 * 1024 / 64);
  const now = new Date().toISOString();
  const id = `e2e-big-${Date.now()}`;
  const res = await signedWebhook(
    "products/update",
    shop,
    { id: 777, title: "Big Product", status: "active", vendor: "V", product_type: "T", body_html: filler, created_at: now, updated_at: now, variants: [] },
    id,
  );
  expect(res.status).toBe(200);
  await expect(async () => {
    const { rows } = await db.query("SELECT status, error FROM webhook_events WHERE webhook_id = $1", [id]);
    expect(rows[0]).toMatchObject({ status: "succeeded" });
  }).toPass({ timeout: 30_000 });
  const { rows } = await db.query("SELECT title FROM products WHERE store_id = $1", [storeId]);
  expect(rows.map((r) => r.title)).toEqual(["Big Product"]);
});
