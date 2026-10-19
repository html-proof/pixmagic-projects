/**
 * The one transport to Meta's Graph API (graph.facebook.com), used by the ad accounts (ads/meta.ts)
 * and WhatsApp (whatsapp/graph.ts) alike. It owns what every call must get right:
 *
 * - the access token travels in the Authorization header, never in a URL: URLs end up in logs,
 *   traces and error reports, headers don't;
 * - a `paging.next` link Meta hands back is followed only to graph.facebook.com, and without any
 *   token it carried;
 * - no answer at all (network down, timeout) and an answer that isn't JSON are reported the same
 *   way as Meta's own errors, so each caller sorts every failure in one place;
 * - with the app's secret (`appSecret`), every call made with a person's token carries
 *   `appsecret_proof`, so a leaked token is useless without the secret. The ads app's secret is
 *   bizinsights' own; a merchant's own WhatsApp app has a secret we don't hold, so WhatsApp sends none.
 *
 * How a failure is classified (reconnect, retry, give up) differs between the two callers, so each
 * passes its own `fail` that turns the failure into its error type.
 */
import { hmacSha256Hex } from "@app/shared";
import type { FetchLike } from "./shopify.js";

export const GRAPH_HOST = "graph.facebook.com";

/** Why a call failed: Meta answered with an error, nothing answered, or Meta's paging link pointed elsewhere. */
export type GraphFailureReason = "refused" | "network" | "bad_link";

export interface GraphFailure {
  reason: GraphFailureReason;
  /** The HTTP status; 0 when nothing answered. */
  status: number;
  /** Meta's `error.code` (190: token invalid, 4/17/613: rate limits...) and `error_subcode`. */
  code: number | null;
  subcode: number | null;
  /** Meta's `error.type` (OAuthException...) and `error.message`; for "network"/"bad_link", what happened. */
  type: string | null;
  message: string | null;
  /** Meta's wording for people (`error_user_title`, `error_user_msg`) and `error_data.details`. */
  userTitle: string | null;
  userMessage: string | null;
  details: string | null;
  /** The start of the body as it came (an HTML error page, say), for when nothing above says more. */
  text: string | null;
  /**
   * The answer's headers (null when nothing answered): Meta says how long a throttle lasts in its
   * usage headers (X-Business-Use-Case-Usage, X-Ad-Account-Usage), not in the error body.
   */
  headers: Headers | null;
}

export interface GraphRequest {
  /** Graph API version, e.g. "v25.0". */
  version: string;
  method: "GET" | "POST" | "DELETE";
  /** Relative to the version ("me/adaccounts", "" for the root), or a `paging.next` link from Meta. */
  path: string;
  /** Sent as `Authorization: Bearer`. A user, system-user or app token (`<app id>|<app secret>`). */
  token?: string;
  /**
   * The secret of the app the token was issued to: `appsecret_proof` (HMAC-SHA256 of the token, keyed
   * with it, in hex) then goes with the call. Not for an app token, which holds the secret itself.
   */
  appSecret?: string;
  /** Query string parameters. */
  query?: Record<string, string>;
  /** Form fields, for a POST or DELETE. */
  form?: Record<string, string>;
  /** A JSON body, for a POST. */
  json?: unknown;
  /** Ends the call early (a live report's time limit); without one, the fetch's own time limit applies. */
  signal?: AbortSignal;
}

const failure = (reason: GraphFailureReason, status: number, message: string | null, extra: Partial<GraphFailure> = {}): GraphFailure => ({
  reason,
  status,
  code: null,
  subcode: null,
  type: null,
  message,
  userTitle: null,
  userMessage: null,
  details: null,
  text: null,
  headers: null,
  ...extra,
});

interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; error_user_title?: string; error_user_msg?: string; error_data?: { details?: string } };
}

/** The URL for a request: the version's path, or Meta's paging link checked and stripped of any token. */
function graphUrl(req: GraphRequest): URL | null {
  let url: URL;
  if (/^https?:\/\//i.test(req.path)) {
    url = new URL(req.path);
    if (url.protocol !== "https:" || url.hostname !== GRAPH_HOST) return null;
  } else {
    url = new URL(`https://${GRAPH_HOST}/${req.version}/${req.path.replace(/^\//, "")}`);
  }
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
  // A paging link repeats the parameters of the call that made it, a token among them when one went
  // in the URL. The header carries it now.
  url.searchParams.delete("access_token");
  // The proof is worked out for this call's token: never one a paging link carried for another.
  url.searchParams.delete("appsecret_proof");
  if (req.token && req.appSecret) url.searchParams.set("appsecret_proof", hmacSha256Hex(req.appSecret, req.token));
  return url;
}

/**
 * Call the Graph API. Resolves with Meta's JSON (an empty object for an empty answer); any failure
 * is handed to `fail`, and what it returns is thrown.
 */
export async function graphCall<T>(fetchImpl: FetchLike, req: GraphRequest, fail: (f: GraphFailure) => Error): Promise<T> {
  const url = graphUrl(req);
  if (!url) throw fail(failure("bad_link", 502, `Meta returned a page link outside ${GRAPH_HOST}`));
  const headers: Record<string, string> = {};
  if (req.token) headers.authorization = `Bearer ${req.token}`;
  let body: string | undefined;
  if (req.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(req.json);
  } else if (req.form) {
    const { access_token: _token, ...form } = req.form;
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  }
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(url.toString(), { method: req.method, headers, body, ...(req.signal ? { signal: req.signal } : {}) });
    // An answer cut off part way (the time limit ran out while it came) is no answer: never an empty success.
    text = await res.text();
  } catch (err) {
    // No answer at all: Meta or the network is down, or the call timed out (withTimeout, or `signal`).
    throw fail(failure("network", 0, err instanceof Error ? err.message : String(err)));
  }
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON: an error page */
  }
  const e = (json as GraphErrorBody | null)?.error;
  if (res.ok && !e && (json !== null || !text)) return (json ?? {}) as T;
  throw fail(
    failure("refused", res.status, e?.message ?? null, {
      code: e?.code ?? null,
      subcode: e?.error_subcode ?? null,
      type: e?.type ?? null,
      userTitle: e?.error_user_title ?? null,
      userMessage: e?.error_user_msg ?? null,
      details: e?.error_data?.details ?? null,
      text: text ? text.slice(0, 300) : null,
      headers: res.headers ?? null,
    }),
  );
}
