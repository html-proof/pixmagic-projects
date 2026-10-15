import { register } from "@shopify/web-pixels-extension";

/**
 * Sends funnel step events (no PII: only event id, name, anonymous clientId,
 * timestamp and the page's pathname) to the bizinsights ingest endpoint, which
 * turns them into where each visit landed, how far it got and where it left.
 * The pathname carries no query string; the API also strips checkout, order and
 * account tokens before storing it. Runs only with analytics consent (see
 * customer_privacy in shopify.extension.toml).
 */
const STEPS = ["page_viewed", "product_viewed", "product_added_to_cart", "checkout_started", "checkout_completed"] as const;

register(({ analytics, settings }) => {
  const url = settings.ingestUrl as string;
  let buffer: Array<{ id: string; name: string; clientId: string; timestamp: string; path?: string }> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (!buffer.length) return;
    const body = JSON.stringify({ events: buffer.splice(0, 50) });
    // text/plain avoids a CORS preflight; the API parses it as JSON.
    fetch(url, { method: "POST", body, keepalive: true, headers: { "content-type": "text/plain" } }).catch(() => {});
  };

  for (const name of STEPS) {
    analytics.subscribe(name, (event) => {
      const path = event.context?.document?.location?.pathname;
      buffer.push({ id: event.id, name, clientId: event.clientId, timestamp: event.timestamp, ...(path ? { path: path.slice(0, 2048) } : {}) });
      if (name === "checkout_completed" || buffer.length >= 20) flush();
      else {
        clearTimeout(timer);
        timer = setTimeout(flush, 2000);
      }
    });
  }
});
