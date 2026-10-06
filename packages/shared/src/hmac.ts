import { createHmac, timingSafeEqual } from "node:crypto";

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
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
