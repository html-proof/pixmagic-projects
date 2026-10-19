import { z } from "zod";
import { withTenant } from "@app/db";
import {
  acceptTeamInvitation,
  ASSIGNABLE_ROLES,
  createTeamInvitation,
  INVITE_DAYS_DEFAULT,
  INVITE_DAYS_MAX,
  INVITE_MESSAGE_MAX,
  invitationForLink,
  invitationLink,
  loadMember,
  logger,
  loadTeam,
  previewTeamInvitation,
  queryTeam,
  recordLinkOpened,
  releaseUserAdGrants,
  removeMember,
  renewTeamAccess,
  replaceInvitationLink,
  resendTeamInvitation,
  restoreMember,
  revokeMember,
  revokeTeamInvitation,
  TEAM_SORTS,
  teamHistory,
  updateMemberAccess,
  updateTeamInvitation,
  type InviteMail,
  type TeamActor,
} from "@app/core";
import {
  ACCESS_CAPABILITY,
  ACCESS_KEYS,
  ACCESS_MODULE_INFO,
  ACCESS_MODULES,
  grantedKeys,
  hasFullAccess,
  modulesOf,
  permissionsOf,
  resolveCapabilities,
  RESTRICTED_ROLES,
  ROLE_INFO,
  ROLE_TEMPLATES,
  ROLES,
  roleAllowsKind,
} from "@app/shared";
import { STAFF_ROLE_HELP, STAFF_ROLE_LABEL, STAFF_ROLES, staffAccess } from "@app/shared/staff";
import { systemDb, type User } from "@app/db";
import { body, clientIp, requireAppOrigin, requireUser, requireWorkspace, type Ctx, type Deps, type WorkspaceAccess } from "../context.js";
import { newLinkSession, setShareCookie } from "../session.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * Team & Access: who may see a workspace and what of it (packages/shared/src/access.ts for the
 * permissions, packages/core/src/team for the rules). Managing the team needs `members:manage`
 * (owners and admins); every member can read their own access (GET .../access), which the web app
 * checks every few seconds and whenever a response's `x-access-fp` differs from what it has.
 */

const BASE = "/workspaces/:ws/team";
const idSchema = z.string().min(1).max(64);
const permissionsSchema = z.array(z.string().max(64)).max(ACCESS_KEYS.length * 2);
const staffRoleSchema = z.enum(STAFF_ROLES).nullable();
const accessSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES),
  permissions: permissionsSchema.default([]),
  staffRole: staffRoleSchema.optional(),
});

export const teamActor = (c: Ctx, a: WorkspaceAccess): TeamActor => ({ workspaceId: a.workspaceId, userId: a.user!.id, role: a.role, ip: clientIp(c) });

/** The mail provider, and the email queue that retries an invitation email after a transient failure. */
const inviteMail = (deps: Deps): InviteMail => ({ mailer: deps.mailer, queues: deps.queues });

const daysSchema = z.object({ days: z.number().int().min(1).max(INVITE_DAYS_MAX).optional() });

/**
 * Each invitation sends an email from our domain: don't let one workspace turn it into a spam
 * relay, nor one person with many workspaces.
 */
export async function inviteLimits(deps: Deps, ws: string, userId: string | undefined) {
  await limit(deps.coord, `rl:invite:${ws}`, LIMITS.invitations, "That's a lot of invitations in a short time. Please wait a while before sending more.");
  if (userId) await limit(deps.coord, `rl:invite-user:${userId}`, LIMITS.invitationsPerUser, "You've sent the most invitations allowed in a day. Please try again tomorrow.");
}

/**
 * Remove a member, and stop their login powering this workspace's ad data: the ad connections they
 * connected here wait for someone else to reconnect them (keeping their days; "connector_left"), and
 * their grant goes back to Google or Meta unless something else relies on it (within
 * AD_RELEASE_REVOKE_BUDGET_MS: a platform that doesn't answer leaves the grant, not the request hanging).
 * The member is removed whatever happens to the ad connections.
 */
export async function removeMemberReleasingAds(c: Ctx, deps: Deps, a: WorkspaceAccess, memberId: string, opts: { allowSelf?: boolean } = {}) {
  const { userId } = await loadMember(a.workspaceId, memberId);
  const removed = await removeMember(teamActor(c, a), memberId, opts);
  await releaseUserAdGrants(userId, a.workspaceId, deps.fetchImpl).catch((err: unknown) => logger.error({ err, workspaceId: a.workspaceId, userId }, "a removed member's ad connections weren't released"));
  return removed;
}

/** A team change needs a person (not an API key) who may manage members. */
async function requireTeamManager(c: Ctx, deps: Deps, ws: string) {
  const a = await requireWorkspace(c, deps, ws, "members:manage");
  await limit(deps.coord, `rl:team:${a.user!.id}`, LIMITS.teamChanges);
  return a;
}

/**
 * The answer to a request carrying an Idempotency-Key the same person already used for the same
 * action in the last 10 minutes: a retried "Send invitation" (a dropped connection, a double click)
 * gets the first answer back instead of sending a second email.
 */
async function once<T>(c: Ctx, deps: Deps, scope: string, run: () => Promise<T>): Promise<T> {
  const key = c.req.header("idempotency-key")?.trim();
  if (!key || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) return run();
  const slot = `idem:${scope}:${key}`;
  const seen = await deps.coord.peek(slot).catch(() => null);
  if (seen) return JSON.parse(seen) as T;
  const result = await run();
  // An answer carrying an invitation link is never kept: the link is as good as the invitation.
  if (!(typeof result === "object" && result !== null && "url" in result)) await deps.coord.put(slot, JSON.stringify(result), 600).catch(() => {});
  return result;
}

export function teamRoutes(app: App, deps: Deps) {
  // ---------------- One's own access ----------------

  /**
   * What the signed-in member may see and do here. Answers 304 to `If-None-Match: "<fingerprint>"`
   * while nothing changed, so the web app can ask often for almost nothing. A revoked member gets
   * 403 `access_revoked` (requireWorkspace).
   */
  app.get("/workspaces/:ws/access", async (c) => {
    const { ws } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "dashboard:read");
    // The same fingerprint every response's x-access-fp carries (a link session's is its read-only access's).
    const fingerprint = a.fingerprint!;
    const etag = `"${fingerprint}"`;
    c.header("etag", etag);
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    const staff = a.staff ?? staffAccess(a.access.role, a.staffRole, a.access.permissions);
    return c.json({
      workspaceId: ws,
      role: a.access.role,
      fullAccess: hasFullAccess(a.access.role),
      permissions: [...grantedKeys(a.access)],
      modules: modulesOf(a.access),
      staffRole: a.staffRole,
      staff: { permissions: staff.permissions, scope: staff.scope },
      fingerprint,
      // Opened from a shared link: view-only, whatever the membership allows.
      readOnly: !!a.link,
    });
  });

  // ---------------- The team ----------------

  app.get(BASE, async (c) => {
    const { ws } = c.req.param();
    await requireWorkspace(c, deps, ws, "members:manage");
    const q = z
      .object({
        q: z.string().max(100).optional(),
        status: z.enum(["active", "revoked", "pending", "expired", "cancelled", "members", "invitations"]).optional(),
        role: z.enum(ROLES).optional(),
        sort: z.enum(TEAM_SORTS).optional(),
        dir: z.enum(["asc", "desc"]).optional(),
        page: z.coerce.number().int().min(1).max(10_000).optional(),
        pageSize: z.coerce.number().int().min(1).max(100).optional(),
      })
      .parse(c.req.query());
    const { rows, summary } = await loadTeam(ws);
    return c.json({ summary, ...queryTeam(rows, q) });
  });

  /**
   * Everything the invitation panel offers: the modules and their permissions, the roles and what
   * each ticks to start with, and which permissions show nothing yet because no connected store
   * has granted bizinsights that data in Shopify.
   */
  app.get(`${BASE}/catalog`, async (c) => {
    const { ws } = c.req.param();
    const a = await requireWorkspace(c, deps, ws, "members:manage");
    const stores = await withTenant(ws, (tx) => tx.store.findMany({ where: { workspaceId: ws, status: { not: "uninstalled" } }, select: { grantedScopes: true, pixelInstalled: true } }));
    const granted = new Set<string>(stores.flatMap((s) => resolveCapabilities(s.grantedScopes, { pixelInstalled: s.pixelInstalled }).filter((cap) => cap.enabled).map((cap) => cap.id)));
    return c.json({
      modules: ACCESS_MODULES.map((m) => ({
        id: m,
        ...ACCESS_MODULE_INFO[m],
        permissions: permissionsOf(m).map((p) => {
          const capability = ACCESS_CAPABILITY[p.key];
          return { ...p, available: !capability || granted.has(capability) };
        }),
      })),
      roles: [
        ...(a.role === "owner" || a.role === "admin" ? [{ id: "admin", ...ROLE_INFO.admin, template: [...ACCESS_KEYS], restricted: false, canManage: true }] : []),
        ...RESTRICTED_ROLES.map((r) => ({ id: r, ...ROLE_INFO[r], template: ROLE_TEMPLATES[r], restricted: true, canManage: roleAllowsKind(r, "manage") })),
      ],
      staffRoles: STAFF_ROLES.map((r) => ({ id: r, label: STAFF_ROLE_LABEL[r], description: STAFF_ROLE_HELP[r] })),
      limits: { messageMax: INVITE_MESSAGE_MAX, expiryDaysMax: INVITE_DAYS_MAX, expiryDaysDefault: INVITE_DAYS_DEFAULT },
      hasStore: stores.length > 0,
    });
  });

  app.get(`${BASE}/members/:id`, async (c) => {
    const { ws, id } = c.req.param();
    await requireWorkspace(c, deps, ws, "members:manage");
    return c.json({ member: await loadMember(ws, idSchema.parse(id)) });
  });

  /** Set a member's role and permissions together. `basedOn`: the fingerprint the editor started from. */
  app.patch(`${BASE}/members/:id`, async (c) => {
    const { ws, id } = c.req.param();
    const a = await requireTeamManager(c, deps, ws);
    const input = accessSchema.extend({ role: z.enum([...ASSIGNABLE_ROLES, "owner"]), basedOn: z.string().max(64).optional() }).parse(await body(c));
    const r = await updateMemberAccess(teamActor(c, a), idSchema.parse(id), input);
    return c.json({ ok: true, ...r });
  });

  app.post(`${BASE}/members/:id/revoke`, async (c) => {
    const { ws, id } = c.req.param();
    const a = await requireTeamManager(c, deps, ws);
    return c.json({ ok: true, ...(await revokeMember(teamActor(c, a), idSchema.parse(id))) });
  });

  app.post(`${BASE}/members/:id/restore`, async (c) => {
    const { ws, id } = c.req.param();
    const a = await requireTeamManager(c, deps, ws);
    await restoreMember(teamActor(c, a), idSchema.parse(id));
    return c.json({ ok: true });
  });

  app.delete(`${BASE}/members/:id`, async (c) => {
    const { ws, id } = c.req.param();
    const a = await requireTeamManager(c, deps, ws);
    return c.json({ ok: true, ...(await removeMemberReleasingAds(c, deps, a, idSchema.parse(id))) });
  });

  /** Renew the access an invitation gave a member, and their link, for `days` (default 60) from now. */
  app.post(`${BASE}/members/:id/renew`, async (c) => {
    const { ws, id } = c.req.param();
    const a = await requireTeamManager(c, deps, ws);
    const { days } = daysSchema.parse(await body(c));
    const r = await renewTeamAccess(teamActor(c, a), { memberId: idSchema.parse(id) }, days);
    return c.json({ ok: true, expiresAt: r.expiresAt.toISOString() });
  });

  /** One person's access history (audit entries for their membership and invitations, link openings included). */
  app.get(`${BASE}/history`, async (c) => {
    const { ws } = c.req.param();
    await requireWorkspace(c, deps, ws, "members:manage");
    const q = z.object({ invitationId: idSchema.optional(), memberId: idSchema.optional() }).refine((v) => v.invitationId || v.memberId, "Say whose history").parse(c.req.query());
    return c.json({ entries: await teamHistory(ws, q) });
  });

  // ---------------- Invitations ----------------

  app.post(`${BASE}/invitations`, async (c) => {
    const { ws } = c.req.param();
    const a = await requireTeamManager(c, deps, ws);
    const input = accessSchema
      .extend({
        email: z.string().trim().email("Enter a valid email address").max(254),
        message: z.string().max(INVITE_MESSAGE_MAX * 2).nullable().optional(),
        expiresInDays: z.number().int().min(1).max(INVITE_DAYS_MAX).optional(),
      })
      .parse(await body(c));
    const r = await once(c, deps, `invite:${ws}:${a.user!.id}`, async () => {
      await inviteLimits(deps, ws, a.user!.id);
      const out = await createTeamInvitation(teamActor(c, a), input, inviteMail(deps));
      // The link only to the owner or admin who just made it, and only when the email didn't go out.
      return {
        ok: true,
        invitationId: out.invitationId,
        emailed: out.emailed,
        delivery: out.delivery,
        ...(out.url ? { url: out.url, emailProblem: out.emailProblem } : {}),
        replaced: out.replaced,
        expiresAt: out.expiresAt.toISOString(),
      };
    });
    return c.json(r);
  });

  app.patch(`${BASE}/invitations/:id`, async (c) => {
    const { ws, id } = c.req.param();
    const a = await requireTeamManager(c, deps, ws);
    await updateTeamInvitation(teamActor(c, a), idSchema.parse(id), accessSchema.parse(await body(c)));
    return c.json({ ok: true });
  });

  app.post(`${BASE}/invitations/:id/resend`, async (c) => {
    const { ws, id } = c.req.param();
    const a = await requireTeamManager(c, deps, ws);
    const invitationId = idSchema.parse(id);
    const r = await once(c, deps, `resend:${ws}:${invitationId}`, async () => {
      await limit(deps.coord, `rl:invite-resend:${invitationId}`, LIMITS.invitationResend, "This invitation was sent several times in the last hour. Please wait before sending it again.");
      await inviteLimits(deps, ws, a.user!.id);
      const out = await resendTeamInvitation(teamActor(c, a), invitationId, inviteMail(deps));
      return { ok: true, emailed: out.emailed, delivery: out.delivery, ...(out.url ? { url: out.url, emailProblem: out.emailProblem } : {}), expiresAt: out.expiresAt.toISOString() };
    });
    return c.json(r);
  });

  app.post(`${BASE}/invitations/:id/revoke`, async (c) => {
    const { ws, id } = c.req.param();
    const a = await requireTeamManager(c, deps, ws);
    await revokeTeamInvitation(teamActor(c, a), idSchema.parse(id));
    return c.json({ ok: true });
  });

  /**
   * The invitation's link, to copy and pass on (a POST, so nothing caches or prefetches it). The
   * same link the email carried: copying it doesn't stop the one already sent from working.
   */
  app.post(`${BASE}/invitations/:id/link`, async (c) => {
    const { ws, id } = c.req.param();
    const a = await requireTeamManager(c, deps, ws);
    const r = await invitationLink(teamActor(c, a), idSchema.parse(id));
    return c.json({ ok: true, url: r.url, expiresAt: r.expiresAt.toISOString() });
  });

  /** A new link for the invitation: the old one stops opening the dashboard at once. */
  app.post(`${BASE}/invitations/:id/replace-link`, async (c) => {
    const { ws, id } = c.req.param();
    const a = await requireTeamManager(c, deps, ws);
    const r = await replaceInvitationLink(teamActor(c, a), idSchema.parse(id));
    return c.json({ ok: true, url: r.url, expiresAt: r.expiresAt.toISOString() });
  });

  /** Renew an invitation not yet opened (pending or expired) for `days` (default 60) from now. Its link stays the same. */
  app.post(`${BASE}/invitations/:id/renew`, async (c) => {
    const { ws, id } = c.req.param();
    const a = await requireTeamManager(c, deps, ws);
    const { days } = daysSchema.parse(await body(c));
    const r = await renewTeamAccess(teamActor(c, a), { invitationId: idSchema.parse(id) }, days);
    return c.json({ ok: true, expiresAt: r.expiresAt.toISOString() });
  });

  // ---------------- The invitee's side ----------------

  const tokenSchema = z.object({ token: z.string().min(10).max(200) });

  /** What the invitation page shows before anyone signs in. The token travels in the body, never the URL. */
  app.post("/invitations/preview", async (c) => {
    await limit(deps.coord, `rl:invite-preview:${clientIp(c)}`, LIMITS.invitePreviewIp);
    const { token } = tokenSchema.parse(await body(c));
    return c.json(await previewTeamInvitation(token));
  });

  /**
   * Opening an invitation link: the link is the invitee's way in, with no account, password or
   * sign-up. The invitation page calls this as soon as it opens.
   *
   * This browser gets a shared-link session (session.ts newLinkSession) in a cookie of its own
   * (__share): that workspace only, view-only, ending with the link. It never replaces or touches
   * an account signed in on the same browser, and never borrows anything from it: a forwarded link
   * exposes no more than the invitation itself, and someone with a bizinsights account of their
   * own keeps it, signed in, in their other tabs. The first opening accepts the invitation; a user
   * record is made for an address new to us (signing up later with that address links to it).
   *
   * The link keeps working (another device, a session that ended) until the invitation's end date,
   * while the member's access lasts. Opening it makes a session, so only from our own pages (login
   * CSRF). Email scanners that open links don't use it up: nothing about it is single-use.
   */
  const openSchema = tokenSchema.extend({ switch: z.boolean().optional() });
  app.post("/invitations/open", async (c) => {
    requireAppOrigin(c);
    await limit(deps.coord, `rl:invite-open:${clientIp(c)}`, LIMITS.inviteAcceptIp);
    const { token } = openSchema.parse(await body(c));
    const inv = await invitationForLink(token);
    if (!inv) return c.json({ error: "invalid_invite", message: "This invitation link isn't valid. Check you opened the whole link, or ask for a new invitation." }, 400);
    if (inv.status !== "pending" && !inv.reopenUserId) {
      return c.json({ error: "invalid_invite", message: "This invitation can no longer be used.", detail: { status: inv.status } }, 400);
    }
    await limit(deps.coord, `rl:invite-open:${inv.id}`, LIMITS.inviteAcceptUser);

    const user = inv.reopenUserId ? await systemDb.user.findUniqueOrThrow({ where: { id: inv.reopenUserId } }) : await userForInvitee(inv.email);
    if (inv.status === "pending") await acceptTeamInvitation(user, token, clientIp(c), { viaLink: true });
    const m = await systemDb.membership.findUnique({ where: { workspaceId_userId: { workspaceId: inv.workspaceId, userId: user.id } }, select: { accessExpiresAt: true } });
    const ends = [inv.expiresAt, m?.accessExpiresAt].filter((d): d is Date => !!d).sort((x, y) => x.getTime() - y.getTime())[0] ?? null;
    setShareCookie(c, newLinkSession({ userId: user.id, workspaceId: inv.workspaceId, until: ends }));
    await recordLinkOpened(inv, user.id, clientIp(c));
    logger.info({ event: "session_created", userId: user.id, workspaceId: inv.workspaceId, method: "invitation_link", reopened: inv.status !== "pending", ip: clientIp(c) }, "opened from an invitation link");
    return c.json({ workspaceId: inv.workspaceId, signedIn: true, shared: true, expiresAt: ends?.toISOString() ?? null });
  });

  app.post("/invitations/accept", async (c) => {
    const user = await requireUser(c, deps);
    await limit(deps.coord, `rl:invite-accept:${clientIp(c)}`, LIMITS.inviteAcceptIp);
    await limit(deps.coord, `rl:invite-accept-user:${user.id}`, LIMITS.inviteAcceptUser);
    const { token } = tokenSchema.parse(await body(c));
    return c.json(await acceptTeamInvitation(user, token, clientIp(c)));
  });
}

/**
 * The user an invitation link signs in for an address: theirs if we know it, else a new one with no
 * sign-in of its own yet (signing up or in with Google later, with this address verified, links to
 * it: identity.ts resolveUser).
 */
async function userForInvitee(email: string): Promise<User> {
  const known = await systemDb.user.findUnique({ where: { email } });
  if (known) return known;
  try {
    return await systemDb.user.create({ data: { email, emailVerified: false } });
  } catch (err) {
    // Opened twice at once: the other request made it.
    if ((err as { code?: string })?.code === "P2002") return systemDb.user.findUniqueOrThrow({ where: { email } });
    throw err;
  }
}
