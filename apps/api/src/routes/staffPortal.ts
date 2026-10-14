import { deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import { systemDb } from "@app/db";
import {
  attendanceState,
  claimInvitation,
  clockIn,
  clockOut,
  employeeDashboard,
  employmentsForUser,
  endBreak,
  env,
  INVITATION_PROBLEM_MESSAGE,
  linkEmployeeAccount,
  logger,
  lookupInvitation,
  mySchedule,
  myPay,
  myTimesheet,
  releaseInvitation,
  requestCorrection,
  StaffError,
  startBreak,
} from "@app/core";
import { sha256Hex } from "@app/shared";
import { BREAK_KINDS, localDayOf, passwordProblems, shiftDay } from "@app/shared/staff";
import { body, clientIp, HttpError, requireAppOrigin, requireUser, retiredSessionKey, SESSION_COOKIE, type Ctx, type Deps } from "../context.js";
import { FirebaseAuthError, FirebaseUnavailableError } from "../authProvider.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { daySchema, idempotencyKey, idSchema, instantSchema, requireEmployee } from "../staffAccess.js";

const EMP = "/employee/:ws";
const SESSION_TTL_S = 5 * 24 * 3600;

const clockBody = z.object({
  /** The device's clock, for the audit trail only. */
  clientTime: instantSchema.nullish(),
  timezone: z.string().max(64).nullish(),
  source: z.enum(["web", "mobile"]).default("web"),
  kind: z.enum(BREAK_KINDS).optional(),
});

/** The account row for a Firebase account this invitation just created (or an existing row for its email). */
async function userForNewAccount(uid: string, email: string, emailVerified: boolean, displayName: string) {
  const byUid = await systemDb.user.findUnique({ where: { firebaseUid: uid } });
  if (byUid) return byUid;
  const byEmail = await systemDb.user.findUnique({ where: { email } });
  // An old row for the same address (its Firebase account was deleted): only a proven inbox may take it over.
  if (byEmail) {
    if (!emailVerified) throw new StaffError(409, "account_exists", "An account with this email address already exists. Sign in, then open your invitation again.");
    return systemDb.user.update({ where: { id: byEmail.id }, data: { firebaseUid: uid, emailVerified: true } });
  }
  return systemDb.user.create({ data: { firebaseUid: uid, email, emailVerified, displayName } });
}

/** Employee self-service, invitation sign-up, and "sign out everywhere". */
export function staffPortalRoutes(app: App, deps: Deps) {
  // ---------------- Invitations (public) ----------------

  /** What the join page shows for a link: who it's for and where, or why it can't be used. */
  app.get("/staff/invitations/lookup", async (c) => {
    await limit(deps.coord, `rl:join:lookup:${clientIp(c)}`, LIMITS.joinLookupIp);
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(c.req.query());
    const r = await lookupInvitation(token);
    if (!r.ok) return c.json({ ok: false, problem: r.problem, message: r.message });
    const account = await deps.auth.findUserByEmail(r.email).catch((err: unknown) => {
      if (err instanceof FirebaseUnavailableError) throw new HttpError(503, "We can't check your invitation right now. Please try again in a moment.", "auth_unavailable");
      throw err;
    });
    return c.json({
      ok: true,
      employeeName: r.employeeName,
      position: r.position,
      organization: r.organization,
      email: r.email,
      expiresAt: r.expiresAt,
      accountExists: !!account,
    });
  });

  /**
   * Create the employee's account from an invitation: password + confirmation, checked here
   * against the password rules. Firebase stores the password (salted scrypt); the invitation is
   * used up atomically first, so two requests with the same link can't both create an account.
   */
  app.post("/staff/invitations/accept", async (c) => {
    requireAppOrigin(c);
    const input = z.object({ token: z.string().min(10).max(200), password: z.string().min(1).max(200), confirmPassword: z.string().min(1).max(200) }).parse(await body(c));
    await limit(deps.coord, `rl:join:accept:${clientIp(c)}`, LIMITS.joinAcceptIp);
    await limit(deps.coord, `rl:join:token:${sha256Hex(input.token)}`, LIMITS.joinAcceptToken);
    if (input.password !== input.confirmPassword) throw new HttpError(400, "The two passwords don't match.", "password_mismatch");
    const look = await lookupInvitation(input.token);
    if (!look.ok) throw new HttpError(400, look.message, `invitation_${look.problem}`);
    const problems = passwordProblems(input.password, { email: look.email, name: look.employeeName });
    if (problems.length) return c.json({ error: "weak_password", message: problems[0], problems }, 400);
    const existing = await deps.auth.findUserByEmail(look.email).catch((err: unknown) => {
      if (err instanceof FirebaseUnavailableError) throw new HttpError(503, "We can't create your account right now. Please try again in a moment.", "auth_unavailable");
      throw err;
    });
    if (existing) {
      throw new HttpError(409, `You already have an account with ${look.email}. Sign in with it, then open this invitation again to join ${look.organization}.`, "account_exists");
    }
    const inv = await claimInvitation(input.token);
    if (!inv) throw new HttpError(400, INVITATION_PROBLEM_MESSAGE.used, "invitation_used");
    let uid: string;
    try {
      uid = await deps.auth.createPasswordUser({ email: look.email, password: input.password, displayName: look.employeeName, emailVerified: look.provesEmail });
    } catch (err) {
      await releaseInvitation(inv.id).catch((e: unknown) => logger.error({ err: e }, "could not release an invitation after a failed sign-up"));
      if (err instanceof FirebaseUnavailableError) throw new HttpError(503, "We can't create your account right now. Please try again in a moment.", "auth_unavailable");
      if ((err as FirebaseAuthError).code === "auth/email-already-exists") throw new HttpError(409, `You already have an account with ${look.email}. Sign in, then open this invitation again.`, "account_exists");
      throw err;
    }
    const user = await userForNewAccount(uid, look.email, look.provesEmail, look.employeeName);
    const linked = await linkEmployeeAccount(inv.id, user.id);
    const customToken = await deps.auth.createCustomToken(uid);
    // The client signs in with the custom token and exchanges it for a session (POST /auth/session).
    return c.json({ customToken, emailVerified: look.provesEmail, workspaceId: linked.workspaceId });
  });

  /** Someone who already has an account (signed in, email verified) joins with the invitation. */
  app.post("/staff/invitations/accept-existing", async (c) => {
    const user = await requireUser(c, deps);
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(await body(c));
    await limit(deps.coord, `rl:join:token:${sha256Hex(token)}`, LIMITS.joinAcceptToken);
    const look = await lookupInvitation(token);
    if (!look.ok) throw new HttpError(400, look.message, `invitation_${look.problem}`);
    if (look.email !== user.email) throw new HttpError(403, `This invitation is for ${look.email}. Sign in with that email address.`, "invite_email_mismatch");
    if (!user.emailVerified) throw new HttpError(403, "Verify your email address first, then open the invitation again.", "email_unverified");
    const inv = await claimInvitation(token);
    if (!inv) throw new HttpError(400, INVITATION_PROBLEM_MESSAGE.used, "invitation_used");
    try {
      const linked = await linkEmployeeAccount(inv.id, user.id);
      return c.json({ workspaceId: linked.workspaceId });
    } catch (err) {
      await releaseInvitation(inv.id).catch(() => {});
      throw err;
    }
  });

  /** Sign out of every device: ends all of this account's sessions, then this one. */
  app.post("/auth/sessions/revoke", async (c) => {
    const user = await requireUser(c, deps);
    await limit(deps.coord, `rl:revoke:${user.id}`, LIMITS.revokeSessions);
    await deps.auth.revokeSessions(user.firebaseUid).catch((err: unknown) => {
      if (err instanceof FirebaseUnavailableError) throw new HttpError(503, "We can't sign you out everywhere right now. Please try again in a moment.", "auth_unavailable");
      throw err;
    });
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) await deps.coord.put(retiredSessionKey(cookie), "1", SESSION_TTL_S).catch(() => {});
    deleteCookie(c, SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "Lax", secure: env().NODE_ENV === "production" });
    return c.json({ ok: true });
  });

  // ---------------- Employee portal ----------------

  app.get("/employee/workspaces", async (c) => {
    const user = await requireUser(c, deps);
    return c.json({ items: await employmentsForUser(user.id) });
  });

  app.get(`${EMP}/dashboard`, async (c) => {
    const ctx = await requireEmployee(c, deps, c.req.param("ws"));
    return c.json(await employeeDashboard(ctx));
  });

  app.get(`${EMP}/attendance/me`, async (c) => {
    const ctx = await requireEmployee(c, deps, c.req.param("ws"));
    return c.json(await attendanceState(ctx));
  });

  const clock = (action: typeof clockIn) => async (c: Ctx) => {
    const ctx = await requireEmployee(c, deps, c.req.param("ws")!);
    await limit(deps.coord, `rl:clock:${ctx.employee.id}`, LIMITS.clockActions, "Too many clock actions in a row. Wait a moment and try again.");
    const input = clockBody.parse(await body(c));
    const result = await action(ctx, {
      idempotencyKey: idempotencyKey(c),
      clientTime: input.clientTime ?? null,
      clientTimezone: input.timezone ?? null,
      source: input.source,
      breakKind: input.kind,
    });
    return c.json(result);
  };
  app.post(`${EMP}/attendance/clock-in`, clock(clockIn));
  app.post(`${EMP}/attendance/clock-out`, clock(clockOut));
  app.post(`${EMP}/attendance/break/start`, clock(startBreak));
  app.post(`${EMP}/attendance/break/end`, clock(endBreak));

  app.get(`${EMP}/timesheets`, async (c) => {
    const ctx = await requireEmployee(c, deps, c.req.param("ws"));
    const today = localDayOf(Date.now(), ctx.employee.timezone);
    const q = z.object({ from: daySchema.default(shiftDay(today, -30)), to: daySchema.default(today) }).parse(c.req.query());
    if (q.from > q.to) throw new HttpError(400, "The start date is after the end date", "validation");
    return c.json(await myTimesheet(ctx, q));
  });

  app.post(`${EMP}/corrections`, async (c) => {
    const ctx = await requireEmployee(c, deps, c.req.param("ws"));
    await limit(deps.coord, `rl:correction:${ctx.employee.id}`, LIMITS.correctionRequests);
    const input = z
      .object({ sessionId: idSchema.nullable(), clockInAt: instantSchema, clockOutAt: instantSchema.nullable(), reason: z.string().trim().min(3, "Say what needs changing and why").max(500) })
      .parse(await body(c));
    return c.json(await requestCorrection(ctx, input), 201);
  });

  app.get(`${EMP}/pay`, async (c) => {
    const ctx = await requireEmployee(c, deps, c.req.param("ws"));
    return c.json({ currency: ctx.employee.currency, items: await myPay(ctx.employee.id, ctx.workspaceId) });
  });

  app.get(`${EMP}/schedule`, async (c) => {
    const ctx = await requireEmployee(c, deps, c.req.param("ws"));
    const today = localDayOf(Date.now(), ctx.employee.timezone);
    const q = z.object({ from: daySchema.default(shiftDay(today, -7)), to: daySchema.default(shiftDay(today, 28)) }).parse(c.req.query());
    return c.json(await mySchedule(ctx.workspaceId, ctx.employee.id, q.from, q.to));
  });

  /** Personal details the employee may keep up to date themselves (phone only; the rest is HR's). */
  app.patch(`${EMP}/profile`, async (c) => {
    const ctx = await requireEmployee(c, deps, c.req.param("ws"));
    if (ctx.employee.status === "inactive") throw new HttpError(403, "Your employee account has been deactivated.", "deactivated");
    const { phone } = z.object({ phone: z.string().trim().max(40).regex(/^[+0-9 ().-]*$/, "Use digits, spaces and + ( ) - only").nullable() }).parse(await body(c));
    await systemDb.employee.update({ where: { id: ctx.employee.id }, data: { phone: phone || null } });
    return c.json({ ok: true });
  });
}
