import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(new URL("../src/lib/apiClient.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { api, ApiError, friendlyError, actionError, isSignedOut, isTransient, safeCorrelationId } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("only 401 signs out; outages remain retryable", () => {
  for (const status of [0, 400, 401, 403, 404, 429, 500, 503]) {
    const error = new ApiError(status, "error", "private SQL diagnostics");
    assert.equal(isSignedOut(error), status === 401);
    assert.equal(isTransient(error), [0, 429, 500, 503].includes(status));
    assert.ok(!friendlyError(error).includes("SQL"));
    assert.ok(!actionError(error, "save").includes("SQL"));
  }
});
test("invitation and validation failures have safe actionable messages", () => {
  assert.match(friendlyError(new ApiError(400, "invalid_invite", "secret")), /new link/);
  assert.match(friendlyError(new ApiError(400, "validation", "secret")), /required fields/);
  assert.match(friendlyError(new ApiError(403, "invite_email_mismatch", "secret")), /verified email/);
  assert.match(friendlyError(new ApiError(400, "invalid_code", "secret")), /invalid or has expired/);
});
test("support references reject private text and markup", () => {
  assert.equal(safeCorrelationId("req_123-ab"), "req_123-ab");
  for (const bad of ["<script>", "email@example.com", "a".repeat(101), "line\nbreak", null]) assert.equal(safeCorrelationId(bad), undefined);
});
test("HTTP errors keep status and diagnostic reference without exposing response text", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "internal", message: "password=secret" }), { status: 503, headers: { "x-request-id": "req-123" } });
    await assert.rejects(api("/me"), (error) => error.status === 503 && error.correlationId === "req-123" && !error.message.includes("secret"));
    globalThis.fetch = async () => new Response("<html>private gateway details</html>", { status: 502 });
    await assert.rejects(api("/me"), (error) => error.status === 502 && !error.message.includes("gateway"));
    globalThis.fetch = async () => { throw new TypeError("private network details"); };
    await assert.rejects(api("/me"), (error) => error.status === 0 && !isSignedOut(error));
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }));
    assert.deepEqual(await api("/healthz"), { ok: true });
  } finally { globalThis.fetch = original; }
});

// Render the real shared state component to check its accessible recovery markup.
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
const require = createRequire(import.meta.url);
function localRequire(id) {
  if (id === "@/lib/apiClient") return { safeCorrelationId };
  if (!id.startsWith("@/")) return require(id);
  const source = readFileSync(new URL(`../src/${id.slice(2)}.tsx`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  new Function("require", "exports", compiled)(localRequire, exports);
  return exports;
}
const componentSource = await readFile(new URL("../src/components/ErrorState.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(componentSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const componentExports = {};
new Function("require", "exports", compiled)((id) => id === "@/lib/apiClient" ? { safeCorrelationId } : id === "@/lib/returnTo" ? { setReturnTo() {} } : localRequire(id), componentExports);
test("recovery states label their regions, disable busy retry and hide unsafe references", () => {
  const markup = renderToStaticMarkup(React.createElement(componentExports.ErrorState, { kind: "unavailable", onRetry() {}, busy: true, correlationId: "<private>" }));
  assert.match(markup, /aria-labelledby=/);
  assert.match(markup, /aria-busy="true"/);
  assert.match(markup, /disabled=""/);
  assert.match(markup, /Service temporarily unavailable/);
  assert.ok(!markup.includes("private"));
  assert.match(renderToStaticMarkup(React.createElement(componentExports.ErrorState, { kind: "session" })), /href="\/login"/);
});

test("route boundaries expose the installed Next.js retry callback", async () => {
  for (const file of ["../src/app/error.tsx", "../src/app/(app)/error.tsx"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const exports = {};
    new Function("require", "exports", compiled)((id) => id === "@/components/ErrorState" ? componentExports : require(id), exports);
    const markup = renderToStaticMarkup(React.createElement(exports.default, { error: new Error("private"), retry() {} }));
    assert.match(markup, /Try again/);
    assert.ok(!markup.includes("private"));
  }
});

test("every error variant has a decorative illustration and a labelled recovery region", () => {
  for (const kind of ["forbidden", "server", "unavailable", "session", "network", "sync", "integration", "empty", "invite", "payment", "validation"]) {
    const markup = renderToStaticMarkup(React.createElement(componentExports.ErrorState, { kind }));
    assert.match(markup, /<svg[^>]+aria-hidden="true"/);
    assert.match(markup, /aria-labelledby=/);
    assert.match(markup, /Contact support/);
  }
  const { ErrorNotice } = localRequire("@/components/ErrorNotice");
  const markup = renderToStaticMarkup(React.createElement(ErrorNotice, { kind: "sync", title: "Data sync failed", correlationId: "<secret>" }, "Last successful data stays visible."));
  assert.match(markup, /role="status"/);
  assert.match(markup, /Last successful data/);
  assert.ok(!markup.includes("secret"));
});
