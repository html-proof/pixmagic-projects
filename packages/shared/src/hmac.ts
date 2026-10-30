import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/**
 * Verify the `hmac` param Shopify appends to OAuth / app-launch redirects.
 * Message = all params except hmac/signature, sorted by key, joined "k=v&k=v".
 */
export function verifyShopifyQueryHmac(
  query: Record<string, string | string[] | undefined>,
  secret: string,
): boolean {
  const provided = query.hmac;
  if (typeof provided !== "string" || !secret) return false;
  const message = Object.keys(query)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort()
    .map((k) => {
      const v = query[k];
      return `${k}=${Array.isArray(v) ? v.join(",") : (v ?? "")}`;
    })
    .join("&");
  const digest = createHmac("sha256", secret).update(message).digest("hex");
  return safeEqual(digest, provided.toLowerCase());
}

/** Verify X-Shopify-Hmac-Sha256 (base64 HMAC of the *raw* request body). */
export function verifyShopifyWebhookHmac(
  rawBody: Buffer | string,
  headerHmac: string | undefined,
  secret: string,
): boolean {
  if (!headerHmac || !secret) return false;
  const digest = createHmac("sha256", secret).update(rawBody).digest("base64");
  return safeEqual(digest, headerHmac);
}

export function signShopifyQuery(params: Record<string, string>, secret: string): string {
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHmac("sha256", secret).update(message).digest("hex");
}

export function signWebhookBody(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * Verify Meta's X-Hub-Signature-256 ("sha256=<hex HMAC-SHA256 of the raw body, keyed with the
 * app secret>"), which signs every WhatsApp Cloud API webhook.
 */
export function verifyMetaSignature(rawBody: Buffer | string, header: string | undefined, appSecret: string): boolean {
  if (!header || !appSecret || !header.startsWith("sha256=")) return false;
  const digest = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return safeEqual(digest, header.slice(7).toLowerCase());
}

export function signMetaBody(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}
