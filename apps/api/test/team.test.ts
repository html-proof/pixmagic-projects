import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { encryptTokenFields, MailError, normalizeRestOrder, pruneTeamRecords, recomputeDays, retryInvitationEmail, upsertOrder, type FetchLike } from "@app/core";
import { systemDb } from "@app/db";
import { LEGACY_GRANTS, sha256Hex } from "@app/shared";
import { clean, cookiesFrom, createStore, createWorkspace, ORIGIN, setup, signIn, teardown, type TestCtx } from "./helpers.js";

/**
 * Team & Access, end to end through the API: inviting someone outside the business with chosen
 * permissions, the email and the link, accepting, what they can and can't reach afterwards, and an
 * owner changing or revoking that access while they use it. (The brief's scenarios 1-20; the
 * sidebar and route guards are covered by apps/web/e2e/team.spec.ts.)
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

const SCOPES = ["read_orders", "read_products", "read_customers"];
const today = new Date().toISOString().slice(0, 10);

type Headers = Record<string, string>;
const call = (method: string, url: string, headers: Headers = {}, payload?: unknown) => ctx.app.inject({ method, url, headers, payload });
function ok<T = any>(res: Awaited<ReturnType<typeof call>>, status = 200): T { // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(res.statusCode, res.body).toBe(status);
  return res.json();
}

async function seedOrder(store: Awaited<ReturnType<typeof createStore>>, id: number, price: number) {
  const days = await upsertOrder(
    store,
    normalizeRestOrder({
      id,
      name: `#${id}`,
      currency: "USD",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      subtotal_price: String(price),
      total_discounts: "0",
      total_tax: "1",
      total_price: String(price + 1),
      financial_status: "paid",
      customer: { id: 5 },
      line_items: [{ id: id * 10, product_id: 99, title: "Hat", quantity: 1, price: String(price) }],
    }),
  );
  await recomputeDays(store, [...days]);
}

/** An owner with a workspace and a connected store holding an order and a product. */
async function business(name = "Acme") {
  const owner = await signIn(ctx, `owner-${name}`, `owner@${name.toLowerCase()}.test`);
  const ws = await createWorkspace(ctx, owner.headers, name);
  const store = await createStore(ws, `${name.toLowerCase()}.myshopify.com`, SCOPES);
  await systemDb.store.update({
    where: { id: store.id },
    data: encryptTokenFields(store.id, { accessToken: "shpat_test", scopes: SCOPES, accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }),
  });
  await seedOrder(store, 1, 100);
  await systemDb.product.create({ data: { workspaceId: ws, storeId: store.id, shopifyId: "99", title: "Hat", status: "active", vendor: "Hatco", shopifyUpdatedAt: new Date() } });
  await systemDb.productVariant.create({
    data: { workspaceId: ws, storeId: store.id, productShopifyId: "99", shopifyId: "990", title: "Default Title", sku: "HAT-1", price: 100, inventoryQuantity: 2, unitCost: 40, shopifyUpdatedAt: new Date() },
  });
  return { owner, ws, store };
}

const tokenFrom = (text: string) => /#token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? null;
const lastMailTo = (to: string) => [...ctx.mailer.sent].reverse().find((m) => m.to === to);

/** Invite `email` with `permissions` and accept as them: their sign-in headers and membership id. */
async function inviteAndJoin(b: Awaited<ReturnType<typeof business>>, email: string, role: string, permissions: string[]) {
  ok(await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email, role, permissions }));
  const token = tokenFrom(lastMailTo(email)!.text)!;
  const guest = await signIn(ctx, email, email);
  ok(await call("POST", "/invitations/accept", guest.headers, { token }));
  const m = await systemDb.membership.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: b.ws, userId: guest.user.id } } });
  return { guest, memberId: m.id, token };
}

const overview = (b: { ws: string; store: { id: string } }, h: Headers) => call("GET", `/workspaces/${b.ws}/stores/${b.store.id}/overview`, h);
const setAccess = (b: Awaited<ReturnType<typeof business>>, memberId: string, role: string, permissions: string[], extra: Record<string, unknown> = {}) =>
  call("PATCH", `/workspaces/${b.ws}/team/members/${memberId}`, b.owner.headers, { role, permissions, ...extra });

const contactsReply: FetchLike = async () =>
  new Response(
    JSON.stringify({
      data: {
        subscribers: { nodes: [] },
        recent: {
          nodes: [
            {
              id: "gid://shopify/Customer/11",
              displayName: "Jane Doe",
              createdAt: "2026-10-05T09:00:00Z",
              numberOfOrders: "2",
              amountSpent: { amount: "120.50", currencyCode: "USD" },
              defaultEmailAddress: { emailAddress: "jane@example.com", marketingState: "SUBSCRIBED" },
              defaultPhoneNumber: { phoneNumber: "+61400000000", smsMarketingConsent: { state: "SUBSCRIBED" } },
            },
          ],
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("inviting someone with Customers access only (scenarios 1-6)", () => {
  it("sends an email with a single-use link, shows the invitation, joins on accept and shows Customers only", async () => {
    const b = await business();
    const email = "client@example.com";
    // 1. The owner invites them with Customers only, a message and a 3-day expiry.
    const inv = ok(
      await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, {
        email: "Client@Example.com",
        role: "custom",
        permissions: ["customers.list", "customers.analytics"],
        message: "Here's the customer view we talked about.",
        expiresInDays: 3,
      }),
    );
    expect(inv).toMatchObject({ ok: true, emailed: true, replaced: 0 });
    expect(inv.url).toBeUndefined();

    // 2. The email: subject, the business, the message, the link (token in the fragment), the expiry.
    const mail = lastMailTo(email)!;
    expect(mail.subject).toBe("You've been invited to view a bizinsights dashboard");
    expect(mail.text).toContain("You've been invited to securely view a shared business dashboard through bizinsights: Acme");
    expect(mail.text).toContain("Your access includes:");
    expect(mail.text).toContain("Customer details");
    expect(mail.text).toContain("Here's the customer view we talked about.");
    expect(mail.text).toContain("No account registration or password is required.");
    expect(mail.text).toMatch(/This invitation expires on \w+ \d+, \d{4}/);
    expect(mail.text).toContain("If you were not expecting this invitation, you can ignore this email.");
    expect(mail.html).toContain("Open Shared Dashboard");
    // No tracking: no images or pixels, and the only links are the invitation's own.
    expect(mail.html).not.toMatch(/<img/i);
    // From the shared-link sender, never the codes' support sender; replies reach the owner who sent it.
    expect(mail.from).toBe("BizInsights <link@bizinsights.io>");
    expect(mail.replyTo).toBe(b.owner.user.email);
    expect(mail.text).toContain("Questions? Reply to this email to reach");
    expect(mail.text).toContain("Need help with bizinsights? Contact support@bizinsights.io.");
    const token = tokenFrom(mail.text)!;
    expect(mail.text).toContain(`/invite#token=${token}`);
    // Only the token's hash is stored, and the invitation is scoped to the workspace.
    const row = await systemDb.invitation.findFirstOrThrow({ where: { workspaceId: b.ws } });
    expect(row.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row).toMatchObject({ email, role: "custom", permissions: ["customers.list", "customers.analytics"], sendCount: 1 });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(2.9 * 86_400_000);
    const audit = await systemDb.auditLog.findFirstOrThrow({ where: { workspaceId: b.ws, action: "member.invited" } });
    expect(audit.metadata).toMatchObject({ email, permissions: ["customers.list", "customers.analytics"] });

    // 3. The link opens: whose dashboard, from whom, what they'll see. No sign-in needed for this.
    const preview = ok(await call("POST", "/invitations/preview", {}, { token }));
    expect(preview).toMatchObject({ status: "pending", workspace: "Acme", role: "custom", modules: ["Customer details"], permissionCount: 2 });
    expect(preview.email).toMatch(/^cl•+@example\.com$/);
    expect(ok(await call("POST", "/invitations/preview", {}, { token: "not-a-real-token-at-all" }))).toEqual({ status: "invalid" });

    // 4. They sign in with the invited address and accept.
    const guest = await signIn(ctx, "client", email);
    expect(ok(await call("POST", "/invitations/accept", guest.headers, { token }))).toEqual({ workspaceId: b.ws, joined: true });
    const m = await systemDb.membership.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: b.ws, userId: guest.user.id } } });
    expect(m).toMatchObject({ role: "custom", permissions: ["customers.list", "customers.analytics"], revokedAt: null, invitedById: b.owner.user.id });
    expect((await systemDb.invitation.findFirstOrThrow({ where: { id: row.id } })).acceptedById).toBe(guest.user.id);

    // 5. Their access, and the dashboard: Customers only, not even the store's other capabilities.
    const access = ok(await call("GET", `/workspaces/${b.ws}/access`, guest.headers));
    expect(access).toMatchObject({ role: "custom", fullAccess: false, modules: ["customers"], permissions: ["customers.list", "customers.analytics"] });
    const me = ok(await call("GET", "/me", guest.headers));
    expect(me.workspaces).toEqual([expect.objectContaining({ id: b.ws, role: "custom", status: "active", permissions: ["customers.list", "customers.analytics"] })]);
    const ov = ok(await overview(b, guest.headers));
    expect(Object.keys(ov.modules)).toEqual(["customers"]);
    expect(ov.capabilities.map((c: { id: string }) => c.id).sort()).toEqual(["contacts", "customers"]);
    expect(ov.data).not.toHaveProperty("orders");
    expect(ov.data).not.toHaveProperty("products");

    // 6. Everything else is refused, typed in directly or not.
    for (const [method, url] of [
      ["GET", `/workspaces/${b.ws}/stores/${b.store.id}/export?section=products`],
      ["GET", `/workspaces/${b.ws}/stores/${b.store.id}/export?section=sales`],
      ["GET", `/workspaces/${b.ws}/stores/${b.store.id}/sync`],
      ["GET", `/workspaces/${b.ws}/stores/${b.store.id}/ads`],
      ["GET", `/workspaces/${b.ws}/stores/${b.store.id}/whatsapp`],
      ["GET", `/workspaces/${b.ws}/team`],
      ["GET", `/workspaces/${b.ws}/members`],
      ["GET", `/workspaces/${b.ws}/audit-logs`],
      ["GET", `/workspaces/${b.ws}/billing`],
      ["GET", `/workspaces/${b.ws}/staff/employees`],
      ["GET", `/workspaces/${b.ws}/email/overview`],
      ["GET", `/workspaces/${b.ws}/email/accounts`],
    ] as const) {
      const res = await call(method, url, guest.headers);
      expect(res.statusCode, url).toBe(403);
    }
  });

  it("can't be accepted by a different account, and works for the right one once its email is verified", async () => {
    const b = await business();
    ok(await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email: "right@example.com", role: "viewer", permissions: ["analytics.sales"] }));
    const token = tokenFrom(lastMailTo("right@example.com")!.text)!;
    const wrong = await signIn(ctx, "wrong", "wrong@example.com");
    const res = await call("POST", "/invitations/accept", wrong.headers, { token });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("invite_email_mismatch");
    const unverified = await signIn(ctx, "right", "right@example.com", false);
    expect((await call("POST", "/invitations/accept", unverified.headers, { token })).statusCode).toBe(403);
    expect(await systemDb.membership.count({ where: { workspaceId: b.ws } })).toBe(1);
    // Accepting needs a session at all.
    expect((await call("POST", "/invitations/accept", {}, { token })).statusCode).toBe(401);
  });
});

describe("changing access after they joined (scenarios 7-11)", () => {
  it("adds Products and removes Customers, effective on their very next request", async () => {
    const b = await business();
    const { guest, memberId } = await inviteAndJoin(b, "agency@example.com", "custom", ["customers.list", "customers.analytics"]);
    ctx.setFetch(contactsReply);
    expect((await call("GET", `/workspaces/${b.ws}/stores/${b.store.id}/contacts`, guest.headers)).statusCode).toBe(200);
    const before = (await overview(b, guest.headers)).headers["x-access-fp"];

    // 7-8. Products added: no new invitation, the next request sees it.
    const current = ok(await call("GET", `/workspaces/${b.ws}/team/members/${memberId}`, b.owner.headers)).member;
    ok(await setAccess(b, memberId, "custom", ["customers.list", "customers.analytics", "products.view", "products.performance", "products.inventory"], { basedOn: current.fingerprint }));
    const ov = await overview(b, guest.headers);
    expect(Object.keys(ok(ov).modules).sort()).toEqual(["catalog", "customers", "inventory", "top_products"]);
    // The browser learns from any response that its access changed.
    expect(ov.headers["x-access-fp"]).toMatch(new RegExp(`^${b.ws}:[0-9a-f]{16}$`));
    expect(ov.headers["x-access-fp"]).not.toBe(before);

    // 9-10. Customers removed: refused straight away, and gone from the dashboard.
    ok(await setAccess(b, memberId, "custom", ["products.view", "products.performance", "products.inventory"]));
    const refused = await call("GET", `/workspaces/${b.ws}/stores/${b.store.id}/contacts`, guest.headers);
    expect(refused.statusCode).toBe(403);
    expect(refused.headers["x-access-fp"]).toBeTruthy();
    expect(Object.keys(ok(await overview(b, guest.headers)).modules).sort()).toEqual(["catalog", "inventory", "top_products"]);

    // The change is in the audit log with what was added and removed.
    const log = await systemDb.auditLog.findMany({ where: { workspaceId: b.ws, action: "member.access_changed" }, orderBy: { createdAt: "asc" } });
    expect(log).toHaveLength(2);
    expect(log[1]!.metadata).toMatchObject({ targetUserId: guest.user.id, removed: ["customers.list", "customers.analytics"], added: [] });

    // An editor working from a stale copy is refused rather than undoing the change.
    const stale = await setAccess(b, memberId, "custom", ["customers.list"], { basedOn: current.fingerprint });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("access_changed");
  });

  it("revokes access everywhere at once, and restores it (scenario 11)", async () => {
    const b = await business();
    const { guest, memberId } = await inviteAndJoin(b, "temp@example.com", "analyst", ["analytics.sales", "products.view"]);
    ok(await overview(b, guest.headers));
    ok(await call("POST", `/workspaces/${b.ws}/team/members/${memberId}/revoke`, b.owner.headers));
    for (const url of [`/workspaces/${b.ws}/stores/${b.store.id}/overview`, `/workspaces/${b.ws}/stores`, `/workspaces/${b.ws}/access`, `/workspaces/${b.ws}/alerts`, `/workspaces/${b.ws}/staff/access`]) {
      const res = await call("GET", url, guest.headers);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error, url).toBe("access_revoked");
    }
    const me = ok(await call("GET", "/me", guest.headers));
    expect(me.workspaces).toEqual([expect.objectContaining({ id: b.ws, status: "revoked", permissions: [] })]);
    // On the team page as revoked, still counted as a member but not an active one.
    const team = ok(await call("GET", `/workspaces/${b.ws}/team`, b.owner.headers));
    expect(team.summary).toMatchObject({ totalMembers: 2, activeMembers: 1 });
    expect(team.rows.find((r: { id: string }) => r.id === memberId).status).toBe("revoked");
    // Can't be invited again while revoked: restore instead.
    const again = await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email: "temp@example.com", role: "viewer", permissions: [] });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("member_revoked");

    ok(await call("POST", `/workspaces/${b.ws}/team/members/${memberId}/restore`, b.owner.headers));
    expect(Object.keys(ok(await overview(b, guest.headers)).modules).sort()).toEqual(["catalog", "sales_overview"]);
    const actions = (await systemDb.auditLog.findMany({ where: { workspaceId: b.ws }, select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["member.access_revoked", "member.access_restored"]));

    // Removing them takes them out altogether.
    ok(await call("DELETE", `/workspaces/${b.ws}/team/members/${memberId}`, b.owner.headers));
    expect((await overview(b, guest.headers)).statusCode).toBe(404);
  });
});

describe("invitation links (scenario 12)", () => {
  it("is accepted once, stops when cancelled, expires, and a resend sends the same link again", async () => {
    const b = await business();
    const { guest, token } = await inviteAndJoin(b, "once@example.com", "viewer", ["analytics.sales"]);
    const reused = await call("POST", "/invitations/accept", guest.headers, { token });
    expect(reused.statusCode).toBe(400);
    expect(reused.json().error).toBe("invalid_invite");
    expect(ok(await call("POST", "/invitations/preview", {}, { token })).status).toBe("accepted");

    // Expired.
    ok(await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email: "late@example.com", role: "viewer", permissions: ["analytics.sales"] }));
    const lateToken = tokenFrom(lastMailTo("late@example.com")!.text)!;
    const late = await systemDb.invitation.findFirstOrThrow({ where: { email: "late@example.com" } });
    await systemDb.invitation.update({ where: { id: late.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(ok(await call("POST", "/invitations/preview", {}, { token: lateToken }))).toMatchObject({ status: "expired", workspace: "Acme" });
    const lateUser = await signIn(ctx, "late", "late@example.com");
    expect((await call("POST", "/invitations/accept", lateUser.headers, { token: lateToken })).statusCode).toBe(400);
    let team = ok(await call("GET", `/workspaces/${b.ws}/team`, b.owner.headers));
    expect(team.summary).toMatchObject({ pendingInvitations: 0, endedInvitations: 1 });

    // Resent: renewed, with the same link, which works again; no second invitation.
    const resent = ok(await call("POST", `/workspaces/${b.ws}/team/invitations/${late.id}/resend`, b.owner.headers));
    expect(resent.emailed).toBe(true);
    const freshToken = tokenFrom(lastMailTo("late@example.com")!.text)!;
    expect(freshToken).toBe(lateToken);
    expect(ok(await call("POST", "/invitations/preview", {}, { token: lateToken })).status).toBe("pending");
    expect(await systemDb.invitation.count({ where: { email: "late@example.com" } })).toBe(1);
    team = ok(await call("GET", `/workspaces/${b.ws}/team`, b.owner.headers));
    expect(team.summary).toMatchObject({ pendingInvitations: 1, endedInvitations: 0 });

    // Cancelled: the link stops working, and the invitation stays on record as cancelled.
    ok(await call("POST", `/workspaces/${b.ws}/team/invitations/${late.id}/revoke`, b.owner.headers));
    expect(ok(await call("POST", "/invitations/preview", {}, { token: freshToken })).status).toBe("revoked");
    expect((await call("POST", "/invitations/accept", lateUser.headers, { token: freshToken })).statusCode).toBe(400);
    team = ok(await call("GET", `/workspaces/${b.ws}/team?status=cancelled`, b.owner.headers));
    expect(team.rows.map((r: { email: string }) => r.email)).toEqual(["late@example.com"]);
    const resendCancelled = await call("POST", `/workspaces/${b.ws}/team/invitations/${late.id}/resend`, b.owner.headers);
    expect(resendCancelled.statusCode).toBe(409);
  });
});

describe("tenants and self-service (scenarios 13-14)", () => {
  it("a member of one business can't reach another's, by any id", async () => {
    const a = await business("Alpha");
    const z = await business("Zeta");
    const { guest } = await inviteAndJoin(a, "both@example.com", "analyst", [...LEGACY_GRANTS.analyst]);
    for (const url of [`/workspaces/${z.ws}/stores/${z.store.id}/overview`, `/workspaces/${z.ws}/access`, `/workspaces/${z.ws}/stores`, `/workspaces/${a.ws}/stores/${z.store.id}/overview`]) {
      expect((await call("GET", url, guest.headers)).statusCode, url).toBe(404);
    }
  });

  it("nobody changes their own access, and a member can't grant anything", async () => {
    const b = await business();
    const { guest, memberId } = await inviteAndJoin(b, "self@example.com", "manager", ["analytics.sales", "integrations.status"]);
    // The member themselves: not a team manager.
    expect((await call("PATCH", `/workspaces/${b.ws}/team/members/${memberId}`, guest.headers, { role: "admin", permissions: [] })).statusCode).toBe(403);
    expect((await call("POST", `/workspaces/${b.ws}/team/invitations`, guest.headers, { email: "friend@example.com", role: "viewer", permissions: ["analytics.sales"] })).statusCode).toBe(403);
    expect((await call("PATCH", `/workspaces/${b.ws}/members/${memberId}`, guest.headers, { role: "admin" })).statusCode).toBe(403);
    // An owner on their own membership.
    const ownerMember = await systemDb.membership.findFirstOrThrow({ where: { workspaceId: b.ws, userId: b.owner.user.id } });
    const own = await call("PATCH", `/workspaces/${b.ws}/team/members/${ownerMember.id}`, b.owner.headers, { role: "viewer", permissions: [] });
    expect(own.statusCode).toBe(403);
    expect(own.json().error).toBe("own_access");
    expect((await call("POST", `/workspaces/${b.ws}/team/members/${ownerMember.id}/revoke`, b.owner.headers)).statusCode).toBe(403);
  });

  it("checks what is granted: no ownership by invitation, viewers only look, permissions come with what they sit inside", async () => {
    const b = await business();
    const invite = (body: Record<string, unknown>) => call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email: "x@example.com", ...body });
    expect((await invite({ role: "owner", permissions: [] })).statusCode).toBe(400);
    const viewerManage = await invite({ role: "viewer", permissions: ["integrations.status", "integrations.manage"] });
    expect(viewerManage.statusCode).toBe(400);
    expect(viewerManage.json().error).toBe("role_cannot_manage");
    const orphan = await invite({ role: "custom", permissions: ["customers.contact"] });
    expect(orphan.statusCode).toBe(400);
    expect(orphan.json().error).toBe("missing_requirement");
    expect((await invite({ role: "custom", permissions: ["everything.please"] })).json().error).toBe("unknown_permission");
    expect((await invite({ role: "admin", permissions: ["analytics.sales"] })).json().error).toBe("not_restricted");
    expect((await invite({ role: "custom", permissions: ["staff.team"], staffRole: "supervisor" })).json().error).toBe("supervisor_with_staff_permissions");
    expect((await invite({ role: "viewer", permissions: [], message: "Log in at https://evil.example/login" })).json().error).toBe("message_has_link");
    expect(await systemDb.invitation.count()).toBe(0);
    // An admin can't make an owner.
    const { memberId } = await inviteAndJoin(b, "adm@example.com", "admin", []);
    const admin = await signIn(ctx, "adm@example.com", "adm@example.com");
    const { memberId: other } = await inviteAndJoin(b, "other@example.com", "viewer", ["analytics.sales"]);
    expect((await call("PATCH", `/workspaces/${b.ws}/team/members/${other}`, admin.headers, { role: "owner", permissions: [] })).statusCode).toBe(403);
    expect((await call("PATCH", `/workspaces/${b.ws}/team/members/${other}`, admin.headers, { role: "analyst", permissions: ["analytics.sales", "orders.list"] })).statusCode).toBe(200);
    expect(memberId).toBeTruthy();
  });
});

describe("exports and sensitive fields (scenarios 15-16)", () => {
  it("shows the Advertising area's reports on screen to whoever may see advertising, and downloads them only with the export permission", async () => {
    const b = await business();
    const today = new Date().toISOString().slice(0, 10);
    const conn = await systemDb.adConnection.create({
      data: { workspaceId: b.ws, storeId: b.store.id, provider: "meta", accountId: "act_1", accountName: "Shop ads", currency: "USD", timezone: "UTC", accessTokenEnc: "x", tokenKeyVersion: 1, historyFrom: "2026-01-01", syncedThrough: today, lastSyncedAt: new Date() },
    });
    await systemDb.adCampaignDaily.create({ data: { workspaceId: b.ws, storeId: b.store.id, connectionId: conn.id, provider: "meta", accountId: "act_1", campaignId: "1", campaignName: "Spring", day: today, spend: 12, impressions: 100, clicks: 4, linkClicks: 2 } });
    const qs = "section=ads_campaigns&preset=7d&platform=meta";
    const { guest, memberId } = await inviteAndJoin(b, "ads@example.com", "custom", ["analytics.sales"]);
    // Without "View advertising analytics" and "View campaigns": neither on screen nor downloaded.
    expect((await call("GET", `/workspaces/${b.ws}/stores/${b.store.id}/export/table?${qs}`, guest.headers)).statusCode).toBe(403);
    ok(await setAccess(b, memberId, "custom", ["marketing.ads", "marketing.campaigns"]));
    const table = await call("GET", `/workspaces/${b.ws}/stores/${b.store.id}/export/table?${qs}`, guest.headers);
    expect(table.statusCode).toBe(200);
    expect(table.json()).toMatchObject({ section: "ads_campaigns", label: "Ad campaigns", rows: [["Meta Ads", "act_1", "Spring", null, 12, 100, 4, 2, 0, 0, null, null, null, 0, null, null, null, "yes"]] });
    // On screen isn't a download: nothing in the audit log, and the download itself still needs the export permission.
    expect(await systemDb.auditLog.count({ where: { workspaceId: b.ws, action: "report.exported" } })).toBe(0);
    expect((await call("GET", `/workspaces/${b.ws}/stores/${b.store.id}/export?${qs}`, guest.headers)).statusCode).toBe(403);
    ok(await setAccess(b, memberId, "custom", ["marketing.ads", "marketing.campaigns", "reports.export"]));
    const csv = await call("GET", `/workspaces/${b.ws}/stores/${b.store.id}/export?${qs}`, guest.headers);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-disposition"]).toMatch(/attachment; filename="bizinsights-acme-ads_campaigns-/);
    // The same rows as on screen: a spend before of $0 (nothing ran in the week before), so no change from it.
    expect(csv.body.trim().split("\r\n")).toHaveLength(1 + table.json().rows.length);
    // (The campaign's status hasn't been read here: an empty cell.)
    expect(csv.body).toContain('"Meta Ads","act_1","Spring",,12,100,4,2');
    expect(await systemDb.auditLog.findFirst({ where: { workspaceId: b.ws, action: "report.exported" }, select: { metadata: true } })).toMatchObject({ metadata: { section: "ads_campaigns", platform: "meta" } });
  });

  it("exports only with the export permission, and only what the member can see", async () => {
    const b = await business();
    const { guest, memberId } = await inviteAndJoin(b, "csv@example.com", "custom", ["analytics.sales"]);
    const url = `/workspaces/${b.ws}/stores/${b.store.id}/export?section=sales&preset=7d`;
    expect((await call("GET", url, guest.headers)).statusCode).toBe(403);
    ok(await setAccess(b, memberId, "custom", ["analytics.sales", "reports.export"]));
    const res = await call("GET", url, guest.headers);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="bizinsights-acme-sales-/);
    const noBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    const header = noBom(res.body).split("\r\n")[0];
    // Returns per day need "View refunds", total sales the sales breakdown (it holds tax and shipping).
    expect(header).toBe('"Day","Orders","Net sales","Average order value"');
    expect(res.body).toContain(`"${today}",1,100`);
    // A section they can't see stays closed even with the export permission.
    expect((await call("GET", `/workspaces/${b.ws}/stores/${b.store.id}/export?section=products`, guest.headers)).statusCode).toBe(403);
    expect(await systemDb.auditLog.count({ where: { workspaceId: b.ws, action: "report.exported" } })).toBe(1);
    // The owner's has the total sales (it holds tax and shipping) and returns columns.
    const owners = await call("GET", url, b.owner.headers);
    expect(noBom(owners.body).split("\r\n")[0]).toBe('"Day","Orders","Total sales","Net sales","Additional fees","Duties","Shipping charges","Taxes","Average order value","Returns"');
  });

  it("leaves out financial detail, stock value and customers' personal data until each is granted", async () => {
    const b = await business();
    const { guest, memberId } = await inviteAndJoin(b, "fields@example.com", "custom", ["analytics.sales", "products.inventory", "orders.list", "customers.list"]);
    let ov = ok(await overview(b, guest.headers));
    expect(ov.modules.sales_overview.current).not.toHaveProperty("grossSales");
    expect(ov.modules.sales_overview.current).not.toHaveProperty("tax");
    expect(ov.modules.sales_overview).not.toHaveProperty("year");
    expect(ov.modules.sales_overview.series[0]).not.toHaveProperty("refunds");
    expect(ov.modules.sales_overview.current.netSales).toBe(100);
    expect(ov.modules.inventory.current).not.toHaveProperty("stockValueAtCost");
    expect(ov.modules.inventory.current).not.toHaveProperty("retailValue");
    expect(ov.modules.recent_orders.items[0]).not.toHaveProperty("financialStatus");
    expect(ov.modules.recent_orders.items[0]).toMatchObject({ name: "#1", total: expect.any(Number) });

    let sent = "";
    ctx.setFetch(async (input, init) => {
      sent = String(init?.body ?? "");
      return contactsReply(input, init);
    });
    const contacts = (h: Headers) => call("GET", `/workspaces/${b.ws}/stores/${b.store.id}/contacts`, h);
    let c = ok(await contacts(guest.headers));
    // Only the lists they may see were asked of Shopify.
    expect(JSON.parse(sent).variables).toMatchObject({ abandoned: false, customers: true });
    expect(c.shown).toEqual({ abandoned: false, customers: true, names: false, contact: false, orders: false });
    expect(c.recent[0]).toMatchObject({ customerId: "11", name: null, email: null, phone: null, adminUrl: null, orders: null, spent: null });
    expect(c.abandoned).toEqual([]);

    ok(await setAccess(b, memberId, "custom", ["analytics.sales", "finance.breakdown", "finance.refunds", "finance.reports", "products.inventory", "products.prices", "orders.list", "orders.payments", "customers.list", "customers.profiles", "customers.contact", "customers.orders"]));
    ov = ok(await overview(b, guest.headers));
    expect(ov.modules.sales_overview.current.grossSales).toBe(100);
    expect(ov.modules.sales_overview).toHaveProperty("year");
    expect(ov.modules).toHaveProperty("refunds");
    expect(ov.modules.inventory.current).toHaveProperty("retailValue");
    expect(ov.modules.recent_orders.items[0].financialStatus).toBe("paid");
    c = ok(await contacts(guest.headers));
    expect(c.recent[0]).toMatchObject({ name: "Jane Doe", email: "jane@example.com", phone: "+61400000000", orders: 2, spent: 120.5 });
  });
});

describe("email problems and existing users (scenarios 17-18)", () => {
  it("refuses a bad address, and hands the link back when the email can't be sent", async () => {
    const b = await business();
    const bad = await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email: "not-an-email", role: "viewer", permissions: [] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("validation");
    const send = ctx.mailer.send;
    ctx.mailer.send = async () => {
      throw new MailError("Resend send failed (422 validation_error): Invalid `to` field", "resend", "permanent", "validation_error");
    };
    try {
      const r = ok(await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email: "bounce@example.com", role: "viewer", permissions: ["analytics.sales"] }));
      expect(r.emailed).toBe(false);
      expect(r.emailProblem).toBe("failed");
      expect(r.url).toMatch(/\/invite#token=[A-Za-z0-9_-]+$/);
      const row = await systemDb.invitation.findFirstOrThrow({ where: { email: "bounce@example.com" } });
      expect(row.sendFailedAt).not.toBeNull();
      expect(row.sendCount).toBe(0);
      // The handed-over link works.
      const token = tokenFrom(r.url)!;
      expect(ok(await call("POST", "/invitations/preview", {}, { token })).status).toBe("pending");
      // SES refusing the address (its sandbox) is told apart, so the panel can say why.
      ctx.mailer.send = async () => {
        throw new Error("SES send failed (400): Email address is not verified. The following identities failed the check in region AP-SOUTHEAST-2: x***@gmail.com");
      };
      const sandboxed = ok(await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email: "sandboxed@example.com", role: "viewer", permissions: ["analytics.sales"] }));
      expect(sandboxed).toMatchObject({ emailed: false, emailProblem: "not_allowed", delivery: "not_allowed" });
      // Recorded as the provider said it, with no address kept in the record.
      const d = await systemDb.emailDelivery.findFirstOrThrow({ where: { invitation: { email: "sandboxed@example.com" } } });
      expect(d).toMatchObject({ status: "not_allowed", provider: "unknown" });
      expect(d.errorMessage).not.toContain("@gmail.com");
    } finally {
      ctx.mailer.send = send;
    }
  });

  it("leaves owners and admins exactly what they had, and API keys read-only without customers' data", async () => {
    const b = await business();
    const ov = ok(await overview(b, b.owner.headers));
    expect(Object.keys(ov.modules)).toEqual(expect.arrayContaining(["sales_overview", "refunds", "customers", "top_products", "recent_orders", "inventory", "catalog"]));
    expect(ov.modules.sales_overview.current).toHaveProperty("grossSales");
    expect(ok(await call("GET", `/workspaces/${b.ws}/access`, b.owner.headers))).toMatchObject({ role: "owner", fullAccess: true });
    // The ETag lets the app's frequent check cost nothing while nothing changed.
    const first = await call("GET", `/workspaces/${b.ws}/access`, b.owner.headers);
    const again = await call("GET", `/workspaces/${b.ws}/access`, { ...b.owner.headers, "if-none-match": first.headers["etag"]! });
    expect(again.statusCode).toBe(304);
    // API keys: what viewers saw before (no contacts), never a change.
    const { secret } = ok(await call("POST", `/workspaces/${b.ws}/api-keys`, b.owner.headers, { name: "bi" }));
    const key = { authorization: `Bearer ${secret}` };
    expect(Object.keys(ok(await overview(b, key)).modules)).toEqual(expect.arrayContaining(["sales_overview", "inventory"]));
    expect((await call("GET", `/workspaces/${b.ws}/stores/${b.store.id}/contacts`, key)).statusCode).toBe(403);
    expect((await call("GET", `/workspaces/${b.ws}/team`, key)).statusCode).toBe(403);
  });

  it("the old member endpoints still work, giving analysts and viewers what they used to see", async () => {
    const b = await business();
    ok(await call("POST", `/workspaces/${b.ws}/invitations`, b.owner.headers, { email: "legacy@example.com", role: "analyst" }));
    const token = /token=([A-Za-z0-9_-]+)/.exec(lastMailTo("legacy@example.com")!.text)![1]!;
    const guest = await signIn(ctx, "legacy", "legacy@example.com");
    ok(await call("POST", "/invitations/accept", guest.headers, { token }));
    const m = await systemDb.membership.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: b.ws, userId: guest.user.id } } });
    expect(m.permissions).toEqual([...LEGACY_GRANTS.analyst]);
    ok(await call("PATCH", `/workspaces/${b.ws}/members/${m.id}`, b.owner.headers, { role: "viewer" }));
    expect((await systemDb.membership.findUniqueOrThrow({ where: { id: m.id } })).permissions).toEqual([...LEGACY_GRANTS.viewer]);
  });
});

describe("concurrency (scenario 20)", () => {
  it("two invitations to one person at once leave one that works", async () => {
    const b = await business();
    const send = () => call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email: "race@example.com", role: "viewer", permissions: ["analytics.sales"] });
    const results = await Promise.all([send(), send(), send()]);
    for (const r of results) expect(r.statusCode).toBe(200);
    const rows = await systemDb.invitation.findMany({ where: { email: "race@example.com" } });
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => !r.revokedAt)).toHaveLength(1);
  });

  it("two tabs accepting the same link: exactly one joins", async () => {
    const b = await business();
    ok(await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email: "twice@example.com", role: "viewer", permissions: ["analytics.sales"] }));
    const token = tokenFrom(lastMailTo("twice@example.com")!.text)!;
    const guest = await signIn(ctx, "twice", "twice@example.com");
    const results = await Promise.all([1, 2, 3].map(() => call("POST", "/invitations/accept", guest.headers, { token })));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(await systemDb.membership.count({ where: { workspaceId: b.ws, userId: guest.user.id } })).toBe(1);
  });

  it("simultaneous edits from the same starting point: one saves, the other is told to look again", async () => {
    const b = await business();
    const { memberId } = await inviteAndJoin(b, "edit@example.com", "viewer", ["analytics.sales"]);
    const { fingerprint } = ok(await call("GET", `/workspaces/${b.ws}/team/members/${memberId}`, b.owner.headers)).member;
    const results = await Promise.all([
      setAccess(b, memberId, "viewer", ["analytics.sales", "products.view"], { basedOn: fingerprint }),
      setAccess(b, memberId, "viewer", ["orders.list"], { basedOn: fingerprint }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const m = await systemDb.membership.findUniqueOrThrow({ where: { id: memberId } });
    expect([["analytics.sales", "products.view"], ["orders.list"]]).toContainEqual(m.permissions);
  });

  it("a retried Send (same Idempotency-Key) sends one email", async () => {
    const b = await business();
    const h = { ...b.owner.headers, "idempotency-key": "invite-abc-12345" };
    const body = { email: "retry@example.com", role: "viewer", permissions: ["analytics.sales"] };
    const first = ok(await call("POST", `/workspaces/${b.ws}/team/invitations`, h, body));
    const second = ok(await call("POST", `/workspaces/${b.ws}/team/invitations`, h, body));
    expect(second.invitationId).toBe(first.invitationId);
    expect(ctx.mailer.sent.filter((m) => m.to === "retry@example.com")).toHaveLength(1);
  });
});

describe("staff and integrations permissions", () => {
  it("staff permissions open Staff Management for every employee; managing integrations doesn't reach the Shopify store", async () => {
    const b = await business();
    const { guest, memberId } = await inviteAndJoin(b, "hr@example.com", "manager", ["staff.team", "integrations.status", "integrations.manage"]);
    expect(ok(await call("GET", `/workspaces/${b.ws}/staff/access`, guest.headers)).permissions).toEqual(["staff:view"]);
    expect((await call("GET", `/workspaces/${b.ws}/staff/employees`, guest.headers)).statusCode).toBe(200);
    expect((await call("GET", `/workspaces/${b.ws}/staff/timesheets`, guest.headers)).statusCode).toBe(403);
    // Integrations: ad accounts yes, the Shopify store no.
    expect((await call("GET", `/workspaces/${b.ws}/stores/${b.store.id}/ads`, guest.headers)).statusCode).toBe(200);
    expect((await call("DELETE", `/workspaces/${b.ws}/stores/${b.store.id}`, guest.headers)).statusCode).toBe(403);
    expect((await call("POST", `/workspaces/${b.ws}/stores/${b.store.id}/resync`, guest.headers)).statusCode).toBe(403);
    // A viewer can't hold management permissions.
    expect((await setAccess(b, memberId, "viewer", ["integrations.status", "integrations.manage"])).statusCode).toBe(400);
  });
});

describe("retention", () => {
  it("removes invitations 90 days after they ended and member audit entries after two years", async () => {
    const b = await business();
    const old = new Date(Date.now() - 100 * 86_400_000);
    await systemDb.invitation.createMany({
      data: [
        { workspaceId: b.ws, email: "gone@example.com", role: "viewer", tokenHash: "h1", expiresAt: old, revokedAt: old, createdAt: old },
        { workspaceId: b.ws, email: "keep@example.com", role: "viewer", tokenHash: "h2", expiresAt: new Date(Date.now() + 86_400_000) },
      ],
    });
    await systemDb.auditLog.createMany({
      data: [
        { workspaceId: b.ws, action: "member.invited", createdAt: new Date(Date.now() - 800 * 86_400_000) },
        { workspaceId: b.ws, action: "store.resync", createdAt: new Date(Date.now() - 800 * 86_400_000) },
      ],
    });
    expect(await pruneTeamRecords()).toEqual({ invitations: 1, auditEntries: 1 });
    expect((await systemDb.invitation.findMany()).map((i) => i.email)).toEqual(["keep@example.com"]);
    expect(await systemDb.auditLog.count({ where: { action: "store.resync" } })).toBe(1);
  });
});

describe("opening the dashboard straight from the invitation link", () => {
  const sendInvite = async (b: Awaited<ReturnType<typeof business>>, email: string) => {
    ok(await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email, role: "viewer", permissions: ["analytics.sales", "products.view"] }));
    return tokenFrom(lastMailTo(email)!.text)!;
  };
  const open = (token: string, headers: Headers = ORIGIN, extra: Record<string, unknown> = {}) => call("POST", "/invitations/open", headers, { token, ...extra });
  const sessionOf = (res: Awaited<ReturnType<typeof call>>) => ({ cookie: cookiesFrom(res), ...ORIGIN });

  it("opens the shared dashboard for someone new, with no account, sign-up or password", async () => {
    const b = await business();
    const token = await sendInvite(b, "newcomer@example.com");
    const res = await open(token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ workspaceId: b.ws, signedIn: true, shared: true });
    const session = sessionOf(res);
    // Its own cookie: never the account session's.
    expect(session.cookie).toContain("__share=");
    expect(session.cookie).not.toContain("__session=");
    expect(res.headers["set-cookie"]).toMatch(/__share=[^;]+;.*HttpOnly/i);
    expect(res.headers["set-cookie"]).toMatch(/SameSite=Lax/i);
    // Exactly what was shared, and the app knows it was opened from a link (view-only).
    const me = ok(await call("GET", "/me", session));
    expect(me.user.email).toBe("newcomer@example.com");
    expect(me.shared).toMatchObject({ workspaceId: b.ws, readOnly: true });
    // The shared access's own end date (60 days), not this session's (5 days).
    expect(Math.round((Date.parse(me.shared.expiresAt) - Date.now()) / 86_400_000)).toBe(60);
    expect(me.workspaces.map((w: { id: string }) => w.id)).toEqual([b.ws]);
    expect(ok(await call("GET", `/workspaces/${b.ws}/access`, session))).toMatchObject({ role: "viewer", modules: ["analytics", "products"] });
    expect(Object.keys(ok(await overview(b, session)).modules).sort()).toEqual(["catalog", "sales_overview"]);
    ok(await call("GET", `/workspaces/${b.ws}/stores`, session));
    // No Cognito account was needed.
    expect(ctx.auth.calls.filter((c) => c === "adminCreateUser")).toHaveLength(0);
    // Joined, and on the team list.
    const team = ok(await call("GET", `/workspaces/${b.ws}/team`, b.owner.headers));
    expect(team.summary).toMatchObject({ totalMembers: 2, pendingInvitations: 0 });
  });

  it("never lands on an account for the address that nobody verified but someone can sign in to", async () => {
    const b = await business();
    const token = await sendInvite(b, "squatted@example.com");
    // Someone else made an account for that address and set its password, without proving the inbox.
    const squat = await systemDb.user.create({ data: { email: "squatted@example.com", emailVerified: false } });
    await systemDb.authIdentity.create({ data: { userId: squat.id, provider: "cognito", subject: "sub-squat", username: "squat-user", method: "password", email: "squatted@example.com" } });
    const res = await open(token);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("account_unverified");
    expect(res.headers["set-cookie"] ?? "").not.toContain("__share=");
    expect(await systemDb.membership.count({ where: { workspaceId: b.ws, userId: squat.id } })).toBe(0);
    expect((await systemDb.invitation.findFirstOrThrow({ where: { workspaceId: b.ws, email: "squatted@example.com" } })).acceptedAt).toBeNull();
  });

  it("keeps working after the first time (another device), and stops once their access is revoked", async () => {
    const b = await business();
    const token = await sendInvite(b, "again@example.com");
    const first = sessionOf(await open(token));
    expect(ok(await call("POST", "/invitations/preview", {}, { token }))).toMatchObject({ status: "accepted", reopens: true, roleLabel: "Viewer" });
    const second = await open(token);
    expect(second.statusCode, second.body).toBe(200);
    ok(await overview(b, sessionOf(second)));

    const m = await systemDb.membership.findFirstOrThrow({ where: { workspaceId: b.ws, user: { email: "again@example.com" } } });
    ok(await call("POST", `/workspaces/${b.ws}/team/members/${m.id}/revoke`, b.owner.headers));
    expect((await overview(b, first)).json().error).toBe("access_revoked");
    const after = await open(token);
    expect(after.statusCode).toBe(400);
    expect(after.json().detail).toEqual({ status: "accepted" });
    expect(ok(await call("POST", "/invitations/preview", {}, { token }))).toEqual({ status: "accepted", workspace: "Acme", inviter: expect.any(String) });
  });

  it("works until the invitation's end date (60 days by default), then stops, until an owner renews it", async () => {
    const b = await business();
    const token = await sendInvite(b, "old@example.com");
    const inv = await systemDb.invitation.findFirstOrThrow({ where: { email: "old@example.com" } });
    expect(Math.round((inv.expiresAt.getTime() - Date.now()) / 86_400_000)).toBe(60);
    const session = sessionOf(await open(token));
    const m = await systemDb.membership.findFirstOrThrow({ where: { workspaceId: b.ws, user: { email: "old@example.com" } } });
    expect(m.accessExpiresAt?.getTime()).toBe(inv.expiresAt.getTime());
    // The end date passes: the open dashboard stops, and the link no longer opens it.
    const past = new Date(Date.now() - 1000);
    await systemDb.membership.update({ where: { id: m.id }, data: { accessExpiresAt: past } });
    await systemDb.invitation.update({ where: { id: inv.id }, data: { expiresAt: past } });
    const stopped = await overview(b, session);
    expect(stopped.statusCode).toBe(403);
    expect(stopped.json().error).toBe("access_expired");
    expect((await open(token)).statusCode).toBe(400);
    let team = ok(await call("GET", `/workspaces/${b.ws}/team`, b.owner.headers));
    expect(team.rows.find((r: { email: string }) => r.email === "old@example.com")).toMatchObject({ kind: "member", status: "expired" });
    expect(team.summary.invitations).toMatchObject({ expired: 1, active: 0 });
    // Renewed: the same link opens it again, for another 60 days.
    const renewed = ok(await call("POST", `/workspaces/${b.ws}/team/members/${m.id}/renew`, b.owner.headers, { days: 60 }));
    expect(Math.round((Date.parse(renewed.expiresAt) - Date.now()) / 86_400_000)).toBe(60);
    ok(await overview(b, sessionOf(await open(token))));
    team = ok(await call("GET", `/workspaces/${b.ws}/team`, b.owner.headers));
    expect(team.summary.invitations).toMatchObject({ expired: 0, active: 1, total: 1 });
    // Only up to 60 days at a time.
    expect((await call("POST", `/workspaces/${b.ws}/team/members/${m.id}/renew`, b.owner.headers, { days: 61 })).statusCode).toBe(400);
  });

  it("never joins an account that already has the address: whoever holds the link may be the inviter", async () => {
    const b = await business();
    // V: their own business and a sign-in of their own.
    const v = await signIn(ctx, "victim", "victim@example.com");
    await createWorkspace(ctx, v.headers, "Victim's business");
    // B's owner invites V as an admin, copies the link and opens it without V.
    ok(await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email: "victim@example.com", role: "admin", permissions: [] }));
    const inv = await systemDb.invitation.findFirstOrThrow({ where: { workspaceId: b.ws, email: "victim@example.com" } });
    const copied = tokenFrom(ok(await call("POST", `/workspaces/${b.ws}/team/invitations/${inv.id}/link`, b.owner.headers)).url)!;
    const res = await open(copied);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("sign_in_required");
    expect(res.headers["set-cookie"] ?? "").not.toContain("__share=");
    expect(await systemDb.membership.count({ where: { workspaceId: b.ws, userId: v.user.id } })).toBe(0);
    expect((await systemDb.invitation.findUniqueOrThrow({ where: { id: inv.id } })).acceptedAt).toBeNull();
    // Signed in as itself, V's account accepts (its address verified, and it is the invited one).
    expect(ok(await call("POST", "/invitations/accept", v.headers, { token: copied }))).toMatchObject({ workspaceId: b.ws, joined: true });
    expect(await systemDb.membership.count({ where: { workspaceId: b.ws, userId: v.user.id } })).toBe(1);
    // Someone else's account can't accept it for V.
    const other = await signIn(ctx, "other", "other@example.com");
    ok(await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email: "late@example.com", role: "viewer", permissions: ["products.view"] }));
    const late = await signIn(ctx, "late", "late@example.com");
    const lateToken = tokenFrom(lastMailTo("late@example.com")!.text)!;
    expect((await open(lateToken)).json().error).toBe("sign_in_required");
    expect((await call("POST", "/invitations/accept", other.headers, { token: lateToken })).json().error).toBe("invite_email_mismatch");
    expect(await systemDb.membership.count({ where: { workspaceId: b.ws, userId: late.user.id } })).toBe(0);
  });

  it("opens only the shared workspace: not the account, nor its other workspaces", async () => {
    const b = await business();
    const existing = await signIn(ctx, "existing", "existing@example.com");
    const own = await createWorkspace(ctx, existing.headers, "Their own");
    const token = await sendInvite(b, "existing@example.com");
    // An account accepts signed in; its link then opens the shared workspace on any device.
    ok(await call("POST", "/invitations/accept", existing.headers, { token }));
    const res = await open(token);
    expect(res.json()).toMatchObject({ workspaceId: b.ws, signedIn: true });
    const link = sessionOf(res);
    expect(ok(await call("GET", "/me", link)).workspaces.map((w: { id: string }) => w.id)).toEqual([b.ws]);
    expect((await call("GET", `/workspaces/${own}/stores`, link)).statusCode).toBe(404);
    expect((await call("GET", `/workspaces/${own}/access`, link)).statusCode).toBe(404);
    for (const [method, url, payload] of [
      ["GET", "/auth/account"],
      ["PATCH", "/me", { displayName: "Changed" }],
      ["POST", "/workspaces", { name: "Another" }],
      ["POST", "/auth/logout-all"],
      ["GET", "/employee/workspaces"],
    ] as const) {
      const r = await call(method, url, link, payload);
      expect(r.statusCode, url).toBe(403);
      expect(r.json().error, url).toBe("shared_link");
    }
    // Their own sign-in still has everything.
    expect(ok(await call("GET", "/me", existing.headers)).workspaces).toHaveLength(2);
    // Signing out of the link session ends it.
    ok(await call("POST", "/auth/logout", link));
    expect((await call("GET", "/me", link)).statusCode).toBe(401);
  });

  it("only from our own pages: a cross-site request can't sign a browser in", async () => {
    const b = await business();
    const token = await sendInvite(b, "csrf@example.com");
    expect((await open(token, { origin: "https://evil.example" })).statusCode).toBe(403);
    expect((await open(token, {})).statusCode).toBe(403);
    expect(await systemDb.membership.count({ where: { workspaceId: b.ws } })).toBe(1);
  });

  it("signed in as someone else: opens the shared dashboard alongside, never switching, merging or signing them out", async () => {
    const b = await business();
    const token = await sendInvite(b, "invited@example.com");
    const other = await signIn(ctx, "other", "other@example.com");
    const theirOwn = await createWorkspace(ctx, other.headers, "Other's business");
    const res = await open(token, other.headers);
    expect(res.statusCode, res.body).toBe(200);
    // Only the shared-link cookie is set: the account's session is untouched.
    expect(cookiesFrom(res)).toContain("__share=");
    expect(cookiesFrom(res)).not.toContain("__session=");
    const browser = { ...other.headers, cookie: `${other.headers.cookie}; ${cookiesFrom(res)}` };
    // The account's tabs: still the account, with its own workspace and nothing of the shared one.
    const own = ok(await call("GET", "/me", browser));
    expect(own.user.email).toBe("other@example.com");
    expect(own.shared).toBeNull();
    expect(own.workspaces.map((w: { id: string }) => w.id)).toEqual([theirOwn]);
    expect((await overview(b, browser)).statusCode).toBe(404);
    // The shared tab: the invited person's view-only access to that workspace only.
    const sharedTab = { ...browser, "x-bi-context": "shared" };
    const shared = ok(await call("GET", "/me", sharedTab));
    expect(shared.user.email).toBe("invited@example.com");
    expect(shared.workspaces.map((w: { id: string }) => w.id)).toEqual([b.ws]);
    ok(await overview(b, sharedTab));
    expect((await call("GET", `/workspaces/${theirOwn}/stores`, sharedTab)).statusCode).toBe(404);
    // Closing the shared dashboard ends only the shared session.
    const closed = await call("POST", "/auth/logout", sharedTab);
    expect(closed.headers["set-cookie"]).toMatch(/__share=;/);
    expect(closed.headers["set-cookie"]).not.toMatch(/__session=;/);
    expect(ok(await call("GET", "/me", other.headers)).user.email).toBe("other@example.com");
  });

  it("signed in already as the invited person: their account keeps its own access; the shared tab is view-only", async () => {
    const b = await business();
    ok(await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email: "invited@example.com", role: "manager", permissions: ["integrations.status", "integrations.manage"] }));
    const token = tokenFrom(lastMailTo("invited@example.com")!.text)!;
    const invited = await signIn(ctx, "invited", "invited@example.com");
    // The link alone doesn't join their account, signed in or not: they accept as themselves.
    expect((await open(token, invited.headers)).json().error).toBe("sign_in_required");
    ok(await call("POST", "/invitations/accept", invited.headers, { token }));
    const res = await open(token, invited.headers);
    expect(ok(res)).toMatchObject({ workspaceId: b.ws, signedIn: true });
    expect(cookiesFrom(res)).not.toContain("__session=");
    expect(ok(await call("GET", "/me", invited.headers)).shared).toBeNull();
    // Through the link: what the invitation shows, never what it lets them change.
    const sharedTab = { ...ORIGIN, cookie: cookiesFrom(res), "x-bi-context": "shared" };
    const viaLink = ok(await call("GET", `/workspaces/${b.ws}/access`, sharedTab));
    expect(viaLink).toMatchObject({ readOnly: true, permissions: ["integrations.status"] });
    // Signed in to their own account they hold what was granted (the link adds nothing to it either).
    expect(ok(await call("GET", `/workspaces/${b.ws}/access`, invited.headers))).toMatchObject({ readOnly: false, permissions: ["integrations.status", "integrations.manage"] });
  });

  it("says a link that isn't one, or was cancelled, can't be used", async () => {
    const b = await business();
    expect((await open("not-a-real-token-123")).statusCode).toBe(400);
    const token = await sendInvite(b, "gone@example.com");
    const inv = await systemDb.invitation.findFirstOrThrow({ where: { email: "gone@example.com" } });
    ok(await call("POST", `/workspaces/${b.ws}/team/invitations/${inv.id}/revoke`, b.owner.headers));
    const res = await open(token);
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toEqual({ status: "revoked" });
  });
});

// ---------------------------------------------------------------------------
// The shared dashboard's security model and the invitation's lifecycle, end to end (the brief's
// tests 1-20 at the API; the browser side is apps/web/e2e/sharing.spec.ts).
// ---------------------------------------------------------------------------

describe("shared dashboards: who can see what, and for how long", () => {
  // The in-memory mailer keeps every email of the run: each test here counts only its own.
  beforeEach(() => {
    ctx.mailer.sent.length = 0;
    ctx.mailer.fail.length = 0;
  });
  const invite = async (b: Awaited<ReturnType<typeof business>>, email: string, permissions: string[], role = "custom", extra: Record<string, unknown> = {}) => {
    const r = ok(await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email, role, permissions, ...extra }));
    return { ...r, token: tokenFrom(lastMailTo(email)!.text)! };
  };
  /** A browser that opened the link: its shared-link cookie, from our own page, in a shared tab. */
  const openLink = async (token: string) => {
    const res = await call("POST", "/invitations/open", ORIGIN, { token });
    expect(res.statusCode, res.body).toBe(200);
    return { ...ORIGIN, cookie: cookiesFrom(res), "x-bi-context": "shared" };
  };
  const memberOf = (ws: string, email: string) => systemDb.membership.findFirstOrThrow({ where: { workspaceId: ws, user: { email } } });

  it("invites any address (Gmail, Outlook, a business domain): no allowlist, one email each, recorded as sent", async () => {
    const b = await business();
    for (const email of ["someone.new@gmail.com", "client@outlook.com", "accounts@acme-agency.com.au"]) {
      const r = await invite(b, email, ["analytics.sales"]);
      expect(r).toMatchObject({ emailed: true, delivery: "sent" });
      expect(r.url).toBeUndefined();
      const d = await systemDb.emailDelivery.findFirstOrThrow({ where: { invitationId: r.invitationId } });
      expect(d).toMatchObject({ status: "sent", provider: "memory", attempts: 1 });
      expect(d.providerMessageId).toMatch(/^mem-/);
    }
    expect(ctx.mailer.sent.map((m) => m.to).sort()).toEqual(["accounts@acme-agency.com.au", "client@outlook.com", "someone.new@gmail.com"]);
    // Each attempt at one delivery carries the same idempotency key (a retried send goes out once).
    expect(new Set(ctx.mailer.sent.map((m) => m.idempotencyKey)).size).toBe(3);
    const team = ok(await call("GET", `/workspaces/${b.ws}/team`, b.owner.headers));
    expect(team.summary.invitations).toEqual({ total: 3, active: 0, pending: 3, expired: 0, revoked: 0 });
    expect(team.rows.filter((r: { kind: string }) => r.kind === "invitation").every((r: { delivery: { status: string } }) => r.delivery.status === "sent")).toBe(true);
  });

  it("shows exactly the permitted sections, and every other section's API refuses (Products and Marketing only)", async () => {
    const b = await business();
    const { token } = await invite(b, "pm@example.com", ["products.view", "products.performance", "marketing.ads"]);
    const tab = await openLink(token);
    const access = ok(await call("GET", `/workspaces/${b.ws}/access`, tab));
    expect(access.modules).toEqual(["products", "marketing"]);
    const ov = ok(await overview(b, tab));
    expect(Object.keys(ov.modules).sort()).toEqual(expect.arrayContaining(["catalog", "top_products"]));
    for (const hidden of ["sales_overview", "refunds", "customers", "recent_orders", "inventory", "fulfillment", "funnel", "channels", "discount_codes"]) expect(ov.modules[hidden], hidden).toBeUndefined();
    // Sections not shared: refused at the API, not just hidden in the page.
    expect((await call("GET", `/workspaces/${b.ws}/stores/${b.store.id}/contacts`, tab)).statusCode).toBe(403);
    expect((await call("GET", `/workspaces/${b.ws}/stores/${b.store.id}/export?section=sales&preset=last_7_days`, tab)).statusCode).toBe(403);
    expect((await call("GET", `/workspaces/${b.ws}/team`, tab)).statusCode).toBe(403);
    expect((await call("GET", `/workspaces/${b.ws}/staff/employees`, tab)).statusCode).toBe(403);
    // No store credentials or tokens anywhere in what the shared tab receives.
    for (const body of [JSON.stringify(ov), JSON.stringify(access), JSON.stringify(ok(await call("GET", "/me", tab))), JSON.stringify(ok(await call("GET", `/workspaces/${b.ws}/stores`, tab)))]) {
      expect(body).not.toMatch(/shpat_|accessToken|access_token|refreshToken|tokenHash|token_sealed|tokenSealed/);
    }
  });

  it("an admin's link is view-only: everything to look at, nothing to change", async () => {
    const b = await business();
    const { token } = await invite(b, "partner@example.com", [], "admin");
    const tab = await openLink(token);
    const access = ok(await call("GET", `/workspaces/${b.ws}/access`, tab));
    expect(access).toMatchObject({ role: "viewer", fullAccess: false, readOnly: true });
    expect(access.permissions).not.toContain("integrations.manage");
    expect(access.permissions).not.toContain("staff.manage");
    ok(await overview(b, tab));
    for (const [method, url, payload] of [
      ["POST", `/workspaces/${b.ws}/team/invitations`, { email: "x@example.com", role: "viewer", permissions: [] }],
      ["GET", `/workspaces/${b.ws}/team`],
      ["POST", `/workspaces/${b.ws}/stores/${b.store.id}/resync`],
      ["GET", `/workspaces/${b.ws}/api-keys`],
    ] as const) {
      const r = await call(method, url, tab, payload);
      expect([403, 404], `${method} ${url}: ${r.body}`).toContain(r.statusCode);
    }
  });

  it("permission changes reach an open shared dashboard on its next request, both ways", async () => {
    const b = await business();
    const { token } = await invite(b, "live@example.com", ["products.view"]);
    const tab = await openLink(token);
    const before = await overview(b, tab);
    const fp1 = String(before.headers["x-access-fp"]);
    expect(Object.keys(before.json().modules)).not.toContain("sales_overview");
    const m = await memberOf(b.ws, "live@example.com");
    // Added: the next request has it, and says the access changed.
    ok(await call("PATCH", `/workspaces/${b.ws}/team/members/${m.id}`, b.owner.headers, { role: "custom", permissions: ["products.view", "analytics.sales"] }));
    const added = await overview(b, tab);
    expect(Object.keys(added.json().modules)).toContain("sales_overview");
    expect(String(added.headers["x-access-fp"])).not.toBe(fp1);
    // The 5-second check answers 304 while nothing changed, and the new access when it did.
    const etag = `"${String(added.headers["x-access-fp"]).split(":")[1]}"`;
    expect((await call("GET", `/workspaces/${b.ws}/access`, { ...tab, "if-none-match": etag })).statusCode).toBe(304);
    // Removed: gone from the very next request.
    ok(await call("PATCH", `/workspaces/${b.ws}/team/members/${m.id}`, b.owner.headers, { role: "custom", permissions: ["analytics.sales"] }));
    const removed = ok(await overview(b, tab));
    expect(removed.modules.catalog).toBeUndefined();
    expect((await call("GET", `/workspaces/${b.ws}/access`, { ...tab, "if-none-match": etag })).statusCode).toBe(200);
  });

  it("revoking ends every open tab and the link at once; restoring brings both back", async () => {
    const b = await business();
    const { token } = await invite(b, "gone@example.com", ["analytics.sales"]);
    const phone = await openLink(token);
    const laptop = await openLink(token);
    const m = await memberOf(b.ws, "gone@example.com");
    ok(await call("POST", `/workspaces/${b.ws}/team/members/${m.id}/revoke`, b.owner.headers));
    for (const tab of [phone, laptop]) {
      const r = await overview(b, tab);
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe("access_revoked");
    }
    expect((await call("POST", "/invitations/open", ORIGIN, { token })).statusCode).toBe(400);
    ok(await call("POST", `/workspaces/${b.ws}/team/members/${m.id}/restore`, b.owner.headers));
    ok(await overview(b, phone));
  });

  it("keeps tenants apart: one business's link reaches nothing of another's, by any id", async () => {
    const a = await business("Alpha");
    const z = await business("Zeta");
    const { token } = await invite(a, "shared@example.com", ["analytics.sales", "products.view"]);
    const { invitationId: zInvitation } = await invite(z, "theirs@example.com", ["analytics.sales"]);
    const tab = await openLink(token);
    ok(await overview(a, tab));
    expect((await overview({ ws: z.ws, store: z.store }, tab)).statusCode).toBe(404);
    expect((await overview({ ws: a.ws, store: z.store }, tab)).statusCode).toBe(404);
    expect((await call("GET", `/workspaces/${z.ws}/access`, tab)).statusCode).toBe(404);
    // An owner of one business can't act on the other's invitations by id.
    for (const path of ["link", "replace-link", "renew", "resend", "revoke"]) {
      expect((await call("POST", `/workspaces/${a.ws}/team/invitations/${zInvitation}/${path}`, a.owner.headers, {})).statusCode, path).toBe(404);
    }
    expect((await call("GET", `/workspaces/${a.ws}/team/history?invitationId=${zInvitation}`, a.owner.headers)).statusCode).toBe(404);
  });

  it("refuses links that aren't real: forged, malformed, truncated, or another's hash", async () => {
    const b = await business();
    const { token } = await invite(b, "real@example.com", ["analytics.sales"]);
    const inv = await systemDb.invitation.findFirstOrThrow({ where: { email: "real@example.com" } });
    for (const t of ["x".repeat(43), token.slice(0, -1), `${token}A`, inv.tokenHash, inv.id, "../../etc/passwd-0000"]) {
      expect(ok(await call("POST", "/invitations/preview", {}, { token: t })).status, t).toBe("invalid");
      expect((await call("POST", "/invitations/open", ORIGIN, { token: t })).statusCode, t).toBe(400);
    }
    expect((await call("POST", "/invitations/open", ORIGIN, { token: "short" })).statusCode).toBe(400);
    expect((await call("POST", "/invitations/open", ORIGIN, {})).statusCode).toBe(400);
    // A session cookie made up or altered is no session at all.
    expect((await call("GET", "/me", { ...ORIGIN, cookie: "__share=eyJ2IjoxfQ.forged", "x-bi-context": "shared" })).statusCode).toBe(401);
    // And nothing was accepted on the way.
    expect(await systemDb.membership.count({ where: { workspaceId: b.ws } })).toBe(1);
  });

  it("a shared-link cookie can't be used cross-site (CSRF), nor reach account endpoints", async () => {
    const b = await business();
    const { token } = await invite(b, "csrf2@example.com", ["analytics.sales"]);
    const tab = await openLink(token);
    const evil = { ...tab, origin: "https://evil.example" };
    expect((await call("POST", "/auth/logout", evil)).statusCode).toBe(403);
    for (const [method, url] of [["GET", "/auth/account"], ["POST", "/workspaces"], ["POST", "/auth/logout-all"]] as const) {
      const r = await call(method, url, tab, method === "POST" ? { name: "x" } : undefined);
      expect(r.statusCode, url).toBe(403);
      expect(r.json().error, url).toBe("shared_link");
    }
  });

  it("copies the same link again, replaces it on request, renews, and keeps an access history", async () => {
    const b = await business();
    const { token, invitationId } = await invite(b, "copy@example.com", ["analytics.sales"], "custom", { expiresInDays: 7 });
    // Copy: the very link the email carried, so it doesn't break the one already sent.
    const copied = ok(await call("POST", `/workspaces/${b.ws}/team/invitations/${invitationId}/link`, b.owner.headers));
    expect(tokenFrom(copied.url)).toBe(token);
    // Renew a pending one: same link, new end date.
    const renewed = ok(await call("POST", `/workspaces/${b.ws}/team/invitations/${invitationId}/renew`, b.owner.headers, {}));
    expect(Math.round((Date.parse(renewed.expiresAt) - Date.now()) / 86_400_000)).toBe(60);
    const tab = await openLink(token);
    // Replace: the old link stops opening it, the new one works; tabs already open carry on.
    const replaced = ok(await call("POST", `/workspaces/${b.ws}/team/invitations/${invitationId}/replace-link`, b.owner.headers));
    const fresh = tokenFrom(replaced.url)!;
    expect(fresh).not.toBe(token);
    expect((await call("POST", "/invitations/open", ORIGIN, { token })).statusCode).toBe(400);
    await openLink(fresh);
    ok(await overview(b, tab));
    // The history says what happened, and from where the link was opened.
    const m = await memberOf(b.ws, "copy@example.com");
    const { entries } = ok(await call("GET", `/workspaces/${b.ws}/team/history?memberId=${m.id}`, b.owner.headers));
    const actions = entries.map((e: { action: string }) => e.action);
    for (const a of ["member.invited", "member.invitation_link_copied", "member.invitation_renewed", "member.joined", "member.link_opened", "member.invitation_link_replaced"]) expect(actions, a).toContain(a);
    expect(entries.find((e: { action: string }) => e.action === "member.link_opened").actor).toBe("copy@example.com");
    // Only owners and admins see any of it.
    expect((await call("GET", `/workspaces/${b.ws}/team/history?memberId=${m.id}`, tab)).statusCode).toBe(403);
    expect((await call("POST", `/workspaces/${b.ws}/team/invitations/${invitationId}/link`, tab)).statusCode).toBe(403);
  });

  it("a resend creates no second invitation or grant, and a second invite replaces the first", async () => {
    const b = await business();
    const first = await invite(b, "twice@example.com", ["analytics.sales"]);
    ok(await call("POST", `/workspaces/${b.ws}/team/invitations/${first.invitationId}/resend`, b.owner.headers));
    ok(await call("POST", `/workspaces/${b.ws}/team/invitations/${first.invitationId}/resend`, b.owner.headers));
    expect(await systemDb.invitation.count({ where: { workspaceId: b.ws, email: "twice@example.com" } })).toBe(1);
    expect(ctx.mailer.sent.filter((m) => m.to === "twice@example.com").map((m) => tokenFrom(m.text))).toEqual([first.token, first.token, first.token]);
    const second = await invite(b, "twice@example.com", ["products.view"]);
    expect(second.replaced).toBe(1);
    expect((await call("POST", "/invitations/open", ORIGIN, { token: first.token })).statusCode).toBe(400);
    await openLink(second.token);
    await openLink(second.token);
    expect(await systemDb.membership.count({ where: { workspaceId: b.ws, user: { email: "twice@example.com" } } })).toBe(1);
    expect((await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email: "twice@example.com", role: "viewer", permissions: [] })).json().error).toBe("already_member");
  });

  it("reports delivery honestly: a busy provider is retried from the queue, a refusal says why, and the provider's events update it", async () => {
    const b = await business();
    // Busy twice (both attempts made while the owner waits), then queued for the email queue.
    ctx.mailer.fail.push(new MailError("Resend send failed (429 rate_limit_exceeded)", "resend", "transient", "rate_limit_exceeded"), new MailError("Resend unreachable", "resend", "transient", "network"));
    const r = await invite(b, "busy@example.com", ["analytics.sales"]).catch(() => null);
    expect(r).toBeNull(); // no email yet, so no token to read from one
    const inv = await systemDb.invitation.findFirstOrThrow({ where: { email: "busy@example.com" } });
    let d = await systemDb.emailDelivery.findFirstOrThrow({ where: { invitationId: inv.id } });
    expect(d).toMatchObject({ status: "queued", attempts: 2, errorCode: "network" });
    expect(ctx.deps.queues.sent.email).toEqual([{ kind: "team_invitation", deliveryId: d.id }]);
    let team = ok(await call("GET", `/workspaces/${b.ws}/team`, b.owner.headers));
    expect(team.rows.find((x: { email: string }) => x.email === "busy@example.com").delivery).toMatchObject({ status: "queued", attempts: 2 });
    // The queue's attempt goes through: now "sent", with the provider's id, the same link as stored.
    expect(await retryInvitationEmail(d.id, { mailer: ctx.mailer, queues: ctx.deps.queues })).toBe("sent");
    d = await systemDb.emailDelivery.findUniqueOrThrow({ where: { id: d.id } });
    expect(d).toMatchObject({ status: "sent", attempts: 3 });
    const sent = lastMailTo("busy@example.com")!;
    expect(sent.idempotencyKey).toBe(`delivery-${d.id}`);
    expect(sha256Hex(tokenFrom(sent.text)!)).toBe(inv.tokenHash);
    // "Sent" is not "delivered": only the provider's signed event says that.
    await systemDb.emailDelivery.update({ where: { id: d.id }, data: { provider: "resend", providerMessageId: "re_123" } });
    ctx.setEnv({ RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from("test-webhook-secret").toString("base64")}` });
    const post = (body: unknown, opts: { secret?: string; at?: number } = {}) => {
      const raw = JSON.stringify(body);
      const id = `msg_${Math.random().toString(36).slice(2)}`;
      const ts = String(opts.at ?? Math.floor(Date.now() / 1000));
      const sig = createHmac("sha256", Buffer.from(opts.secret ?? "test-webhook-secret")).update(`${id}.${ts}.${raw}`).digest("base64");
      return call("POST", "/webhooks/email/resend", { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` }, raw);
    };
    expect((await post({ type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: "re_123" } }, { secret: "wrong" })).statusCode).toBe(401);
    expect((await post({ type: "email.delivered", data: { email_id: "re_123" } }, { at: Math.floor(Date.now() / 1000) - 3600 })).statusCode).toBe(401);
    expect(ok(await post({ type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: "re_123" } }))).toMatchObject({ matched: true });
    team = ok(await call("GET", `/workspaces/${b.ws}/team`, b.owner.headers));
    expect(team.rows.find((x: { email: string }) => x.email === "busy@example.com").delivery.status).toBe("delivered");
    // A late "sent" changes nothing; a bounce after delivery is recorded, without the address.
    ok(await post({ type: "email.sent", data: { email_id: "re_123" } }));
    expect((await systemDb.emailDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("delivered");
    ok(await post({ type: "email.bounced", data: { email_id: "re_123", bounce: { type: "Permanent", subType: "General", message: "busy@example.com does not exist" } } }));
    d = await systemDb.emailDelivery.findUniqueOrThrow({ where: { id: d.id } });
    expect(d).toMatchObject({ status: "bounced", errorCode: "Permanent:General" });
    expect(d.errorMessage).not.toContain("busy@example.com");
    // Opens and clicks aren't tracked; unknown messages are acknowledged.
    expect(ok(await post({ type: "email.opened", data: { email_id: "re_123" } }))).toMatchObject({ ignored: true });
    expect(ok(await post({ type: "email.delivered", data: { email_id: "re_other" } }))).toMatchObject({ matched: false });
  });

  it("an invitation cancelled while its email waits in the queue is never sent", async () => {
    const b = await business();
    ctx.mailer.fail.push(new MailError("busy", "resend", "transient", "rate_limit_exceeded"), new MailError("busy", "resend", "transient", "rate_limit_exceeded"));
    ok(await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email: "later@example.com", role: "custom", permissions: ["analytics.sales"] }));
    const inv = await systemDb.invitation.findFirstOrThrow({ where: { email: "later@example.com" } });
    ok(await call("POST", `/workspaces/${b.ws}/team/invitations/${inv.id}/revoke`, b.owner.headers));
    const d = await systemDb.emailDelivery.findFirstOrThrow({ where: { invitationId: inv.id } });
    expect(await retryInvitationEmail(d.id, { mailer: ctx.mailer, queues: ctx.deps.queues })).toBe("failed");
    expect(ctx.mailer.sent.filter((m) => m.to === "later@example.com")).toHaveLength(0);
  });

  it("normal sign-in is unchanged: an account's session works as before, and its cookie is never the link's", async () => {
    const b = await business();
    const me = ok(await call("GET", "/me", b.owner.headers));
    expect(me.shared).toBeNull();
    expect(me.workspaces[0]).toMatchObject({ id: b.ws, role: "owner", status: "active" });
    expect(b.owner.headers.cookie).toContain("__session=");
    expect(b.owner.headers.cookie).not.toContain("__share=");
    ok(await overview(b, b.owner.headers));
    // Asking for the shared context with only an account session gets no session (never the account's).
    expect((await call("GET", "/me", { ...b.owner.headers, "x-bi-context": "shared" })).statusCode).toBe(401);
  });
});

describe("an owner or admin who leaves takes no working link along", () => {
  const open = (token: string) => call("POST", "/invitations/open", ORIGIN, { token });
  const copyLink = async (ws: string, invitationId: string, headers: Headers) => tokenFrom(ok(await call("POST", `/workspaces/${ws}/team/invitations/${invitationId}/link`, headers)).url)!;

  /** Owner O, admin M (signed in), viewer X who joined from O's link; M has copied X's link and invited m2@ as an admin. */
  async function teamWithAdmin() {
    const b = await business();
    const m = await inviteAndJoin(b, "m@example.com", "admin", []);
    ok(await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email: "x@example.com", role: "viewer", permissions: ["products.view"] }));
    const xToken = tokenFrom(lastMailTo("x@example.com")!.text)!;
    ok(await open(xToken));
    const xInvitation = await systemDb.invitation.findFirstOrThrow({ where: { workspaceId: b.ws, email: "x@example.com" } });
    const copied = await copyLink(b.ws, xInvitation.id, m.guest.headers);
    expect(copied).toBe(xToken);
    ok(await call("POST", `/workspaces/${b.ws}/team/invitations`, m.guest.headers, { email: "m2@example.com", role: "admin", permissions: [] }));
    const m2Token = tokenFrom(lastMailTo("m2@example.com")!.text)!;
    return { b, m, xInvitation, copied, m2Token };
  }

  /** Neither link M kept opens anything any more; X's access goes on, through a new link from an owner. */
  async function expectLinksRetired(t: Awaited<ReturnType<typeof teamWithAdmin>>) {
    expect((await open(t.copied)).statusCode).toBe(400);
    const m2 = await open(t.m2Token);
    expect(m2.statusCode).toBe(400);
    expect(m2.json().detail).toEqual({ status: "revoked" });
    expect(await systemDb.membership.count({ where: { workspaceId: t.b.ws, user: { email: "m2@example.com" } } })).toBe(0);
    const fresh = await copyLink(t.b.ws, t.xInvitation.id, t.b.owner.headers);
    expect(fresh).not.toBe(t.copied);
    ok(await open(fresh));
  }

  it("removing an admin cancels the invitations they sent and replaces the links they copied", async () => {
    const t = await teamWithAdmin();
    ok(await call("DELETE", `/workspaces/${t.b.ws}/team/members/${t.m.memberId}`, t.b.owner.headers));
    await expectLinksRetired(t);
    const entry = await systemDb.auditLog.findFirstOrThrow({ where: { workspaceId: t.b.ws, action: "member.removed" } });
    expect(entry.metadata).toMatchObject({ invitationsCancelled: 1, linksReplaced: 1, ownLinksEnded: 1 });
  });

  it("demoting an admin does the same; their own link keeps opening their own, smaller access", async () => {
    const t = await teamWithAdmin();
    // A change that leaves them an admin retires nothing.
    ok(await setAccess(t.b, t.m.memberId, "admin", []));
    ok(await open(t.copied));
    expect(ok(await call("POST", "/invitations/preview", {}, { token: t.m2Token })).status).toBe("pending");
    ok(await setAccess(t.b, t.m.memberId, "viewer", ["products.view"]));
    await expectLinksRetired(t);
    ok(await open(t.m.token));
    const entries = await systemDb.auditLog.findMany({ where: { workspaceId: t.b.ws, action: "member.access_changed" }, orderBy: { createdAt: "asc" } });
    expect(entries.map((e) => e.metadata)).toMatchObject([
      { invitationsCancelled: 0, linksReplaced: 0 },
      { invitationsCancelled: 1, linksReplaced: 1 },
    ]);
  });

  it("revoking an admin does the same; restoring them gives back their own link only", async () => {
    const t = await teamWithAdmin();
    ok(await call("POST", `/workspaces/${t.b.ws}/team/members/${t.m.memberId}/revoke`, t.b.owner.headers));
    await expectLinksRetired(t);
    expect((await open(t.m.token)).statusCode).toBe(400);
    ok(await call("POST", `/workspaces/${t.b.ws}/team/members/${t.m.memberId}/restore`, t.b.owner.headers));
    ok(await open(t.m.token));
    expect((await open(t.m2Token)).statusCode).toBe(400);
  });

  it("a removed member's old link stays dead when they are invited back", async () => {
    const b = await business();
    ok(await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email: "x@example.com", role: "viewer", permissions: ["products.view"] }));
    const first = tokenFrom(lastMailTo("x@example.com")!.text)!;
    ok(await open(first));
    const x = await systemDb.membership.findFirstOrThrow({ where: { workspaceId: b.ws, user: { email: "x@example.com" } } });
    ok(await call("DELETE", `/workspaces/${b.ws}/team/members/${x.id}`, b.owner.headers));
    ok(await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email: "x@example.com", role: "viewer", permissions: ["products.view"] }));
    const again = tokenFrom(lastMailTo("x@example.com")!.text)!;
    expect(again).not.toBe(first);
    ok(await open(again));
    expect((await open(first)).statusCode).toBe(400);
  });
});
