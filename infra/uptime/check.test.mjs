// node --test infra/uptime/check.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { check, probe } from "./check.mjs";

const answer = (status, body) => async () => new globalThis.Response(body, { status });

test("probe: 200 is fine, readyz must say ok, anything else is named without its body", async () => {
  assert.equal(await probe("https://bizinsights.io/login", answer(200, "<html>")), null);
  assert.equal(await probe("https://bizinsights.io/api/readyz", answer(200, '{"ok":true}')), null);
  assert.equal(await probe("https://bizinsights.io/api/readyz", answer(200, '{"ok":false,"checks":{"db":false}}')), "https://bizinsights.io/api/readyz says it is not ready");
  assert.equal(await probe("https://bizinsights.io/api/readyz", answer(200, "<html>an edge error page</html>")), "https://bizinsights.io/api/readyz says it is not ready");
  assert.equal(await probe("https://bizinsights.io/login", answer(301, "")), "https://bizinsights.io/login answered 301");
  assert.equal(await probe("https://bizinsights.io/login", answer(502, "secret stack trace")), "https://bizinsights.io/login answered 502");
  const refused = async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  };
  assert.equal(await probe("https://bizinsights.io/login", refused), "https://bizinsights.io/login: ECONNREFUSED");
  const slow = async () => {
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  };
  assert.equal(await probe("https://bizinsights.io/login", slow), "https://bizinsights.io/login: no answer within 15 seconds");
});

test("check: all well means one look and no wait", async () => {
  let looks = 0;
  const waits = [];
  const problems = await check(["a", "b"], { probeImpl: async () => (looks++, null), wait: async (ms) => void waits.push(ms) });
  assert.deepEqual(problems, []);
  assert.equal(looks, 2);
  assert.deepEqual(waits, []);
});

test("check: a restart's blip clears on the second look, 30 seconds later", async () => {
  let round = 0;
  const waits = [];
  const problems = await check(["a", "b"], { probeImpl: async (u) => (round === 0 && u === "a" ? "a answered 502" : null), wait: async (ms) => void (waits.push(ms), round++) });
  assert.deepEqual(problems, []);
  assert.deepEqual(waits, [30_000]);
});

test("check: still wrong on the second look is what gets reported, each address by name", async () => {
  const problems = await check(["a", "b"], { probeImpl: async (u) => (u === "b" ? "b answered 503" : null), wait: async () => {} });
  assert.deepEqual(problems, ["b answered 503"]);
});
