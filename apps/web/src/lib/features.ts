/**
 * Parts of the app that are built but switched off for now. Flip one to `true` to bring it back;
 * the pages, API routes and Shopify webhooks behind it are all still in place.
 */

/** Settings → Billing (plans charged through Shopify). Hidden 2026-10-15 until paid plans launch. */
export const BILLING_ENABLED: boolean = false;

/**
 * Settings → API keys (read-only `sk_live_` keys for other tools). Hidden 2026-10-15; keys that
 * already exist keep working, since the API still accepts them.
 */
export const API_KEYS_ENABLED: boolean = false;
