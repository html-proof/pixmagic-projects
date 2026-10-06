/**
 * Where to go after signing in, when sign-in interrupted something (an invitation link opened
 * while signed out). Kept in localStorage, not sessionStorage, because an emailed sign-in link
 * opens in a new tab; it expires so a stale one can't hijack a later, unrelated sign-in.
 */
const KEY = "insights:returnTo";
const TTL_MS = 60 * 60_000;

/** Same-origin paths only: never an absolute or protocol-relative URL. */
const safe = (path: unknown): path is string => typeof path === "string" && path.startsWith("/") && !path.startsWith("//");

export function setReturnTo(path: string) {
  if (!safe(path)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ path, at: Date.now() }));
  } catch {
    /* storage blocked: sign-in lands on the default page instead */
  }
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
