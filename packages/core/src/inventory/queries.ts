/**
 * The GraphQL documents of the Inventory module: Shopify's locations, the stock levels at each
 * one, a single item's level (read again after a webhook or a change made here), the stock
 * mutations (each with Shopify's required @idempotent key, API 2026-04+), and the shop-specific
 * webhook subscriptions the module needs once its scopes are granted.
 *
 * Requested cost model as in ../shopifyQueries.ts (packages/core/test/queryCost.ts re-derives it).
 */
import { QUANTITY_NAMES } from "@app/shared";

/** Every quantity state, as the `names` variable of the level queries. */
export const LEVEL_NAMES: readonly string[] = QUANTITY_NAMES;

/** Page sizes of the paged inventory reads (overridable per message, halved on MAX_COST_EXCEEDED). */
export const INVENTORY_PAGE_SIZE = { locations: 250, levels: 200 } as const;

/**
 * Every location, active or not, app-managed (fulfillment service) included, as Shopify Admin
 * lists stock for them. Cost per Location node: 1 + address 1 = 2;
 * locations(first: $first) = 2 + 1 (pageInfo) + $first × 2 → 250 → 503.
 */
export const INVENTORY_LOCATIONS_QUERY = /* GraphQL */ `
  query InventoryLocations($first: Int!, $cursor: String) {
    locations(first: $first, after: $cursor, includeInactive: true, includeLegacy: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name isActive fulfillsOnlineOrders isFulfillmentService
        address { address1 address2 city province zip country countryCode formatted }
      }
    }
  }`;

/** One location (after a locations/* webhook). Cost 2. */
export const INVENTORY_LOCATION_QUERY = /* GraphQL */ `
  query InventoryLocation($id: ID!) {
    location(id: $id) {
      id name isActive fulfillsOnlineOrders isFulfillmentService
      address { address1 address2 city province zip country countryCode formatted }
    }
  }`;

/**
 * A page of one location's stock levels, every quantity state of each. Cost: location 1 +
 * inventoryLevels(first) = 2 + 1 (pageInfo) + $first × (1 + item 1 + quantities 1) → 200 → 604.
 */
export const LOCATION_LEVELS_QUERY = /* GraphQL */ `
  query LocationLevels($id: ID!, $first: Int!, $cursor: String, $names: [String!]!) {
    location(id: $id) {
      id
      inventoryLevels(first: $first, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { updatedAt item { id } quantities(names: $names) { name quantity } }
      }
    }
  }`;

/** One item's level at one location, every state. Cost: inventoryItem 1 + inventoryLevel 1 + quantities 1 = 3. */
export const ITEM_LEVEL_QUERY = /* GraphQL */ `
  query InventoryItemLevel($item: ID!, $location: ID!, $names: [String!]!) {
    inventoryItem(id: $item) {
      id tracked
      inventoryLevel(locationId: $location) { updatedAt quantities(names: $names) { name quantity } }
    }
  }`;

/**
 * What the product panel reads live: the product's images and its options (stored copies hold
 * only the featured image). Cost: product 1 + media(first: 10) (2 + 10 × (1 + preview 1 + image 1))
 * 32 + options(first: 3) (3 × (1 + optionValues 1)) 6 = 39.
 */
export const PRODUCT_MEDIA_QUERY = /* GraphQL */ `
  query ProductMedia($id: ID!) {
    product(id: $id) {
      id
      media(first: 10) { nodes { preview { image { url altText } } } }
      options(first: 3) { name optionValues { name } }
    }
  }`;

const GROUP = "inventoryAdjustmentGroup { id createdAt reason changes { name delta } }";

/** A delta on `available` (increase, decrease, correction). */
export const INVENTORY_ADJUST_MUTATION = /* GraphQL */ `
  mutation InventoryAdjust($input: InventoryAdjustQuantitiesInput!, $key: String!) {
    inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
      ${GROUP}
      userErrors { field message code }
    }
  }`;

/** A new quantity for `available` (set) or `on_hand` (stocktake). */
export const INVENTORY_SET_MUTATION = /* GraphQL */ `
  mutation InventorySet($input: InventorySetQuantitiesInput!, $key: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $key) {
      ${GROUP}
      userErrors { field message code }
    }
  }`;

/** Units moved between states at one location (available → damaged). */
export const INVENTORY_MOVE_MUTATION = /* GraphQL */ `
  mutation InventoryMove($input: InventoryMoveQuantitiesInput!, $key: String!) {
    inventoryMoveQuantities(input: $input) @idempotent(key: $key) {
      ${GROUP}
      userErrors { field message code }
    }
  }`;

/** The store's shop-specific webhook subscriptions (the toml's app-wide ones aren't listed). */
export const WEBHOOK_SUBSCRIPTIONS_QUERY = /* GraphQL */ `
  query WebhookSubscriptions($cursor: String) {
    webhookSubscriptions(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id topic uri }
    }
  }`;

export const WEBHOOK_SUBSCRIPTION_CREATE = /* GraphQL */ `
  mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
      webhookSubscription { id topic }
      userErrors { field message }
    }
  }`;

/**
 * The topics the module subscribes each store to once it holds the scopes they need: stock
 * changes (read_inventory) and locations (read_locations). They can't go in the app's toml: the
 * scopes are optional there, granted after install, and the toml's subscriptions are the app's.
 */
export const INVENTORY_WEBHOOK_TOPICS: ReadonlyArray<{ topic: string; scope: string }> = [
  { topic: "INVENTORY_LEVELS_UPDATE", scope: "read_inventory" },
  { topic: "INVENTORY_LEVELS_CONNECT", scope: "read_inventory" },
  { topic: "INVENTORY_LEVELS_DISCONNECT", scope: "read_inventory" },
  { topic: "INVENTORY_ITEMS_UPDATE", scope: "read_inventory" },
  { topic: "LOCATIONS_CREATE", scope: "read_locations" },
  { topic: "LOCATIONS_UPDATE", scope: "read_locations" },
  { topic: "LOCATIONS_DELETE", scope: "read_locations" },
  { topic: "LOCATIONS_ACTIVATE", scope: "read_locations" },
  { topic: "LOCATIONS_DEACTIVATE", scope: "read_locations" },
];

export const itemGid = (id: string) => `gid://shopify/InventoryItem/${id}`;
export const locationGid = (id: string) => `gid://shopify/Location/${id}`;
export const productGid = (id: string) => `gid://shopify/Product/${id}`;
/** What Shopify's adjustment group points back at: our adjustment's row (never a gid://shopify/ uri). */
export const adjustmentUri = (id: string) => `gid://bizinsights/InventoryAdjustment/${id}`;
