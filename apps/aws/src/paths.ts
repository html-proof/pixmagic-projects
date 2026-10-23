/**
 * Which requests are the API's and which are the static UI's: for the function (index.ts) and the
 * local server (local.ts), and for CloudFront (infra/cdk/lib/app-stack.ts), which gives the UI's a
 * page of its own while the function can't answer. No imports: the CDK app loads this file too.
 */

/** API paths served without the /api prefix (webhooks, pixel, Shopify, health checks). */
const BARE_API = /^\/(webhooks|pixel|shopify)\/|^\/(healthz|readyz)$/;
const API_PREFIX = /^\/api(\/|$)/;

/** The API route a path is for (`/api/me` → `/me`), or null for the static UI. */
export function apiPath(pathname: string): string | null {
  if (API_PREFIX.test(pathname)) return pathname.slice(4) || "/";
  if (BARE_API.test(pathname)) return pathname;
  return null;
}

/** The same paths as CloudFront path patterns (`*` is any run of characters, case counts). */
export const API_PATH_PATTERNS = ["/api", "/api/*", "/webhooks/*", "/pixel/*", "/shopify/*", "/healthz", "/readyz"] as const;
