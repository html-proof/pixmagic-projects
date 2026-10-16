import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encryptTokenFields, normalizeRestOrder, pruneTeamRecords, recomputeDays, upsertOrder, type FetchLike } from "@app/core";
import { systemDb } from "@app/db";
import { LEGACY_GRANTS, sha256Hex } from "@app/shared";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";

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
    expect(mail.subject).toBe("You've been invited to access a business dashboard: Acme");
    expect(mail.text).toContain("has invited you to access the Acme business dashboard");
    expect(mail.text).toContain("Customer details");
    expect(mail.text).toContain("Here's the customer view we talked about.");
    expect(mail.text).toContain("If you weren't expecting this invitation, you can safely ignore this email.");
    expect(mail.html).toContain("Accept Invitation");
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
  it("works once, stops when cancelled, expires, and a resend replaces the old link", async () => {
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

    // Resent: a new link that works; the old one doesn't.
    const resent = ok(await call("POST", `/workspaces/${b.ws}/team/invitations/${late.id}/resend`, b.owner.headers));
    expect(resent.emailed).toBe(true);
    const freshToken = tokenFrom(lastMailTo("late@example.com")!.text)!;
    expect(freshToken).not.toBe(lateToken);
    expect(ok(await call("POST", "/invitations/preview", {}, { token: lateToken })).status).toBe("invalid");
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
    // Refunds per day need "View refunds".
    expect(header).toBe('"Day","Orders","Net sales","Average order value"');
    expect(res.body).toContain(`"${today}",1,100`);
    // A section they can't see stays closed even with the export permission.
    expect((await call("GET", `/workspaces/${b.ws}/stores/${b.store.id}/export?section=products`, guest.headers)).statusCode).toBe(403);
    expect(await systemDb.auditLog.count({ where: { workspaceId: b.ws, action: "report.exported" } })).toBe(1);
    // The owner's has the refunds column.
    const owners = await call("GET", url, b.owner.headers);
    expect(noBom(owners.body).split("\r\n")[0]).toBe('"Day","Orders","Net sales","Average order value","Refunds"');
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
      throw new Error("SES says no");
    };
    try {
      const r = ok(await call("POST", `/workspaces/${b.ws}/team/invitations`, b.owner.headers, { email: "bounce@example.com", role: "viewer", permissions: ["analytics.sales"] }));
      expect(r.emailed).toBe(false);
      expect(r.url).toMatch(/\/invite#token=[A-Za-z0-9_-]+$/);
      const row = await systemDb.invitation.findFirstOrThrow({ where: { email: "bounce@example.com" } });
      expect(row.sendFailedAt).not.toBeNull();
      expect(row.sendCount).toBe(0);
      // The handed-over link works.
      const token = tokenFrom(r.url)!;
      expect(ok(await call("POST", "/invitations/preview", {}, { token })).status).toBe("pending");
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
