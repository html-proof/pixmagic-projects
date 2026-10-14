// Business events an email automation can react to, and the fields each one carries.
//
// Only events with a real source are offered: the Shopify ones arrive as Shopify webhooks the app
// already subscribes to (shopify-app/shopify.app.toml), and checkout.abandoned is detected from
// checkouts/* webhooks plus an order that never came. Anything else (appointments, invoices,
// tickets...) comes from the business's own systems through the event API as a custom event.
//
// An event's data is a plain nested object: { customer: {...}, order: {...}, store: {...}, data: {...} }.
// Conditions and template variables address it by dotted path, from the lists below only.

export type FieldType = "string" | "number" | "boolean" | "string_list";

export interface EventField {
  path: string;
  label: string;
  type: FieldType;
  /** Personal data: masked in dry-run traces and never logged. */
  pii?: boolean;
  example: string | number | boolean | string[];
}

export interface EventTypeInfo {
  type: string;
  label: string;
  description: string;
  source: "shopify" | "custom";
  fields: EventField[];
}

export const CUSTOMER_FIELDS: EventField[] = [
  { path: "customer.email", label: "Customer email", type: "string", pii: true, example: "alex@example.com" },
  { path: "customer.first_name", label: "Customer first name", type: "string", pii: true, example: "Alex" },
  { path: "customer.last_name", label: "Customer last name", type: "string", pii: true, example: "Rivera" },
  { path: "customer.accepts_marketing", label: "Customer agreed to email marketing", type: "boolean", example: true },
];

const STORE_FIELDS: EventField[] = [
  { path: "store.name", label: "Store name", type: "string", example: "Rivera Goods" },
  { path: "store.domain", label: "Store domain", type: "string", example: "rivera-goods.myshopify.com" },
];

const ORDER_FIELDS: EventField[] = [
  { path: "order.id", label: "Order number (as customers see it)", type: "string", example: "#1001" },
  { path: "order.number", label: "Order number", type: "number", example: 1001 },
  { path: "order.total", label: "Order total", type: "number", example: 129.5 },
  { path: "order.subtotal", label: "Order subtotal", type: "number", example: 119.5 },
  { path: "order.currency", label: "Currency", type: "string", example: "USD" },
  { path: "order.financial_status", label: "Payment status", type: "string", example: "paid" },
  { path: "order.fulfillment_status", label: "Fulfillment status", type: "string", example: "unfulfilled" },
  { path: "order.item_count", label: "Number of items", type: "number", example: 3 },
  { path: "order.product_titles", label: "Products", type: "string_list", example: ["Linen shirt", "Canvas tote"] },
  { path: "order.discount_codes", label: "Discount codes", type: "string_list", example: ["WELCOME10"] },
  { path: "order.shipping_country", label: "Shipping country (two letters)", type: "string", example: "US" },
  { path: "order.status_url", label: "Order status page link", type: "string", example: "https://rivera-goods.myshopify.com/orders/abc/authenticate" },
];

const CHECKOUT_FIELDS: EventField[] = [
  { path: "checkout.total", label: "Cart total", type: "number", example: 84 },
  { path: "checkout.currency", label: "Currency", type: "string", example: "USD" },
  { path: "checkout.item_count", label: "Number of items", type: "number", example: 2 },
  { path: "checkout.product_titles", label: "Products", type: "string_list", example: ["Linen shirt"] },
  { path: "checkout.recovery_url", label: "Link back to the checkout", type: "string", pii: true, example: "https://rivera-goods.myshopify.com/checkouts/recover/abc" },
];

/** Events Insights produces from Shopify. Their names are reserved: the event API can't send them. */
export const SHOPIFY_EVENT_TYPES = ["order.created", "order.paid", "order.cancelled", "order.fulfilled", "checkout.abandoned"] as const;
export type ShopifyEventType = (typeof SHOPIFY_EVENT_TYPES)[number];

export const EVENT_CATALOG: Record<ShopifyEventType, EventTypeInfo> = {
  "order.created": {
    type: "order.created",
    label: "Order placed",
    description: "A customer places an order in a connected Shopify store.",
    source: "shopify",
    fields: [...CUSTOMER_FIELDS, ...ORDER_FIELDS, ...STORE_FIELDS],
  },
  "order.paid": {
    type: "order.paid",
    label: "Order paid",
    description: "Shopify marks an order as paid.",
    source: "shopify",
    fields: [...CUSTOMER_FIELDS, ...ORDER_FIELDS, ...STORE_FIELDS],
  },
  "order.cancelled": {
    type: "order.cancelled",
    label: "Order cancelled",
    description: "An order is cancelled in Shopify.",
    source: "shopify",
    fields: [...CUSTOMER_FIELDS, ...ORDER_FIELDS, ...STORE_FIELDS],
  },
  "order.fulfilled": {
    type: "order.fulfilled",
    label: "Order fulfilled",
    description: "Every item in an order has been fulfilled (shipped or handed over).",
    source: "shopify",
    fields: [...CUSTOMER_FIELDS, ...ORDER_FIELDS, ...STORE_FIELDS],
  },
  "checkout.abandoned": {
    type: "checkout.abandoned",
    label: "Checkout abandoned",
    description: `A customer entered their email at checkout and placed no order within ${60} minutes of their last change.`,
    source: "shopify",
    fields: [...CUSTOMER_FIELDS, ...CHECKOUT_FIELDS, ...STORE_FIELDS],
  },
};

/** How long a checkout must sit untouched, with no order, to count as abandoned. */
export const CHECKOUT_ABANDON_MINUTES = 60;

/**
 * A custom event's name: two to four lowercase dotted parts, like `appointment.booked` or
 * `invoice.overdue`. Names starting with a reserved prefix belong to Shopify events.
 */
export const CUSTOM_EVENT_PATTERN = /^[a-z][a-z0-9_]{0,39}(\.[a-z][a-z0-9_]{0,39}){1,3}$/;
const RESERVED_PREFIXES = ["order.", "checkout.", "refund.", "email.", "insights."];

export const isShopifyEventType = (t: string): t is ShopifyEventType => (SHOPIFY_EVENT_TYPES as readonly string[]).includes(t);
export const isCustomEventType = (t: string) => CUSTOM_EVENT_PATTERN.test(t) && !RESERVED_PREFIXES.some((p) => t.startsWith(p));
export const isEventType = (t: string) => isShopifyEventType(t) || isCustomEventType(t);

/** Suggestions shown when creating a custom event (they need the business's own system to send them). */
export const CUSTOM_EVENT_EXAMPLES = ["appointment.booked", "invoice.overdue", "subscription.expiring", "support.ticket_created", "payment.failed", "customer.signed_up"];

/** A custom event's own fields live under `data.`: lowercase keys, up to three levels deep. */
export const CUSTOM_DATA_KEY = /^[a-z][a-z0-9_]{0,39}$/;
export const CUSTOM_DATA_LIMITS = { maxDepth: 3, maxKeys: 50, maxStringLength: 1000, maxListItems: 50 };

export function eventLabel(type: string): string {
  return isShopifyEventType(type) ? EVENT_CATALOG[type].label : type;
}

export function eventFields(type: string): EventField[] {
  if (isShopifyEventType(type)) return EVENT_CATALOG[type].fields;
  return CUSTOMER_FIELDS;
}

/**
 * The type of a field an event of this type can carry, or null when it can't carry it. A custom
 * event's `data.*` fields are whatever the business sends, so their type is only known at runtime
 * ("any").
 */
export function fieldType(type: string, path: string): FieldType | "any" | null {
  const known = eventFields(type).find((f) => f.path === path);
  if (known) return known.type;
  if (isCustomEventType(type) && path.startsWith("data.")) {
    const parts = path.slice(5).split(".");
    return parts.length >= 1 && parts.length <= CUSTOM_DATA_LIMITS.maxDepth && parts.every((p) => CUSTOM_DATA_KEY.test(p)) ? "any" : null;
  }
  return null;
}

/** Template variables every email can use, whatever its event. */
export const GLOBAL_VARIABLES: EventField[] = [
  { path: "business.name", label: "Your business name", type: "string", example: "Rivera Goods" },
  { path: "business.address", label: "Your business postal address", type: "string", example: "12 Market St, Springfield" },
  { path: "recipient.email", label: "Recipient email", type: "string", pii: true, example: "alex@example.com" },
];

/** Only in marketing email: the recipient's one-click unsubscribe link (added to the footer when the template doesn't use it). */
export const UNSUBSCRIBE_VARIABLE: EventField = { path: "unsubscribe_url", label: "Unsubscribe link", type: "string", example: "https://insights.example/unsubscribe?t=…" };

/** Variables a template written for this event type (null: any event) may use. */
export function templateVariables(type: string | null, category: "transactional" | "marketing"): EventField[] {
  const own = type ? eventFields(type) : CUSTOMER_FIELDS;
  return [...own, ...GLOBAL_VARIABLES, ...(category === "marketing" ? [UNSUBSCRIBE_VARIABLE] : [])];
}

/** Whether a template for this event type may use `path`. */
export function isAllowedVariable(type: string | null, category: "transactional" | "marketing", path: string): boolean {
  if (templateVariables(type, category).some((f) => f.path === path)) return true;
  return !!type && isCustomEventType(type) && fieldType(type, path) === "any";
}

export type EventData = Record<string, unknown>;

function setPath(target: EventData, path: string, value: unknown) {
  const parts = path.split(".");
  let o = target;
  for (const p of parts.slice(0, -1)) o = (o[p] ??= {}) as EventData;
  o[parts[parts.length - 1]!] = value;
}

/** Example data for previews and dry runs: never a real customer. */
export function sampleEventData(type: string | null): EventData {
  const data: EventData = {};
  for (const f of type ? eventFields(type) : CUSTOMER_FIELDS) setPath(data, f.path, f.example);
  if (type && isCustomEventType(type)) data.data = { reference: "A-1042", amount: 49, due_date: "2026-11-01" };
  for (const f of GLOBAL_VARIABLES) if (f.path.startsWith("recipient.")) setPath(data, f.path, f.example);
  return data;
}

/**
 * Read a dotted path from event data. Only own properties of plain objects are followed, so a path
 * can never reach a prototype (`constructor`, `__proto__`) or anything that isn't data.
 */
export function readPath(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (part === "__proto__" || part === "constructor" || part === "prototype") return undefined;
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Problems with a custom event's `data` object (keys, depth, sizes); empty when it is acceptable. */
export function customDataProblems(data: unknown): string[] {
  const problems: string[] = [];
  let keys = 0;
  const walk = (v: unknown, path: string, depth: number) => {
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      if (typeof v === "string" && v.length > CUSTOM_DATA_LIMITS.maxStringLength) problems.push(`${path}: longer than ${CUSTOM_DATA_LIMITS.maxStringLength} characters`);
      if (typeof v === "number" && !Number.isFinite(v)) problems.push(`${path}: not a finite number`);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length > CUSTOM_DATA_LIMITS.maxListItems) problems.push(`${path}: more than ${CUSTOM_DATA_LIMITS.maxListItems} items`);
      for (const item of v.slice(0, CUSTOM_DATA_LIMITS.maxListItems)) {
        if (typeof item !== "string" && typeof item !== "number") problems.push(`${path}: lists may hold only strings and numbers`);
        else if (typeof item === "string" && item.length > CUSTOM_DATA_LIMITS.maxStringLength) problems.push(`${path}: an item is too long`);
      }
      return;
    }
    if (typeof v !== "object") {
      problems.push(`${path}: unsupported value`);
      return;
    }
    if (depth >= CUSTOM_DATA_LIMITS.maxDepth) {
      problems.push(`${path}: nested deeper than ${CUSTOM_DATA_LIMITS.maxDepth} levels`);
      return;
    }
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (++keys > CUSTOM_DATA_LIMITS.maxKeys) {
        problems.push(`more than ${CUSTOM_DATA_LIMITS.maxKeys} fields`);
        return;
      }
      if (!CUSTOM_DATA_KEY.test(k)) problems.push(`${path ? `${path}.` : ""}${k}: field names must be lowercase letters, digits and underscores`);
      else walk(child, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  if (data !== undefined) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) problems.push("data must be an object");
    else walk(data, "", 0);
  }
  return problems.slice(0, 10);
}
