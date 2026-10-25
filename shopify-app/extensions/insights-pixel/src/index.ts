import { register } from "@shopify/web-pixels-extension";

/**
 * Sends funnel step events to the bizinsights ingest endpoint, which turns them into where each
 * visit landed, how far it got, where it left, where it came from and which products it carried.
 * No PII: each event is its id, name, anonymous clientId, timestamp and the page's pathname, and
 * optionally:
 * - `arrival`, with the page view of a page reached from outside the store (another site, or none):
 *   the referring site's host, the landing link's utm_source and utm_medium, and the names of the
 *   ad click ids it carried. Never a URL, another site's path or a query string; the API keeps one
 *   word for the source (arrivalSource in packages/shared/src/funnel.ts).
 * - `products`, with an add to cart or a checkout: the handles of the products it holds.
 * The pathname carries no query string; the API also strips checkout, order and account tokens
 * before storing it. Runs only with analytics consent (see customer_privacy in
 * shopify.extension.toml). The API takes events without the optional fields too (older pixels).
 */
const STEPS = ["page_viewed", "product_viewed", "product_added_to_cart", "checkout_started", "checkout_completed"] as const;
/** The ad click ids the API reads (CLICK_IDS in packages/shared/src/funnel.ts): only whether the link had one. */
const CLICK_IDS = ["gclid", "gbraid", "wbraid", "fbclid", "ttclid", "msclkid"] as const;
/** Products named per event, and characters per handle or tag value: the API refuses a batch with more. */
const MAX_PRODUCTS = 50;
const MAX_HANDLE = 200;
const MAX_TAG = 100;

interface Arrival {
  ref?: string;
  utmSource?: string;
  utmMedium?: string;
  click?: string[];
}

interface PixelEvent {
  id: string;
  name: string;
  clientId: string;
  timestamp: string;
  path?: string;
  arrival?: Arrival;
  products?: string[];
}

interface Doc {
  referrer?: string;
  location?: { hostname?: string; pathname?: string; search?: string };
}

type ProductRef = { url?: string | null } | null | undefined;
interface EventData {
  cartLine?: { merchandise?: { product?: ProductRef } | null } | null;
  checkout?: { lineItems?: Array<{ variant?: { product?: ProductRef } | null }> } | null;
}

const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, "");

/** How the shopper reached this page when it wasn't from a page of this store; undefined otherwise. */
function arrivalOf(doc: Doc | undefined): Arrival | undefined {
  const here = doc?.location?.hostname;
  if (!here) return undefined;
  let ref = "";
  try {
    ref = doc.referrer ? new URL(doc.referrer).hostname : "";
  } catch {
    // Not a URL: as good as none.
  }
  if (ref && bareHost(ref) === bareHost(here)) return undefined;
  const query = new URLSearchParams(doc.location?.search ?? "");
  const tag = (name: string) => query.get(name)?.trim().slice(0, MAX_TAG) || undefined;
  const utmSource = tag("utm_source");
  const utmMedium = tag("utm_medium");
  const click = CLICK_IDS.filter((c) => query.has(c));
  return { ...(ref ? { ref: bareHost(ref).slice(0, 253) } : {}), ...(utmSource ? { utmSource } : {}), ...(utmMedium ? { utmMedium } : {}), ...(click.length ? { click } : {}) };
}

/** A product's handle from its storefront URL: "/en-au/products/linen-tee?variant=1" → "linen-tee". */
function handleOf(product: ProductRef): string | undefined {
  const m = product?.url ? /\/products\/([^/?#]+)/.exec(product.url) : null;
  return m?.[1] ? m[1].slice(0, MAX_HANDLE) : undefined;
}

/** The products an add to cart or a checkout holds, by handle. */
function productsOf(name: string, data: EventData | undefined): string[] | undefined {
  const refs = name === "product_added_to_cart" ? [data?.cartLine?.merchandise?.product] : name === "checkout_started" || name === "checkout_completed" ? (data?.checkout?.lineItems ?? []).map((l) => l.variant?.product) : null;
  if (!refs) return undefined;
  return [...new Set(refs.map(handleOf).filter((h): h is string => !!h))].slice(0, MAX_PRODUCTS);
}

register(({ analytics, settings }) => {
  const url = settings.ingestUrl as string;
  let buffer: PixelEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (!buffer.length) return;
    const body = JSON.stringify({ events: buffer.splice(0, 50) });
    // text/plain avoids a CORS preflight; the API parses it as JSON.
    fetch(url, { method: "POST", body, keepalive: true, headers: { "content-type": "text/plain" } }).catch(() => {});
  };

  for (const name of STEPS) {
    analytics.subscribe(name, (event) => {
      const doc = event.context?.document as Doc | undefined;
      const path = doc?.location?.pathname;
      const arrival = name === "page_viewed" ? arrivalOf(doc) : undefined;
      const products = productsOf(name, (event as { data?: EventData }).data);
      buffer.push({
        id: event.id,
        name,
        clientId: event.clientId,
        timestamp: event.timestamp,
        ...(path ? { path: path.slice(0, 2048) } : {}),
        ...(arrival ? { arrival } : {}),
        ...(products ? { products } : {}),
      });
      if (name === "checkout_completed" || buffer.length >= 20) flush();
      else {
        clearTimeout(timer);
        timer = setTimeout(flush, 2000);
      }
    });
  }
});
