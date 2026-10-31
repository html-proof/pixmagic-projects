import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

/**
 * Settings → Stores' words for removing one optional permission (components/settings/scopeRevoke.ts):
 * a label with a name in it keeps its capital mid-sentence, and the confirm names everything that stops.
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
const capabilities = await load("../../../packages/shared/src/capabilities.ts");
const { revokeWords } = await load("../src/components/settings/scopeRevoke.ts", { "@app/shared/capabilities": capabilities });

test("Shopify keeps its capital in every sentence about removing the reports permission", () => {
  const w = revokeWords("read_reports", "x.myshopify.com");
  assert.equal(w.question, "Stop letting bizinsights read your Shopify reports for x.myshopify.com?");
  assert.equal(w.button, "Remove your Shopify reports permission for x.myshopify.com");
  assert.equal(w.failed, "We couldn't remove your Shopify reports. Please try again.");
  for (const s of Object.values(w)) assert.doesNotMatch(s, /shopify reports/);
});

test("removing the reports permission names the sales check and the product costs too, not only its reports", () => {
  const { consequence } = revokeWords("read_reports", "x.myshopify.com");
  for (const part of ["Sessions and visitors (Shopify)", "Gross profit", "the check of your sales against Shopify's sales report", "the product costs and net profit in Business profit overview"]) assert.ok(consequence.includes(part), `${part}: ${consequence}`);
  assert.match(consequence, / will stop working until you grant it again\.$/);
  // The daily check beside the store's status reads orders and keeps working: not named.
  assert.doesNotMatch(consequence, /Checked against Shopify/);
});

test("other permissions read as before, lower case mid-sentence", () => {
  const w = revokeWords("read_customers", "x.myshopify.com");
  assert.equal(w.question, "Stop letting bizinsights read your customers for x.myshopify.com?");
  assert.match(w.consequence, /will stop working until you grant it again\.$/);
  assert.equal(revokeWords("read_locations_unused", "x.myshopify.com").consequence, "Nothing on your dashboard uses it today.");
});
