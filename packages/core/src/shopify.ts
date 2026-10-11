import { normalizeShopDomain } from "@app/shared";
import { logger } from "./logger.js";

export type FetchLike = typeof fetch;

export interface ShopifyAppConfig {
  apiKey: string;
  apiSecret: string;
  scopes: string;
  apiVersion: string;
  redirectUri: string;
}

/** Shopify's authorize URL, in offline access mode (a store-level token for background sync). */
export function buildAuthorizeUrl(cfg: ShopifyAppConfig, shop: string, state: string): string {
  const normalized = normalizeShopDomain(shop);
  if (!normalized) throw new Error("Invalid shop domain");
  const url = new URL(`https://${normalized}/admin/oauth/authorize`);
  url.searchParams.set("client_id", cfg.apiKey);
  url.searchParams.set("scope", cfg.scopes);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Shopify-managed install link: Shopify signs the merchant in, lets them pick a store and
 * approve the app's scopes, then opens the app URL (/shopify/launch) for that store.
 */
export function managedInstallUrl(apiKey: string): string {
  return `https://admin.shopify.com/oauth/install?client_id=${encodeURIComponent(apiKey)}`;
}

export interface TokenResponse {
  accessToken: string;
  scopes: string[];
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
}

function parseTokenResponse(json: Record<string, unknown>, now = Date.now()): TokenResponse {
  if (typeof json.access_token !== "string") throw new Error("Shopify token response missing access_token");
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : null;
  const refreshExpiresIn =
    typeof json.refresh_token_expires_in === "number" ? json.refresh_token_expires_in : null;
  return {
    accessToken: json.access_token,
    scopes: String(json.scope ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    accessTokenExpiresAt: expiresIn ? new Date(now + expiresIn * 1000) : null,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    refreshTokenExpiresAt: refreshExpiresIn ? new Date(now + refreshExpiresIn * 1000) : null,
  };
}

async function tokenRequest(
  shop: string,
  body: Record<string, string | number>,
  fetchImpl: FetchLike,
): Promise<TokenResponse> {
  const res = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new ShopifyHttpError(`Token request failed (${res.status})`, res.status);
  }
  return parseTokenResponse((await res.json()) as Record<string, unknown>);
}

/**
 * Authorization-code exchange for the *permanent* offline token background sync runs on.
 *
 * Sending `expiring: 1` here would opt into Shopify's expiring tokens instead: a 1-hour access
 * token plus a single-use 90-day refresh token. That is deliberately not done. Rotation then
 * became a liveness requirement for every store - a store whose refresh failed once was dead,
 * and the refresh token is invalidated by any later authorize for the same app and shop, so an
 * abandoned authorize could kill a live store's token while leaving its row untouched. A permanent
 * offline token has no expiry and no refresh token, so there is nothing to rotate and nothing to
 * invalidate; it stays valid until the merchant uninstalls.
 */
export function exchangeCodeForToken(
  cfg: ShopifyAppConfig,
  shop: string,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenResponse> {
  return tokenRequest(shop, { client_id: cfg.apiKey, client_secret: cfg.apiSecret, code }, fetchImpl);
}

/** Rotate: Shopify returns a new access token AND a new refresh token. */
export function refreshAccessToken(
  cfg: Pick<ShopifyAppConfig, "apiKey" | "apiSecret">,
  shop: string,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenResponse> {
  return tokenRequest(
    shop,
    {
      client_id: cfg.apiKey,
      client_secret: cfg.apiSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    fetchImpl,
  );
}

/**
 * GraphQL-level failure. `codes` holds each error's extensions.code, e.g.
 * MAX_COST_EXCEEDED (the query asks for more than 1000 cost points; retry with a
 * smaller page) or ACCESS_DENIED.
 */
export class ShopifyGraphqlError extends Error {
  constructor(
    message: string,
    public codes: string[],
  ) {
    super(message);
  }
  get costExceeded() {
    return this.codes.includes("MAX_COST_EXCEEDED") || /exceeds the single query max cost/i.test(this.message);
  }
}

export class ShopifyHttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The cost accounting Shopify returns on every Admin GraphQL response, in `extensions.cost`. */
export interface ShopifyCost {
  requestedQueryCost: number;
  throttleStatus: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number };
}

export interface ShopifyCallOptions {
  shop: string;
  accessToken: string;
  apiVersion: string;
  query: string;
  variables?: Record<string, unknown>;
  fetchImpl?: FetchLike;
  maxRetries?: number;
}

/**
 * Admin GraphQL call that reports how long the caller should wait before its *next* call,
 * instead of sleeping itself.
 *
 * Shopify's cost budget is a leaky bucket: `maximumAvailable` points, refilled at
 * `restoreRate` per second, and each call reserves `requestedQueryCost`. Pacing therefore has
 * to answer one question - can the next call run right now, and if not, how long until it can?
 * Everything else is waste, and the previous version wasted on both counts: it waited whenever
 * `currentlyAvailable < requestedQueryCost * 2`, a threshold it never compared against the
 * bucket ceiling (so for a query costing more than half the bucket it was true after *every*
 * call), and it then slept long enough to restore the entire query cost rather than the part
 * that was actually missing. For the 864-point orders query that is a guaranteed ~8.6s after
 * every page of 7 orders, roughly double what the budget requires.
 *
 * Returning the delay rather than sleeping matters just as much: a sleep inside a queue
 * consumer holds one of only four `insights-sync` concurrency slots doing nothing. Callers that
 * re-enqueue themselves (the sync chains) pass `requiredDelayMs` as the next message's
 * `delaySeconds` and let the slot go.
 */
export async function shopifyGraphqlWithCost<T>(opts: ShopifyCallOptions): Promise<{ data: T; requiredDelayMs: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 5;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(`https://${opts.shop}/admin/api/${opts.apiVersion}/graphql.json`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": opts.accessToken },
      body: JSON.stringify({ query: opts.query, variables: opts.variables ?? {} }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new ShopifyHttpError(`Shopify auth error ${res.status}`, res.status);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= maxRetries) throw new ShopifyHttpError(`Shopify ${res.status}`, res.status);
      const retryAfter = Number(res.headers.get("retry-after") ?? 0);
      await sleep(retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 500 * 2 ** attempt));
      continue;
    }
    // Any other failure (402 for a frozen or unpaid store, 404 for one that is gone, 423 for a
    // locked one) answers `{"errors": "<text>"}`, a string rather than GraphQL's array, and asking
    // again won't change it.
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { errors?: unknown } | null;
      const detail = typeof body?.errors === "string" ? `: ${body.errors}` : "";
      throw new ShopifyHttpError(`Shopify ${res.status}${detail}`, res.status);
    }
    const json = (await res.json()) as {
      data?: T;
      errors?: Array<{ message: string; extensions?: { code?: string } }>;
      extensions?: { cost?: ShopifyCost };
    };
    const throttled = json.errors?.some((e) => e.extensions?.code === "THROTTLED");
    if (throttled) {
      if (attempt >= maxRetries) throw new ShopifyHttpError("Shopify throttled", 429);
      const cost = json.extensions?.cost;
      const wait = cost
        ? Math.ceil(((cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable) / cost.throttleStatus.restoreRate) * 1000)
        : 1000 * 2 ** attempt;
      await sleep(Math.max(250, wait));
      continue;
    }
    if (json.errors?.length) {
      const codes = json.errors.map((e) => e.extensions?.code ?? "");
      // Fields the app isn't approved for (e.g. protected customer data) come back as null with
      // ACCESS_DENIED errors next to otherwise valid data: keep the data, log what was withheld.
      if (json.data && codes.every((c) => c === "ACCESS_DENIED")) {
        logger.warn({ shop: opts.shop, errors: json.errors.map((e) => e.message).slice(0, 3) }, "shopify withheld some fields");
      } else {
        throw new ShopifyGraphqlError(`Shopify GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`, codes);
      }
    }
    return { data: json.data as T, requiredDelayMs: pacingDelayMs(json.extensions?.cost, opts.shop) };
  }
}

/**
 * How long until the bucket can afford another call of the same cost.
 *
 * `requestedQueryCost` is the right figure to budget for even though the call may have cost
 * less: it is what Shopify reserves up front, so it is what the next call has to have available.
 * Clamping it to `maximumAvailable` keeps the answer finite - a query costing more than the
 * bucket can ever hold would otherwise demand a wait that never arrives, and Shopify would
 * reject that query outright anyway.
 */
function pacingDelayMs(cost: ShopifyCost | undefined, shop: string): number {
  if (!cost) return 0;
  const { maximumAvailable, currentlyAvailable, restoreRate } = cost.throttleStatus;
  if (!(restoreRate > 0)) return 0;
  const needed = Math.min(cost.requestedQueryCost, maximumAvailable);
  const deficit = needed - currentlyAvailable;
  if (deficit <= 0) return 0;
  const wait = Math.ceil((deficit / restoreRate) * 1000);
  logger.debug({ shop, wait, currentlyAvailable, needed }, "shopify pacing");
  return wait;
}

/**
 * Admin GraphQL call that paces itself, for callers with nowhere to put a delay (the one-shot
 * `shop` query, the pixel mutation, the per-order detail fetches inside a page). Callers that
 * re-enqueue themselves should use `shopifyGraphqlWithCost` and carry the delay on the message.
 */
export async function shopifyGraphql<T>(opts: ShopifyCallOptions): Promise<T> {
  const { data, requiredDelayMs } = await shopifyGraphqlWithCost<T>(opts);
  if (requiredDelayMs > 0) await sleep(requiredDelayMs);
  return data;
}
