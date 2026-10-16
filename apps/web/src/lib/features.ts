/**
 * Parts of the app that are built but switched off for now. Flip one to `true` to bring it back;
 * the pages, API routes and Shopify webhooks behind it are all still in place.
 */

/**
 * Settings → Billing (plans charged through Shopify). Hidden 2026-10-15 until paid plans launch.
 * Turn it on together with the API's BILLING_ENABLED setting (apps/aws/src/settings.ts), which
 * lets merchants start a paid plan and applies each plan's store limit. Before launch:
 * docs/shopify-app-store-compliance.md, "Billing".
 */
export const BILLING_ENABLED: boolean = false;

/**
 * Whether Settings → Billing is shown: once billing is on, and in the e2e build before that
 * (apps/web/playwright.config.ts sets NEXT_PUBLIC_E2E_BILLING; next.config.ts refuses it in any
 * other build), so the page is tested before it launches.
 */
export const BILLING_PAGE: boolean = BILLING_ENABLED || process.env.NEXT_PUBLIC_E2E_BILLING === "1";

/**
 * Settings → API keys (read-only `sk_live_` keys for other tools). Hidden 2026-10-15; keys that
 * already exist keep working, since the API still accepts them.
 */
export const API_KEYS_ENABLED: boolean = false;
