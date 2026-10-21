/**
 * Where to go after signing in, when sign-in interrupted something (an invitation link opened
 * while signed out). Kept in localStorage, not sessionStorage, because an emailed sign-in link
 * opens in a new tab; it expires so a stale one can't hijack a later, unrelated sign-in.
 */
const KEY = "insights:returnTo";
const TTL_MS = 60 * 60_000;

/**
 * Same-origin paths only: never an absolute or protocol-relative URL. Browsers read a backslash
 * as a slash, so "/\evil.com" is "//evil.com"; control characters are dropped from URLs, so
 * "/\t/evil.com" is too. Neither belongs in a path of ours.
 */
export const isSafePath = (path: unknown): path is string =>
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && !/[\\\u0000-\u001f\u007f]/.test(path);

/**
 * A path of this site as the browser will read it. isSafePath checks the text; this also checks
 * where it leads once dot segments are resolved ("/..//evil.example" is "//evil.example").
 */
export function isSafeDestination(path: unknown): path is string {
  if (!isSafePath(path)) return false;
  try {
    const u = new URL(path, window.location.origin);
    return u.origin === window.location.origin && isSafePath(`${u.pathname}${u.search}${u.hash}`);
  } catch {
    return false;
  }
}
const safe = isSafeDestination;

export function setReturnTo(path: string) {
  if (!safe(path)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ path, at: Date.now() }));
  } catch {
    /* storage blocked: sign-in lands on the default page instead */
  }
}

/** A trip to sign in is under way (signInAndReturn). */
let leaving = false;

/**
 * A protected page found the visitor signed out: remember it (query included, so ?shop= or
 * ?view= survive) for after they sign in, and send them to sign in.
 */
export function signInAndReturn(router: { replace(href: string): void }) {
  // One 401 reaches several handlers in the same task (the signed-out event, then the failed
  // call's own catch): one trip to sign in, not a second fetch of the sign-in page. Cleared once
  // that task is over, so a later sign-out goes to sign in again.
  if (leaving) return;
  leaving = true;
  window.setTimeout(() => (leaving = false), 0);
  setReturnTo(window.location.pathname + window.location.search);
  router.replace("/login");
}

/** The pending path, consumed; null when there is none or it has expired. */
export function takeReturnTo(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    if (!raw) return null;
    const { path, at } = JSON.parse(raw) as { path?: unknown; at?: number };
    return safe(path) && typeof at === "number" && Date.now() - at < TTL_MS ? path : null;
  } catch {
    return null;
  }
}

/** The pending path, left in place (a sign-in that leaves the site may come back without finishing). */
export function peekReturnTo(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const { path, at } = JSON.parse(raw) as { path?: unknown; at?: number };
    return safe(path) && typeof at === "number" && Date.now() - at < TTL_MS ? path : null;
  } catch {
    return null;
  }
}
