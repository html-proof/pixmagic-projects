/**
 * What Shopify sends us, as Zod schemas: REST webhook payloads (orders, refunds, products and their
 * variants for analytics; orders, checkouts, refunds and parcels as the automations read them; the
 * app and GDPR topics) and Admin GraphQL nodes (orders, products, variants, parcels). normalize.ts
 * works on these types, and so do the WhatsApp and email automations and the webhook consumer.
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
import { parsePayload, parsePayloadList } from "./payloads.js";

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
/** A field read only for display: any scalar, or null. Anything else is read as absent rather than rejecting the payload. */
const looseScalar = z.union([z.string(), z.number(), z.boolean()]).nullish().catch(null);

// ---------------------------------------------------------------- REST webhooks

export const restRefundSchema = obj({
  id: restId,
  created_at: timestamp,
});

/** refunds/create also names the order the refund belongs to (whose sales are then read again). */
export const restRefundWebhookSchema = restRefundSchema.extend({ order_id: restId });

const restLineItem = obj({
  id: restId,
  product_id: restId.nullish(),
  variant_id: restId.nullish(),
  sku: str,
  title: str,
  quantity: quantity.nullish(),
  /** What is left of the line after edits and refunds. */
  current_quantity: quantity.nullish(),
  price: amount.nullish(),
  total_discount: amount.nullish(),
  discount_allocations: z.array(obj({ amount: amount.nullish() })).nullish(),
  gift_card: z.boolean().nullish(),
  tax_lines: z.array(obj({ price: amount.nullish() })).nullish(),
});

const restShippingLine = obj({
  id: restId.nullish(),
  price: amount.nullish(),
  discounted_price: amount.nullish(),
  tax_lines: z.array(obj({ price: amount.nullish() })).nullish(),
});

/** orders/create, updated, paid, cancelled, fulfilled, partially_fulfilled. */
export const restOrderSchema = obj({
  id: restId,
  name: str,
  currency: str,
  created_at: timestamp,
  updated_at: timestamp.nullish(),
  cancelled_at: timestamp.nullish(),
  /** A test order (Bogus Gateway, a payment provider's test mode): Shopify's reports leave it out. */
  test: z.boolean().nullish(),
  /** Whether the prices include tax (GST/VAT stores). */
  taxes_included: z.boolean().nullish(),
  financial_status: str,
  fulfillment_status: str,
  source_name: str,
  landing_site: str,
  referring_site: str,
  subtotal_price: amount.nullish(),
  total_discounts: amount.nullish(),
  total_tax: amount.nullish(),
  total_price: amount.nullish(),
  /** The totals after edits, returns and refunds: they move whenever the order's sales do (`restSalesKey`). */
  current_subtotal_price: amount.nullish(),
  current_total_discounts: amount.nullish(),
  current_total_tax: amount.nullish(),
  current_total_price: amount.nullish(),
  total_shipping_price_set: obj({ shop_money: obj({ amount: amount.nullish() }).nullish() }).nullish(),
  customer: obj({ id: restId.nullish(), orders_count: z.number().nullish() }).nullish(),
  fulfillments: z.array(obj({ created_at: str })).nullish(),
  discount_codes: z.array(obj({ code: str })).nullish(),
  line_items: z.array(restLineItem).nullish(),
  shipping_lines: z.array(restShippingLine).nullish(),
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
  // Product information for the Inventory module. Loosely typed on purpose: one of these in an
  // unexpected shape must not reject the whole product (its variants would then go unrecorded).
  created_at: timestamp.nullish(),
  inventory_item_id: restId.nullish(),
  barcode: looseScalar,
  compare_at_price: looseScalar,
  option1: looseScalar,
  option2: looseScalar,
  option3: looseScalar,
  taxable: looseScalar,
  inventory_policy: looseScalar,
  requires_shipping: looseScalar,
  weight: looseScalar,
  weight_unit: looseScalar,
  position: looseScalar,
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
  // Product information (Inventory module), as loose as the variant's.
  handle: looseScalar,
  body_html: looseScalar,
  /** Comma separated in REST payloads. */
  tags: z.union([z.string(), z.array(z.string())]).nullish(),
  image: obj({ src: looseScalar }).nullish().catch(null),
  images: z.array(obj({ src: looseScalar })).nullish().catch(null),
  /** The option names, in the order of the variants' option1..3. */
  options: z.array(obj({ name: looseScalar, position: looseScalar })).nullish().catch(null),
});

/** products/delete carries only the id. */
export const restProductDeleteSchema = obj({ id: restId });

/** orders/delete carries only the id too. */
export const restOrderDeleteSchema = obj({ id: restId });

export type RestOrder = z.output<typeof restOrderSchema>;
export type RestVariant = z.output<typeof restVariantSchema>;
export type RestProduct = z.output<typeof restProductSchema>;

// ---------------------------------------------------------------- REST webhooks, as the automations read them

/*
 * The WhatsApp and email automations (whatsapp/events.ts, email/events.ts) read more of an order
 * or checkout than analytics does: who the customer is and how to reach them. They have schemas of
 * their own, so a field only they read can't cost analytics an order, nor the other way round.
 * Each module parses a payload only once it is about to act on it, so a store that doesn't use it
 * logs nothing.
 */

const address = obj({
  first_name: str,
  last_name: str,
  phone: str,
  country_code: str,
  address1: str,
  address2: str,
  city: str,
  province: str,
  zip: str,
  country: str,
}).nullish();

/** A total the automations store as a Decimal: text that isn't a number can't be one, so it doesn't fit. */
const decimal = z.union([z.number().finite(), z.string().regex(/^-?\d+(\.\d+)?$/, "not an amount")]);

const automationLineItem = obj({ product_id: restId.nullish(), title: str, variant_title: str, quantity: z.number().nullish(), price: amount.nullish() });

/** Who is buying, how to reach them and what they agreed to: the same fields on orders and checkouts. */
const buyer = {
  email: str,
  phone: str,
  sms_marketing_phone: str,
  buyer_accepts_marketing: z.boolean().nullish(),
  buyer_accepts_sms_marketing: z.boolean().nullish(),
  customer: obj({
    id: restId.nullish(),
    first_name: str,
    last_name: str,
    email: str,
    phone: str,
    accepts_marketing: z.boolean().nullish(),
    email_marketing_consent: obj({ state: str }).nullish(),
    sms_marketing_consent: obj({ state: str }).nullish(),
    default_address: address,
  }).nullish(),
  shipping_address: address,
  billing_address: address,
  line_items: z.array(automationLineItem).nullish(),
  total_price: decimal.nullish(),
  currency: str,
  presentment_currency: str,
  created_at: timestamp.nullish(),
  updated_at: timestamp.nullish(),
};

/** A parcel: an item of an order's `fulfillments`. */
export const fulfillmentSchema = obj({
  id: restId,
  status: str,
  shipment_status: str,
  tracking_company: str,
  tracking_number: str,
  tracking_numbers: z.array(z.string()).nullish(),
  tracking_url: str,
  tracking_urls: z.array(z.string()).nullish(),
  created_at: timestamp.nullish(),
  updated_at: timestamp.nullish(),
});

/** fulfillments/create and /update: a parcel, naming its order. */
export const fulfillmentWebhookSchema = fulfillmentSchema.extend({ order_id: restId });

/** orders/* (create, updated, paid, cancelled, fulfilled, partially_fulfilled). */
export const automationOrderSchema = obj({
  ...buyer,
  id: restId,
  name: str,
  order_number: z.union([z.number(), z.string()]).nullish(),
  contact_email: str,
  subtotal_price: amount.nullish(),
  financial_status: str,
  fulfillment_status: str,
  checkout_token: str,
  processed_at: timestamp.nullish(),
  cancelled_at: timestamp.nullish(),
  /** A comma-separated string; a list is read the same way. */
  tags: z.union([z.string(), z.array(z.string())]).nullish(),
  /** Cart attributes, set by the merchant's theme and apps: values arrive as strings, but needn't. */
  note_attributes: z.array(obj({ name: str, value: z.union([z.string(), z.number(), z.boolean()]).nullish() })).nullish(),
  discount_codes: z.array(obj({ code: str })).nullish(),
  order_status_url: str,
  /** Each parcel is checked on its own (fulfillmentSchema): one that doesn't fit costs only itself. */
  fulfillments: z.array(z.unknown()).nullish(),
});

/** checkouts/create and /update. */
export const automationCheckoutSchema = obj({
  ...buyer,
  token: z.string().min(1),
  completed_at: timestamp.nullish(),
  abandoned_checkout_url: str,
});

/** refunds/create, for what was paid back. */
export const automationRefundSchema = obj({
  id: restId,
  order_id: restId,
  created_at: timestamp.nullish(),
  transactions: z.array(obj({ kind: str, status: str, amount: amount.nullish() })).nullish(),
});

/** fulfillment_events/create: a courier's progress report on one parcel. */
export const fulfillmentEventSchema = obj({
  order_id: restId,
  fulfillment_id: restId,
  status: str,
  happened_at: timestamp.nullish(),
  created_at: timestamp.nullish(),
  estimated_delivery_at: timestamp.nullish(),
});

export type ShopifyFulfillment = z.output<typeof fulfillmentSchema>;
export type AutomationOrder = z.output<typeof automationOrderSchema>;
export type AutomationCheckout = z.output<typeof automationCheckoutSchema>;
export type AutomationRefund = z.output<typeof automationRefundSchema>;

// ---------------------------------------------------------------- REST webhooks: the app and GDPR topics

/**
 * app/scopes_update. `current` is a list (or, from older payloads, a comma-separated string), and
 * required: read as missing, every scope the store has would count as revoked.
 */
export const scopesUpdateSchema = obj({ current: z.union([z.array(z.string()), z.string()]) });

/** app_subscriptions/update: which charge, and its status now. */
export const subscriptionUpdateSchema = obj({ app_subscription: obj({ admin_graphql_api_id: z.string().min(1), status: str }) });

/** customers/data_request. */
/** customers/data_request: who asked, and Shopify's id for the request (one row per request). */
export const customersDataRequestSchema = obj({
  customer: obj({ id: restId.nullish(), email: str, phone: str }).nullish(),
  orders_requested: z.array(restId).nullish(),
  data_request: obj({ id: restId }).nullish(),
});

/**
 * customers/redact: whose data goes. It has to name someone, the customer or their orders: one
 * that names nobody can't be carried out, and the webhook consumer fails it rather than record a
 * redaction that didn't happen.
 */
export const customersRedactSchema = obj({
  customer: obj({ id: restId.nullish(), email: str, phone: str }).nullish(),
  orders_to_redact: z.array(restId).nullish(),
}).refine((p) => p.customer?.id != null || !!p.customer?.email || !!p.customer?.phone || !!p.orders_to_redact?.length, "names no customer and no orders");

export type CustomersRedact = z.output<typeof customersRedactSchema>;

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

/**
 * Order.customerJourneySummary, when it is an object (see graphqlOrderSchema). `customerOrderIndex`
 * is the order's position in its customer's order history (1 = their first purchase; test orders
 * aren't counted), which is how Shopify tells a new customer's order from a returning one's.
 */
export const journeySummarySchema = obj({ ready: z.boolean().nullish(), customerOrderIndex: count.nullish(), lastVisit: visit.nullish() });

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

/** One of Shopify's sales records (SALE_FIELDS in normalize.ts). */
export const graphqlSaleSchema = obj({
  id: gid,
  actionType: str,
  lineType: str,
  quantity: quantity.nullish(),
  totalAmount: moneyBag,
  totalDiscountAmountBeforeTaxes: moneyBag,
  totalTaxAmount: moneyBag,
  /** Product sales only. */
  lineItem: ref,
});

/** A sales agreement: what happened to the order at one moment (placed, edited, refunded, returned). */
export const graphqlAgreementSchema = obj({
  id: gid,
  happenedAt: timestamp,
  sales: obj({ pageInfo, nodes: z.array(graphqlSaleSchema).nullish() }).nullish(),
});

/** An order's agreements read on their own (ORDER_SALES_QUERY), checked all together. */
export const graphqlAgreementListSchema = z.array(graphqlAgreementSchema);

/**
 * What ORDER_SALES_QUERY reads about the order's customer besides its sales: Shopify's position of
 * the order in the customer's history, and the customer's lifetime order count (asked for only with
 * read_customers). Checked on their own: a value that doesn't fit is dropped, never the sales.
 */
export const orderCustomerHistorySchema = obj({
  customerJourneySummary: obj({ customerOrderIndex: count.nullish() }).nullish(),
  customer: obj({ numberOfOrders: count.nullish() }).nullish(),
});

/** One node of ordersQuery() / bulkOrdersQuery(), completed by the per-order detail queries. */
export const graphqlOrderSchema = obj({
  id: gid,
  name: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp.nullish(),
  cancelledAt: timestamp.nullish(),
  test: z.boolean().nullish(),
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
  /** Absent when the query didn't ask for it (then the stored sales are kept), which is told apart from an empty list. */
  agreements: obj({ pageInfo, nodes: z.array(graphqlAgreementSchema).nullish() }).nullish(),
});

export const graphqlProductSchema = obj({
  id: gid,
  title: str,
  status: str,
  vendor: str,
  productType: str,
  createdAt: timestamp.nullish(),
  updatedAt: timestamp,
  // Product information (Inventory module). Absent on pages asked for before it was read.
  handle: str,
  tags: z.array(z.string()).nullish().catch(null),
  onlineStoreUrl: str,
  description: str,
  category: obj({ fullName: str }).nullish().catch(null),
  featuredMedia: obj({ preview: obj({ image: obj({ url: str }).nullish() }).nullish() }).nullish().catch(null),
  collections: obj({ nodes: z.array(obj({ id: gid, title: str })) }).nullish().catch(null),
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
  inventoryItem: obj({
    id: gid.nullish(),
    tracked: z.boolean().nullish(),
    requiresShipping: z.boolean().nullish(),
    unitCost: obj({ amount: amount.nullish() }).nullish(),
    measurement: obj({ weight: obj({ value: z.number().nullish(), unit: str }).nullish() }).nullish().catch(null),
  }).nullish(),
  // Variant details (Inventory module).
  createdAt: timestamp.nullish(),
  barcode: str,
  compareAtPrice: amount.nullish(),
  taxable: z.boolean().nullish(),
  inventoryPolicy: str,
  position: z.number().int().nullish(),
  selectedOptions: z.array(obj({ name: z.string(), value: z.string() })).nullish().catch(null),
});

/** Order.fulfillments as the WhatsApp shipment poll asks for them (SHIPMENTS_QUERY in whatsapp/events.ts). */
export const graphqlShipmentSchema = obj({
  id: gid,
  status: str,
  displayStatus: str,
  updatedAt: timestamp.nullish(),
  inTransitAt: timestamp.nullish(),
  deliveredAt: timestamp.nullish(),
  estimatedDeliveryAt: timestamp.nullish(),
  trackingInfo: z.array(obj({ company: str, number: str, url: str })).nullish(),
});

/** An order of the shipment poll. Each parcel is checked on its own (graphqlShipmentSchema). */
export const graphqlShipmentOrderSchema = obj({ id: gid, fulfillments: z.array(z.unknown()).nullish() });

export type GraphqlMoney = z.output<typeof moneyBag>;
export type GraphqlOrder = z.output<typeof graphqlOrderSchema>;
export type GraphqlProduct = z.output<typeof graphqlProductSchema>;
export type GraphqlVariant = z.output<typeof graphqlVariantSchema>;

// ---------------------------------------------------------------- Inventory (core/inventory)

const quantityList = z.array(obj({ name: z.string(), quantity: quantity }));

/** A Location node (INVENTORY_LOCATIONS_QUERY, INVENTORY_LOCATION_QUERY). */
export const graphqlLocationSchema = obj({
  id: gid,
  name: str,
  isActive: z.boolean().nullish(),
  fulfillsOnlineOrders: z.boolean().nullish(),
  isFulfillmentService: z.boolean().nullish(),
  address: obj({
    address1: str,
    address2: str,
    city: str,
    province: str,
    zip: str,
    country: str,
    countryCode: str,
    formatted: z.array(z.string()).nullish().catch(null),
  })
    .nullish()
    .catch(null),
});

/** One of a location's InventoryLevel nodes (LOCATION_LEVELS_QUERY). */
export const graphqlLocationLevelSchema = obj({
  updatedAt: timestamp,
  item: obj({ id: gid }),
  quantities: quantityList,
});

/** An InventoryItem with its level at one location (ITEM_LEVEL_QUERY); `inventoryLevel` null: not stocked there. */
export const graphqlItemLevelSchema = obj({
  id: gid,
  tracked: z.boolean().nullish(),
  inventoryLevel: obj({ updatedAt: timestamp, quantities: quantityList }).nullish(),
});

/** inventory_levels/update and /connect (and /disconnect, which has no quantities). */
export const restInventoryLevelSchema = obj({
  inventory_item_id: restId,
  location_id: restId,
  available: quantity.nullish(),
  updated_at: timestamp.nullish(),
});

/** inventory_items/update: cost, tracking and shipping, read where they change. */
export const restInventoryItemSchema = obj({
  id: restId,
  sku: str,
  cost: amount.nullish(),
  tracked: z.boolean().nullish(),
  requires_shipping: z.boolean().nullish(),
  updated_at: timestamp.nullish(),
});

/** locations/create, update, delete, activate, deactivate: only the id is read (the location is read again). */
export const restLocationSchema = obj({ id: restId });

export type GraphqlLocation = z.output<typeof graphqlLocationSchema>;
export type GraphqlLocationLevel = z.output<typeof graphqlLocationLevelSchema>;
export type GraphqlItemLevel = z.output<typeof graphqlItemLevelSchema>;

// ---------------------------------------------------------------- parsing

/**
 * `raw` checked against `schema`. When it doesn't fit: one warning naming the fields that didn't
 * (paths, never values), and null, which the caller treats as "skip it" (retrying would get the
 * same payload again). `what` names the payload in the log (a webhook topic, "GraphQL order");
 * `context` adds ids.
 */
export function parseShopify<S extends z.ZodTypeAny>(schema: S, raw: unknown, what: string, context: Record<string, unknown> = {}): z.output<S> | null {
  return parsePayload("Shopify", schema, raw, what, context);
}

/** The items of a page that fit `schema`, in order. The rest are skipped, with one warning for the page. */
export function parseShopifyList<S extends z.ZodTypeAny>(
  schema: S,
  raw: readonly unknown[],
  what: string,
  context: Record<string, unknown> = {},
): Array<z.output<S>> {
  return parsePayloadList("Shopify", schema, raw, what, context);
}
