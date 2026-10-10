const SHOP_RE = /^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$/;

/**
 * Normalize user input ("My-Store", "https://my-store.myshopify.com/admin", or the admin's own
 * address "admin.shopify.com/store/my-store/orders") into a canonical "my-store.myshopify.com".
 * Returns null for anything that is not a valid myshopify domain (custom domains are rejected:
 * OAuth must hit *.myshopify.com).
 */
export function normalizeShopDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = /^admin\.shopify\.com\/store\/([^/?#]+)/.exec(s)?.[1] ?? s;
  s = s.split(/[/?#]/)[0] ?? "";
  if (!s) return null;
  if (!s.includes(".")) s = `${s}.myshopify.com`;
  return SHOP_RE.test(s) ? s : null;
}

export function isValidShopDomain(shop: string): boolean {
  return SHOP_RE.test(shop);
}
