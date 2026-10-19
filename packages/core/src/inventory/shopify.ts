/** Admin GraphQL calls for one store, outside the worker's paced sync chains (the API's stock changes and the product panel). */
import type { Store } from "@app/db";
import type { Coord } from "../coord.js";
import { env } from "../env.js";
import { shopifyGraphql, type FetchLike } from "../shopify.js";
import { withAccessToken } from "../tokens.js";

export type InventoryGql = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

/**
 * The store's Admin GraphQL, with its token (rotated or moved as needed) and Shopify's cost
 * budget honoured; 429 and 5xx answers are retried, which the stock mutations allow because each
 * carries its idempotency key.
 */
export function storeGraphql(store: Pick<Store, "id" | "shopDomain" | "status">, coord: Coord, fetchImpl: FetchLike): InventoryGql {
  return <T>(query: string, variables?: Record<string, unknown>) =>
    withAccessToken(store, coord, fetchImpl, (accessToken) =>
      shopifyGraphql<T>({ shop: store.shopDomain, accessToken, apiVersion: env().SHOPIFY_API_VERSION, query, variables, fetchImpl, maxRetries: 2 }),
    );
}
