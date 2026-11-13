import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import ts from "typescript";

/**
 * The costs and net profit behind Business profit overview, the Expenses breakdown and Shopify's
 * gross profit card (components/dashboard/profitFigures.ts): Shopify's 0 for a store that records no
 * cost per item is never a product cost, and the gross profit card gives the overview's net profit.
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
const sharedRequire = createRequire(new URL("../../../packages/shared/package.json", import.meta.url));
const dates = await load("../../../packages/shared/src/dates.ts");
const expenses = await load("../../../packages/shared/src/expenses.ts", { "./dates": dates, "./zod": { z: sharedRequire("zod").z } });
const { adsLeftOut, adsNotUsableWords, costsOf, leftOutOf, leftOutWords, leftOverOf, leftOverWords, marginKnown, profitOf, profitCardFigures } = await load("../src/components/dashboard/profitFigures.ts", { "@app/shared/expenses": expenses });

/** A dashboard answer for one store in AUD: $2,000 of net sales, Shopify's profit report as given. */
function overview(profit, { expenses: costs = { total: 300, complete: true } } = {}) {
  return {
    modules: {
      sales_overview: { current: { netSales: 2000, shipping: 50, additionalFees: 0 } },
      profit: profit && { status: "ready", asOf: null, until: null, current: profit },
      expenses: costs && { currency: "AUD", count: 1, current: { total: costs.total, byCategory: [{ category: "staff", amount: costs.total }], counted: 1 }, completeFrom: null, complete: costs.complete },
    },
  };
}
const noAds = { offered: false, shown: false };

test("a store that records no cost per item has its product costs not recorded, never $0", () => {
  // ShopifyQL counts a sale with no cost at no cost: its cost of goods sold is 0 for $2,000 of sales.
  const ov = overview({ grossProfit: 2000, costOfGoodsSold: 0, netSalesWithCost: 0, netSalesWithoutCost: 2000, profitOnCosted: 0, marginOnCosted: null });
  const k = costsOf(ov, "AUD", false);
  assert.equal(k.productCosts, null);
  assert.equal(k.productState, "not_recorded");
  // So what is left isn't "after product costs", and its share is no margin.
  assert.equal(marginKnown(k), false);
  const p = profitOf(ov, k, noAds, true);
  assert.equal(p.value, null);
  assert.deepEqual(p.gaps, ["no_cost_recorded"]);
  const f = profitCardFigures(ov, "AUD", noAds, true);
  assert.equal(f.noCostRecorded, true);
  assert.equal(f.net, null);
  assert.match(f.netNote, /^No sale in these dates has a cost recorded in Shopify/);
  // Shopify may also give no cost of goods sold at all for such sales: still not recorded, not "unavailable".
  const blank = costsOf(overview({ grossProfit: 2000, costOfGoodsSold: null, netSalesWithCost: 0, netSalesWithoutCost: 2000, profitOnCosted: 0, marginOnCosted: null }), "AUD", false);
  assert.equal(blank.productState, "not_recorded");
});

test("some sales costed: Shopify's cost of goods is the product costs, but what is left isn't a margin", () => {
  const ov = overview({ grossProfit: 1350, costOfGoodsSold: 650, netSalesWithCost: 1500, netSalesWithoutCost: 500, profitOnCosted: 850, marginOnCosted: 850 / 1500 });
  const k = costsOf(ov, "AUD", false);
  assert.equal(k.productCosts, 650);
  assert.equal(k.productState, "known");
  assert.equal(marginKnown(k), false);
  assert.deepEqual(profitOf(ov, k, noAds, true).gaps, ["uncosted_sales"]);
  assert.equal(profitCardFigures(ov, "AUD", noAds, true).noCostRecorded, false);
});

test("every sale costed, or nothing sold: the cost of goods is known and the share is a margin", () => {
  const costed = costsOf(overview({ grossProfit: 1350, costOfGoodsSold: 650, netSalesWithCost: 2000, netSalesWithoutCost: 0, profitOnCosted: 1350, marginOnCosted: 0.675 }), "AUD", false);
  assert.equal(costed.productCosts, 650);
  assert.equal(marginKnown(costed), true);
  const none = costsOf(overview({ grossProfit: 0, costOfGoodsSold: 0, netSalesWithCost: 0, netSalesWithoutCost: 0, profitOnCosted: 0, marginOnCosted: null }), "AUD", false);
  assert.equal(none.productCosts, 0);
  assert.equal(none.productState, "known");
  // Before the store grants Shopify's reports there is no profit module: not available, no margin.
  const before = costsOf(overview(null), "AUD", false);
  assert.equal(before.productState, "missing");
  assert.equal(marginKnown(before), false);
});

test("the gross profit card gives Business profit overview's net profit, or its reasons, never 'doesn't know your costs'", () => {
  const profit = { grossProfit: 1350, costOfGoodsSold: 650, netSalesWithCost: 2000, netSalesWithoutCost: 0, profitOnCosted: 1350, marginOnCosted: 0.675 };
  const ov = overview(profit);
  // Revenue 2,050 (net sales + shipping) − 650 − 300 of the owner's costs, no ads offered.
  assert.equal(profitOf(ov, costsOf(ov, "AUD", false), noAds, true).value, 1100);
  const f = profitCardFigures(ov, "AUD", noAds, true);
  assert.equal(f.net, 1100);
  assert.match(f.netNote, /as in Business profit overview/);
  // The costs list not marked complete: no figure, and the overview's own words for why.
  const open = profitCardFigures(overview(profit, { expenses: { total: 300, complete: false } }), "AUD", noAds, true);
  assert.equal(open.net, null);
  assert.equal(open.netNote, expenses.PROFIT_GAP_WORDS.costs_not_complete);
  // Ads offered but not shown to this member: net profit would give the spend away.
  assert.equal(profitCardFigures(ov, "AUD", { offered: true, shown: false }, true).netNote, expenses.PROFIT_GAP_WORDS.ads_hidden);
  // A member not shown the owner's costs.
  const hidden = profitCardFigures(overview(profit, { expenses: null }), "AUD", noAds, true);
  assert.equal(hidden.net, null);
  assert.doesNotMatch(hidden.netNote, /doesn't know/);
});

test("a member not shown Shopify's product costs gets no net profit, and isn't told whether costs are recorded", () => {
  const profit = { grossProfit: 1350, costOfGoodsSold: 650, netSalesWithCost: 2000, netSalesWithoutCost: 0, profitOnCosted: 1350, marginOnCosted: 0.675 };
  const ov = overview(profit);
  const p = profitOf(ov, costsOf(ov, "AUD", false), noAds, false);
  assert.equal(p.value, null);
  assert.deepEqual(p.gaps, ["product_costs_hidden"]);
  assert.equal(profitCardFigures(ov, "AUD", noAds, false).netNote, expenses.PROFIT_GAP_WORDS.product_costs_hidden);
  // Not "no cost recorded" either: that would say what Shopify's cost of goods sold is.
  const uncosted = overview({ grossProfit: 2000, costOfGoodsSold: 0, netSalesWithCost: 0, netSalesWithoutCost: 2000, profitOnCosted: 0, marginOnCosted: null });
  assert.deepEqual(profitOf(uncosted, costsOf(uncosted, "AUD", false), noAds, false).gaps, ["product_costs_hidden"]);
});

test("without Shopify's profit report, the product costs are the items sold at their cost per item", () => {
  const own = (current) => ({ current });
  // Not granted (no profit module), or Shopify refused: the cost per item stands in, with the same rules.
  for (const report of [undefined, { status: "access_denied", asOf: null, until: null, current: null }]) {
    const ov = overview(null);
    ov.modules.profit = report;
    ov.modules.product_costs = own({ costOfGoodsSold: 700, netSalesWithCost: 2000, netSalesWithoutCost: 0 });
    const k = costsOf(ov, "AUD", false);
    assert.equal(k.productCosts, 700);
    assert.equal(k.productState, "known");
    assert.equal(k.productSource, "cost_per_item");
    assert.equal(marginKnown(k), true);
    // Revenue 2,050 − 700 − 300 of the owner's costs, no ads offered.
    assert.equal(profitOf(ov, k, noAds, true).value, 1050);
  }
  // Sales of items with no cost per item are named, and keep it from net profit.
  const some = overview(null);
  some.modules.product_costs = own({ costOfGoodsSold: 400, netSalesWithCost: 1500, netSalesWithoutCost: 500 });
  const ks = costsOf(some, "AUD", false);
  assert.equal(ks.uncosted, 500);
  assert.deepEqual(profitOf(some, ks, noAds, true).gaps, ["uncosted_sales"]);
  // No item sold has one: not recorded, never $0.
  const none = overview(null);
  none.modules.product_costs = own({ costOfGoodsSold: 0, netSalesWithCost: 0, netSalesWithoutCost: 2000 });
  assert.equal(costsOf(none, "AUD", false).productState, "not_recorded");
  // Shopify's report, when it answers, is the one used.
  const both = overview({ grossProfit: 1350, costOfGoodsSold: 650, netSalesWithCost: 2000, netSalesWithoutCost: 0, profitOnCosted: 1350, marginOnCosted: 0.675 });
  both.modules.product_costs = own({ costOfGoodsSold: 700, netSalesWithCost: 2000, netSalesWithoutCost: 0 });
  assert.deepEqual([costsOf(both, "AUD", false).productCosts, costsOf(both, "AUD", false).productSource], [650, "report"]);
  // While it is on its way, it is waited for.
  both.modules.profit = { ...both.modules.profit, status: "loading", current: null };
  assert.deepEqual([costsOf(both, "AUD", false).productState, costsOf(both, "AUD", false).productSource], ["loading", null]);
});

/** The ads module for the dates: the accounts as listed, $120 spent by the counted ones in `currency`. */
function ads(accounts, { currency = "AUD", spend = 120, leftOut } = {}) {
  return {
    currency,
    accounts: accounts.map((a) => ({ provider: "meta", accountId: a.id, name: `Shop ${a.id}`, demo: false, ...a })),
    ...(leftOut !== undefined ? { leftOut } : {}),
    current: spend === null ? null : { spend },
    byProvider: [{ provider: "meta", current: spend === null ? null : { spend } }],
    demo: false,
  };
}
const adsShown = { offered: true, shown: true };
const costed = { grossProfit: 1350, costOfGoodsSold: 650, netSalesWithCost: 2000, netSalesWithoutCost: 0, profitOnCosted: 1350, marginOnCosted: 0.675 };

test("an ad account in another currency is left out of the ad spend: the spend is partial and there is no net profit", () => {
  const ov = overview(costed);
  ov.modules.ads = ads([{ id: "au", currency: "AUD", counted: true }, { id: "eu", currency: "EUR", counted: false }], {
    leftOut: [{ id: "eu", provider: "meta", accountId: "act_eu", name: "EU shop", currency: "EUR" }],
  });
  const k = costsOf(ov, "AUD", true);
  // The Australian dollars are shown as what they are, never as the whole spend.
  assert.equal(k.adSpend, 120);
  assert.equal(k.adState, "partial");
  assert.deepEqual(k.adLeftOut.map((a) => a.id), ["eu"]);
  assert.equal(leftOutWords(k.adLeftOut), "Left out: EU shop (EUR), in another currency.");
  const p = profitOf(ov, k, adsShown, true);
  assert.equal(p.value, null);
  assert.deepEqual(p.gaps, ["ad_spend"]);
  assert.equal(profitCardFigures(ov, "AUD", adsShown, true).netNote, expenses.PROFIT_GAP_WORDS.ad_spend);
  // Every account in the store's currency: the spend is the whole of it, and net profit is given. 2,050 − 650 − 120 − 300.
  ov.modules.ads = ads([{ id: "au", currency: "AUD", counted: true }], { leftOut: [] });
  const whole = costsOf(ov, "AUD", true);
  assert.deepEqual([whole.adState, whole.adLeftOut, leftOutWords(whole.adLeftOut)], ["known", [], null]);
  assert.equal(profitOf(ov, whole, adsShown, true).value, 980);
});

test("the accounts left out are the module's own, read from its accounts in older answers, and never the demo", () => {
  const ov = overview(costed);
  // An answer without `leftOut`: the accounts not counted, the demo aside.
  ov.modules.ads = ads([
    { id: "au", currency: "AUD", counted: true },
    { id: "eu", currency: "EUR", counted: false, name: "EU shop" },
    { id: "uk", currency: "GBP", counted: false, name: null, accountId: "act_uk" },
    { id: "demo", provider: "google", currency: "USD", counted: false, demo: true },
  ]);
  assert.deepEqual(leftOutOf(ov.modules.ads).map((a) => a.id), ["eu", "uk"]);
  assert.equal(leftOutWords(adsLeftOut(ov, "AUD")), "Left out: EU shop (EUR) and act_uk (GBP), in another currency.");
  // The module in another currency than the store's: none of its spend is the store's, every account is left out.
  ov.modules.ads = ads([{ id: "eu", currency: "EUR", counted: true }, { id: "demo", provider: "google", currency: "EUR", counted: true, demo: true }], { currency: "EUR", leftOut: [] });
  assert.deepEqual(adsLeftOut(ov, "AUD").map((a) => a.id), ["eu"]);
  const k = costsOf(ov, "AUD", true);
  assert.deepEqual([k.adSpend, k.adState], [null, "unavailable"]);
  // Not shown the ads: nothing is said about them.
  assert.deepEqual(costsOf(ov, "AUD", false).adLeftOut, []);
});

test("ad spend with a day missing stays unavailable, whatever is left out", () => {
  const ov = overview(costed);
  ov.modules.ads = ads([{ id: "au", currency: "AUD", counted: true }, { id: "eu", currency: "EUR", counted: false }], { spend: null, leftOut: [{ id: "eu", provider: "meta", accountId: "act_eu", name: "EU shop", currency: "EUR" }] });
  const k = costsOf(ov, "AUD", true);
  assert.deepEqual([k.adSpend, k.adState, k.adLeftOut.length], [null, "unavailable", 1]);
  assert.deepEqual(profitOf(ov, k, adsShown, true).gaps, ["ad_spend"]);
});

test("the Profit sheet's profit and loss names the account left out of a spend in the store's currency, and says another currency only when the spend is in one", () => {
  // An AUD store, Meta in AUD, Google in EUR: the spend is in AUD (adsCurrency null) and the EUR account is left out.
  const google = { id: "g", provider: "google", accountId: "123-456-7890", name: "EU shop", currency: "EUR" };
  assert.equal(adsNotUsableWords({ demo: false, currency: null, leftOut: [google] }, "AUD"), "Left out: EU shop (EUR), in another currency. Profit needs every account's spend.");
  // Never "in AUD, not AUD", even from an answer that gave the spend's currency either way and named no account.
  assert.equal(adsNotUsableWords({ demo: false, currency: "AUD", leftOut: [google] }, "AUD"), "Left out: EU shop (EUR), in another currency. Profit needs every account's spend.");
  assert.equal(adsNotUsableWords({ demo: false, currency: "AUD", leftOut: [] }, "AUD"), "An ad account reports in another currency than AUD.");
  // The spend itself in another currency: every currency the accounts report in, once.
  assert.equal(adsNotUsableWords({ demo: false, currency: "EUR", leftOut: [] }, "AUD"), "Your ad accounts report in EUR, not AUD.");
  assert.equal(adsNotUsableWords({ demo: false, currency: "EUR", leftOut: [{ ...google, id: "uk", currency: "GBP" }, { ...google, id: "eu2" }] }, "AUD"), "Your ad accounts report in EUR and GBP, not AUD.");
  assert.equal(adsNotUsableWords({ demo: true, currency: null, leftOut: [] }, "AUD"), "The Google Ads demo's spend is simulated.");
});

test("Left over is Business profit overview's figure: net profit once complete, else net sales less the costs known", () => {
  const profit = { grossProfit: 1350, costOfGoodsSold: 650, netSalesWithCost: 2000, netSalesWithoutCost: 0, profitOnCosted: 1350, marginOnCosted: 0.675 };
  // Costs list complete: net profit out of revenue (2,050 − 650 − 300).
  const done = overview(profit);
  const net = leftOverOf(done, costsOf(done, "AUD", false), "AUD", noAds, true);
  assert.equal(net.isNet, true);
  assert.equal(net.value, 1100);
  assert.equal(net.base, 2050);
  assert.equal(leftOverWords(net), "Net profit");
  // Not marked complete: net sales less what is known (2,000 − 650 − 300), never called profit.
  const open = overview(profit, { expenses: { total: 300, complete: false } });
  const left = leftOverOf(open, costsOf(open, "AUD", false), "AUD", noAds, true);
  assert.equal(left.isNet, false);
  assert.equal(left.value, 1050);
  assert.equal(left.base, 2000);
  assert.equal(left.taken, 950);
  assert.equal(leftOverWords(left), "After product costs and your costs");
  // Nothing known to take off: net sales under its own name, with nothing taken.
  const bare = overview(null, { expenses: null });
  const none = leftOverOf(bare, costsOf(bare, "AUD", false), "AUD", noAds, true);
  assert.equal(none.taken, 0);
  assert.equal(none.value, 2000);
  assert.equal(leftOverWords(none), "Net sales");
});
