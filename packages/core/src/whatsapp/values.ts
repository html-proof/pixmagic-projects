/** The values a template's variables are filled with, computed on the server from real order data. */
import type { OrderTracking, Store } from "@app/db";
import type { ParamSource, WhatsappConfig } from "@app/shared";
import { env } from "../env.js";
import { waDecrypt } from "./store.js";

export type Values = Partial<Record<ParamSource, string | null>>;

export function money(amount: number | string | { toString(): string }, currency: string): string {
  const n = Number(amount.toString());
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export const storeName = (store: Pick<Store, "name" | "shopDomain">) => store.name?.trim() || store.shopDomain.replace(/\.myshopify\.com$/, "");

export const trackingUrl = (token: string) => `${env().APP_URL}/track?t=${encodeURIComponent(token)}`;
export const reviewUrl = (token: string) => `${env().APP_URL}/review?t=${encodeURIComponent(token)}`;

export function supportContact(cfg: WhatsappConfig): string | null {
  return cfg.supportPhone || cfg.supportEmail || null;
}

/** Values every order notification can use. */
export function orderValues(
  store: Pick<Store, "name" | "shopDomain">,
  cfg: WhatsappConfig,
  tracking: Pick<OrderTracking, "storeId" | "orderName" | "totalPrice" | "currency" | "tokenEnc" | "reviewTokenEnc">,
  firstName: string | null,
  extra: Values = {},
): Values {
  const token = waDecrypt(tracking.storeId, "track", tracking.tokenEnc);
  const reviewToken = waDecrypt(tracking.storeId, "review", tracking.reviewTokenEnc);
  return {
    customer_name: firstName || "there",
    store_name: storeName(store),
    order_number: tracking.orderName,
    order_total: money(tracking.totalPrice, tracking.currency),
    tracking_url: trackingUrl(token),
    tracking_token: token,
    review_url: reviewUrl(reviewToken),
    review_token: reviewToken,
    support_contact: supportContact(cfg),
    ...extra,
  };
}

/** One line from a Shopify address: "12 MG Road, Kochi 682016, India". */
export function addressLine(a: { address1?: string | null; address2?: string | null; city?: string | null; province?: string | null; zip?: string | null; country?: string | null } | null | undefined): string | null {
  if (!a) return null;
  const cityLine = [a.city, a.province, a.zip].filter((x) => x && String(x).trim()).join(" ");
  const parts = [a.address1, a.address2, cityLine, a.country].map((x) => (x ? String(x).trim() : "")).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** Values for a cart reminder (automatic or sent by hand). */
export function cartValues(store: Pick<Store, "name" | "shopDomain">, cfg: WhatsappConfig, firstName: string | null, total: number | string | { toString(): string }, currency: string): Values {
  return {
    customer_name: firstName || "there",
    store_name: storeName(store),
    cart_total: money(total, currency),
    support_contact: supportContact(cfg),
  };
}

/** Example values for test sends and previews. */
export function sampleValues(store: Pick<Store, "name" | "shopDomain" | "currency">, cfg: WhatsappConfig): Partial<Record<ParamSource, string>> {
  const app = env().APP_URL;
  return {
    customer_name: "Test",
    store_name: storeName(store),
    order_number: "#TEST-1001",
    order_total: money(49.99, store.currency),
    delivery_address: "1 Example Street, Sample City",
    tracking_url: `${app}/track?t=test-message-example-link`,
    tracking_token: "test-message-example-link",
    courier_name: "Test Courier",
    tracking_number: "TEST123456",
    carrier_tracking_url: `${app}/track?t=test-message-example-link`,
    estimated_delivery: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
    review_url: `${app}/review?t=test-message-example-link`,
    review_token: "test-message-example-link",
    checkout_url: app,
    checkout_link_code: "testlink00",
    cart_total: money(49.99, store.currency),
    refund_amount: money(10, store.currency),
    campaign_url: app,
    campaign_link_code: "testlink00",
    discount_code: "TEST10",
    discount_percentage: "10",
    end_date: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    occasion: "Special offers",
    support_contact: supportContact(cfg) ?? "the store",
  };
}
