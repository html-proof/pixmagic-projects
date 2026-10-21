export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    _message: string,
    public correlationId?: string,
    public retryAt?: number,
  ) {
    super(publicErrorMessage(status, code));
    this.name = "ApiError";
  }
}

const UNREACHABLE = "We can't reach Insights right now. We'll keep trying.";

/** Only a 401 means the session is gone. Anything else must never sign the user out. */
export const isSignedOut = (e: unknown) => e instanceof ApiError && e.status === 401;

/**
 * Outage-shaped failures that go away on their own: no response (status 0), a 5xx (the API or its
 * database is unreachable), or a rate limit. Callers retry these instead of showing a dead end.
 */
export const isTransient = (e: unknown) =>
  !(e instanceof ApiError) || e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500;

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

export function friendlyError(e: unknown): string {
  return e instanceof ApiError ? e.message : UNREACHABLE;
}

/**
 * Message for a failed action (a save, a delete). Unlike a load, nothing retries an action on its
 * own, so an outage has to say "try again" rather than friendlyError's "we'll keep trying".
 */
export function actionError(e: unknown, what: string): string {
  if (e instanceof ApiError && e.status === 408) return "The request timed out. Check whether it completed before trying again.";
  if (isTransient(e)) return `We couldn't reach Insights to ${what}. Please try again in a moment.`;
  return friendlyError(e);
}

/** All calls go to same-origin /api/* (served by the Cloudflare Worker). */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; credentials?: RequestCredentials; referrerPolicy?: ReferrerPolicy; timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000);
  try {
    const res = await fetch(`/api${path}`, {
      method: init.method ?? "GET", credentials: init.credentials ?? "same-origin", referrerPolicy: init.referrerPolicy,
      headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined, signal: controller.signal,
    });
    const text = await res.text();
    let json: { error?: string; message?: string } = {};
    try { if (text) json = JSON.parse(text); }
    catch { if (res.ok) throw new ApiError(502, "bad_response", ""); }
    if (!res.ok) {
      const failure = json && typeof json === "object" ? json : {};
      throw new ApiError(res.status, typeof failure.error === "string" ? failure.error : "error", "",
        safeCorrelationId(res.headers.get("x-request-id") ?? res.headers.get("cf-ray")),
        (res.status === 429 || res.status === 503) ? parseRetryAfter(res.headers.get("retry-after")) : undefined);
    }
    return json as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(controller.signal.aborted ? 408 : 0, controller.signal.aborted ? "timeout" : "network", "");
  } finally { clearTimeout(timer); }
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
