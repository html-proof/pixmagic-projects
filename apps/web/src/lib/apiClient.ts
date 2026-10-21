export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    _message: string,
    public correlationId?: string,
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
  !(e instanceof ApiError) || e.status === 0 || e.status === 429 || e.status >= 500;

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
  if (isTransient(e)) return `We couldn't reach Insights to ${what}. Please try again in a moment.`;
  return friendlyError(e);
}

/** All calls go to same-origin /api/* (served by the Cloudflare Worker). */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    // No response at all (offline, DNS, connection reset): status 0, so callers can tell it from a 401.
    throw new ApiError(0, "network", UNREACHABLE);
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new ApiError(0, "network", UNREACHABLE);
  }
  let json: { error?: string; message?: string } = {};
  try {
    if (text) json = JSON.parse(text);
  } catch {
    // Non-JSON body (e.g. a Cloudflare error page): report the status instead of a parse error.
    if (res.ok) throw new ApiError(res.status, "bad_response", "Unexpected response from the server");
  }
  if (!res.ok) {
    const failure = json && typeof json === "object" ? json : {};
    throw new ApiError(res.status,
      typeof failure.error === "string" ? failure.error : "error",
      typeof failure.message === "string" ? failure.message : "Request failed",
      safeCorrelationId(res.headers.get("x-request-id") ?? res.headers.get("cf-ray")));
  }
  return json as T;
}

/** Only opaque diagnostic identifiers belong in user-facing support references. */
export function safeCorrelationId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : undefined;
}
