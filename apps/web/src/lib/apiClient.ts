export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
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

/** Message to show for a failed call: a calm "retrying" line for outages, the API's own text otherwise. */
export function friendlyError(e: unknown): string {
  if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) return UNREACHABLE;
  return e.message;
}

/**
 * Message for a failed action (a save, a delete). Unlike a load, nothing retries an action on its
 * own, so an outage has to say "try again" rather than friendlyError's "we'll keep trying".
 */
export function actionError(e: unknown, what: string): string {
  if (isTransient(e)) return `We couldn't reach Insights to ${what}. Please try again in a moment.`;
  return (e as Error).message;
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
      typeof failure.message === "string" ? failure.message : "Request failed");
  }
  return json as T;
}
