import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

/**
 * Sales by collection asks for the days the dashboard's answer is for (collectionDates.ts); the
 * route works the dates out again with @app/shared's resolvePreset. They must be the dashboard's
 * own days, and never a 400 for dates the dashboard itself shows.
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
const { collectionSalesParams } = await load("../src/components/dashboard/collectionDates.ts");

/** What the route answers the panel's question with (apps/api/src/routes/dashboard.ts resolveQueryDates). */
function routeDates(params, now) {
  const q = Object.fromEntries(params);
  return shared.resolvePreset(q.preset ?? "30d", now, "UTC", q.from && q.to ? { from: q.from, to: q.to } : undefined);
}

/** The dashboard's answer for a question, as far as the panel reads it. */
const dashboard = (preset, now, custom) => shared.resolvePreset(preset, now, "UTC", custom);

const same = (ov, now) => {
  const asked = collectionSalesParams(ov);
  assert.equal(asked.toString(), `preset=custom&from=${ov.range.from}&to=${ov.range.to}`);
  assert.deepEqual(routeDates(asked, now).range, ov.range);
  return asked;
};

test("every preset's days come back as the dashboard's own, while today runs too", () => {
  // 15 March 2028: the last 12 months hold 29 February 2028, so they are 366 days.
  for (const at of ["2028-03-15T05:30:00Z", "2026-10-28T23:10:00Z", "2025-01-01T00:00:00Z"]) {
    const now = new Date(at);
    for (const preset of ["today", "yesterday", "wtd", "lastweek", "7d", "30d", "90d", "6m", "12m", "mtd", "lastmonth", "ytd", "lastyear"]) same(dashboard(preset, now), now);
  }
});

test("the dashboard's days are still the panel's once the day has turned: yesterday's answer asks for yesterday", () => {
  // The dashboard answered "today" at 23:59; the panel asks a minute after midnight, before the next poll.
  const ov = dashboard("today", new Date("2026-10-28T23:59:00Z"));
  assert.deepEqual(routeDates(collectionSalesParams(ov), new Date("2026-10-29T00:01:00Z")).range, { from: "2026-10-28", to: "2026-10-28" });
});

test("custom dates go as the dates, a 366-day range and a calendar year included", () => {
  const now = new Date("2026-10-30T02:00:00Z");
  // A financial year with a 29 February in it.
  const year = dashboard("custom", now, { from: "2023-07-01", to: "2024-06-30" });
  assert.equal(same(year, now).toString(), "preset=custom&from=2023-07-01&to=2024-06-30");
  same(dashboard("custom", now, { from: "2025-01-01", to: "2025-12-31" }), now);
  // Running past today: the dashboard reports them up to today, and so does the route.
  same(dashboard("custom", now, { from: "2026-10-01", to: "2026-10-31" }), now);
});
