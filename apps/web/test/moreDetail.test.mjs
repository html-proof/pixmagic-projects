import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

/**
 * "More detail" (lib/moreDetail.ts): a page's other panels sit in a fold that is closed until the
 * device opens it, says what is inside, and is always open on a printout or with folding off.
 */
const source = await readFile(new URL("../src/lib/moreDetail.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const rules = {};
new Function("exports", outputText)(rules);
const { detailKey, parseDetail, detailOpen, detailSummary } = rules;

test("a fold is closed until this device opens it, and stays as it was left", () => {
  assert.equal(detailOpen(true, null), false);
  assert.equal(detailOpen(true, "open"), true);
  assert.equal(detailOpen(true, "closed"), false);
});

test("with folding off, or on a printout, every panel shows whatever was chosen", () => {
  for (const choice of [null, "open", "closed"]) {
    assert.equal(detailOpen(false, choice), true);
    assert.equal(detailOpen(true, choice, true), true);
  }
});

test("each fold keeps its own choice, and anything else in storage is nothing saved", () => {
  assert.equal(detailKey("sales"), "more-detail:sales");
  assert.notEqual(detailKey("sales"), detailKey("terms"));
  assert.equal(parseDetail("open"), "open");
  assert.equal(parseDetail("closed"), "closed");
  for (const raw of [null, "", "1", "true", "OPEN"]) assert.equal(parseDetail(raw), null);
});

test("a closed fold names what is inside", () => {
  assert.equal(detailSummary([]), "");
  assert.equal(detailSummary(["returns"]), "returns");
  assert.equal(detailSummary(["returns", "sales day by day"]), "returns and sales day by day");
  // One left over is named rather than counted.
  assert.equal(detailSummary(["a", "b", "c"]), "a, b and c");
  assert.equal(detailSummary(["a", "b", "c", "d"]), "a, b and 2 more");
  assert.equal(detailSummary(["a", "b", "c", "d", "e", "f", "g"]), "a, b and 5 more");
  assert.equal(detailSummary(["a", "b", "c", "d", "e"], 3), "a, b, c and 2 more");
  // Empty names (a panel this store doesn't have) are not counted.
  assert.equal(detailSummary(["a", "", " ", "b"]), "a and b");
});
