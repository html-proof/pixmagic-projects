import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV, E2E_MAILPIT_URL } from "../playwright.config";
import { BILLING_ENABLED } from "../src/lib/features";
import { confirmSignUp, fillSignUp, signedWebhook, signUp, uniqueEmail } from "./helpers";

/**
 * Settings, invitations, billing and the public pages, driven through the real Worker.
 * Added by the full test pass (2026-10-06): none of these pages had e2e coverage, and each case
 * below pins a defect that pass fixed.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.DATABASE_URL });
test.afterAll(() => db.end());

/** A newcomer creates their account from the sign-in page (the code they confirm proves the email). */
async function createAccountFromLogin(page: Page, email: string) {
  await page.getByRole("link", { name: "Create Account" }).first().click();
  await fillSignUp(page, email);
  await confirmSignUp(page, email);
}

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
  await page.goto("/settings/members");
  const invitee = uniqueEmail("invitee");
  await page.getByLabel("Email to invite").fill(invitee);
  await page.getByLabel("Role", { exact: true }).selectOption("analyst");
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByRole("status")).toContainText(`Invitation sent to ${invitee}`);
  await expect(page.getByText(`${invitee} · invited`)).toBeVisible();

  // When the email can't be sent the API still saves the invitation and returns its link. The
  // page used to say "sent" anyway and drop the link.
  await page.route("**/api/workspaces/*/invitations", (route) =>
    route.fulfill({ json: { ok: true, emailed: false, url: "http://localhost/invite?token=handed-over-token" } }),
  );
  const unmailable = uniqueEmail("unmailable");
  await page.getByLabel("Email to invite").fill(unmailable);
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByTestId("invite-link")).toHaveValue("http://localhost/invite?token=handed-over-token");
  await expect(page.getByText(`Invitation sent to ${unmailable}`)).toHaveCount(0);
  await page.unroute("**/api/workspaces/*/invitations");

  // The invitee opens the emailed link while signed out, signs in, and comes back to accept it.
  const link = /\/invite\?token=[^\s]+/.exec(await latestMailText(invitee))![0];
  const ctx = await browser.newContext();
  const guest = await ctx.newPage();
  await guest.goto(link);
  await guest.getByRole("button", { name: "Accept invitation" }).click();
  await expect(guest).toHaveURL(/\/login/);
  await createAccountFromLogin(guest, invitee);
  await expect(guest).toHaveURL(/\/invite\?token=/);
  await guest.getByRole("button", { name: "Accept invitation" }).click();
  await expect(guest).toHaveURL(/\/dashboard/);
  // Joined the inviter's workspace, and did not get one of their own on the way.
  const { rows } = await db.query(
    "SELECT m.workspace_id, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1",
    [invitee],
  );
  expect(rows).toEqual([{ workspace_id: ws, role: "analyst" }]);
  expect(await guest.evaluate(() => localStorage.getItem("ws"))).toBe(ws);
  await ctx.close();
});

test("store permissions say which are optional for every role, and Disconnect removes the store", async ({ page }) => {
  const { email, ws } = await owner(page, "perms");
  const shop = `perms-${Date.now()}.myshopify.com`;
  const storeId = await insertStore(ws, shop, ["read_orders", "read_customers"]);
  await page.goto("/settings/stores");
  // e2e declares read_customers optional (SHOPIFY_OPTIONAL_SCOPES in worker.env).
  const optionalRow = page.getByRole("listitem").filter({ has: page.getByTestId("revoke-read_customers") });
  await expect(optionalRow).toContainText("Optional");
  // Named for the permission and the store, not a bare "Remove" repeated down the page.
  expect(await page.getByTestId("revoke-read_customers").getAttribute("aria-label")).toMatch(/^Remove .+ permission for /);
  expect(await page.getByTestId("revoke-read_customers").getAttribute("aria-label")).toContain(shop);

  // As an analyst: no Remove button, but the permission is still optional. It used to read "Required".
  await db.query("UPDATE memberships SET role = 'analyst' WHERE workspace_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)", [ws, email]);
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

test("billing shows the plan in force, and a change awaiting Shopify as pending", async ({ page }) => {
  test.skip(!BILLING_ENABLED, "Billing is switched off in src/lib/features.ts");
  const { ws } = await owner(page, "billing");
  await page.goto("/settings/billing");
  await expect(page.getByText(/Current plan:\s*Free\./)).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose Growth" })).toBeVisible();

  await db.query("UPDATE subscriptions SET pending_plan = 'growth', pending_charge_id = 'gid://shopify/AppSubscription/9' WHERE workspace_id = $1", [ws]);
  await page.reload();
  await expect(page.getByText(/Current plan:\s*Free\./)).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "waiting for approval in Shopify" })).toBeVisible();
  // The pending plan can be reopened; it used to hide its button as though it were already active.
  await expect(page.getByRole("button", { name: "Approve Growth in Shopify" })).toBeVisible();
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

test("a webhook bigger than one Durable Object value is stored and processed", async ({ page }) => {
  const { ws } = await owner(page, "bigwebhook");
  const shop = `big-${Date.now()}.myshopify.com`;
  const storeId = await insertStore(ws, shop, ["read_orders", "read_products"]);
  // R2 is not bound locally, so a payload over the inline limit goes to Durable Object storage,
  // which caps a value at 2 MB. Webhook bodies may be 5 MB; this one is ~3 MB.
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
