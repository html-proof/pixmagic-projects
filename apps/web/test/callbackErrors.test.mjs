import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/components/settings/ads/callbackErrors.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const mod = {};
new Function("exports", outputText)(mod);
const { callbackErrorMessage, loginOf } = mod;

test("a login that reaches nothing is named first, on its platform's own words", () => {
  const meta = callbackErrorMessage("no_accounts", "meta", "Sebastian Thomas");
  assert.match(meta, /^You signed in to Facebook as “Sebastian Thomas”\. That Facebook login can't reach any ad account/);
  assert.match(callbackErrorMessage("none_shared", "meta", "A"), /^You signed in to Facebook as “A”\. No ad account was shared/);
  assert.match(callbackErrorMessage("no_accounts", "google", "B"), /^You signed in to Google as “B”\. That Google login has no Google Ads account/);
  // Without a name, or for any other failure, the words stay as they were.
  assert.match(callbackErrorMessage("no_accounts", "meta"), /^That Facebook login can't reach any ad account/);
  assert.equal(callbackErrorMessage("rate_limited", "meta", "C").includes("C”"), false);
  assert.equal(callbackErrorMessage("no_accounts", "elsewhere", "D").includes("D"), false);
});

test("the name is read only from a string in the error's detail", () => {
  assert.equal(loginOf({ detail: { login: "  Sebastian Thomas " } }), "Sebastian Thomas");
  for (const data of [undefined, {}, { detail: null }, { detail: "x" }, { detail: { login: 7 } }, { detail: { login: "   " } }]) assert.equal(loginOf(data), null);
  assert.equal(loginOf({ detail: { login: "x".repeat(500) } }).length, 120);
});
