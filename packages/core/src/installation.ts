import type { Store } from "@app/db";
import type { Coord } from "./coord.js";
import { env } from "./env.js";
import { withTimeout } from "./http.js";
import { shopifyGraphqlWithCost, ShopifyHttpError, type FetchLike } from "./shopify.js";
import { getAccessToken, StoreDisconnectedError } from "./tokens.js";

/**
 * The cheapest question that tells whether Shopify still honours a store's token: it names the
 * installation the token was granted to. Uninstalling the app revokes the token at once, while the
 * app/uninstalled saying so reaches us later (queued, applied by the worker).
 */
export const INSTALLATION_QUERY = "{ currentAppInstallation { id } }";

/** How long a quick check waits for Shopify: a merchant is waiting on the answer. */
const QUICK_CHECK_TIMEOUT_MS = 5_000;

/**
 * True when Shopify accepts the store's token right now; false when it refuses it (401/403, or a
 * refresh of an expiring token it refuses), i.e. the installation the token belongs to is gone
 * or Shopify won't serve it, whatever the store's row says. Anything else (the network, a timeout,
 * Shopify's 429/5xx, a shop that is frozen or gone) is thrown, for the caller to decide what an
 * unanswered question means. Asked once, within a few seconds, for callers a merchant waits on.
 *
 * The token goes out as it stands, not through `withAccessToken`: that answers a refusal by
 * trading the token for an expiring one first, which only costs another call for a revoked one.
 */
export async function shopifyHonoursToken(
  store: Pick<Store, "id" | "shopDomain" | "status">,
  coord: Coord,
  fetchImpl: FetchLike,
): Promise<boolean> {
  const quick = withTimeout(fetchImpl, QUICK_CHECK_TIMEOUT_MS);
  let accessToken: string;
  try {
    accessToken = await getAccessToken(store, coord, quick);
  } catch (err) {
    if (err instanceof StoreDisconnectedError) return false;
    throw err;
  }
  try {
    await shopifyGraphqlWithCost({
      shop: store.shopDomain,
      accessToken,
      apiVersion: env().SHOPIFY_API_VERSION,
      query: INSTALLATION_QUERY,
      fetchImpl: quick,
      maxRetries: 0,
    });
    return true;
  } catch (err) {
    if (err instanceof ShopifyHttpError && (err.status === 401 || err.status === 403)) return false;
    throw err;
  }
}
