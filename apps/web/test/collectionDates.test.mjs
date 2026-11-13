import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URLSearchParams } from "node:url";
import ts from "typescript";

/**
 * Sales by collection asks as the dashboard was asked (collectionDates.ts); the route works the
 * dates out again with @app/shared's resolvePreset. Both sides must be the dashboard's own, and
 * never a 400 for dates the dashboard itself shows.
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
const { collectionSalesParams } = await load("../src/components/dashboard/collectionDates.ts", { "@app/shared/dates": shared });

/** What the route answers the panel's question with (apps/api/src/routes/dashboard.ts resolveQueryDates). */
function routeDates(params, now) {
  const q = Object.fromEntries(params);
  return shared.resolvePreset(q.preset ?? "30d", now, "UTC", q.from && q.to ? { from: q.from, to: q.to } : undefined);
}

/** The dashboard's answer for a question, as far as the panel reads it. */
const dashboard = (preset, now, custom) => ({ preset, ...shared.resolvePreset(preset, now, "UTC", custom) });

const same = (ov, now) => {
  const asked = collectionSalesParams(ov);
  assert.deepEqual(routeDates(asked, now), { range: ov.range, previous: ov.previous });
  return asked;
};

test("every preset comes back as the dashboard's own days on both sides, while today runs too", () => {
  // 15 March 2028: the last 12 months hold 29 February 2028, so they are 366 days.
  for (const at of ["2028-03-15T05:30:00Z", "2026-10-28T23:10:00Z", "2025-01-01T00:00:00Z"]) {
    const now = new Date(at);
    for (const preset of ["today", "yesterday", "wtd", "lastweek", "7d", "30d", "90d", "6m", "12m", "mtd", "lastmonth", "ytd", "lastyear"]) {
      const asked = same(dashboard(preset, now), now);
      assert.equal(asked.toString(), `preset=${preset}`);
    }
  }
});

test("this week and last month are asked by name: their days written out would be compared otherwise", () => {
  const now = new Date("2026-10-28T03:00:00Z");
  // This week so far against the same days last week, not the days just before.
  const week = dashboard("wtd", now);
  assert.deepEqual(week.previous, { from: "2026-10-19", to: "2026-10-21", until: "03:00:00" });
  assert.notDeepEqual(routeDates(new URLSearchParams({ preset: "custom", ...week.range }), now).previous, week.previous);
  // Last month against the whole month before, whatever its length.
  const month = dashboard("lastmonth", now);
  assert.deepEqual(month.previous, { from: "2026-08-01", to: "2026-08-31" });
  assert.notDeepEqual(routeDates(new URLSearchParams({ preset: "custom", ...month.range }), now).previous, month.previous);
});

test("custom dates go as the dates, a 366-day range and a calendar year included", () => {
  const now = new Date("2026-10-30T02:00:00Z");
  // A financial year with a 29 February in it: the 366 days before it have none.
  const year = dashboard("custom", now, { from: "2023-07-01", to: "2024-06-30" });
  assert.deepEqual(year.previous, { from: "2022-06-30", to: "2023-06-30" });
  assert.equal(same(year, now).toString(), "preset=custom&from=2023-07-01&to=2024-06-30");
  same(dashboard("custom", now, { from: "2025-01-01", to: "2025-12-31" }), now);
  // Running past today: the dashboard reports them up to today, and so does the route.
  same(dashboard("custom", now, { from: "2026-10-01", to: "2026-10-31" }), now);
});

test("an answer that doesn't say how it was asked goes as its dates", () => {
  const now = new Date("2026-10-28T03:00:00Z");
  const { range } = shared.resolvePreset("30d", now, "UTC");
  assert.equal(collectionSalesParams({ range }).toString(), `preset=custom&from=${range.from}&to=${range.to}`);
});
