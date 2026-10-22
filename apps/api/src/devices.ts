import type { Context } from "hono";
import { systemDb } from "@app/db";
import { logger } from "@app/core";
import { clientHint, DEVICE_UA_MAX, SIGN_IN_EVENT, SIGN_IN_FAILED_EVENT, type DeviceInfo } from "@app/shared";
import type { SessionClaims } from "./session.js";

/**
 * Where an account is signed in, for Settings → Security: a row per session (user_sessions) with
 * the browser it came from and where it was last seen, and the sign-in activity (auth_events
 * signed_in / sign_in_failed). The session itself is the cookie (session.ts) and is checked
 * without these rows; they only describe it, so failing to write one never fails a request.
 */

/**
 * Where the client is, as the edge read it from its address: "country|region|city", each part
 * URI-encoded, the country an ISO 3166 code. On AWS apps/aws/src/index.ts sets it from what the
 * CloudFront viewer function found (Cloudflare's visitor-location headers, or CloudFront's own),
 * dropping anything the client sent under this name; the local server passes on what it is given.
 */
export const CLIENT_GEO_HEADER = "x-insights-client-geo";

export interface ClientLocation {
  country: string | null;
  region: string | null;
  city: string | null;
}

const part = (raw: string | undefined, max: number) => {
  if (!raw) return null;
  let v = raw;
  try {
    v = decodeURIComponent(raw);
  } catch {
    /* not encoded: as sent */
  }
  // A UTF-8 name ("São Paulo") that reached the edge function as Latin-1 text comes out as "SÃ£o Paulo".
  if (/[Â-ô][\u0080-¿]/.test(v)) {
    const utf8 = Buffer.from(v, "latin1").toString("utf8");
    if (!utf8.includes("�")) v = utf8;
  }
  v = v.trim();
  return v ? v.slice(0, max) : null;
};

export function locationOf(c: Context): ClientLocation | null {
  const raw = c.req.header(CLIENT_GEO_HEADER);
  if (!raw) return null;
  const [country, region, city] = raw.split("|");
  const code = part(country, 2)?.toUpperCase() ?? null;
  // Cloudflare's "XX" (unknown) and "T1" (Tor) are no country.
  const known = code && /^[A-Z]{2}$/.test(code) && code !== "XX" && code !== "T1" ? code : null;
  return { country: known, region: part(region, 80), city: part(city, 80) };
}

/** What the browser says about itself: its User-Agent and, from Chromium, the client hints Accept-CH asks for. */
export function deviceOf(c: Context): DeviceInfo {
  const ua = c.req.header("user-agent")?.trim().slice(0, DEVICE_UA_MAX);
  const info: DeviceInfo = {};
  if (ua) info.ua = ua;
  const platform = clientHint(c.req.header("sec-ch-ua-platform"));
  const platformVersion = clientHint(c.req.header("sec-ch-ua-platform-version"));
  const model = clientHint(c.req.header("sec-ch-ua-model"));
  if (platform) info.platform = platform;
  if (platformVersion) info.platformVersion = platformVersion;
  if (model) info.model = model;
  return info;
}

const knownIp = (ip: string) => (ip && ip !== "unknown" ? ip.slice(0, 64) : null);

/** Where the request is from, for a row: only what the edge said (a missing header keeps what the row has). */
function seenFrom(c: Context, ip: string) {
  const address = knownIp(ip);
  return { ...(address ? { ip: address } : {}), ...(locationOf(c) ?? {}) };
}

const quietly = (what: string) => (err: unknown) => {
  logger.error({ err }, `could not record ${what}`);
};

/**
 * A new session: its device row, and (unless `activity` is false: a session that replaced one,
 * such as after a password change) a sign-in in the activity. Sessions opened from an invitation
 * link aren't an account's sign-ins.
 */
export async function recordSession(c: Context, s: SessionClaims, ip: string, opts: { activity?: boolean } = {}) {
  if (s.m === "link") return;
  const device = deviceOf(c);
  const where = locationOf(c);
  await systemDb.userSession
    .create({ data: { userId: s.uid, sid: s.sid, method: s.m, device: device as object, ...seenFrom(c, ip), createdAt: new Date(s.iat), lastSeenAt: new Date(s.iat), expiresAt: new Date(s.exp) } })
    .catch(quietly("a session"));
  if (opts.activity === false) return;
  await systemDb.authEvent
    .create({ data: { type: SIGN_IN_EVENT, userId: s.uid, ip: knownIp(ip), metadata: { method: s.m, device, ...where } as object } })
    .catch(quietly("a sign-in"));
}

/**
 * The session was used just now (context.ts calls this when it re-checks a session, at most once a
 * minute): its last-seen time, address and place. A session from before these rows existed gets
 * its row here.
 */
export async function touchSession(c: Context, s: SessionClaims, ip: string) {
  if (s.m === "link") return;
  const now = new Date();
  const seen = { device: deviceOf(c) as object, ...seenFrom(c, ip), lastSeenAt: now };
  await systemDb.userSession
    .upsert({
      where: { sid: s.sid },
      create: { userId: s.uid, sid: s.sid, method: s.m, createdAt: new Date(s.iat), expiresAt: new Date(s.exp), ...seen },
      update: seen,
    })
    .catch(quietly("a session's last use"));
}

/** Sessions that ended (signed out, removed, refused by Cognito): off the device list. */
export async function endSessions(where: { sid: string } | { userId: string; method?: string }) {
  await systemDb.userSession.updateMany({ where: { ...where, endedAt: null }, data: { endedAt: new Date() } }).catch(quietly("ended sessions"));
}

/**
 * A sign-in to an existing account that failed at its password or its code: listed in the
 * account's sign-in activity. An address with no account records nothing (and says nothing).
 */
export async function recordFailedSignIn(c: Context, email: string, ip: string, step: "password" | "code") {
  const user = await systemDb.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true } }).catch(() => null);
  if (!user) return;
  await systemDb.authEvent
    .create({ data: { type: SIGN_IN_FAILED_EVENT, userId: user.id, ip: knownIp(ip), metadata: { step, device: deviceOf(c), ...(locationOf(c) ?? {}) } as object } })
    .catch(quietly("a failed sign-in"));
}
