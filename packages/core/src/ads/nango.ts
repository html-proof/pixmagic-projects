/**
 * Nango (https://nango.dev, docs/nango.md): the OAuth broker a merchant can connect Meta Ads and
 * Google AdSense through. The merchant authorizes on the platform's own consent screen, opened by
 * Nango's Connect UI, for bizinsights' own Meta app and Google OAuth client (the integrations in
 * bizinsights' Nango environment carry their keys). Nango keeps the tokens and renews them; bizinsights
 * asks Nango for a working access token right before each call and reads the platform with its own
 * clients (ads/meta.ts, ads/adsense.ts), exactly as for a direct connection.
 *
 * Only Nango's REST API is used, server side, with the environment's secret key in the Authorization
 * header: connect sessions, the connections they made (with their tags), a connection's access token,
 * deleting a connection, and the signature on Nango's webhooks. Nothing here reads the environment.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AdProvider } from "@app/shared";
import type { FetchLike } from "../shopify.js";
import { AdsApiError, AdsAuthError, AdsRateLimitedError, AdsRetryableError } from "./common.js";

export interface NangoConfig {
  /** The Nango environment's secret API key (Environment Settings → API Keys). */
  secretKey: string;
  /** Nango's API, https://api.nango.dev (a local stand-in in tests). */
  apiUrl: string;
  fetchImpl?: FetchLike;
}

/**
 * Each platform's integration in bizinsights' Nango environment (its "unique key"). Created by
 * infra/cdk/scripts/nango-setup.mjs from bizinsights' own Meta app and Google OAuth client.
 */
export const NANGO_INTEGRATION: Record<AdProvider, string> = {
  meta: "bizinsights-meta-ads",
  google: "bizinsights-google-ads",
  adsense: "bizinsights-google-adsense",
};

/**
 * The Nango provider each integration is made from. Meta's is `facebook`, not `meta-marketing-api`:
 * only `facebook` gets Nango's long-lived token exchange and renewal (`fb_exchange_token`); the alias
 * would leave every Meta connection to expire after 60 days with a refresh error.
 */
export const NANGO_PROVIDER_TEMPLATE: Record<AdProvider, string> = { meta: "facebook", google: "google", adsense: "google" };

/** The platform an integration key belongs to, or null for one bizinsights didn't make. */
export const nangoProviderOf = (integrationKey: string): AdProvider | null =>
  (Object.entries(NANGO_INTEGRATION).find(([, key]) => key === integrationKey)?.[0] as AdProvider | undefined) ?? null;

/** A connection's id at Nango: what Nango generates (a UUID), never anything with a path or query in it. */
export const isNangoConnectionId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(id);

interface NangoErrorBody {
  code?: string;
  message?: string;
}

/** Nango answered 404: the connection (or session) isn't there. */
export class NangoNotFoundError extends AdsApiError {
  constructor(message: string) {
    super(message, 404, undefined, "provider_error");
  }
}

function retryAfter(headers: Headers | null | undefined): number | null {
  const v = headers?.get("retry-after");
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return Math.min(Math.ceil(s), 3600);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, Math.min(Math.ceil((at - Date.now()) / 1000), 3600)) : null;
}

/** Words in Nango's answer that say the platform itself refused the grant (not a passing failure). */
const DEAD_GRANT = /invalid_grant|revoked|unauthori[sz]ed_client|exhausted|refresh limit|expired|deauthori|access_denied|consent_required/i;

/**
 * A Nango failure as the errors every ad caller sorts by.
 *
 * - The platform refused the grant (revoked, expired, Nango's refresh attempts exhausted), `invalid_credentials`
 *   or a 424: connecting again is the fix (AdsAuthError).
 * - Nango backing off after a failed refresh (`connection_refresh_backoff`, 30 s), or the platform's token
 *   endpoint failing while Nango renewed (`refresh_token_external_error` without a refusal in it: an outage, a
 *   timeout): retried, never "reconnect".
 * - 401/403: bizinsights' own key or integration, not the merchant's to fix.
 */
export function nangoError(httpStatus: number, error: NangoErrorBody | null | undefined, retryAfterS: number | null = null, what = "Nango"): Error {
  const code = error?.code ?? "";
  const message = `${what}: ${error?.message ?? `HTTP ${httpStatus}`}${code ? ` (${code})` : ""}`;
  if (httpStatus === 429 || code === "too_many_requests") return new AdsRateLimitedError(message, retryAfterS, "rate_limited", httpStatus);
  if (code === "connection_refresh_backoff" || /backing off/i.test(error?.message ?? "")) return new AdsRateLimitedError(message, retryAfterS ?? 60, "rate_limited", httpStatus);
  const refused = DEAD_GRANT.test(`${code} ${error?.message ?? ""}`);
  if (code === "refresh_token_external_error" && !refused) return new AdsRetryableError(message, httpStatus);
  if (httpStatus === 424 || code === "invalid_credentials" || code === "refresh_token_external_error" || code === "refresh_exhausted" || code === "connection_test_failed") return new AdsAuthError(message);
  if (httpStatus >= 500) return new AdsRetryableError(message, httpStatus);
  if (httpStatus === 401 || httpStatus === 403 || code === "unknown_provider_config" || code === "invalid_api_key") return new AdsApiError(message, httpStatus, undefined, "not_configured");
  if (httpStatus === 404) return new NangoNotFoundError(message);
  return new AdsApiError(message, httpStatus);
}

async function nangoRequest<T>(
  c: NangoConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts: { query?: Array<[string, string]>; body?: unknown; what?: string } = {},
): Promise<T> {
  const query = opts.query?.length ? `?${new URLSearchParams(opts.query)}` : "";
  let res: Response;
  try {
    res = await (c.fetchImpl ?? fetch)(`${c.apiUrl.replace(/\/+$/, "")}${path}${query}`, {
      method,
      headers: {
        authorization: `Bearer ${c.secretKey}`,
        accept: "application/json",
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch (err) {
    throw new AdsRetryableError(`Nango didn't answer: ${(err as Error)?.name ?? "network error"}`);
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: NangoErrorBody | string };
  if (res.ok) return body;
  const error = typeof body.error === "string" ? { code: body.error } : body.error;
  throw nangoError(res.status, error, retryAfter(res.headers), opts.what);
}

// ---------------------------------------------------------------------------
// Connect sessions
// ---------------------------------------------------------------------------

/**
 * Tags bizinsights puts on a connect session; Nango copies them onto the connection it makes and into
 * its webhooks. Keys are lowercase (Nango lowercases them), values strings of up to 255 characters.
 * No personal data: ids only.
 */
export interface NangoSessionTags {
  /** bizinsights' user who connects (Nango's recommended key). */
  end_user_id: string;
  /** The workspace (Nango's recommended key). */
  organization_id: string;
  bi_store: string;
  bi_provider: AdProvider;
  /** The session's single-use nonce: how the connection is tied to the session that made it. */
  bi_session: string;
}

export interface NangoConnectSession {
  token: string;
  expiresAt: string | null;
}

/**
 * A short-lived (30 minutes) session token for Nango's Connect UI, limited to one integration. Its
 * `authorizationParams` go onto the platform's authorize URL (Meta's Login for Business `config_id`).
 */
export async function nangoCreateConnectSession(
  c: NangoConfig,
  input: { integrationKey: string; tags: NangoSessionTags; authorizationParams?: Record<string, string> },
): Promise<NangoConnectSession> {
  const res = await nangoRequest<{ data?: { token?: string; expires_at?: string } }>(c, "POST", "/connect/sessions", {
    what: "Nango connect session",
    body: {
      tags: input.tags,
      allowed_integrations: [input.integrationKey],
      ...(input.authorizationParams && Object.keys(input.authorizationParams).length
        ? { integrations_config_defaults: { [input.integrationKey]: { authorization_params: input.authorizationParams } } }
        : {}),
    },
  });
  if (!res.data?.token) throw new AdsApiError("Nango didn't return a session token", 502);
  return { token: res.data.token, expiresAt: res.data.expires_at ?? null };
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export interface NangoConnectionInfo {
  connectionId: string;
  integrationKey: string;
  /** The Nango provider it was made from ("facebook", "google"). */
  provider: string | null;
  tags: Record<string, string>;
  createdAt: string | null;
}

interface ConnectionListItem {
  connection_id?: string;
  provider_config_key?: string;
  provider?: string;
  tags?: Record<string, unknown> | null;
  created?: string;
}

/**
 * The connections Nango holds with this id (one per integration at most), with their tags. Never their
 * credentials (the list doesn't carry them).
 */
export async function nangoConnections(c: NangoConfig, connectionId: string): Promise<NangoConnectionInfo[]> {
  const res = await nangoRequest<{ connections?: ConnectionListItem[] }>(c, "GET", "/connections", { query: [["connectionId", connectionId]], what: "Nango connections" });
  return (res.connections ?? [])
    .filter((x): x is ConnectionListItem & { connection_id: string; provider_config_key: string } => typeof x.connection_id === "string" && typeof x.provider_config_key === "string")
    .map((x) => ({
      connectionId: x.connection_id,
      integrationKey: x.provider_config_key,
      provider: x.provider ?? null,
      tags: Object.fromEntries(Object.entries(x.tags ?? {}).filter((e): e is [string, string] => typeof e[1] === "string")),
      createdAt: x.created ?? null,
    }));
}

export interface NangoToken {
  accessToken: string;
  /** When Nango says it expires (Meta's long-lived and Google's one-hour tokens); null when it doesn't. */
  expiresAt: Date | null;
  /** The scopes the platform granted, from its own token answer, when it said (Google: `scope`). */
  grantedScopes?: string[];
}

interface ConnectionCredentials {
  credentials?: {
    type?: string;
    access_token?: string;
    expires_at?: string;
    raw?: { scope?: unknown; granted_scopes?: unknown } | null;
  };
}

const scopesOf = (v: unknown): string[] | undefined => {
  if (typeof v === "string") return v.split(/[\s,]+/).filter(Boolean);
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === "string");
  return undefined;
};

/**
 * A working access token for a connection: Nango renews one that expires within 15 minutes before
 * answering (Google's last an hour; Meta's are long-lived and renewed by Nango's `facebook` template).
 * A grant Nango can't renew is an AdsAuthError (reconnect); a connection Nango doesn't have is too.
 */
export async function nangoAccessToken(c: NangoConfig, integrationKey: string, connectionId: string): Promise<NangoToken> {
  let res: ConnectionCredentials;
  try {
    res = await nangoRequest<ConnectionCredentials>(c, "GET", `/connections/${encodeURIComponent(connectionId)}`, {
      query: [["provider_config_key", integrationKey]],
      what: "Nango connection",
    });
  } catch (err) {
    // Deleted at Nango (by its dashboard, or the merchant's revoke there): the access is gone.
    if (err instanceof NangoNotFoundError) throw new AdsAuthError("The Nango connection no longer exists");
    throw err;
  }
  const cred = res.credentials;
  if (!cred?.access_token || (cred.type && cred.type !== "OAUTH2")) throw new AdsAuthError("The Nango connection holds no OAuth access token");
  const expiresAt = cred.expires_at ? new Date(cred.expires_at) : null;
  return {
    accessToken: cred.access_token,
    expiresAt: expiresAt && Number.isFinite(expiresAt.getTime()) ? expiresAt : null,
    grantedScopes: scopesOf(cred.raw?.scope) ?? scopesOf(cred.raw?.granted_scopes),
  };
}

/** Delete a connection at Nango (its tokens with it). "gone": it wasn't there any more. */
export async function nangoDeleteConnection(c: NangoConfig, integrationKey: string, connectionId: string): Promise<"deleted" | "gone"> {
  try {
    await nangoRequest(c, "DELETE", `/connections/${encodeURIComponent(connectionId)}`, { query: [["provider_config_key", integrationKey]], what: "Nango connection delete" });
    return "deleted";
  } catch (err) {
    if (err instanceof NangoNotFoundError) return "gone";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Webhooks from Nango
// ---------------------------------------------------------------------------

/**
 * Whether a webhook body was signed by Nango: `X-Nango-Hmac-Sha256` is the hex HMAC-SHA256 of the raw
 * body under the environment's webhook signing key (Environment Settings → Webhooks). Any of `keys`
 * may have signed it (two while a key is being rotated). Constant-time.
 */
export function verifyNangoSignature(rawBody: string, signature: string | null | undefined, keys: string[]): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const got = Buffer.from(signature.toLowerCase(), "hex");
  let ok = false;
  for (const key of keys) {
    if (!key) continue;
    const want = createHmac("sha256", key).update(rawBody).digest();
    if (want.length === got.length && timingSafeEqual(want, got)) ok = true;
  }
  return ok;
}

/** An auth webhook from Nango, as bizinsights reads it (every other type is acknowledged and left alone). */
export interface NangoAuthEvent {
  type: "auth";
  /** creation | override (reconnected) | refresh (a renewal; `success` false when it failed) | deletion. */
  operation: string;
  success: boolean;
  connectionId: string;
  integrationKey: string;
  environment: string | null;
  tags: Record<string, string>;
  /** Nango's words for a failure, for the logs only. */
  errorType: string | null;
}

/** The webhook's body as an auth event, or null for anything else (other webhook types, a malformed body). */
export function parseNangoWebhook(body: unknown): NangoAuthEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.type !== "auth" || !isNangoConnectionId(b.connectionId) || typeof b.providerConfigKey !== "string") return null;
  const error = b.error && typeof b.error === "object" ? (b.error as Record<string, unknown>) : null;
  const tags = b.tags && typeof b.tags === "object" ? Object.fromEntries(Object.entries(b.tags as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
  return {
    type: "auth",
    operation: typeof b.operation === "string" ? b.operation : "unknown",
    success: b.success === true,
    connectionId: b.connectionId,
    integrationKey: b.providerConfigKey,
    environment: typeof b.environment === "string" ? b.environment : null,
    tags,
    errorType: typeof error?.type === "string" ? error.type.slice(0, 100) : null,
  };
}
