import { signalAccess } from "@/lib/access";

import { ApiError, apiFailure, readApiResponse, UNREACHABLE } from "./apiResponse";
export { ApiError } from "./apiResponse";

/**
 * Only a 401 means the session is gone, and only one for the session the tab uses
 * (ApiError.sessionLeft). Anything else must never sign the user out.
 */
export const isSignedOut = (e: unknown) => e instanceof ApiError && e.status === 401 && !e.sessionLeft;

/**
 * Dispatched on window whenever any call finds the session gone (the account was deleted or
 * disabled, or signed out elsewhere), so the signed-in shells can send the person to sign in
 * instead of leaving them on a page whose background checks quietly keep the last data up.
 * Only `unauthenticated`: a 401 for a wrong password or a re-authentication is not "signed out".
 */
export const SIGNED_OUT_EVENT = "insights:signed-out";

/** Calls `onSignedOut` whenever a call finds the session gone; returns the unsubscribe (an effect's cleanup). */
export function onSessionGone(onSignedOut: () => void): () => void {
  window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
  return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
}

/**
 * Outage-shaped failures that go away on their own: no response (status 0), a 5xx (the API or its
 * database is unreachable), or a rate limit. Callers retry these instead of showing a dead end.
 */
export const isTransient = (e: unknown) =>
  !(e instanceof ApiError) || e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500;

/**
 * Refused because of who is asking (Team & Access): no permission for this, or access to the
 * workspace revoked. What was shown before must not stay on screen.
 */
export const isRefused = (e: unknown) => e instanceof ApiError && e.status === 403 && (e.code === "forbidden" || e.code === "access_revoked" || e.code === "access_expired");

/** Message to show for a failed call: a calm "retrying" line for outages, the API's own text otherwise. */
export function friendlyError(e: unknown): string {
  if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) return UNREACHABLE;
  return publicErrorMessage(e.status, e.code);
}

/**
 * Message for a failed action (a save, a delete). Unlike a load, nothing retries an action on its
 * own, so an outage has to say "try again" rather than friendlyError's "we'll keep trying".
 */
export function actionError(e: unknown, what: string, messages: Readonly<Record<string, string>> = {}): string {
  if (e instanceof ApiError && e.status === 408) return "The request timed out. Check whether it completed before trying again.";
  if (isTransient(e)) return `We couldn't reach bizinsights to ${what}. Please try again in a moment.`;
  if (e instanceof ApiError && Object.hasOwn(messages, e.code)) return messages[e.code]!;
  return friendlyError(e);
}

/**
 * Whether this tab shows a shared dashboard opened from an invitation link. Kept per tab
 * (sessionStorage): such a tab's calls use the shared-link session only (the API's __share cookie,
 * chosen by the x-bi-context header), while the browser's other tabs stay in the account signed in
 * there, if any. The two sessions never mix.
 */
const CONTEXT_KEY = "bi:context";

export function isSharedTab(): boolean {
  try {
    return sessionStorage.getItem(CONTEXT_KEY) === "shared";
  } catch {
    return false;
  }
}

export function setSharedTab(on: boolean) {
  try {
    if (on) sessionStorage.setItem(CONTEXT_KEY, "shared");
    else sessionStorage.removeItem(CONTEXT_KEY);
  } catch {
    /* storage blocked: the API falls back to the shared session when no account is signed in */
  }
}

/** The tab is closing its shared dashboard (leaveSharedSession): see signedOutHere. */
let leaving = false;

/**
 * Whether a 401 for a call made as `asShared` (isSharedTab() when it was sent) means this tab
 * is signed out. It does only while that is still the tab's session and the tab is not leaving
 * it: closing a shared dashboard signs the shared-link session out while the dashboard's checks
 * are still in flight as it, and those refusals say nothing about the account the tab goes on
 * as (so they must not send it to sign in, or say the link has ended, as it leaves).
 */
export const signedOutHere = (asShared: boolean): boolean => asShared === isSharedTab() && !(asShared && leaving);

/**
 * Close the shared dashboard this tab shows: its shared-link session ends, and the tab is the
 * account's from then on (or nobody's). The sign-out goes first, as the shared-link session,
 * which the tab still is until it has answered: sent as the account's it would end that
 * session instead, and the dashboard's checks meanwhile could re-adopt the link session.
 */
export async function leaveSharedSession(): Promise<void> {
  leaving = true;
  try {
    await api("/auth/logout", { method: "POST" });
  } catch {
    // Unreachable: the session ends with its link anyway. The tab leaves it either way.
  } finally {
    setSharedTab(false);
    leaving = false;
  }
}

/** The header that says which session a call uses (none for an account's tab). */
export const contextHeaders = (): Record<string, string> => (isSharedTab() ? { "x-bi-context": "shared" } : {});

/** A same-origin API address for a plain link (a download), saying the same as contextHeaders where no header can be sent. */
export const apiHref = (path: string) => `/api${path}${isSharedTab() ? `${path.includes("?") ? "&" : "?"}ctx=shared` : ""}`;

/** Same-origin transport. Preserve shared-tab identity, access signals and auth challenge data. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; credentials?: RequestCredentials; referrerPolicy?: ReferrerPolicy; timeoutMs?: number } = {}): Promise<T> {
  const authenticated = init.credentials !== "omit";
  const asShared = authenticated && isSharedTab();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000);
  try {
    const res = await fetch(`/api${path}`, {
      method: init.method ?? "GET",
      credentials: init.credentials ?? "same-origin",
      referrerPolicy: init.referrerPolicy,
      headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(authenticated ? contextHeaders() : {}), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const fp = authenticated ? res.headers.get("x-access-fp") : null;
    if (fp) {
      const at = fp.lastIndexOf(":");
      signalAccess({ workspaceId: fp.slice(0, at), fingerprint: fp.slice(at + 1) });
    }
    const json = await readApiResponse(res);
    if (!res.ok) {
      const err = apiFailure(res.status, json);
      if (res.status >= 500) err.message = UNREACHABLE;
      else if (!authenticated) err.message = publicErrorMessage(res.status, err.code);
      err.correlationId = safeCorrelationId(res.headers.get("x-request-id") ?? res.headers.get("cf-ray"));
      err.retryAt = (res.status === 429 || res.status === 503) ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
      if (authenticated && res.status === 401 && err.code === "unauthenticated") {
        if (signedOutHere(asShared)) window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
        else err.sessionLeft = true;
      }
      if (authenticated && isRefused(err)) signalAccess({ refused: err.code as "forbidden" | "access_revoked" | "access_expired" });
      throw err;
    }
    return json as T;
  } catch (error) {
    if (error instanceof ApiError && !(controller.signal.aborted && error.status === 0)) throw error;
    throw new ApiError(controller.signal.aborted ? 408 : 0, controller.signal.aborted ? "timeout" : "network", UNREACHABLE);
  } finally { clearTimeout(timer); }
}

/** Messages are selected locally; provider responses can contain private diagnostics. */
function publicErrorMessage(status: number, code: string): string {
  const messages: Record<string, string> = {
    invalid_code: "That code is invalid or has expired",
    invalid_link: "That sign-in link is invalid, already used or expired. Request a new one.",
    invalid_invite: "This invitation has expired or has already been used. Ask your workspace owner for a new link.",
    invite_email_mismatch: "Sign in with the verified email address this invite was sent to.",
    email_unverified: "Verify your email address before continuing.",
    email_in_use: "That email address belongs to another account. Sign in with an email code to prove it's yours.",
    invalid_shop: "Enter your store's myshopify.com address.",
    shop_required: "Enter your store's myshopify.com address.",
    store_taken: "This store is already connected to another workspace.",
    invalid_range: "Choose a valid date range and try again.",
    reconnect: "Integration disconnected. Reconnect it in Settings to resume updates.",
    pending_expired: "That account selection has expired. Connect again to choose your accounts.",
    validation: "Check the required fields and their formats, then try again.",
  };
  if (status === 0 || status >= 500) return UNREACHABLE;
  if (Object.hasOwn(messages, code)) return messages[code]!;
  if (status === 401) return "Your session has expired. Sign in again to continue.";
  if (status === 403) return "You don't have permission to access this. Ask your workspace owner for access.";
  if (status === 404) return "We couldn't find this item. It may have been removed.";
  if (status === 408) return "The request timed out. Check your connection and try again.";
  if (status === 409) return "This item has changed. Reload its latest details before trying again.";
  if (status === 410) return "This link has expired or the item has been removed. Request a new link.";
  if (status === 413) return "This request is too large. Reduce its size and try again.";
  if (status === 422) return "Check the required fields and correct their formats.";
  if (status === 429) return "Too many requests. Wait a moment before trying again.";
  return "We couldn't complete this request. Check your details and try again.";
}

/** Retry-After accepts a delta in seconds or an HTTP date. Invalid hints are ignored. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const hint = value.trim();
  const at = /^\d+$/.test(hint) ? now + Number(hint) * 1000 : /[a-z]/i.test(hint) ? Date.parse(hint) : NaN;
  return Number.isFinite(at) && at > now ? at : undefined;
}

/** Only opaque diagnostic identifiers belong in user-facing support references. */
export function safeCorrelationId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : undefined;
}
