import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(new URL("../src/lib/apiClient.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const responseExports = {};
const responseSource = await readFile(new URL("../src/lib/apiResponse.ts", import.meta.url), "utf8");
const responseCompiled = ts.transpileModule(responseSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
new Function("exports", responseCompiled)(responseExports);
const accessSignals = [];
const clientExports = {};
new Function("require", "exports", outputText)((id) => {
  if (id === "./apiResponse") return responseExports;
  assert.equal(id, "@/lib/access");
  return { signalAccess: (detail) => accessSignals.push(detail) };
}, clientExports);
const { api, ApiError, friendlyError, actionError, isSignedOut, isTransient, safeCorrelationId, parseRetryAfter, setSharedTab, leaveSharedSession, SIGNED_OUT_EVENT } = clientExports;
const storage = new Map();
globalThis.sessionStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
globalThis.window = new globalThis.EventTarget();

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

test("Meta sign-in refusals give safe recovery instructions", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new globalThis.Response(JSON.stringify({ error: "exchange_failed", message: "private provider token=secret" }), { status: 400 });
    await assert.rejects(api("/workspaces/ws/stores/store/whatsapp/connect/finish", { method: "POST", body: { code: "expired" } }), (error) => {
      const text = actionError(error, "finish connecting", { exchange_failed: "Meta didn't accept the sign-in. Please connect again." });
      assert.match(text, /Meta didn't accept the sign-in/);
      assert.match(text, /connect again/);
      assert.ok(!text.includes("secret"));
      assert.ok(!actionError(error, "save").includes("Meta"));
      return true;
    });
  } finally { globalThis.fetch = original; }
});
test("HTTP errors keep status and diagnostic reference without exposing response text", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new globalThis.Response(JSON.stringify({ error: "internal", message: "password=secret" }), { status: 503, headers: { "x-request-id": "req-123" } });
    await assert.rejects(api("/me"), (error) => error.status === 503 && error.correlationId === "req-123" && !error.message.includes("secret"));
    globalThis.fetch = async () => new globalThis.Response("<html>private gateway details</html>", { status: 502 });
    await assert.rejects(api("/me"), (error) => error.status === 502 && !error.message.includes("gateway"));
    globalThis.fetch = async () => { throw new TypeError("private network details"); };
    await assert.rejects(api("/me"), (error) => error.status === 0 && !isSignedOut(error));
    globalThis.fetch = async () => new globalThis.Response(JSON.stringify({ ok: true }));
    assert.deepEqual(await api("/healthz"), { ok: true });
  } finally { globalThis.fetch = original; }
});

// Render the real shared state component to check its accessible recovery markup.
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
const require = createRequire(import.meta.url);
function localRequire(id) {
  if (id === "@/lib/apiClient") return clientExports;
  if (!id.startsWith("@/")) return require(id);
  const base = new URL(`../src/${id.slice(2)}`, import.meta.url).href;
  const source = readFileSync(new URL(existsSync(new URL(`${base}.tsx`)) ? `${base}.tsx` : `${base}.ts`), "utf8");
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
  for (const kind of ["forbidden", "server", "unavailable", "session", "notFound", "network", "sync", "integration", "empty", "invite", "payment", "validation"]) {
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

test("full-page errors sit in the site's frame and show their status code", () => {
  const markup = renderToStaticMarkup(React.createElement(componentExports.ErrorState, { kind: "notFound", fullPage: true }));
  assert.match(markup, /aria-label="bizinsights home"/);
  assert.match(markup, />404<\/text>/);
  assert.match(markup, /Error 404/);
  assert.match(markup, /Page not found/);
  assert.match(markup, /Go back/);
  const offline = renderToStaticMarkup(React.createElement(componentExports.ErrorState, { kind: "network" }));
  assert.ok(!offline.includes("Error "));
  assert.ok(!offline.includes("bizinsights home"));
  assert.match(offline, /Offline/);
});

test("remaining HTTP failures keep distinct recovery meanings", async () => {
  const source = await readFile(new URL("../src/lib/errorKind.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const { errorKind, canRetryLoad } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  for (const [status, kind] of [[400, "request"], [408, "timeout"], [409, "conflict"], [410, "gone"], [413, "tooLarge"], [422, "validation"], [429, "rateLimit"], [502, "gateway"], [504, "gatewayTimeout"]]) {
    assert.equal(errorKind(status), kind);
    const markup = renderToStaticMarkup(React.createElement(componentExports.ErrorState, { kind }));
    assert.match(markup, /<svg/);
    assert.match(markup, /aria-labelledby=/);
    assert.equal(canRetryLoad(status), [408, 409, 429, 502, 504].includes(status));
  }
});

test("customer requests omit credentials and referrers and never expose provider text", async () => {
  const original = globalThis.fetch;
  try {
    let options;
    globalThis.fetch = async (_url, init) => { options = init; return new globalThis.Response(JSON.stringify({ message: "private provider token" }), { status: 410 }); };
    await assert.rejects(api("/public/track/example", { credentials: "omit", referrerPolicy: "no-referrer" }), (error) => error.status === 410 && !error.message.includes("provider"));
    assert.equal(options.credentials, "omit");
    assert.equal(options.referrerPolicy, "no-referrer");
  } finally { globalThis.fetch = original; }
});

test("requests have a bounded timeout and mutations warn about uncertain completion", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("private abort diagnostics"))));
    await assert.rejects(api("/slow", { timeoutMs: 5 }), (error) => error.status === 408 && !error.message.includes("private"));
    assert.match(actionError(new ApiError(408, "timeout", ""), "save"), /whether it completed/);
  } finally { globalThis.fetch = original; }
});

test("rate limit response carries a validated server retry time", async () => {
  const now = Date.now();
  assert.equal(parseRetryAfter("10", now), now + 10_000);
  assert.equal(parseRetryAfter("invalid", now), undefined);
  assert.equal(parseRetryAfter("-1", now), undefined);
  assert.equal(parseRetryAfter("0", now), undefined);
  assert.equal(parseRetryAfter(new Date(now - 10_000).toUTCString(), now), undefined);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new globalThis.Response("{}", { status: 429, headers: { "retry-after": "10" } });
    await assert.rejects(api("/limited"), (error) => error.status === 429 && error.retryAt >= now + 10_000);
  } finally { globalThis.fetch = original; }
});

test("late shared-session refusals do not sign the account out", async () => {
  const original = globalThis.fetch;
  let gone = 0;
  const listener = () => gone++;
  globalThis.window.addEventListener(SIGNED_OUT_EVENT, listener);
  try {
    setSharedTab(true);
    let answer;
    globalThis.fetch = (url, init) => {
      assert.equal(init.headers["x-bi-context"], "shared");
      if (url.endsWith("/auth/logout")) return Promise.resolve(new globalThis.Response("{}"));
      return new Promise((resolve) => { answer = resolve; });
    };
    const pending = api("/slow-shared-call");
    await leaveSharedSession();
    answer(new globalThis.Response('{"error":"unauthenticated"}', { status: 401 }));
    await assert.rejects(pending, (error) => error.sessionLeft && !isSignedOut(error));
    assert.equal(gone, 0);
  } finally {
    globalThis.fetch = original;
    setSharedTab(false);
    globalThis.window.removeEventListener(SIGNED_OUT_EVENT, listener);
  }
});

test("transport retains permission signals and sign-in challenge data", async () => {
  const original = globalThis.fetch;
  accessSignals.length = 0;
  try {
    globalThis.fetch = async () => new globalThis.Response('{"error":"access_revoked"}', { status: 403, headers: { "x-access-fp": "workspace:revision" } });
    await assert.rejects(api("/restricted"), (error) => error.code === "access_revoked");
    assert.deepEqual(accessSignals, [{ workspaceId: "workspace", fingerprint: "revision" }, { refused: "access_revoked" }]);
    const detail = { challenge: { id: "challenge", email: "merchant@example.com" } };
    globalThis.fetch = async () => new globalThis.Response(JSON.stringify({ error: "code_required", detail }), { status: 401 });
    await assert.rejects(api("/auth/login"), (error) => {
      assert.deepEqual(error.data.detail, detail);
      return error.code === "code_required";
    });
  } finally { globalThis.fetch = original; }
});

test("public-link errors never change the merchant session or permissions", async () => {
  const original = globalThis.fetch;
  accessSignals.length = 0;
  try {
    setSharedTab(true);
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.headers["x-bi-context"], undefined);
      return new globalThis.Response('{"error":"access_revoked"}', { status: 403, headers: { "x-access-fp": "other:revision" } });
    };
    await assert.rejects(api("/public/track/token", { credentials: "omit" }));
    assert.deepEqual(accessSignals, []);
  } finally { globalThis.fetch = original; setSharedTab(false); }
});
