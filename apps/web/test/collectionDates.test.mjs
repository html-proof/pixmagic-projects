import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URLSearchParams } from "node:url";
import ts from "typescript";

/**
 * Sales by collection asks with the dashboard's dates written out (collectionDates.ts); the route
 * works them out again with @app/shared's resolvePreset. Both sides must be the dashboard's own,
 * and never a 400 for dates the dashboard itself shows.
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
const shared = await load("../../../packages/shared/src/dates.ts");
const { collectionSalesParams } = await load("../src/components/dashboard/collectionDates.ts", { "@app/shared": shared });

/** What the route answers the panel's question with (apps/api/src/routes/dashboard.ts resolveQueryDates). */
function routeDates(params, now) {
  const q = Object.fromEntries(params);
  return shared.resolvePreset(q.preset, now, "UTC", { from: q.from, to: q.to }, { mode: q.compare, from: q.cfrom, to: q.cto });
}

const same = (dashboard, now) => {
  const asked = collectionSalesParams(dashboard.range, dashboard.previous);
  const answer = routeDates(asked, now);
  assert.deepEqual(answer.range, dashboard.range);
  assert.deepEqual({ from: answer.previous.from, to: answer.previous.to, until: answer.previous.until }, { from: dashboard.previous.from, to: dashboard.previous.to, until: dashboard.previous.until });
  return asked;
};

test("a 366-day range against the period before is asked as that, not as dates the route would refuse", () => {
  const now = new Date("2026-10-30T02:00:00Z");
  // A financial year with a 29 February in it: the 366 days before it have none.
  const dashboard = shared.resolvePreset("custom", now, "UTC", { from: "2023-07-01", to: "2024-06-30" });
  assert.deepEqual(dashboard.previous, { from: "2022-06-30", to: "2023-06-30" });
  assert.throws(() => routeDates(new URLSearchParams({ preset: "custom", from: "2023-07-01", to: "2024-06-30", compare: "custom", cfrom: "2022-06-30", cto: "2023-06-30" }), now), /Comparison too long/);
  const asked = same({ ...dashboard, previous: { ...dashboard.previous, compare: "previous" } }, now);
  assert.equal(asked.get("compare"), "previous");
  assert.equal(asked.get("cfrom"), null);
});

test("every preset's comparison comes back as the dashboard's own days, while today runs too", () => {
  // 15 March 2028: the last 12 months hold 29 February 2028, so they are 366 days.
  for (const at of ["2028-03-15T05:30:00Z", "2026-10-28T23:10:00Z", "2025-01-01T00:00:00Z"]) {
    const now = new Date(at);
    for (const preset of ["today", "yesterday", "wtd", "lastweek", "7d", "30d", "90d", "6m", "12m", "mtd", "lastmonth", "ytd", "lastyear"]) {
      for (const mode of ["previous", "year"]) {
        const d = shared.resolvePreset(preset, now, "UTC", undefined, { mode });
        same({ range: d.range, previous: { ...d.previous, compare: mode } }, now);
      }
    }
  }
});

test("a comparison the route can't work out from custom dates goes as its own dates", () => {
  const now = new Date("2026-10-28T03:00:00Z");
  // This week so far against the same days last week, not the days just before.
  const week = shared.resolvePreset("wtd", now, "UTC");
  const asked = same({ range: week.range, previous: { ...week.previous, compare: "previous" } }, now);
  assert.equal(asked.get("compare"), "custom");
  assert.equal(asked.get("cfrom"), week.previous.from);
  // Dates picked.
  const picked = { range: { from: "2026-10-01", to: "2026-10-10" }, previous: { from: "2026-08-01", to: "2026-08-05", compare: "custom" } };
  assert.equal(same(picked, now).get("compare"), "custom");
  // A year earlier: always as the mode, which the route never refuses.
  assert.equal(collectionSalesParams(picked.range, { from: "2025-10-01", to: "2025-10-10", compare: "year" }).get("compare"), "year");
});
