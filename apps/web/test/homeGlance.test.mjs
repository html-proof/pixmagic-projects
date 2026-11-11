import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

/**
 * The simple Home at a glance (lib/homeGlance.ts): the dates one click away, "Needs you" kept to
 * three, the quieter numbers that never repeat a tile, and sales, expenses and profit by week from
 * the days, where a part that isn't known is never summed as if it were.
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
const dates = await load("../../../packages/shared/src/dates.ts");
const { HOME_DATE_CHIPS, NEEDS_SHOWN, needsSplit, smallNumbers, weeksOf, drawable, costsKnown, firstView } = await load("../src/lib/homeGlance.ts", { "@app/shared/dates": dates });

test("every date chip is a range the dates menu has", () => {
  assert.deepEqual([...HOME_DATE_CHIPS], ["today", "yesterday", "wtd", "mtd", "30d", "lastmonth", "ytd"]);
  for (const id of HOME_DATE_CHIPS) assert.ok(dates.DATE_PRESETS.includes(id), id);
  // The default range is one of them, so a first visit has a chip pressed.
  assert.ok(HOME_DATE_CHIPS.includes("30d"));
});

test("Needs you shows three, worst first as given, until asked for all", () => {
  assert.equal(NEEDS_SHOWN, 3);
  assert.deepEqual(needsSplit([], false), { shown: [], more: 0 });
  assert.deepEqual(needsSplit(["a", "b", "c"], false), { shown: ["a", "b", "c"], more: 0 });
  assert.deepEqual(needsSplit(["a", "b", "c", "d", "e"], false), { shown: ["a", "b", "c"], more: 2 });
  assert.deepEqual(needsSplit(["a", "b", "c", "d", "e"], true), { shown: ["a", "b", "c", "d", "e"], more: 0 });
});

test("the quieter numbers are the headline figures the tiles don't show", () => {
  // Tiles: Total sales, Orders, Average order value, Total products sold.
  assert.deepEqual(smallNumbers({ totalSales: true, leftOver: false, funnel: false, costs: false }), ["netSales"]);
  // Tiles: Total sales, Orders, Average order value, Visits that bought.
  assert.deepEqual(smallNumbers({ totalSales: true, leftOver: false, funnel: true, costs: false }), ["netSales", "itemsSold"]);
  // Tiles: Total sales, Orders, Net profit, Average order value.
  assert.deepEqual(smallNumbers({ totalSales: true, leftOver: true, funnel: false, costs: true }), ["netSales", "costs", "itemsSold"]);
  // Tiles: Total sales, Orders, Net profit, Visits that bought.
  assert.deepEqual(smallNumbers({ totalSales: true, leftOver: true, funnel: true, costs: true }), ["netSales", "costs", "averageOrder", "itemsSold"]);
  // A member not shown the total has Net sales as the tile: not again underneath.
  assert.deepEqual(smallNumbers({ totalSales: false, leftOver: false, funnel: false, costs: false }), []);
  // No cost was taken off, or none above zero: no costs figure.
  assert.deepEqual(smallNumbers({ totalSales: true, leftOver: true, funnel: true, costs: false }), ["netSales", "averageOrder", "itemsSold"]);
  assert.deepEqual(smallNumbers({ totalSales: true, leftOver: false, funnel: true, costs: true }), ["netSales", "itemsSold"]);
});

const day = (d, revenue, totalExpenses, netProfit) => ({ from: d, to: d, revenue, totalExpenses, netProfit });

test("the month's days by calendar week, Monday to Sunday, the first and last as long as they are", () => {
  // 1 November 2026 is a Sunday.
  const days = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-08", "2026-11-09"].map((d) => day(d, 100, 60, 40));
  const weeks = weeksOf(days);
  assert.deepEqual(
    weeks.map((w) => [w.from, w.to, w.revenue]),
    [
      ["2026-11-01", "2026-11-01", 100],
      ["2026-11-02", "2026-11-08", 300],
      ["2026-11-09", "2026-11-09", 100],
    ],
  );
  assert.deepEqual(weeksOf([]), []);
});

test("a week's figure is null as soon as one of its days isn't known, and sums are exact to the cent", () => {
  const [w] = weeksOf([day("2026-11-02", 0.1, 0.1, 0), day("2026-11-03", 0.2, null, null), day("2026-11-04", 0.3, 0.2, 0.1)]);
  assert.equal(w.revenue, 0.6);
  assert.equal(w.totalExpenses, null);
  assert.equal(w.netProfit, null);
  const [loss] = weeksOf([day("2026-11-02", 10, 25.5, -15.5), day("2026-11-03", 5, 1.25, 3.75)]);
  assert.equal(loss.netProfit, -11.75);
});

test("a visit opens on the 12 months, or on the days when only they can be drawn", () => {
  const known = [day("2026-11-02", 10, 4, 6)];
  const unknown = [day("2026-10-01", null, null, null)];
  assert.equal(firstView(known, known), "monthly");
  assert.equal(firstView(known, unknown), "monthly");
  assert.equal(firstView(unknown, known), "daily");
  assert.equal(firstView(unknown, unknown), "monthly");
  assert.equal(firstView([], []), "monthly");
});

test("the chart draws once any sales are known, and says so when a cost is missing", () => {
  assert.equal(drawable([]), false);
  assert.equal(drawable([day("2026-11-02", null, null, null)]), false);
  assert.equal(drawable([day("2026-11-02", null, null, null), day("2026-11-03", 0, 0, 0)]), true);
  assert.equal(costsKnown([day("2026-11-02", 10, 4, 6)]), true);
  assert.equal(costsKnown([day("2026-11-02", 10, 4, 6), day("2026-11-03", 10, null, null)]), false);
  // A day with no sales known has nothing drawn, so nothing to explain.
  assert.equal(costsKnown([day("2026-11-02", 10, 4, 6), day("2026-11-03", null, null, null)]), true);
});
