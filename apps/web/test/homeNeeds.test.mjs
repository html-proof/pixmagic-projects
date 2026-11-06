import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

/**
 * The simple Home's "Needs you" (components/dashboard/homeNeeds.ts): open problems from the bell,
 * orders waiting to ship, stock running out and sales with no cost per item, worst first, each with
 * the one button that does something about it. Never the bell's notes, nor another store's problems.
 */
const load = async (path, deps = {}) => {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const exports = {};
  new Function("require", "exports", outputText)((id) => {
    assert.ok(id in deps, `unexpected import ${id}`);
    return deps[id];
  }, exports);
  return exports;
};
const health = await load("../../../packages/shared/src/health.ts");
const ALERT_PATH = { shopify: "/settings/stores", ads: "/settings/ads", whatsapp: "/dashboard/whatsapp-automation", inventory: "/inventory/low-stock", general: "/support" };
const { needsOf } = await load("../src/components/dashboard/homeNeeds.ts", { "@app/shared/alerts": { ALERT_PATH }, "@app/shared/health": health });

const money = (n) => `$${n.toFixed(2)}`;

/** A dashboard answer for one store, with the modules given. */
const overview = (modules = {}, status = "active") => ({ store: { id: "s1", shopDomain: "demo.myshopify.com", status }, modules });
const alert = (over) => ({ id: "a1", severity: "warning", area: "whatsapp", title: "WhatsApp is logged out", body: "Messages wait 48 hours.", store: null, createdAt: "2026-11-05T01:00:00Z", ...over });
const inventory = (current, lowStockItems = []) => ({ current: { trackedVariants: 40, unitsInStock: 900, ...current }, lowStockItems });

test("nothing to do: an empty list, so the Home says so", () => {
  assert.deepEqual(needsOf({ ov: overview(), alerts: [], costs: null, money, stockHref: null }), []);
  // While the alerts load (null) the rest still shows.
  const ov = overview({ fulfillment: { current: {}, openNow: 1, oldestOpenDays: 0 } });
  assert.equal(needsOf({ ov, alerts: null, costs: null, money, stockHref: null }).length, 1);
});

test("orders waiting to ship open Shopify: bizinsights doesn't ship them", () => {
  const ov = overview({ fulfillment: { current: {}, openNow: 3, oldestOpenDays: 2 } });
  const [n] = needsOf({ ov, alerts: [], costs: null, money, stockHref: null });
  assert.equal(n.text, "3 orders waiting to ship · the oldest for 2 days");
  assert.equal(n.tone, "warn");
  assert.deepEqual(n.action, { label: "Open in Shopify", href: "https://demo.myshopify.com/admin/orders", external: true });
  // Over three days is urgent.
  const late = overview({ fulfillment: { current: {}, openNow: 1, oldestOpenDays: 5 } });
  const [l] = needsOf({ ov: late, alerts: [], costs: null, money, stockHref: null });
  assert.equal(l.text, "1 order waiting to ship · the oldest for 5 days");
  assert.equal(l.tone, "danger");
});

test("stock names the item running out first and how many more need stock", () => {
  const ov = overview({ inventory: inventory({ outOfStock: 0, lowStock: 15 }, [{ productTitle: "Linen Tote Bag", variantTitle: "Default Title", sku: null, quantity: 9, dailySales: 3.2, daysOfCover: 2.8 }]) });
  const [n] = needsOf({ ov, alerts: [], costs: null, money, stockHref: "/inventory/low-stock" });
  assert.equal(n.text, "Linen Tote Bag runs out in about 3 days, and 14 more need stock");
  // Under a week of sales left is urgent (gradeCover).
  assert.equal(n.tone, "danger");
  assert.deepEqual(n.action, { label: "See stock", href: "/inventory/low-stock" });
  // Without the Inventory section, the dashboard's stock details.
  const [d] = needsOf({ ov, alerts: [], costs: null, money, stockHref: null });
  assert.deepEqual(d.action, { label: "See stock", topic: "stock" });
  // A variant is named; a sold-out item says so.
  const out = overview({ inventory: inventory({ outOfStock: 1, lowStock: 0 }, [{ productTitle: "Journal", variantTitle: "A5", sku: null, quantity: 0, dailySales: 0.8, daysOfCover: 0 }]) });
  assert.equal(needsOf({ ov: out, alerts: [], costs: null, money, stockHref: null })[0].text, "Journal (A5) is sold out");
  // Nothing tracked, or nothing short: no row.
  assert.deepEqual(needsOf({ ov: overview({ inventory: inventory({ outOfStock: 0, lowStock: 0 }) }), alerts: [], costs: null, money, stockHref: null }), []);
});

test("the bell's problems for this store or the workspace, never its notes, another store's, or one said twice", () => {
  const ov = overview({ inventory: inventory({ outOfStock: 0, lowStock: 2 }, []) });
  const alerts = [
    alert({ id: "w" }),
    alert({ id: "note", severity: "info", title: "Import finished" }),
    alert({ id: "other", store: { id: "s2", name: "Other" } }),
    alert({ id: "stock", area: "inventory", title: "Low stock" }),
    alert({ id: "crit", severity: "critical", area: "ads", title: "Meta Ads needs reconnecting", store: { id: "s1", name: "Demo" } }),
  ];
  const needs = needsOf({ ov, alerts, costs: null, money, stockHref: null });
  assert.deepEqual(needs.map((n) => n.id), ["alert-crit", "alert-w", "stock"]);
  assert.deepEqual(needs[0].action, { label: "Check ad accounts", href: "/settings/ads" });
  assert.equal(needs[1].detail, "Messages wait 48 hours.");
  // A stopped sync is explained above the numbers already.
  const stopped = overview({}, "error");
  const sync = alert({ id: "sync", area: "shopify", title: "Couldn't sync your orders", store: { id: "s1", name: "Demo" } });
  assert.deepEqual(needsOf({ ov: stopped, alerts: [sync], costs: null, money, stockHref: null }), []);
});

test("sales with no cost per item send the owner to add it in Shopify", () => {
  const ov = overview();
  const [some] = needsOf({ ov, alerts: [], costs: { productState: "known", uncosted: 500 }, money, stockHref: null });
  assert.equal(some.text, "$500.00 of sales had no cost per item in Shopify, so Left over leaves their cost out");
  assert.deepEqual(some.action, { label: "Add in Shopify", href: "https://demo.myshopify.com/admin/products", external: true });
  const [none] = needsOf({ ov, alerts: [], costs: { productState: "not_recorded", uncosted: 2000 }, money, stockHref: null });
  assert.match(none.text, /^No product sold in these dates has a cost per item in Shopify/);
  // Every sale costed, or a member not shown product costs (null): nothing to do.
  assert.deepEqual(needsOf({ ov, alerts: [], costs: { productState: "known", uncosted: 0 }, money, stockHref: null }), []);
  assert.deepEqual(needsOf({ ov, alerts: [], costs: null, money, stockHref: null }), []);
});
