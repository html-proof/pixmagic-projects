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
