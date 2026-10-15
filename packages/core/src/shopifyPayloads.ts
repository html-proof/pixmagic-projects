/**
 * What Shopify sends us, as Zod schemas: REST webhook payloads (orders, refunds, products and their
 * variants) and Admin GraphQL nodes (orders, products, variants). normalize.ts works on these types.
 *
 * This is the boundary. A payload is checked once, where it enters (`parseShopify` in the webhook
 * consumer, the sync pages and the bulk import), before anything is normalized or stored. One that
 * doesn't fit is logged and skipped, so a malformed delivery can neither crash a job (and retry
 * until it is given up on) nor be stored as an "undefined" id, a NaN quantity or an Invalid Date.
 *
 * A schema insists only on what a row cannot do without: the ids, the timestamps it is keyed and
 * bucketed by, and the type of every field the normalizers read. Everything else may be missing or
 * null, as Shopify sends it, and the normalizers' defaults apply as before. Objects let unknown keys
 * through: Shopify adds fields with every API version, and they are not ours to reject.
 */
import { z } from "zod";
import { logger } from "./logger.js";

const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

/** An ISO-8601 timestamp: REST and GraphQL both send strings. */
const timestamp = z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), "not a timestamp");
/** A REST id: a number (accepted as a string too). */
const restId = z.union([z.number(), z.string().min(1)]);
/** A GraphQL global id (gid://shopify/Order/1), or a bare id; never empty after the last "/". */
const gid = z.string().regex(/[^/]$/, "not a Shopify id");
/** Money and prices: strings ("10.00") or numbers. Text that isn't a number counts as 0, as it always has. */
const amount = z.union([z.string(), z.number()]);
/** A whole count. GraphQL's UnsignedInt64 arrives as a string ("4"). */
const count = z.union([z.number().int(), z.string().regex(/^\d+$/, "not a count")]);
const quantity = z.number().int();
const str = z.string().nullish();

// ---------------------------------------------------------------- REST webhooks

export const restRefundSchema = obj({
  id: restId,
  created_at: timestamp,
  refund_line_items: z.array(obj({ subtotal: amount.nullish() })).nullish(),
});

/** refunds/create also names the order the refund belongs to. */
export const restRefundWebhookSchema = restRefundSchema.extend({ order_id: restId });

const restLineItem = obj({
  id: restId,
  product_id: restId.nullish(),
  variant_id: restId.nullish(),
  sku: str,
  title: str,
  quantity: quantity.nullish(),
  price: amount.nullish(),
  total_discount: amount.nullish(),
  discount_allocations: z.array(obj({ amount: amount.nullish() })).nullish(),
});

/** orders/create, updated, paid, cancelled, fulfilled, partially_fulfilled. */
export const restOrderSchema = obj({
  id: restId,
  name: str,
  currency: str,
  created_at: timestamp,
  updated_at: timestamp.nullish(),
  cancelled_at: timestamp.nullish(),
  financial_status: str,
  fulfillment_status: str,
  source_name: str,
  landing_site: str,
  referring_site: str,
  subtotal_price: amount.nullish(),
  total_discounts: amount.nullish(),
  total_tax: amount.nullish(),
  total_price: amount.nullish(),
  total_shipping_price_set: obj({ shop_money: obj({ amount: amount.nullish() }).nullish() }).nullish(),
  customer: obj({ id: restId.nullish(), orders_count: z.number().nullish() }).nullish(),
  fulfillments: z.array(obj({ created_at: str })).nullish(),
  discount_codes: z.array(obj({ code: str })).nullish(),
  line_items: z.array(restLineItem).nullish(),
  refunds: z.array(restRefundSchema).nullish(),
});

export const restVariantSchema = obj({
  id: restId,
  /** Missing on some payloads: the product's own id applies. */
  product_id: restId.nullish(),
  title: str,
  sku: str,
  price: amount.nullish(),
  inventory_quantity: quantity.nullish(),
  /** Present (even as null) only on payloads before API 2024-07; normalizeRestVariant checks for the key. */
  inventory_management: str,
  updated_at: timestamp.nullish(),
});

/**
 * products/create and products/update. One variant that doesn't fit rejects the whole payload
 * rather than just itself: the variants listed are also the ones kept when the rest are pruned,
 * so dropping one would delete it. `variant_gids` lists every variant for the same reason.
 */
export const restProductSchema = obj({
  id: restId,
  title: str,
  status: str,
  vendor: str,
  product_type: str,
  created_at: timestamp.nullish(),
  updated_at: timestamp.nullish(),
  variants: z.array(restVariantSchema).nullish(),
  variant_gids: z.array(obj({ admin_graphql_api_id: gid })).nullish(),
});

/** products/delete carries only the id. */
export const restProductDeleteSchema = obj({ id: restId });

export type RestRefund = z.output<typeof restRefundSchema>;
export type RestOrder = z.output<typeof restOrderSchema>;
export type RestVariant = z.output<typeof restVariantSchema>;
export type RestProduct = z.output<typeof restProductSchema>;

// ---------------------------------------------------------------- Admin GraphQL nodes

const moneyBag = obj({ shopMoney: obj({ amount: amount.nullish() }).nullish() }).nullish();
/** A linked object's `{ id }`; null when it is gone (a deleted product or variant). */
const ref = obj({ id: gid }).nullish();
const pageInfo = obj({ hasNextPage: z.boolean().nullish(), endCursor: str }).nullish();

/** Order.customerJourneySummary.lastVisit: the fields of ShopifyVisit (@app/shared). */
const visit = obj({
  source: str,
  sourceType: str,
  referrerUrl: str,
  landingPage: str,
  utmParameters: obj({ source: str, medium: str, campaign: str }).nullish(),
});

/** Order.customerJourneySummary, when it is an object (see graphqlOrderSchema). */
export const journeySummarySchema = obj({ ready: z.boolean().nullish(), lastVisit: visit.nullish() });

export const graphqlLineItemSchema = obj({
  id: gid,
  title: str,
  quantity: quantity.nullish(),
  sku: str,
  variant: ref,
  product: ref,
  originalUnitPriceSet: moneyBag,
  totalDiscountSet: moneyBag,
});

export const graphqlRefundSchema = obj({
  id: gid,
  createdAt: timestamp,
  refundLineItems: obj({ pageInfo, nodes: z.array(obj({ subtotalSet: moneyBag })).nullish() }).nullish(),
});

/** One node of ordersQuery() / bulkOrdersQuery(), completed by the per-order detail queries. */
export const graphqlOrderSchema = obj({
  id: gid,
  name: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp.nullish(),
  cancelledAt: timestamp.nullish(),
  currencyCode: str,
  displayFinancialStatus: str,
  displayFulfillmentStatus: str,
  sourceName: str,
  discountCodes: z.array(z.string()).nullish(),
  /**
   * Where the customer came from. Checked on its own when the order is normalized (with
   * journeySummarySchema): a journey that doesn't fit costs the visit, not the whole order.
   * Absent when the query didn't ask for it, which is told apart from null.
   */
  customerJourneySummary: z.unknown(),
  subtotalPriceSet: moneyBag,
  totalDiscountsSet: moneyBag,
  totalTaxSet: moneyBag,
  totalShippingPriceSet: moneyBag,
  totalPriceSet: moneyBag,
  customer: obj({ id: gid.nullish(), numberOfOrders: count.nullish() }).nullish(),
  fulfillments: z.array(obj({ createdAt: str })).nullish(),
  lineItems: obj({ pageInfo, nodes: z.array(graphqlLineItemSchema).nullish() }).nullish(),
  refunds: z.array(graphqlRefundSchema).nullish(),
});

export const graphqlProductSchema = obj({
  id: gid,
  title: str,
  status: str,
  vendor: str,
  productType: str,
  createdAt: timestamp.nullish(),
  updatedAt: timestamp,
});

export const graphqlVariantSchema = obj({
  id: gid,
  title: str,
  sku: str,
  price: amount.nullish(),
  inventoryQuantity: quantity.nullish(),
  updatedAt: timestamp,
  product: obj({ id: gid }),
  /** null when Shopify withholds it (ACCESS_DENIED), undefined when not asked for: cost and tracking unknown. */
  inventoryItem: obj({ tracked: z.boolean().nullish(), unitCost: obj({ amount: amount.nullish() }).nullish() }).nullish(),
});

export type GraphqlMoney = z.output<typeof moneyBag>;
export type GraphqlLineItem = z.output<typeof graphqlLineItemSchema>;
export type GraphqlRefund = z.output<typeof graphqlRefundSchema>;
export type GraphqlOrder = z.output<typeof graphqlOrderSchema>;
export type GraphqlProduct = z.output<typeof graphqlProductSchema>;
export type GraphqlVariant = z.output<typeof graphqlVariantSchema>;

// ---------------------------------------------------------------- parsing

/**
 * Where a payload didn't fit, e.g. `line_items.0.price: Expected string, received object`. Paths
 * and Zod's messages only, never the values: a payload can carry a customer's details.
 */
function problems(error: z.ZodError): string[] {
  return error.issues.slice(0, 5).map((i) => {
    // A union's own message is "Invalid input"; its first alternative's says what was wrong.
    const message = (i.code === "invalid_union" ? i.unionErrors[0]?.issues[0]?.message : undefined) ?? i.message;
    return `${i.path.join(".") || "(payload)"}: ${message}`;
  });
}

/**
 * `raw` checked against `schema`. When it doesn't fit: one warning naming the fields that didn't,
 * and null, which the caller treats as "skip it" (retrying would get the same payload again).
 * `what` names the payload in the log (a webhook topic, "GraphQL order"); `context` adds ids.
 */
export function parseShopify<S extends z.ZodTypeAny>(schema: S, raw: unknown, what: string, context: Record<string, unknown> = {}): z.output<S> | null {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  logger.warn({ ...context, payload: what, problems: problems(r.error) }, "Shopify payload doesn't fit its schema; skipped");
  return null;
}

/** The items of a page that fit `schema`, in order. The rest are skipped, with one warning for the page. */
export function parseShopifyList<S extends z.ZodTypeAny>(
  schema: S,
  raw: readonly unknown[],
  what: string,
  context: Record<string, unknown> = {},
): Array<z.output<S>> {
  const out: Array<z.output<S>> = [];
  let first: string[] | null = null;
  for (const item of raw) {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data);
    else first ??= problems(r.error);
  }
  if (first) {
    logger.warn({ ...context, payload: what, skipped: raw.length - out.length, of: raw.length, problems: first }, "Shopify payload doesn't fit its schema; skipped");
  }
  return out;
}
