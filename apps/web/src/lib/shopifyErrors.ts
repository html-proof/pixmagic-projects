/**
 * What to tell a merchant when connecting a Shopify store fails, by the code the API redirects
 * back with (`?error=`) or answers with. Shared by the connect page and Settings → Stores.
 */
export const OAUTH_ERRORS: Record<string, string> = {
  invalid_hmac: "Shopify's response couldn't be verified. Please try again.",
  state_mismatch: "The connection was started in a different browser or tab. Please start again here.",
  state_expired: "That connection link expired. Please start again.",
  session_mismatch: "You were signed out during the connection. Sign in and try again.",
  missing_required_scopes: "We need permission to read orders to show any metrics. Please approve access.",
  store_taken: "That store is already connected to another workspace.",
  exchange_failed: "Shopify didn't complete the connection. Please try again.",
  stale_request: "That request was too old. Please try again.",
  shop_mismatch: "Shopify returned a different store than the one you picked. Please try again.",
  app_mismatch: "Shopify answered for a different version of our app than the one this connection started with. Please start again.",
  missing_params: "Shopify didn't send everything we need. Please try again.",
  invalid_shop: "Enter your store's myshopify.com address, e.g. your-store.myshopify.com.",
  shop_required: "Enter your store's myshopify.com address so we can open the right install page.",
  app_unavailable: "This store can't install our app yet. Please contact support so we can set it up for your store.",
  launch_unverified: "That link didn't come through from Shopify intact. Open Insights again from your Shopify admin, or enter your store address below.",
  temporarily_unavailable: "We couldn't reach our servers. Please try again in a minute.",
};
