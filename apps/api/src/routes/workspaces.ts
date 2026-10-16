import { z } from "zod";
import { systemDb, withTenant } from "@app/db";
import {
  APP_SUBSCRIPTION_CREATE,
  audit,
  createTeamInvitation,
  env,
  getAccessToken,
  loadMember,
  loadTeam,
  purgeStoreData,
  removeMember,
  revokeTeamInvitation,
  shopifyGraphql,
  updateMemberAccess,
} from "@app/core";
import { allows, describeAlert, hasFullAccess, LEGACY_GRANTS, randomToken, ROLES, sha256Hex, type AlertArea, type AlertView } from "@app/shared";
import { STAFF_ROLES, staffAccess, staffCan } from "@app/shared/staff";
import { body, clientIp, HttpError, requireFullAccess, requireUser, requireWorkspace, type Deps } from "../context.js";
import { inviteLimits, teamActor } from "./team.js";
import type { App } from "../app.js";
import { seedResync } from "../sync.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * Shown on the billing page, which is a page Shopify's reviewer sees — so these strings are
 * part of what the app advertises, and every one of them has to be something the app actually
 * does under the scopes it declares. "Funnel insights" was listed here and is NOT one of them:
 * the funnel needs `write_pixels` and `read_customer_events`, which are protected customer data
 * and deliberately undeclared (shopify-app/shopify.app.toml). Advertising it would fail review.
 * Re-add it only alongside those scopes.
 */
export const PLANS = [
  { id: "free", name: "Free", priceUsd: 0, features: ["1 store", "30 days of history", "Core metrics"] },
  { id: "growth", name: "Growth", priceUsd: 29, features: ["3 stores", "Email alerts", "API access"] },
  { id: "scale", name: "Scale", priceUsd: 99, features: ["Unlimited stores", "Priority support", "Audit log export"] },
] as const;

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

  // ---------------- Members & invitations (the endpoints from before Team & Access) ----------------
  // Kept for API clients and older pages; the Team & Access page uses routes/team.ts. They go through
  // the same core functions, so the same rules apply. Analysts and viewers invited or set here get
  // what those roles could see before Team & Access (LEGACY_GRANTS).
  app.get("/workspaces/:ws/members", async (c) => {
    const { ws } = c.req.param();
    await requireWorkspace(c, deps, ws, "members:manage");
    const { rows } = await loadTeam(ws);
    return c.json({
      members: rows.filter((r) => r.kind === "member").map((m) => ({ id: m.id, userId: m.userId, email: m.email, name: m.name, role: m.role, staffRole: m.staffRole, status: m.status })),
      invitations: rows.filter((r) => r.kind === "invitation" && r.status === "pending").map((i) => ({ id: i.id, email: i.email, role: i.role, staffRole: i.staffRole, expiresAt: i.expiresAt })),
    });
  });

  app.post("/workspaces/:ws/invitations", async (c) => {
    const { ws } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "members:manage");
    const input = z.object({ email: z.string().email().max(254), role: z.enum(["admin", "analyst", "viewer"]), staffRole: staffRoleSchema.optional() }).parse(await body(c));
    await inviteLimits(deps, ws, a.user?.id);
    const r = await createTeamInvitation(teamActor(c, a), { email: input.email, role: input.role, permissions: input.role === "admin" ? [] : LEGACY_GRANTS[input.role], staffRole: input.staffRole ?? null }, deps.mailer);
    // Only ever to the member manager who just created it, and only when we couldn't send it.
    return c.json(r.emailed ? { ok: true, emailed: true } : { ok: true, emailed: false, url: r.url });
  });

  app.patch("/workspaces/:ws/members/:memberId", async (c) => {
    const { ws, memberId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "members:manage");
    // `staffRole` (Staff Management: HR manager, payroll manager, supervisor) can change on its own.
    const input = z
      .object({ role: roleSchema.optional(), staffRole: staffRoleSchema.optional() })
      .refine((v) => v.role !== undefined || v.staffRole !== undefined, "Nothing to change")
      .parse(await body(c));
    const current = await loadMember(ws, memberId);
    const role = input.role ?? current.role;
    // A new role brings that role's old access; the same role keeps the permissions it has.
    const permissions = hasFullAccess(role) ? [] : role === current.role ? (hasFullAccess(current.role) ? [] : current.permissions) : role === "analyst" || role === "viewer" ? LEGACY_GRANTS[role] : [];
    await updateMemberAccess(teamActor(c, a), memberId, { role, permissions, ...(input.staffRole !== undefined ? { staffRole: input.staffRole } : {}), allowSelf: true });
    return c.json({ ok: true });
  });

  app.delete("/workspaces/:ws/members/:memberId", async (c) => {
    const { ws, memberId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "members:manage");
    await removeMember(teamActor(c, a), memberId, { allowSelf: true });
    return c.json({ ok: true });
  });

  /** Withdraw an invitation that hasn't been accepted (one sent to the wrong address, or by someone since removed). */
  app.delete("/workspaces/:ws/invitations/:invitationId", async (c) => {
    const { ws, invitationId } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "members:manage");
    await revokeTeamInvitation(teamActor(c, a), invitationId);
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

  // ---------------- Billing (Shopify Billing API) ----------------
  app.get("/workspaces/:ws/billing", async (c) => {
    const { ws } = c.req.param();
    requireFullAccess(await requireWorkspace(c, deps, ws, "dashboard:read"));
    const sub = await withTenant(ws, (tx) => tx.subscription.findUnique({ where: { workspaceId: ws } }));
    const { plan, status, pendingPlan } = sub ?? { plan: "free", status: "active", pendingPlan: null };
    return c.json({ subscription: { plan, status, pendingPlan }, plans: PLANS });
  });

  app.post("/workspaces/:ws/billing/subscribe", async (c) => {
    const { ws } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "billing:manage");
    const input = z.object({ plan: z.enum(["growth", "scale"]), storeId: z.string() }).parse(await body(c));
    const plan = PLANS.find((p) => p.id === input.plan)!;
    const store = await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: input.storeId, workspaceId: ws, status: { not: "uninstalled" } } }));
    if (!store) throw new HttpError(400, "Connect a store first: plans are billed through Shopify", "store_required");
    const token = await getAccessToken(store, deps.coord, deps.fetchImpl);
    const data = await shopifyGraphql<{
      appSubscriptionCreate: { confirmationUrl: string | null; userErrors: Array<{ message: string }>; appSubscription: { id: string } | null };
    }>({
      shop: store.shopDomain,
      accessToken: token,
      apiVersion: env().SHOPIFY_API_VERSION,
      query: APP_SUBSCRIPTION_CREATE,
      variables: {
        name: `bizinsights ${plan.name}`,
        returnUrl: `${env().APP_URL}/settings/billing?confirmed=1`,
        amount: plan.priceUsd,
        currency: "USD",
        test: env().NODE_ENV !== "production",
      },
      fetchImpl: deps.fetchImpl,
    });
    const r = data.appSubscriptionCreate;
    if (r.userErrors.length || !r.confirmationUrl) throw new HttpError(400, r.userErrors.map((e) => e.message).join("; ") || "Billing failed", "billing_error");
    // Recorded as pending only: the plan in force changes when Shopify reports this charge active
    // (app_subscriptions/update). Writing it to `plan` here made an abandoned or declined approval
    // look like a plan the merchant had, and hid the button to try again.
    await systemDb.subscription.upsert({
      where: { workspaceId: ws },
      create: { workspaceId: ws, plan: "free", status: "active", pendingPlan: input.plan, pendingChargeId: r.appSubscription?.id ?? null },
      update: { pendingPlan: input.plan, pendingChargeId: r.appSubscription?.id ?? null },
    });
    await audit({ workspaceId: ws, actorUserId: a.user?.id, action: "billing.subscribe_started", metadata: { plan: input.plan }, ip: clientIp(c) });
    return c.json({ confirmationUrl: r.confirmationUrl });
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
    const staff = staffAccess(a.role, a.staffRole, a.access.permissions);
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
    // Only what this person can open and fix. Settings → Privacy requests needs audit:read
    // (routes/privacy.ts); the Shopify connection and the help page's alerts go to owners and admins.
    const mayFix = (area: AlertArea) =>
      area === "staff"
        ? staffCan(staff, "attendance:view")
        : area === "email"
          ? allows(a.access, "email:read")
          : area === "privacy"
            ? allows(a.access, "audit:read")
            : area === "whatsapp"
              ? allows(a.access, "marketing.campaigns")
              : hasFullAccess(a.access.role);
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
