import { z } from "zod";
import { systemDb, withTenant, type Store, type Subscription } from "@app/db";
import {
  APP_SUBSCRIPTION_CANCEL,
  APP_SUBSCRIPTION_CREATE,
  audit,
  billingEnabled,
  env,
  getAccessToken,
  logger,
  planById,
  PLANS,
  PRORATE_ON_CANCEL,
  purgeStoreData,
  SHOP_PARTNER_DEVELOPMENT,
  shopifyGraphql,
  syncBillingFromShopify,
} from "@app/core";
import { can, describeAlert, randomToken, ROLES, sha256Hex, type AlertArea, type AlertView } from "@app/shared";
import { STAFF_ROLES, staffAccess, staffCan } from "@app/shared/staff";
import { body, clientIp, HttpError, requireUser, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { seedResync } from "../sync.js";
import { limit, LIMITS } from "../rateLimit.js";

const roleSchema = z.enum(ROLES);
const staffRoleSchema = z.enum(STAFF_ROLES).nullable();
/** How long the bell keeps listing a note (an info alert), which nothing resolves. */
const ALERT_NOTE_DAYS = 7;

export function workspaceRoutes(app: App, deps: Deps) {
  // ---------------- Workspaces ----------------
  app.post("/workspaces", async (c) => {
    const user = await requireUser(c, deps);
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(await body(c));
    await limit(deps.coord, `rl:workspace:create:${user.id}`, LIMITS.workspaceCreate);
    const ws = await systemDb.$transaction(async (tx) => {
      const w = await tx.workspace.create({ data: { name } });
      await tx.membership.create({ data: { workspaceId: w.id, userId: user.id, role: "owner" } });
      await tx.subscription.create({ data: { workspaceId: w.id, plan: "free" } });
      return w;
    });
    await audit({ workspaceId: ws.id, actorUserId: user.id, action: "workspace.created", ip: clientIp(c) });
    return c.json({ workspace: { id: ws.id, name: ws.name, role: "owner" } });
  });

  app.patch("/workspaces/:ws", async (c) => {
    const { ws } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "members:manage");
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(await body(c));
    await withTenant(ws, (tx) => tx.workspace.update({ where: { id: ws }, data: { name } }));
    await audit({ workspaceId: ws, actorUserId: a.user?.id, action: "workspace.renamed", metadata: { name }, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  // ---------------- Members & invitations ----------------
  app.get("/workspaces/:ws/members", async (c) => {
    const { ws } = c.req.param();
    await requireWorkspace(c, deps, ws, "dashboard:read");
    return withTenant(ws, async (tx) => {
      const members = await tx.membership.findMany({ where: { workspaceId: ws }, include: { user: true }, orderBy: { createdAt: "asc" } });
      const invites = await tx.invitation.findMany({ where: { workspaceId: ws, acceptedAt: null, expiresAt: { gt: new Date() } } });
      return c.json({
        members: members.map((m) => ({ id: m.id, userId: m.userId, email: m.user.email, name: m.user.displayName, role: m.role, staffRole: m.staffRole })),
        invitations: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, staffRole: i.staffRole, expiresAt: i.expiresAt })),
      });
    });
  });

  app.post("/workspaces/:ws/invitations", async (c) => {
    const { ws } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "members:manage");
    const input = z.object({ email: z.string().email().max(254), role: roleSchema.exclude(["owner"]), staffRole: staffRoleSchema.optional() }).parse(await body(c));
    // Each invitation sends an email from our domain: don't let one workspace turn it into a spam
    // relay, nor one person with many workspaces.
    await limit(deps.coord, `rl:invite:${ws}`, LIMITS.invitations);
    if (a.user) await limit(deps.coord, `rl:invite-user:${a.user.id}`, LIMITS.invitationsPerUser);
    const token = randomToken(32);
    await withTenant(ws, (tx) =>
      tx.invitation.create({
        data: { workspaceId: ws, email: input.email.toLowerCase(), role: input.role, staffRole: input.staffRole ?? null, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 7 * 86400_000) },
      }),
    );
    // The invitation is already saved and the link is valid, so a mail failure must not fail
    // the request: EMAIL_FROM has to be on a domain verified in Amazon SES (out of the sandbox), and
    // when it isn't, every send throws. Losing the whole call there would leave an orphaned
    // invitation, skip the audit entry, and take away the only way to get someone into a
    // workspace. Hand the link back instead so the inviter can pass it on themselves.
    const url = `${env().APP_URL}/invite?token=${token}`;
    let emailed = true;
    try {
      await deps.mailer.send(input.email, "You've been invited", `Join the workspace: ${url}`);
    } catch (err) {
      emailed = false;
      logger.error({ err, workspaceId: ws }, "invitation email failed; returning the link to the inviter");
    }
    await audit({ workspaceId: ws, actorUserId: a.user?.id, action: "member.invited", metadata: { email: input.email, role: input.role, emailed }, ip: clientIp(c) });
    // Only ever to the member manager who just created it, and only when we couldn't send it.
    return c.json(emailed ? { ok: true, emailed } : { ok: true, emailed, url });
  });

  app.post("/invitations/accept", async (c) => {
    const user = await requireUser(c, deps);
    const { token } = z.object({ token: z.string().min(10) }).parse(await body(c));
    const inv = await systemDb.invitation.findUnique({ where: { tokenHash: sha256Hex(token) } });
    if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) throw new HttpError(400, "This invitation is no longer valid", "invalid_invite");
    if (inv.email !== user.email || !user.emailVerified) {
      throw new HttpError(403, "Sign in with the verified email address this invite was sent to", "invite_email_mismatch");
    }
    await systemDb.$transaction([
      systemDb.membership.upsert({
        where: { workspaceId_userId: { workspaceId: inv.workspaceId, userId: user.id } },
        create: { workspaceId: inv.workspaceId, userId: user.id, role: inv.role, staffRole: inv.staffRole },
        update: {},
      }),
      systemDb.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } }),
    ]);
    await audit({ workspaceId: inv.workspaceId, actorUserId: user.id, action: "member.joined", ip: clientIp(c) });
    return c.json({ workspaceId: inv.workspaceId });
  });

  app.patch("/workspaces/:ws/members/:memberId", async (c) => {
    const { ws, memberId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "members:manage");
    // `staffRole` (Staff Management: HR manager, payroll manager, supervisor) can change on its own.
    const input = z
      .object({ role: roleSchema.optional(), staffRole: staffRoleSchema.optional() })
      .refine((v) => v.role !== undefined || v.staffRole !== undefined, "Nothing to change")
      .parse(await body(c));
    const { role } = input;
    if (role === "owner" && a.role !== "owner") throw new HttpError(403, "Only owners can grant ownership", "forbidden");
    const keysRevoked = await withTenant(ws, async (tx) => {
      await lockOwners(tx, ws);
      const m = await tx.membership.findFirst({ where: { id: memberId, workspaceId: ws } });
      if (!m) throw new HttpError(404, "Not found", "not_found");
      if (m.role === "owner" && a.role !== "owner") throw new HttpError(403, "Only owners can change an owner", "forbidden");
      if (role && m.role === "owner" && role !== "owner") await assertAnotherOwner(tx, ws, m.id);
      await tx.membership.update({ where: { id: m.id }, data: { ...(role ? { role } : {}), ...(input.staffRole !== undefined ? { staffRole: input.staffRole } : {}) } });
      // Keys they made keep working after they can no longer manage keys: retire them with the role.
      return role && !can(role, "apikeys:manage") ? revokeKeysOf(tx, ws, m.userId) : 0;
    });
    await audit({ workspaceId: ws, actorUserId: a.user?.id, action: "member.role_changed", targetId: memberId, metadata: { role, staffRole: input.staffRole, keysRevoked }, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  app.delete("/workspaces/:ws/members/:memberId", async (c) => {
    const { ws, memberId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "members:manage");
    const keysRevoked = await withTenant(ws, async (tx) => {
      await lockOwners(tx, ws);
      const m = await tx.membership.findFirst({ where: { id: memberId, workspaceId: ws } });
      if (!m) throw new HttpError(404, "Not found", "not_found");
      if (m.role === "owner") {
        if (a.role !== "owner") throw new HttpError(403, "Only owners can remove an owner", "forbidden");
        await assertAnotherOwner(tx, ws, m.id);
      }
      await tx.membership.delete({ where: { id: m.id } });
      // An API key outlives its creator's membership otherwise (keys never expire).
      return revokeKeysOf(tx, ws, m.userId);
    });
    await audit({ workspaceId: ws, actorUserId: a.user?.id, action: "member.removed", targetId: memberId, metadata: { keysRevoked }, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  /** Withdraw an invitation that hasn't been accepted (one sent to the wrong address, or by someone since removed). */
  app.delete("/workspaces/:ws/invitations/:invitationId", async (c) => {
    const { ws, invitationId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "members:manage");
    const res = await withTenant(ws, (tx) => tx.invitation.deleteMany({ where: { id: invitationId, workspaceId: ws, acceptedAt: null } }));
    if (res.count === 0) throw new HttpError(404, "Not found", "not_found");
    await audit({ workspaceId: ws, actorUserId: a.user?.id, action: "member.invitation_revoked", targetId: invitationId, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  // ---------------- Stores ----------------
  app.post("/workspaces/:ws/stores/:storeId/resync", async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "stores:manage");
    const store = await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: storeId, workspaceId: ws, status: { not: "uninstalled" } } }));
    if (!store) throw new HttpError(404, "Not found", "not_found");
    // One refresh per store every 5 minutes is plenty (and keeps Shopify's rate limit for real work).
    await limit(deps.coord, `rl:resync:${store.id}`, LIMITS.resync, "A refresh is already under way. Try again in a few minutes.", "too_soon");
    const jobs = await seedResync(deps, store);
    await audit({ workspaceId: ws, actorUserId: a.user?.id, action: "store.resync", targetId: storeId, ip: clientIp(c) });
    return c.json({ ok: true, jobs: jobs.length });
  });

  app.delete("/workspaces/:ws/stores/:storeId", async (c) => {
    const { ws, storeId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "stores:manage");
    const store = await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: storeId, workspaceId: ws } }));
    if (!store) throw new HttpError(404, "Not found", "not_found");
    await systemDb.store.update({
      where: { id: store.id },
      data: { status: "uninstalled", uninstalledAt: new Date(), accessTokenEnc: null, refreshTokenEnc: null, grantedScopes: [] },
    });
    await purgeStoreData(store.id, deps.fetchImpl);
    await audit({ workspaceId: ws, actorUserId: a.user?.id, action: "store.disconnected", targetId: storeId, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  // ---------------- Notifications ----------------
  app.get("/workspaces/:ws/notifications", async (c) => {
    const { ws } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "dashboard:read");
    if (!a.user) throw new HttpError(403, "Session required", "forbidden");
    const pref = await withTenant(ws, (tx) =>
      tx.notificationPreference.findUnique({ where: { userId_workspaceId: { userId: a.user!.id, workspaceId: ws } } }),
    );
    return c.json({ preferences: pref ?? { syncFailures: true, weeklyDigest: false, productNews: false } });
  });

  app.put("/workspaces/:ws/notifications", async (c) => {
    const { ws } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "dashboard:read");
    if (!a.user) throw new HttpError(403, "Session required", "forbidden");
    const prefs = z.object({ syncFailures: z.boolean(), weeklyDigest: z.boolean(), productNews: z.boolean() }).parse(await body(c));
    await withTenant(ws, (tx) =>
      tx.notificationPreference.upsert({
        where: { userId_workspaceId: { userId: a.user!.id, workspaceId: ws } },
        create: { userId: a.user!.id, workspaceId: ws, ...prefs },
        update: prefs,
      }),
    );
    return c.json({ preferences: prefs });
  });

  // ---------------- API keys ----------------
  app.get("/workspaces/:ws/api-keys", async (c) => {
    const { ws } = c.req.param();
    await requireWorkspace(c, deps, ws, "apikeys:manage");
    const keys = await withTenant(ws, (tx) => tx.apiKey.findMany({ where: { workspaceId: ws }, orderBy: { createdAt: "desc" } }));
    const creators = await systemDb.user.findMany({ where: { id: { in: [...new Set(keys.map((k) => k.createdById).filter((id): id is string => !!id))] } }, select: { id: true, email: true } });
    const emailOf = new Map(creators.map((u) => [u.id, u.email]));
    return c.json({
      keys: keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, createdBy: (k.createdById && emailOf.get(k.createdById)) ?? null, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt })),
    });
  });

  app.post("/workspaces/:ws/api-keys", async (c) => {
    const { ws } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "apikeys:manage");
    if (!a.user) throw new HttpError(403, "Session required", "forbidden");
    const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(await body(c));
    await limit(deps.coord, `rl:apikey:create:${ws}`, LIMITS.apiKeyCreate);
    const secret = `sk_live_${randomToken(30)}`;
    const key = await withTenant(ws, (tx) =>
      tx.apiKey.create({ data: { workspaceId: ws, name, prefix: secret.slice(0, 14), keyHash: sha256Hex(secret), createdById: a.user!.id } }),
    );
    await audit({ workspaceId: ws, actorUserId: a.user.id, action: "apikey.created", targetId: key.id, ip: clientIp(c) });
    // Returned exactly once; only the hash is stored.
    return c.json({ key: { id: key.id, name, prefix: key.prefix }, secret });
  });

  app.delete("/workspaces/:ws/api-keys/:keyId", async (c) => {
    const { ws, keyId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "apikeys:manage");
    const res = await withTenant(ws, (tx) => tx.apiKey.updateMany({ where: { id: keyId, workspaceId: ws, revokedAt: null }, data: { revokedAt: new Date() } }));
    if (res.count === 0) throw new HttpError(404, "Not found", "not_found");
    await audit({ workspaceId: ws, actorUserId: a.user?.id, action: "apikey.revoked", targetId: keyId, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  // ---------------- Billing (Shopify Billing API, packages/core/src/billing.ts) ----------------
  app.get("/workspaces/:ws/billing", async (c) => {
    const { ws } = c.req.param();
    await requireWorkspace(c, deps, ws, "dashboard:read");
    const sub = await withTenant(ws, (tx) => tx.subscription.findUnique({ where: { workspaceId: ws } }));
    const { plan, status, pendingPlan } = sub ?? { plan: "free", status: "active", pendingPlan: null };
    // Where the charges appear, while there are any.
    const billed = sub && (sub.shopifyChargeId || sub.pendingChargeId) ? (await billedStores(ws, sub))[0] : undefined;
    const billedStore = billed ? { id: billed.id, shopDomain: billed.shopDomain, name: billed.name } : null;
    return c.json({ subscription: { plan, status, pendingPlan, billedStore }, plans: PLANS });
  });

  app.post("/workspaces/:ws/billing/subscribe", async (c) => {
    const { ws } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "billing:manage");
    const input = z.object({ plan: z.enum(["growth", "scale"]), storeId: z.string() }).parse(await body(c));
    // Until paid plans launch nothing may start a charge, whoever calls this.
    if (!billingEnabled()) throw new HttpError(403, "Paid plans aren't available yet", "billing_disabled");
    const plan = planById(input.plan);
    const sub = await withTenant(ws, (tx) => tx.subscription.findUnique({ where: { workspaceId: ws } }));
    if (sub?.shopifyChargeId && sub.plan === plan.id) throw new HttpError(409, `This workspace is already on ${plan.name}`, "already_on_plan");
    // While a charge is in force, the change goes on the same store's bill, where Shopify replaces
    // that charge once the new one is approved (APPLY_IMMEDIATELY). A charge on another store's
    // bill would run alongside it. Otherwise, the store the merchant has open.
    const billed = sub?.shopifyChargeId ? (await billedStores(ws, sub))[0] : undefined;
    const store = billed ?? (await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: input.storeId, workspaceId: ws, status: { not: "uninstalled" } } })));
    if (!store) throw new HttpError(400, "Connect a store first: plans are billed through Shopify", "store_required");
    const token = await getAccessToken(store, deps.coord, deps.fetchImpl);
    const call = <T>(query: string, variables?: Record<string, unknown>) =>
      shopifyGraphql<T>({ shop: store.shopDomain, accessToken: token, apiVersion: env().SHOPIFY_API_VERSION, query, variables, fetchImpl: deps.fetchImpl });
    // Shopify accepts only test charges from a development store (Shopify's reviewers use one), so
    // those are test charges in production too; nothing is billed for them.
    const { shop } = await call<{ shop: { plan: { partnerDevelopment: boolean } } }>(SHOP_PARTNER_DEVELOPMENT);
    const data = await call<{
      appSubscriptionCreate: { confirmationUrl: string | null; userErrors: Array<{ message: string }>; appSubscription: { id: string } | null };
    }>(APP_SUBSCRIPTION_CREATE, {
      name: `bizinsights ${plan.name}`,
      returnUrl: `${env().APP_URL}/settings/billing?confirmed=1`,
      amount: plan.priceUsd,
      currency: "USD",
      test: env().NODE_ENV !== "production" || shop.plan.partnerDevelopment,
    });
    const r = data.appSubscriptionCreate;
    if (r.userErrors.length || !r.confirmationUrl) throw new HttpError(400, r.userErrors.map((e) => e.message).join("; ") || "Billing failed", "billing_error");
    // Recorded as pending only: the plan in force changes when Shopify reports this charge active
    // (app_subscriptions/update). Writing it to `plan` here made an abandoned or declined approval
    // look like a plan the merchant had, and hid the button to try again.
    const pending = { pendingPlan: input.plan, pendingChargeId: r.appSubscription?.id ?? null, billingStoreId: store.id };
    await systemDb.subscription.upsert({ where: { workspaceId: ws }, create: { workspaceId: ws, plan: "free", status: "active", ...pending }, update: pending });
    await audit({ workspaceId: ws, actorUserId: a.user?.id, action: "billing.subscribe_started", metadata: { plan: input.plan, shop: store.shopDomain }, ip: clientIp(c) });
    return c.json({ confirmationUrl: r.confirmationUrl });
  });

  /**
   * Back to Free, from the app and with nobody's help (requirement 1.2.3): the charge in force is
   * cancelled in Shopify, crediting the unused days (PRORATE_ON_CANCEL), and the plan ends now.
   * Works whether or not paid plans are on sale. A change still awaiting approval stays: approving
   * it in Shopify is the merchant choosing that plan, and they then get it.
   */
  app.post("/workspaces/:ws/billing/cancel", async (c) => {
    const { ws } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "billing:manage");
    const sub = await withTenant(ws, (tx) => tx.subscription.findUnique({ where: { workspaceId: ws } }));
    const chargeId = sub?.shopifyChargeId;
    if (!sub || !chargeId) return c.json({ plan: "free" });
    const stores = await billedStores(ws, sub);
    // No store left to ask: uninstalling the one that paid cancelled the charge.
    let ended = stores.length === 0;
    let refused: string | null = null;
    for (const store of stores) {
      const token = await getAccessToken(store, deps.coord, deps.fetchImpl);
      const { appSubscriptionCancel: r } = await shopifyGraphql<{
        appSubscriptionCancel: { userErrors: Array<{ message: string }>; appSubscription: { id: string; status: string } | null };
      }>({
        shop: store.shopDomain,
        accessToken: token,
        apiVersion: env().SHOPIFY_API_VERSION,
        query: APP_SUBSCRIPTION_CANCEL,
        variables: { id: chargeId, prorate: PRORATE_ON_CANCEL },
        fetchImpl: deps.fetchImpl,
      });
      if (!r.userErrors.length) {
        // Anything but CANCELLED (Shopify only stopping the renewal) ends with its own webhook.
        ended = r.appSubscription?.status === "CANCELLED";
        refused = null;
        break;
      }
      refused = r.userErrors.map((e) => e.message).join("; ");
      // Over already (an uninstall, or a cancellation we haven't heard of yet)? Shopify says.
      if (store.id === sub.billingStoreId) {
        await syncBillingFromShopify(store, token, deps.fetchImpl);
        const now = await systemDb.subscription.findUnique({ where: { workspaceId: ws } });
        if (now?.shopifyChargeId !== chargeId) return c.json({ plan: now?.plan ?? "free" });
      }
    }
    if (refused) throw new HttpError(400, refused, "billing_error");
    if (ended) {
      const { count } = await systemDb.subscription.updateMany({ where: { workspaceId: ws, shopifyChargeId: chargeId }, data: { plan: "free", status: "active", shopifyChargeId: null } });
      if (count) await audit({ workspaceId: ws, actorUserId: a.user?.id, action: "billing.cancelled", metadata: { plan: sub.plan, prorate: PRORATE_ON_CANCEL }, ip: clientIp(c) });
    }
    const now = await systemDb.subscription.findUnique({ where: { workspaceId: ws } });
    return c.json({ plan: now?.plan ?? "free" });
  });

  // ---------------- Audit log & alerts ----------------
  app.get("/workspaces/:ws/audit-logs", async (c) => {
    const { ws } = c.req.param();
    await requireWorkspace(c, deps, ws, "audit:read");
    const { cursor } = z.object({ cursor: z.string().optional() }).parse(c.req.query());
    const rows = await withTenant(ws, (tx) =>
      tx.auditLog.findMany({
        where: { workspaceId: ws },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 51,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    );
    const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter(Boolean))] as string[];
    const actors = await systemDb.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } });
    const byId = new Map(actors.map((a) => [a.id, a.email]));
    return c.json({
      items: rows.slice(0, 50).map((r) => ({ id: r.id, action: r.action, actor: r.actorUserId ? byId.get(r.actorUserId) ?? null : null, targetType: r.targetType, targetId: r.targetId, metadata: r.metadata, createdAt: r.createdAt })),
      nextCursor: rows.length > 50 ? rows[49]!.id : null,
    });
  });

  // The bell's feed. Each alert is worded from its code (describeAlert): the stored message can end
  // with an error's own text, so it is never sent as is.
  app.get("/workspaces/:ws/alerts", async (c) => {
    const { ws } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "dashboard:read");
    const member = a.user ? await systemDb.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ws, userId: a.user.id } }, select: { staffRole: true } }) : null;
    const staff = staffAccess(a.role, member?.staffRole);
    const { problems, notes, stores } = await withTenant(ws, async (tx) => ({
      // Problems stay until whatever fixes them resolves them. Notes (info) are never resolved, so
      // only the last week's are listed, and apart, so a busy automation can't push problems out.
      problems: await tx.alert.findMany({ where: { workspaceId: ws, resolvedAt: null, severity: { not: "info" } }, orderBy: { createdAt: "desc" }, take: 20 }),
      notes: await tx.alert.findMany({
        where: { workspaceId: ws, resolvedAt: null, severity: "info", createdAt: { gt: new Date(Date.now() - ALERT_NOTE_DAYS * 86_400_000) } },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      stores: await tx.store.findMany({ where: { workspaceId: ws, status: { not: "uninstalled" } }, select: { id: true, name: true, shopDomain: true } }),
    }));
    const storeById = new Map(stores.map((s) => [s.id, { id: s.id, name: s.name ?? s.shopDomain }]));
    const mayFix = (area: AlertArea) => (area === "staff" ? staffCan(staff, "attendance:view") : area === "email" ? can(a.role, "email:read") : true);
    const alerts: AlertView[] = [];
    for (const row of [...problems, ...notes].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())) {
      // A store that has since been uninstalled or removed has nothing left to fix.
      const store = row.storeId ? storeById.get(row.storeId) : null;
      if (store === undefined) continue;
      const w = describeAlert(row);
      if (!mayFix(w.area)) continue;
      alerts.push({ id: row.id, ...w, store, createdAt: row.createdAt.toISOString() });
    }
    return c.json({ alerts });
  });
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * Serialize changes to a workspace's members: without it two owners demoting or removing each
 * other at the same moment both see "another owner remains" and leave the workspace with none.
 */
async function lockOwners(tx: Tx, ws: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`owners:${ws}`}))`;
}

async function revokeKeysOf(tx: Tx, ws: string, userId: string): Promise<number> {
  const r = await tx.apiKey.updateMany({ where: { workspaceId: ws, createdById: userId, revokedAt: null }, data: { revokedAt: new Date() } });
  return r.count;
}

async function assertAnotherOwner(tx: Parameters<Parameters<typeof withTenant>[1]>[0], ws: string, excludingMemberId: string) {
  const others = await tx.membership.count({ where: { workspaceId: ws, role: "owner", id: { not: excludingMemberId } } });
  if (others === 0) throw new HttpError(400, "A workspace needs at least one owner", "last_owner");
}

/**
 * The live store whose Shopify bill carries the workspace's charges. A charge recorded before that
 * was tracked has no store: then every live store of the workspace, to be tried in turn.
 */
async function billedStores(ws: string, sub: Pick<Subscription, "billingStoreId">): Promise<Store[]> {
  return withTenant(ws, (tx) =>
    tx.store.findMany({
      where: { workspaceId: ws, status: { not: "uninstalled" }, ...(sub.billingStoreId ? { id: sub.billingStoreId } : {}) },
      orderBy: { createdAt: "asc" },
    }),
  );
}
