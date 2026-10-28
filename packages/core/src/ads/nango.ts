/**
 * Nango (https://nango.dev), which brokered the ad platforms' sign-ins from 2026-10-22 to 2026-10-28,
 * kept only for leaving it (adConnections/leaveNango.ts): the tokens a connection held there are read
 * once, sealed on bizinsights' own rows, and the connection is deleted at Nango. Nothing connects
 * through Nango any more; this module goes once no row reads through it (docs/ads-setup.md, "Leaving
 * Nango").
 *
 * Only Nango's REST API, server side, with the environment's secret key in the Authorization header.
 * Nothing here reads the environment.
 */
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

/** Each platform's integration in bizinsights' Nango environment (its "unique key"). */
export const NANGO_INTEGRATION: Record<AdProvider, string> = {
  meta: "bizinsights-meta-ads",
  google: "bizinsights-google-ads",
  adsense: "bizinsights-google-adsense",
};

/** A connection's id at Nango: what Nango generates (a UUID), never anything with a path or query in it. */
export const isNangoConnectionId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(id);

interface NangoErrorBody {
  code?: string;
  message?: string;
}

/** Nango answered 404: the connection isn't there. */
export class NangoNotFoundError extends AdsApiError {
  constructor(message: string) {
    super(message, 404, undefined, "provider_error");
  }
}

/** Words in Nango's answer that say the platform itself refused the grant (not a passing failure). */
const DEAD_GRANT = /invalid_grant|revoked|unauthori[sz]ed_client|exhausted|refresh limit|expired|deauthori|access_denied|consent_required/i;

/**
 * A Nango failure as the errors every ad caller sorts by: the platform refused the grant (AdsAuthError:
 * nothing left to move), Nango busy or down (retried later), bizinsights' key refused (ours to fix), a
 * connection that isn't there (NangoNotFoundError).
 */
function nangoError(httpStatus: number, error: NangoErrorBody | null | undefined, what: string): Error {
  const code = error?.code ?? "";
  const message = `${what}: ${error?.message ?? `HTTP ${httpStatus}`}${code ? ` (${code})` : ""}`;
  if (httpStatus === 429 || code === "too_many_requests" || code === "connection_refresh_backoff") return new AdsRateLimitedError(message, 60, "rate_limited", httpStatus);
  const refused = DEAD_GRANT.test(`${code} ${error?.message ?? ""}`);
  if (code === "refresh_token_external_error" && !refused) return new AdsRetryableError(message, httpStatus);
  if (httpStatus === 424 || code === "invalid_credentials" || code === "refresh_token_external_error" || code === "refresh_exhausted") return new AdsAuthError(message);
  if (httpStatus >= 500) return new AdsRetryableError(message, httpStatus);
  if (httpStatus === 401 || httpStatus === 403 || code === "unknown_provider_config" || code === "invalid_api_key") return new AdsApiError(message, httpStatus, undefined, "not_configured");
  if (httpStatus === 404) return new NangoNotFoundError(message);
  return new AdsApiError(message, httpStatus);
}

async function nangoRequest<T>(c: NangoConfig, method: "GET" | "DELETE", path: string, query: Array<[string, string]>, what: string): Promise<T> {
  let res: Response;
  try {
    res = await (c.fetchImpl ?? fetch)(`${c.apiUrl.replace(/\/+$/, "")}${path}?${new URLSearchParams(query)}`, {
      method,
      headers: { authorization: `Bearer ${c.secretKey}`, accept: "application/json" },
    });
  } catch (err) {
    throw new AdsRetryableError(`Nango didn't answer: ${(err as Error)?.name ?? "network error"}`);
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: NangoErrorBody | string };
  if (res.ok) return body;
  throw nangoError(res.status, typeof body.error === "string" ? { code: body.error } : body.error, what);
}

/** What a Nango connection holds of the platform's grant: the tokens bizinsights' own app was given. */
export interface NangoCredentials {
  accessToken: string;
  /** Google's (Meta's long-lived user tokens have none). */
  refreshToken: string | null;
  /** When the access token ends, when Nango says. */
  expiresAt: Date | null;
}

interface ConnectionCredentials {
  credentials?: { type?: string; access_token?: string; refresh_token?: string; expires_at?: string };
}

/**
 * The tokens a connection holds at Nango (GET /connections/{id}). Nango renews an access token that is
 * about to end before answering; the refresh token is Google's own, issued to bizinsights' client, so
 * bizinsights renews it from then on. A connection Nango no longer has, or one whose grant the platform
 * refused, is an AdsAuthError: there is nothing to move.
 */
export async function nangoConnectionCredentials(c: NangoConfig, integrationKey: string, connectionId: string): Promise<NangoCredentials> {
  let res: ConnectionCredentials;
  try {
    // Nango leaves the refresh token out unless asked (`refresh_token=true`).
    res = await nangoRequest<ConnectionCredentials>(
      c,
      "GET",
      `/connections/${encodeURIComponent(connectionId)}`,
      [
        ["provider_config_key", integrationKey],
        ["refresh_token", "true"],
      ],
      "Nango connection",
    );
  } catch (err) {
    if (err instanceof NangoNotFoundError) throw new AdsAuthError("The Nango connection no longer exists");
    throw err;
  }
  const cred = res.credentials;
  if (!cred?.access_token || (cred.type && cred.type !== "OAUTH2")) throw new AdsAuthError("The Nango connection holds no OAuth access token");
  const expiresAt = cred.expires_at ? new Date(cred.expires_at) : null;
  return {
    accessToken: cred.access_token,
    refreshToken: typeof cred.refresh_token === "string" && cred.refresh_token ? cred.refresh_token : null,
    expiresAt: expiresAt && Number.isFinite(expiresAt.getTime()) ? expiresAt : null,
  };
}

/** Delete a connection at Nango (its copy of the tokens with it). "gone": it wasn't there any more. Never revokes the grant. */
export async function nangoDeleteConnection(c: NangoConfig, integrationKey: string, connectionId: string): Promise<"deleted" | "gone"> {
  try {
    await nangoRequest(c, "DELETE", `/connections/${encodeURIComponent(connectionId)}`, [["provider_config_key", integrationKey]], "Nango connection delete");
    return "deleted";
  } catch (err) {
    if (err instanceof NangoNotFoundError) return "gone";
    throw err;
  }
}
