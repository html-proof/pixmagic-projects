import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import {
  automationCheckoutSchema,
  automationOrderSchema,
  automationRefundSchema,
  customersDataRequestSchema,
  customersRedactSchema,
  fulfillmentEventSchema,
  fulfillmentSchema,
  fulfillmentWebhookSchema,
  graphqlShipmentSchema,
  parseShopify,
  scopesUpdateSchema,
  subscriptionUpdateSchema,
} from "../src/index.js";
import { metaInboundSchema, metaPreferenceSchema, metaStatusSchema, metaTemplateValueSchema, metaWebhookSchema, parseMeta, parseMetaList } from "../src/whatsapp/metaPayloads.js";

/**
 * The payloads the automations, the app/GDPR topics and Meta's WhatsApp webhooks read, at the
 * same boundary as the analytics ones (shopifyPayloads.test.ts): what Shopify and Meta really send
 * passes as it came, and what doesn't fit is skipped with one warning naming fields, never values.
 */

let warnings: Array<Record<string, unknown>>;
let prevLevel: string | undefined;
beforeEach(() => {
  warnings = [];
  prevLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "warn";
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
    if (String(line).startsWith("{")) warnings.push(JSON.parse(String(line)) as Record<string, unknown>);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env.LOG_LEVEL = prevLevel;
});

/** An orders/create body as Shopify sends it (2025-10), the fields the automations read and some they don't. */
const order = (over: Record<string, unknown> = {}) => ({
  id: 820982911946154500,
  admin_graphql_api_id: "gid://shopify/Order/820982911946154500",
  name: "#1001",
  order_number: 1001,
  email: "pat@example.com",
  contact_email: "pat@example.com",
  phone: null,
  currency: "INR",
  presentment_currency: "INR",
  created_at: "2026-03-01T10:00:00+05:30",
  updated_at: "2026-03-01T10:05:00+05:30",
  processed_at: "2026-03-01T10:00:00+05:30",
  cancelled_at: null,
  financial_status: "paid",
  fulfillment_status: null,
  checkout_token: "a1b2c3",
  total_price: "1499.00",
  subtotal_price: "1499.00",
  tags: "vip, wholesale",
  note_attributes: [{ name: "whatsapp_opt_in", value: "yes" }],
  discount_codes: [{ code: "WELCOME", amount: "0.00", type: "percentage" }],
  order_status_url: "https://shop.example/orders/1/authenticate?key=x",
  buyer_accepts_marketing: false,
  customer: {
    id: 77,
    email: "pat@example.com",
    first_name: "Pat",
    last_name: "Lee",
    phone: "+919876543210",
    email_marketing_consent: { state: "subscribed", opt_in_level: "single_opt_in", consent_updated_at: null },
    sms_marketing_consent: { state: "not_subscribed", opt_in_level: "single_opt_in", consent_updated_at: null, consent_collected_from: "OTHER" },
    default_address: { country_code: "IN", phone: null },
  },
  shipping_address: { first_name: "Pat", last_name: "Lee", address1: "12 MG Road", address2: null, city: "Kochi", province: "Kerala", zip: "682016", country: "India", country_code: "IN", phone: "098765 43210" },
  billing_address: null,
  line_items: [{ id: 1, product_id: 10, variant_id: 11, title: "Kerala Saree", variant_title: "Red", quantity: 1, price: "1499.00", sku: "KS-R" }],
  fulfillments: [
    { id: 91, status: "success", created_at: "2026-03-02T00:00:00Z", updated_at: "2026-03-02T00:00:00Z", shipment_status: null, tracking_company: "Blue Dart", tracking_number: "BD123", tracking_numbers: ["BD123"], tracking_url: "https://bluedart.test/BD123", tracking_urls: ["https://bluedart.test/BD123"] },
  ],
  ...over,
});

const checkout = (over: Record<string, unknown> = {}) => ({
  id: 9001,
  token: "ck-123",
  email: "pat@example.com",
  phone: "+919876543210",
  created_at: "2026-03-01T09:00:00Z",
  updated_at: "2026-03-01T09:10:00Z",
  completed_at: null,
  currency: "INR",
  presentment_currency: "INR",
  total_price: "2500.00",
  abandoned_checkout_url: "https://shop.example/checkouts/ck-123/recover?key=x",
  buyer_accepts_marketing: true,
  buyer_accepts_sms_marketing: false,
  sms_marketing_phone: null,
  customer: { id: 77, first_name: "Pat" },
  shipping_address: { first_name: "Pat", country_code: "IN" },
  line_items: [{ title: "Mug", variant_title: null, quantity: 2, price: "1250.00", product_id: 12 }],
  ...over,
});

const parsed = <S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> => {
  const out = parseShopify(schema, raw, "test");
  expect(warnings).toEqual([]);
  return out!;
};

describe("Shopify payloads the automations read", () => {
  it("an order, a checkout, a refund and a parcel as Shopify sends them pass as they came", () => {
    expect(parsed(automationOrderSchema, order())).toEqual(order());
    expect(parsed(automationCheckoutSchema, checkout())).toEqual(checkout());
    const refund = { id: 5, order_id: 820982911946154500, created_at: "2026-03-05T12:00:00Z", transactions: [{ kind: "refund", status: "success", amount: "100.00", gateway: "manual" }], refund_line_items: [] };
    expect(parsed(automationRefundSchema, refund)).toEqual(refund);
    const parcel = { ...order().fulfillments[0]!, order_id: 820982911946154500 };
    expect(parsed(fulfillmentWebhookSchema, parcel)).toEqual(parcel);
    const courier = { id: 1, fulfillment_id: 91, order_id: 820982911946154500, status: "out_for_delivery", happened_at: "2026-03-03T08:00:00Z", estimated_delivery_at: null };
    expect(parsed(fulfillmentEventSchema, courier)).toEqual(courier);
  });

  it("the minimal bodies the tests and the demo seeds send still fit", () => {
    // Email's fixture has no dates, WhatsApp's a customer of null and tags of "".
    parsed(automationOrderSchema, { id: 501, name: "#1501", order_number: 1501, email: "a@b.co", total_price: "180.00", line_items: [{ title: "Lamp", quantity: 2 }], customer: { first_name: "Bo" } });
    parsed(automationOrderSchema, order({ customer: null, tags: "", shipping_address: { country_code: "IN" }, fulfillments: [] }));
    parsed(automationCheckoutSchema, { token: "ck-1", total_price: "40.00", line_items: [{ title: "Mug", quantity: 2 }] });
    parsed(fulfillmentSchema, { id: 3, status: "success", created_at: "2026-03-01T00:00:00Z", tracking_url: null });
  });

  it("reads tags as a list too, and cart attributes that aren't text", () => {
    expect(parsed(automationOrderSchema, order({ tags: ["vip", "packed"] })).tags).toEqual(["vip", "packed"]);
    expect(parsed(automationOrderSchema, order({ note_attributes: [{ name: "whatsapp_opt_in", value: true }] })).note_attributes).toEqual([{ name: "whatsapp_opt_in", value: true }]);
  });

  const cases: Array<[string, z.ZodTypeAny, unknown, string]> = [
    ["order without its id", automationOrderSchema, order({ id: undefined }), "id"],
    ["order whose total isn't an amount", automationOrderSchema, order({ total_price: "free" }), "total_price"],
    ["order with an unreadable date", automationOrderSchema, order({ updated_at: "soon" }), "updated_at"],
    ["order whose customer isn't an object", automationOrderSchema, order({ customer: "Pat Lee" }), "customer"],
    ["order with a quantity that isn't a number", automationOrderSchema, order({ line_items: [{ title: "Tee", quantity: "2 units" }] }), "line_items.0.quantity"],
    ["checkout without its token", automationCheckoutSchema, checkout({ token: "" }), "token"],
    ["checkout with a number where its phone goes", automationCheckoutSchema, checkout({ phone: 919876543210 }), "phone"],
    ["refund that doesn't name its order", automationRefundSchema, { id: 5, created_at: "2026-03-05T12:00:00Z" }, "order_id"],
    ["parcel without its id", fulfillmentSchema, { status: "success" }, "id"],
    ["courier report without its parcel", fulfillmentEventSchema, { order_id: 1, status: "delivered" }, "fulfillment_id"],
    ["shipment with a tracking list that isn't one", graphqlShipmentSchema, { id: "gid://shopify/Fulfillment/1", trackingInfo: { number: "X" } }, "trackingInfo"],
  ];

  it.each(cases)("%s: skipped, with a warning naming the field", (_name, schema, raw, path) => {
    expect(parseShopify(schema, raw, "orders/create", { storeId: "s1", module: "whatsapp" })).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: "warn", storeId: "s1", module: "whatsapp", payload: "orders/create" });
    expect((warnings[0]!.problems as string[]).some((p) => p.startsWith(`${path}: `))).toBe(true);
  });

  it("never logs the values: a customer's name, number or address", () => {
    expect(parseShopify(automationOrderSchema, order({ customer: "Pat Lee", phone: 919876543210 }), "orders/create")).toBeNull();
    const logged = JSON.stringify(warnings);
    expect(logged).not.toContain("Pat");
    expect(logged).not.toContain("9876543210");
    expect(logged).not.toContain("MG Road");
  });
});

describe("the app and GDPR topics", () => {
  it("scopes_update needs `current`: without it every scope would read as revoked", () => {
    expect(parsed(scopesUpdateSchema, { current: ["read_orders"], previous: [] }).current).toEqual(["read_orders"]);
    expect(parsed(scopesUpdateSchema, { current: "read_orders,read_products" }).current).toBe("read_orders,read_products");
    expect(parseShopify(scopesUpdateSchema, { previous: ["read_orders"] }, "app/scopes_update")).toBeNull();
    expect(warnings[0]!.problems).toEqual(["current: Invalid input: expected array, received undefined"]);
  });

  it("app_subscriptions/update names the charge", () => {
    parsed(subscriptionUpdateSchema, { app_subscription: { admin_graphql_api_id: "gid://shopify/AppSubscription/1", name: "Pro", status: "ACTIVE" } });
    expect(parseShopify(subscriptionUpdateSchema, { app_subscription: { status: "ACTIVE" } }, "app_subscriptions/update")).toBeNull();
  });

  it("customers/redact must name the customer or their orders", () => {
    parsed(customersRedactSchema, { shop_id: 1, shop_domain: "s.myshopify.com", customer: { id: 7, email: "pat@example.com", phone: "+61400000000" }, orders_to_redact: [1, 2] });
    parsed(customersRedactSchema, { customer: { id: 7 } });
    parsed(customersRedactSchema, { customer: null, orders_to_redact: [1] });
    expect(parseShopify(customersRedactSchema, { customer: {}, orders_to_redact: [] }, "customers/redact")).toBeNull();
    expect(parseShopify(customersRedactSchema, { customer: { id: 7 }, orders_to_redact: "1,2" }, "customers/redact")).toBeNull();
    expect(warnings.map((w) => w.problems)).toEqual([["(payload): names no customer and no orders"], ["orders_to_redact: Invalid input: expected array, received string"]]);
  });

  it("customers/data_request", () => {
    parsed(customersDataRequestSchema, { customer: { id: 7, email: "pat@example.com" }, orders_requested: [1], data_request: { id: 9 } });
    expect(parseShopify(customersDataRequestSchema, { customer: { id: { nested: true } } }, "customers/data_request")).toBeNull();
  });
});

describe("Meta's WhatsApp webhooks", () => {
  const status = { id: "wamid.1", status: "failed", timestamp: "1760000000", recipient_id: "919876543210", errors: [{ code: 131026, title: "Message undeliverable", error_data: { details: "x" } }], pricing: { billable: false, category: "utility", pricing_model: "CBP" } };

  it("statuses, messages, preferences and template updates as Meta sends them pass as they came", () => {
    expect(parseMeta(metaStatusSchema, status, "status")).toEqual(status);
    const message = { from: "919876543210", id: "wamid.in", timestamp: "1760000000", type: "button", button: { text: "Stop promotions", payload: "STOP" } };
    expect(parseMeta(metaInboundSchema, message, "message")).toEqual(message);
    const preference = { wa_id: "919876543210", detail: "User requested to stop marketing messages", category: "marketing_messages", value: "stop", timestamp: 1760000000 };
    expect(parseMeta(metaPreferenceSchema, preference, "preference")).toEqual(preference);
    // Template ids arrive as numbers in real payloads; the tests use strings.
    parseMeta(metaTemplateValueSchema, { event: "APPROVED", message_template_id: 1234567890, message_template_name: "x", message_template_language: "en", reason: "NONE" }, "message_template_status_update");
    expect(warnings).toEqual([]);
  });

  it("a list keeps the items that fit, with one warning (field paths only) for the rest", () => {
    const list = [status, { ...status, id: "" }, { status: "read", recipient_id: "919876543210" }, { ...status, id: "wamid.2" }];
    expect(parseMetaList(metaStatusSchema, list, "status", { wabaId: "1" }).map((s) => s.id)).toEqual(["wamid.1", "wamid.2"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ payload: "status", wabaId: "1", skipped: 2, of: 4, problems: ["id: Too small: expected string to have >=1 characters"] });
    expect(warnings[0]!.msg).toBe("Meta payload doesn't fit its schema; skipped");
    expect(JSON.stringify(warnings)).not.toContain("919876543210");
  });

  it("a body that isn't an object is logged; one for another product is simply not ours", () => {
    expect(parseMeta(metaWebhookSchema, { object: "page", entry: [] }, "webhook")?.object).toBe("page");
    expect(parseMeta(metaWebhookSchema, ["not", "a", "body"], "webhook")).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});
