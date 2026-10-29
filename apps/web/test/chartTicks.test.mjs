import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(new URL("../src/components/dashboard/chartUtils.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const utils = {};
new Function("require", "exports", outputText)((id) => {
  assert.equal(id, "react");
  return {};
}, utils);
const { niceTicks, niceTicksAround } = utils;

test("never below zero, the gridlines are niceTicks'", () => {
  assert.deepEqual(niceTicksAround(0, 705, 4), niceTicks(705, 4));
  assert.deepEqual(niceTicksAround(0, 705, 4), [0, 200, 400, 600, 800]);
  assert.deepEqual(niceTicksAround(0, 0, 4), [0]);
});

test("a day below zero is inside the axis, on the same steps as above it", () => {
  // The screenshot's week: A$38, −A$390, A$705.
  assert.deepEqual(niceTicksAround(-390, 705, 4), [-400, -200, 0, 200, 400, 600, 800]);
  assert.deepEqual(niceTicksAround(-20, 705, 4), [-200, 0, 200, 400, 600, 800]);
});

test("the axis always runs through zero and covers every figure", () => {
  for (const [min, max] of [[-390, 705], [-700, 700], [-0.4, 0.3], [-1234, 0], [-5, 18000], [-18000, 5]]) {
    const ticks = niceTicksAround(min, max, 4);
    assert.ok(ticks.includes(0), `${min}..${max}: ${ticks}`);
    assert.ok(ticks[0] <= min && ticks.at(-1) >= max, `${min}..${max}: ${ticks}`);
    assert.ok(ticks.length <= 9, `${min}..${max}: ${ticks.length} gridlines`);
    const step = ticks[1] - ticks[0];
    ticks.forEach((t, i) => assert.ok(Math.abs(t - (ticks[0] + i * step)) < 1e-9, `${min}..${max}: uneven ${ticks}`));
    assert.ok(!ticks.some((t) => Object.is(t, -0)), `${min}..${max}: a −0 gridline`);
  }
});
