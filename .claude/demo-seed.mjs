// Fills the LOCAL demo (http://localhost:8789, database app_demo) with a sample store:
// products, variants and ~160 orders sent as signed Shopify webhooks through the real
// pipeline (API → queue → worker → database). Test values only; never touches production.
//
//   node .claude/demo-seed.mjs demo.merchant@example.com
//   node .claude/demo-pixel.mjs          (then: storefront visits for the shopping funnel)
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://localhost:8789";
const SHOP = "demo-boutique.myshopify.com";
const email = process.argv[2] ?? "demo.merchant@example.com";
const secret = /^SHOPIFY_API_SECRET=(.*)$/m.exec(readFileSync(resolve(root, "apps/web/e2e/worker.env"), "utf8"))[1].trim();

const sql = (q) =>
  execFileSync("docker", ["exec", "-i", "saas-project20-postgres-1", "psql", "-U", "app", "-d", "app_demo", "-tA", "-v", "ON_ERROR_STOP=1"], { input: q }).toString().trim();

// ---- deterministic pseudo-random
let seed = 20261003;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const weighted = (pairs) => {
  const total = pairs.reduce((a, [, w]) => a + w, 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
  return pairs[0][0];
};

// ---- workspace + store for the signed-in demo user
const userId = sql(`SELECT id FROM users WHERE email = '${email}'`);
if (!userId) throw new Error(`Sign in as ${email} on ${BASE} first`);
sql(`
  DELETE FROM workspaces WHERE id = 'demo_ws';
  DELETE FROM stores WHERE id = 'demo_store';
  INSERT INTO workspaces (id, name) VALUES ('demo_ws', 'Demo Boutique');
  INSERT INTO memberships (id, workspace_id, user_id, role) VALUES ('demo_m', 'demo_ws', '${userId}', 'owner');
  INSERT INTO subscriptions (workspace_id, plan) VALUES ('demo_ws', 'free');
  INSERT INTO stores (id, workspace_id, shop_domain, name, timezone, currency, status, granted_scopes, pixel_ingest_key, installed_at, last_synced_at, updated_at)
  VALUES ('demo_store', 'demo_ws', '${SHOP}', 'Demo Boutique (sample data)', 'America/New_York', 'USD', 'active',
          '{read_orders,read_products}', 'pk_demo', now() - interval '75 days', now(), now());
`);

async function webhook(topic, payload, id) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${BASE}/api/webhooks/shopify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": SHOP,
      "x-shopify-webhook-id": id,
      "x-shopify-hmac-sha256": createHmac("sha256", secret).update(body).digest("base64"),
    },
    body,
  });
  if (!res.ok) throw new Error(`${topic} ${id}: ${res.status} ${await res.text()}`);
  await new Promise((r) => setTimeout(r, 120)); // stay well under the local 300/min limiter
}

// ---- catalog
const CATALOG = [
  ["Linen Shirt", "Northwind", "Shirts", 68, ["S", "M", "L"]],
  ["Organic Cotton Tee", "Northwind", "T-Shirts", 32, ["S", "M", "L", "XL"]],
  ["Merino Crew Sweater", "Alpine & Co", "Knitwear", 120, ["M", "L"]],
  ["Canvas Tote Bag", "Harbor Goods", "Bags", 45, ["Natural", "Black"]],
  ["Leather Card Wallet", "Harbor Goods", "Accessories", 55, ["Tan", "Black"]],
  ["Wool Beanie", "Alpine & Co", "Accessories", 28, ["Grey", "Navy"]],
  ["Relaxed Chinos", "Northwind", "Trousers", 89, ["30", "32", "34"]],
  ["Rain Jacket", "Alpine & Co", "Outerwear", 160, ["M", "L"]],
  ["Ceramic Mug", "Harbor Goods", "Home", 22, ["Default"]],
  ["Scented Candle", "Lumen", "Home", 34, ["Cedar", "Fig"]],
  ["Silk Scarf", "Lumen", "Accessories", 75, ["Default"]],
  ["Gift Card", "Demo Boutique", "Gift cards", 50, ["Default"]],
];
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const products = [];
let vid = 50000;
CATALOG.forEach(([title, vendor, type, price, options], i) => {
  const id = 9000 + i;
  const variants = options.map((opt) => ({
    id: ++vid,
    product_id: id,
    title: opt === "Default" ? "Default Title" : opt,
    sku: `${title.split(" ").map((w) => w[0]).join("")}-${opt}`.toUpperCase().replace(/\s+/g, ""),
    price: price.toFixed(2),
    // Most stock is healthy; a few items are nearly sold out (low-stock demo) or out of stock.
    inventory_quantity: weighted([[Math.floor(20 + rnd() * 60), 6], [Math.floor(1 + rnd() * 4), 2], [0, 1]]),
    inventory_management: "shopify",
    updated_at: iso(now - 86400_000),
  }));
  products.push({ id, title, vendor, type, price, variants, status: i === 11 ? "draft" : "active" });
});
for (const p of products) {
  await webhook(
    "products/create",
    {
      id: p.id,
      title: p.title,
      status: p.status,
      vendor: p.vendor,
      product_type: p.type,
      created_at: iso(now - 200 * 86400_000),
      updated_at: iso(now - 86400_000),
      variants: p.variants,
      variant_gids: p.variants.map((v) => ({ admin_graphql_api_id: `gid://shopify/ProductVariant/${v.id}`, updated_at: v.updated_at })),
    },
    `demo-prod-${p.id}`,
  );
}
console.log(`sent ${products.length} products`);

// ---- orders over the last 75 days (more on weekends and evenings, growing over time)
const sellable = products.filter((p) => p.status === "active");
const CODES = [["WELCOME10", 0.1], ["SUMMER20", 0.2], ["VIP15", 0.15]];
let orderId = 700000;
let lineId = 800000;
let refundId = 600000;
const orders = [];
for (let day = 75; day >= 0; day--) {
  const date = new Date(now - day * 86400_000);
  const dow = date.getUTCDay();
  const base = 1.2 + (75 - day) / 40; // growth trend
  const count = Math.max(0, Math.round(base * (dow === 0 || dow === 6 ? 1.6 : 1) * (0.6 + rnd() * 0.8)));
  for (let k = 0; k < count; k++) {
    const hourUtc = weighted([[14, 1], [16, 2], [18, 2], [20, 3], [22, 3], [0, 3], [2, 2], [12, 1]]);
    const created = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hourUtc, Math.floor(rnd() * 60)));
    if (created.getTime() > now) continue;
    const lines = [];
    const n = weighted([[1, 6], [2, 3], [3, 1]]);
    for (let j = 0; j < n; j++) {
      const p = pick(sellable);
      const v = pick(p.variants);
      lines.push({ id: ++lineId, product_id: p.id, variant_id: v.id, sku: v.sku, title: p.title, quantity: weighted([[1, 8], [2, 2]]), price: v.price });
    }
    const gross = lines.reduce((a, l) => a + Number(l.price) * l.quantity, 0);
    const code = rnd() < 0.27 ? pick(CODES) : null;
    const discount = code ? Math.round(gross * code[1] * 100) / 100 : 0;
    for (const l of lines) l.total_discount = code ? (Math.round(Number(l.price) * l.quantity * code[1] * 100) / 100).toFixed(2) : "0.00";
    const subtotal = Math.round((gross - discount) * 100) / 100;
    const shipping = subtotal >= 100 ? 0 : 6.95;
    const tax = Math.round(subtotal * 0.0825 * 100) / 100;
    const source = weighted([["web", 70], ["pos", 14], ["580111", 9], ["shopify_draft_order", 4], ["iphone", 3]]);
    const ageDays = (now - created.getTime()) / 86400_000;
    const cancelled = rnd() < 0.03;
    const fulfillmentStatus = cancelled ? null : ageDays > 3 ? "fulfilled" : ageDays > 1.5 && rnd() < 0.5 ? "partial" : rnd() < 0.3 ? "fulfilled" : null;
    const fulfilledAt = fulfillmentStatus ? iso(created.getTime() + (8 + rnd() * 56) * 3600_000) : null;
    const id = ++orderId;
    const refunds =
      !cancelled && ageDays > 5 && rnd() < 0.06
        ? [{ id: ++refundId, created_at: iso(created.getTime() + (2 + rnd() * 4) * 86400_000), refund_line_items: [{ subtotal: (Number(lines[0].price) - Number(lines[0].total_discount)).toFixed(2) }] }]
        : [];
    orders.push({
      id,
      name: `#${1000 + id - 700000}`,
      currency: "USD",
      created_at: created.toISOString(),
      updated_at: iso(Math.min(now, created.getTime() + 3 * 86400_000)),
      cancelled_at: cancelled ? iso(created.getTime() + 3600_000) : null,
      financial_status: refunds.length ? "partially_refunded" : cancelled ? "voided" : "paid",
      fulfillment_status: fulfillmentStatus,
      fulfillments: fulfilledAt ? [{ created_at: fulfilledAt }] : [],
      source_name: source,
      discount_codes: code ? [{ code: code[0], amount: discount.toFixed(2), type: "percentage" }] : [],
      subtotal_price: subtotal.toFixed(2),
      total_discounts: discount.toFixed(2),
      total_tax: tax.toFixed(2),
      total_shipping_price_set: { shop_money: { amount: shipping.toFixed(2) } },
      total_price: (subtotal + tax + shipping).toFixed(2),
      line_items: lines,
      refunds,
    });
  }
}
for (const o of orders) await webhook("orders/create", o, `demo-order-${o.id}`);
console.log(`sent ${orders.length} orders`);

// Unit costs come from Shopify's GraphQL sync (not webhooks): set them like it would.
sql(`UPDATE product_variants SET unit_cost = ROUND(price * 0.42, 2) WHERE store_id = 'demo_store'`);
console.log("done");
