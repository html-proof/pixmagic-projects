// Fills the LOCAL demo's shopping funnel (http://localhost:8789, database app_demo): ~45 days of
// simulated storefront visits sent as web pixel events through the real ingest endpoint, the way
// the Shopify pixel sends them. Also grants the demo store the pixel scopes so the funnel unlocks.
// Run after demo-seed.mjs (it needs demo_store). Test values only; never touches production.
//
//   node .claude/demo-pixel.mjs
import { execFileSync } from "node:child_process";

const BASE = "http://localhost:8789";
const KEY = "pk_demo";
const DAYS = 45;

const sql = (q) =>
  execFileSync("docker", ["exec", "-i", "saas-project20-postgres-1", "psql", "-U", "app", "-d", "app_demo", "-tA", "-v", "ON_ERROR_STOP=1"], { input: q }).toString().trim();

if (!sql(`SELECT id FROM stores WHERE id = 'demo_store'`)) throw new Error("Run .claude/demo-seed.mjs first");
sql(`
  UPDATE stores SET granted_scopes = ARRAY(SELECT DISTINCT unnest(granted_scopes || '{write_pixels,read_customer_events}'::text[])),
                    pixel_installed = true
  WHERE id = 'demo_store';
  DELETE FROM funnel_visits WHERE store_id = 'demo_store';
  DELETE FROM pixel_events_seen WHERE store_id = 'demo_store';
`);

// ---- deterministic pseudo-random
let seed = 20261006;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const weighted = (pairs) => {
  const total = pairs.reduce((a, [, w]) => a + w, 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
  return pairs[0][0];
};

const PRODUCTS = ["linen-shirt", "organic-cotton-tee", "merino-crew-sweater", "canvas-tote-bag", "leather-card-wallet", "wool-beanie", "relaxed-chinos", "rain-jacket", "ceramic-mug", "scented-candle", "silk-scarf"];
const COLLECTIONS = ["shirts", "knitwear", "accessories", "home", "all", "new-arrivals"];
const CONTENT = ["/pages/about-us", "/blogs/journal/how-to-care-for-linen", "/pages/shipping-returns", "/pages/size-guide"];

// Where a visit lands, then a walk through the store. Each page type has its own odds of the
// shopper moving on or leaving, which is what makes the funnel's drop-offs look like a real store.
const landing = () =>
  weighted([
    [{ type: "home", path: "/" }, 38],
    [{ type: "product", path: `/products/${pick(PRODUCTS)}` }, 27],
    [{ type: "collection", path: `/collections/${pick(COLLECTIONS)}` }, 19],
    [{ type: "content", path: pick(CONTENT) }, 9],
    [{ type: "search", path: "/search" }, 2],
    [{ type: "other", path: "/apps/reviews" }, 5],
  ]);
const NEXT = {
  home: () => weighted([["collection", 45], ["product", 15], ["search", 7], ["content", 5], ["leave", 28]]),
  collection: () => weighted([["product", 52], ["collection", 10], ["search", 3], ["leave", 35]]),
  product: () => weighted([["add", 20], ["product", 20], ["collection", 14], ["leave", 46]]),
  cart: () => weighted([["checkout", 55], ["product", 10], ["leave", 35]]),
  content: () => weighted([["product", 20], ["home", 15], ["leave", 65]]),
  search: () => weighted([["product", 55], ["leave", 45]]),
  other: () => weighted([["home", 30], ["product", 20], ["leave", 50]]),
};
const pathFor = (type) =>
  type === "home" ? "/" : type === "collection" ? `/collections/${pick(COLLECTIONS)}` : type === "product" ? `/products/${pick(PRODUCTS)}` : type === "search" ? "/search" : type === "content" ? pick(CONTENT) : "/cart";

function visit(visitor, startMs) {
  const events = [];
  let t = startMs;
  let n = 0;
  const push = (name, path) => {
    events.push({ id: `demo-${visitor}-${n++}`, name, clientId: visitor, timestamp: new Date(t).toISOString(), path });
    t += (15 + rnd() * 75) * 1000;
  };
  let page = landing();
  for (let pages = 0; pages < 14; pages++) {
    push("page_viewed", page.path);
    if (page.type === "product") push("product_viewed", page.path);
    const next = NEXT[page.type]();
    if (next === "leave") return events;
    if (next === "add") {
      push("product_added_to_cart", page.path);
      // Most go to the cart; some keep shopping.
      page = rnd() < 0.75 ? { type: "cart", path: "/cart" } : { type: "product", path: pathFor("product") };
      continue;
    }
    if (next === "checkout") {
      const token = Math.floor(rnd() * 1e12).toString(36);
      push("checkout_started", `/checkouts/cn/${token}/information`);
      push("page_viewed", `/checkouts/cn/${token}/information`);
      if (rnd() < 0.62) {
        push("page_viewed", `/checkouts/cn/${token}/payment`);
        if (rnd() < 0.72) push("checkout_completed", `/checkouts/cn/${token}/thank-you`);
      }
      return events;
    }
    page = { type: next, path: pathFor(next) };
  }
  return events;
}

// ---- visits over the last DAYS days: busier at weekends and in the evening, growing over time
const now = Date.now();
const all = [];
let visitorNo = 0;
for (let day = DAYS; day >= 0; day--) {
  const date = new Date(now - day * 86400_000);
  const dow = date.getUTCDay();
  const count = Math.round((22 + (DAYS - day) * 0.6) * (dow === 0 || dow === 6 ? 1.4 : 1) * (0.75 + rnd() * 0.5));
  for (let k = 0; k < count; k++) {
    const hourUtc = weighted([[13, 1], [15, 2], [17, 2], [19, 3], [21, 3], [23, 3], [1, 2], [3, 1]]);
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hourUtc, Math.floor(rnd() * 50));
    if (start > now - 30 * 60_000) continue;
    all.push(...visit(`demo-shopper-${++visitorNo}`, start));
  }
}

// The pixel sends at most 50 events per request; the API groups them by shopper and day.
let accepted = 0;
for (let i = 0; i < all.length; i += 50) {
  const res = await fetch(`${BASE}/pixel/${KEY}`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ events: all.slice(i, i + 50) }) });
  if (!res.ok) throw new Error(`pixel ${res.status}: ${await res.text()}`);
  accepted += (await res.json()).accepted;
}
console.log(`sent ${all.length} events from ${visitorNo} visits; accepted ${accepted}`);
console.log(sql(`SELECT count(*) || ' visits, ' || count(*) FILTER (WHERE furthest_step = 4) || ' purchases' FROM funnel_visits WHERE store_id = 'demo_store'`));
