import { z } from "zod";
import { systemDb, type User } from "@app/db";
import { logger } from "@app/core";
import { describeDevice, SIGN_IN_EVENT, SIGN_IN_FAILED_EVENT, type DeviceInfo } from "@app/shared";
import { clientIp, HttpError, requireUser, retiredSessionKey, sessionOf, type Deps } from "../context.js";
import { endSessions, touchSession } from "../devices.js";
import { recordAuthEvent } from "../identity.js";
import { cursorPage } from "../pagination.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";

const place = (row: { country: string | null; region: string | null; city: string | null }) => (row.country || row.region || row.city ? { country: row.country, region: row.region, city: row.city } : null);

/** The sessions of this account still running: not ended, not expired, and not from before a "sign out everywhere". */
const liveSessions = (user: User, now = new Date()) => ({
  userId: user.id,
  endedAt: null,
  expiresAt: { gt: now },
  ...(user.sessionsValidAfter && { createdAt: { gte: user.sessionsValidAfter } }),
});

/**
 * Settings → Security: where the account is signed in (devices.ts keeps a row per session), signing
 * one of those devices out, and the account's recent sign-ins. Account-wide, so never for a session
 * opened from an invitation link (requireUser refuses those).
 */
export function sessionRoutes(app: App, deps: Deps) {
  app.get("/auth/account/sessions", async (c) => {
    const user = await requireUser(c, deps);
    const s = sessionOf(c);
    let rows = await systemDb.userSession.findMany({ where: liveSessions(user), orderBy: { lastSeenAt: "desc" }, take: 50 });
    // A session from before the list existed gets its row on its next check; this one, now.
    if (!rows.some((r) => r.sid === s.sid)) {
      await touchSession(c, s, clientIp(c));
      rows = await systemDb.userSession.findMany({ where: liveSessions(user), orderBy: { lastSeenAt: "desc" }, take: 50 });
    }
    const sessions = rows
      .map((r) => ({
        id: r.id,
        current: r.sid === s.sid,
        method: r.method,
        device: describeDevice(r.device as DeviceInfo | null),
        ip: r.ip,
        location: place(r),
        signedInAt: r.createdAt.toISOString(),
        lastActiveAt: (r.sid === s.sid ? new Date() : r.lastSeenAt).toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      }))
      // This device first, then the most recently used.
      .sort((a, b) => Number(b.current) - Number(a.current));
    return c.json({ sessions });
  });

  /**
   * Sign one other device out: its session is retired (as signing out there would), so its next
   * request finds it signed out. This device signs out with POST /auth/logout instead.
   */
  app.delete("/auth/account/sessions/:id", async (c) => {
    const user = await requireUser(c, deps);
    const s = sessionOf(c);
    await limit(deps.coord, `rl:sessions:${user.id}`, LIMITS.sessionRemove);
    const row = await systemDb.userSession.findFirst({ where: { ...liveSessions(user), id: c.req.param("id") } });
    if (!row) throw new HttpError(404, "That device is already signed out.", "not_found");
    if (row.sid === s.sid) throw new HttpError(409, "That's the device you're using now. Use Sign out to sign out here.", "current_session");
    // Retired first: the row can say "ended" only once the session really is.
    await deps.coord.put(retiredSessionKey(row.sid), "1", Math.max(60, Math.ceil((row.expiresAt.getTime() - Date.now()) / 1000))).catch((err: unknown) => {
      logger.error({ err }, "could not retire a removed session");
      throw new HttpError(503, "We can't sign that device out right now. Please try again in a moment.", "auth_unavailable");
    });
    await endSessions({ sid: row.sid });
    const device = describeDevice(row.device as DeviceInfo | null);
    await recordAuthEvent("session_removed", user.id, clientIp(c), { method: row.method, device: device.name, browser: device.browser });
    return c.json({ ok: true });
  });

  /** The account's sign-ins, newest first: those that got in, and those stopped at the password or the code. */
  app.get("/auth/account/activity", async (c) => {
    const user = await requireUser(c, deps);
    const q = z.object({ limit: z.string().optional(), cursor: z.string().max(64).optional() }).parse(c.req.query());
    const page = cursorPage(q, 20);
    const rows = await systemDb.authEvent.findMany({
      where: { userId: user.id, type: { in: [SIGN_IN_EVENT, SIGN_IN_FAILED_EVENT] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...page.args,
    });
    const { items, nextCursor } = page.split(rows);
    return c.json({
      events: items.map((e) => {
        const m = (e.metadata ?? {}) as { method?: string; step?: string; device?: DeviceInfo; country?: string | null; region?: string | null; city?: string | null };
        return {
          id: e.id,
          at: e.createdAt.toISOString(),
          status: e.type === SIGN_IN_EVENT ? ("success" as const) : ("failed" as const),
          method: m.method ?? null,
          // Where a failed one stopped: the password, or the code after it.
          step: m.step ?? null,
          device: describeDevice(m.device ?? null),
          ip: e.ip,
          location: place({ country: m.country ?? null, region: m.region ?? null, city: m.city ?? null }),
        };
      }),
      nextCursor,
    });
  });
}
