import { z } from "zod";
import { withTenant } from "@app/db";
import {
  acceptTeamInvitation,
  accessFingerprint,
  ASSIGNABLE_ROLES,
  createTeamInvitation,
  INVITE_DAYS_MAX,
  INVITE_MESSAGE_MAX,
  invitationForLink,
  loadMember,
  logger,
  loadTeam,
  previewTeamInvitation,
  queryTeam,
  removeMember,
  resendTeamInvitation,
  restoreMember,
  revokeMember,
  revokeTeamInvitation,
  TEAM_SORTS,
  updateMemberAccess,
  TeamError,
  updateTeamInvitation,
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
import { systemDb } from "@app/db";
import { body, clientIp, HttpError, loadUser, requireAppOrigin, requireUser, requireWorkspace, type Ctx, type Deps, type WorkspaceAccess } from "../context.js";
import { CognitoError, CognitoUnavailableError, unguessablePassword } from "../cognito.js";
import { resolveUser } from "../identity.js";
import { newSession, setSessionCookies } from "../session.js";
import { cognitoFailure } from "./auth.js";
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

/**
 * Each invitation sends an email from our domain: don't let one workspace turn it into a spam
 * relay, nor one person with many workspaces.
 */
export async function inviteLimits(deps: Deps, ws: string, userId: string | undefined) {
  await limit(deps.coord, `rl:invite:${ws}`, LIMITS.invitations, "That's a lot of invitations in a short time. Please wait a while before sending more.");
  if (userId) await limit(deps.coord, `rl:invite-user:${userId}`, LIMITS.invitationsPerUser, "You've sent the most invitations allowed in a day. Please try again tomorrow.");
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
    const fingerprint = accessFingerprint({ role: a.access.role, permissions: a.access.permissions, staffRole: a.staffRole, revokedAt: null });
    const etag = `"${fingerprint}"`;
    c.header("etag", etag);
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    const staff = staffAccess(a.access.role, a.staffRole, a.access.permissions);
    return c.json({
      workspaceId: ws,
      role: a.access.role,
      fullAccess: hasFullAccess(a.access.role),
      permissions: [...grantedKeys(a.access)],
      modules: modulesOf(a.access),
      staffRole: a.staffRole,
      staff: { permissions: staff.permissions, scope: staff.scope },
      fingerprint,
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
      limits: { messageMax: INVITE_MESSAGE_MAX, expiryDaysMax: INVITE_DAYS_MAX, expiryDaysDefault: 7 },
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
    return c.json({ ok: true, ...(await removeMember(teamActor(c, a), idSchema.parse(id))) });
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
      const out = await createTeamInvitation(teamActor(c, a), input, deps.mailer);
      // The link only to the owner or admin who just made it, and only when the email didn't go out.
      return {
        ok: true,
        invitationId: out.invitationId,
        emailed: out.emailed,
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
      const out = await resendTeamInvitation(teamActor(c, a), invitationId, deps.mailer);
      return { ok: true, emailed: out.emailed, ...(out.url ? { url: out.url, emailProblem: out.emailProblem } : {}), expiresAt: out.expiresAt.toISOString() };
    });
    return c.json(r);
  });

  app.post(`${BASE}/invitations/:id/revoke`, async (c) => {
    const { ws, id } = c.req.param();
    const a = await requireTeamManager(c, deps, ws);
    await revokeTeamInvitation(teamActor(c, a), idSchema.parse(id));
    return c.json({ ok: true });
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
   * "Open dashboard" on the invitation page: the link is the invitee's way in.
   *
   * - Someone new (no bizinsights account for the invited address): an account is made for them in
   *   Cognito (a random password nobody knows; later they sign in with an emailed code, or set a
   *   password with "Forgot password"), they are signed in on this device, and the invitation is
   *   accepted. No sign-up form, no password.
   * - Signed in already as the invited address: accepted, as /invitations/accept.
   * - An existing account for the address, not signed in: the invitation is accepted for that
   *   account, but the link does NOT sign it in. That account may hold other workspaces, and a
   *   link that was forwarded or intercepted must not open them; they sign in once as usual.
   * - Signed in as someone else: refused, so the page can offer to switch.
   *
   * Single use like any invitation. A sign-in, so only from our own pages (login CSRF).
   */
  app.post("/invitations/open", async (c) => {
    requireAppOrigin(c);
    await limit(deps.coord, `rl:invite-open:${clientIp(c)}`, LIMITS.inviteAcceptIp);
    const { token } = tokenSchema.parse(await body(c));
    const inv = await invitationForLink(token);
    if (!inv) return c.json({ error: "invalid_invite", message: "This invitation link isn't valid. Check you opened the whole link, or ask for a new invitation." }, 400);
    if (inv.status !== "pending") return c.json({ error: "invalid_invite", message: "This invitation can no longer be used.", detail: { status: inv.status } }, 400);
    await limit(deps.coord, `rl:invite-open:${inv.id}`, LIMITS.inviteAcceptUser);

    const current = await loadUser(c, deps);
    if (current) {
      if (current.email.toLowerCase() !== inv.email) {
        throw new HttpError(409, `You're signed in as ${current.email}, but this invitation is for another address. Sign out, then open the link again.`, "signed_in_as_other");
      }
      return c.json({ ...(await acceptTeamInvitation(current, token, clientIp(c), { viaLink: true })), signedIn: true });
    }

    const existing = await systemDb.user.findUnique({ where: { email: inv.email } });
    const inCognito = existing ? null : await deps.auth.adminGetUser(inv.email).catch((err: unknown) => {
      if (err instanceof CognitoUnavailableError) throw new HttpError(503, "We can't open your invitation right now. Please try again in a moment.", "auth_unavailable");
      throw err;
    });
    if (existing || inCognito) {
      // Accepted for their account; they sign in to it once, as usual.
      const workspaceId = existing ? (await acceptTeamInvitation(existing, token, clientIp(c), { viaLink: true })).workspaceId : inv.workspaceId;
      return c.json({ workspaceId, joined: !!existing, signedIn: false, accountExists: true });
    }

    // Someone new: an account, a session on this device, and the invitation accepted.
    const password = unguessablePassword();
    let user;
    try {
      await deps.auth.adminCreateUser({ email: inv.email, emailVerified: true, password });
      const signedIn = await deps.auth.passwordSignIn(inv.email, password);
      if (!("tokens" in signedIn)) throw new CognitoError("UnexpectedChallenge", signedIn.challenge);
      const claims = await deps.auth.verifyIdToken(signedIn.tokens.idToken);
      user = await resolveUser(claims, { ip: clientIp(c) });
      const accepted = await acceptTeamInvitation(user, token, clientIp(c), { viaLink: true });
      setSessionCookies(c, newSession({ userId: user.id, sub: claims.sub, username: claims.username, method: claims.method, authTime: claims.authTime }), signedIn.tokens.refreshToken);
      logger.info({ event: "session_created", userId: user.id, method: "invitation_link", ip: clientIp(c) }, "signed in from an invitation link");
      return c.json({ ...accepted, signedIn: true });
    } catch (err) {
      if (err instanceof CognitoError && err.code === "UsernameExistsException") {
        throw new HttpError(409, "An account with this email address already exists. Sign in, then open the invitation again.", "account_exists");
      }
      if (err instanceof HttpError || err instanceof TeamError) throw err;
      throw cognitoFailure(err, "invitation link sign-in");
    }
  });

  app.post("/invitations/accept", async (c) => {
    const user = await requireUser(c, deps);
    await limit(deps.coord, `rl:invite-accept:${clientIp(c)}`, LIMITS.inviteAcceptIp);
    await limit(deps.coord, `rl:invite-accept-user:${user.id}`, LIMITS.inviteAcceptUser);
    const { token } = tokenSchema.parse(await body(c));
    return c.json(await acceptTeamInvitation(user, token, clientIp(c)));
  });
}
