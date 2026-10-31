/**
 * Who an order or checkout is from, as Shopify's webhook payloads say it: the customer's phone
 * number, first name, items and tags. Read the same way by WhatsApp Automation and Customer
 * Messaging (SMS), which act on these payloads (shopifyPayloads.ts automationOrderSchema,
 * automationCheckoutSchema).
 */
import { normalizePhone } from "@app/shared";
import type { AutomationCheckout, AutomationOrder } from "./shopifyPayloads.js";

/** An order or a checkout: who is buying and how to reach them read the same on both. */
export type Purchase = AutomationOrder | AutomationCheckout;

/** The first phone number on the order that can be read as an international number. */
export function phoneOf(p: Purchase) {
  const country = p.shipping_address?.country_code ?? p.billing_address?.country_code ?? p.customer?.default_address?.country_code ?? null;
  const candidates = [p.phone, p.shipping_address?.phone, p.billing_address?.phone, p.customer?.phone, p.customer?.default_address?.phone, p.sms_marketing_phone];
  for (const c of candidates) {
    const n = normalizePhone(typeof c === "string" ? c : null, country);
    if (n) return n;
  }
  return null;
}

export const firstNameOf = (p: Purchase): string | null => p.shipping_address?.first_name || p.billing_address?.first_name || p.customer?.first_name || null;

export const tagsOf = (p: AutomationOrder): string[] =>
  (Array.isArray(p.tags) ? p.tags.join(",") : (p.tags ?? ""))
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

export function itemsOf(p: Purchase) {
  return (p.line_items ?? []).slice(0, 50).map((li) => ({
    productId: li.product_id ? String(li.product_id) : "",
    title: [li.title, li.variant_title].filter((x) => x && String(x).trim() && x !== "Default Title").join(" – ") || "Item",
    quantity: Number(li.quantity ?? 1),
    price: Number(li.price ?? 0),
  }));
}
