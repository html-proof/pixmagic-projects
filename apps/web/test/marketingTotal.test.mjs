import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import ts from "typescript";

/**
 * "Total advertising expenses" on the Ad spend reported to Shopify card (components/advertising/
 * marketingTotal.ts): a platform shown from its own API whose figures aren't in yet, or whose accounts
 * report in another currency, is named as left out and the total marked partial, never silently short.
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
const profitFigures = await load("../src/components/dashboard/profitFigures.ts", { "@app/shared/expenses": expenses });
const adFigures = await load("../src/components/dashboard/adFigures.ts", { "./format": { fmtDay: (d) => d } });
const { totalLeftOutWords, totalSpend } = await load("../src/components/advertising/marketingTotal.ts", {
  "@/components/dashboard/adFigures": adFigures,
  "@/components/dashboard/profitFigures": profitFigures,
});

const RANGE = { from: "2026-10-01", to: "2026-10-20" };
const account = (provider, accountId, currency, extra = {}) => ({ id: `c-${accountId}`, provider, accountId, name: `${accountId} shop`, currency, counted: true, demo: false, ...extra });
/** Meta's own figures for the dates: their spend, or (null) none of the dates in yet. */
const metaFigures = (spend) => ({ provider: "meta", accounts: ["act_1"], current: spend === null ? null : { spend }, soFar: null });
/** What Google & YouTube (and, given, other channels) reported to Shopify, in AUD. */
const marketing = (google, others = []) => ({
  currency: "AUD",
  through: RANGE.to,
  platforms: [
    { platform: "meta", totals: null },
    { platform: "google", totals: google === null ? null : { spend: google } },
  ],
  others: others.map(([name, spend]) => ({ name, totals: { spend } })),
});
const META_OWN = { provider: "meta", state: "connected", source: "platform" };
const GOOGLE_REPORTED = { provider: "google", state: "not_connected", source: "none", marketing: true };
const overview = (ads) => ({ range: RANGE, modules: ads ? { ads } : {} });

test("every platform in, in the store's currency: the whole total, nothing left out", () => {
  const ov = overview({ currency: "AUD", accounts: [account("meta", "act_1", "AUD")], byProvider: [metaFigures(70)] });
  const t = totalSpend(ov, marketing(30, [["TikTok", 5]]), [META_OWN, GOOGLE_REPORTED]);
  assert.equal(t.total, 105);
  assert.deepEqual(
    t.parts.map((p) => [p.key, p.spend, p.from]),
    [
      ["meta", 70, "platform"],
      ["google", 30, "marketing"],
      ["other:TikTok", 5, "marketing"],
    ],
  );
  assert.equal(t.partial, false);
  assert.deepEqual(totalLeftOutWords(t), []);
});

test("a platform whose own figures aren't in yet (its first sync, or syncs that stopped) is named, and the total partial", () => {
  const ov = overview({ currency: "AUD", accounts: [account("meta", "act_1", "AUD")], byProvider: [metaFigures(null)] });
  const t = totalSpend(ov, marketing(30), [META_OWN, GOOGLE_REPORTED]);
  assert.equal(t.total, 30);
  assert.deepEqual(t.beingRead, [{ provider: "meta", name: "Meta Ads" }]);
  assert.equal(t.partial, true);
  assert.deepEqual(totalLeftOutWords(t), ["Left out: Meta Ads, its figures for these dates still being read."]);
  // No ad figures at all in the answer yet: the same, and nothing to add up.
  const none = totalSpend(overview(null), marketing(null), [META_OWN, { ...GOOGLE_REPORTED, provider: "google", source: "platform" }]);
  assert.equal(none.total, null);
  assert.deepEqual(totalLeftOutWords(none), ["Left out: Meta Ads and Google Ads, their figures for these dates still being read."]);
});

test("ad accounts in another currency are named with it (leftOutWords), never added in", () => {
  // The platform's accounts all report in EUR: none of Meta's spend is in the AUD total.
  const eur = overview({ currency: "EUR", accounts: [account("meta", "act_1", "EUR")], byProvider: [metaFigures(70)] });
  const t = totalSpend(eur, marketing(30), [META_OWN, GOOGLE_REPORTED]);
  assert.equal(t.total, 30);
  assert.deepEqual(t.parts.map((p) => p.key), ["google"]);
  assert.equal(t.partial, true);
  assert.deepEqual(totalLeftOutWords(t), ["Left out: act_1 shop (EUR), in another currency."]);
  // One of Meta's accounts in another currency (the module's `leftOut`): Meta's AUD spend is in, that account named.
  const someEur = overview({
    currency: "AUD",
    accounts: [account("meta", "act_1", "AUD"), account("meta", "act_2", "EUR", { counted: false })],
    leftOut: [{ id: "c-act_2", provider: "meta", accountId: "act_2", name: "EU shop", currency: "EUR" }],
    byProvider: [metaFigures(70)],
  });
  const partial = totalSpend(someEur, marketing(30), [META_OWN, GOOGLE_REPORTED]);
  assert.equal(partial.total, 100);
  assert.equal(partial.partial, true);
  assert.deepEqual(totalLeftOutWords(partial), ["Left out: EU shop (EUR), in another currency."]);
});

test("the Google Ads demo is neither spend nor left out: its figures are simulated", () => {
  const ov = overview({ currency: "USD", accounts: [account("google", "demo", "USD", { demo: true })], byProvider: [{ provider: "google", accounts: ["demo"], current: { spend: 500 }, soFar: null, demo: true }] });
  const t = totalSpend(ov, marketing(null), [{ provider: "google", state: "connected", source: "platform" }]);
  assert.equal(t.total, null);
  assert.equal(t.partial, false);
  assert.deepEqual(totalLeftOutWords(t), []);
});
