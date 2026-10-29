import { test } from "node:test";
import assert from "node:assert/strict";
import { watch } from "./stop-when-superseded.mjs";

const head = "1".repeat(40);
const env = { GITHUB_API_URL: "https://api.test", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "9", GITHUB_TOKEN: "t", PR_NUMBER: "7", PR_HEAD: head };

// GitHub as a list of answers per round: each round asks for the pull request, maybe a compare, maybe a cancel.
function fixture(heads, { files = [], fail = () => false } = {}) {
  let clock = 0;
  const calls = [];
  const lines = [];
  const request = async (url, { method }) => {
    const path = url.replace("https://api.test/repos/o/r/", "");
    calls.push(`${method} ${path}`);
    if (fail(path, calls.length)) return { ok: false, status: 502 };
    if (path === "pulls/7") {
      const sha = heads[Math.min(Math.floor(clock / 60_000), heads.length - 1)];
      return { ok: true, json: async () => (sha === "closed" ? { state: "closed", merged: true, head: { sha: head } } : { state: "open", head: { sha } }) };
    }
    if (path.startsWith("compare/")) return { ok: true, json: async () => ({ status: "ahead", files: files.map((filename) => ({ filename })) }) };
    if (path === "actions/runs/9/cancel") return { ok: true, status: 202 };
    throw new Error(`unexpected ${path}`);
  };
  return { calls, lines, options: { env, request, wait: async (ms) => { clock += ms; }, now: () => clock, log: (line) => lines.push(line) } };
}

test("an unchanged head never cancels, and the watch ends after 3 hours", async () => {
  const { calls, options } = fixture([head]);
  assert.equal(await watch(options), undefined);
  assert.equal(calls.length, 180);
  assert.ok(calls.every((c) => c === "GET pulls/7"));
});

test("a newer push of only docs lets the run carry on, compared once", async () => {
  const newer = "2".repeat(40);
  const { calls, lines, options } = fixture([head, newer], { files: ["docs/zapier.md", "README.md"] });
  assert.equal(await watch(options), undefined);
  assert.equal(calls.filter((c) => c.startsWith("GET compare/")).length, 1);
  assert.ok(calls.includes(`GET compare/${head}...${newer}`));
  assert.ok(!calls.some((c) => c.startsWith("POST")));
  assert.match(lines.join("\n"), /^::notice::A newer push to this pull request \(2222222\) changed only Markdown or docs\//m);
});

test("a newer push that changes code cancels the run and says why", async () => {
  const newer = "3".repeat(40);
  const { calls, lines, options } = fixture([head, head, newer], { files: ["docs/zapier.md", "apps/api/src/app.ts"] });
  assert.equal(await watch(options), "cancelled");
  assert.deepEqual(calls.slice(-2), [`GET compare/${head}...${newer}`, "POST actions/runs/9/cancel"]);
  assert.equal(lines.at(-1), "::notice::Stopped: a newer push to this pull request (3333333) changed apps/api/src/app.ts. The run for that push tests it.");
});

test("GitHub errors are asked again, never a reason to stop", async () => {
  const newer = "4".repeat(40);
  // The first cancel fails: the next round compares again and cancels.
  const { calls, lines, options } = fixture([newer], { files: ["apps/web/src/app.tsx"], fail: (path, n) => n === 1 || (path.endsWith("/cancel") && n < 5) });
  assert.equal(await watch(options), "cancelled");
  assert.equal(calls.filter((c) => c === "POST actions/runs/9/cancel").length, 2);
  assert.equal(lines.filter((l) => l.includes("Couldn't check for a newer push")).length, 2);
});

test("a closed pull request ends the watch without cancelling", async () => {
  const { calls, lines, options } = fixture([head, "closed"]);
  assert.equal(await watch(options), undefined);
  assert.ok(!calls.some((c) => c.startsWith("POST")));
  assert.match(lines.at(-1), /^Pull request #7 was merged/);
});

test("missing settings fail before asking GitHub anything", async () => {
  await assert.rejects(watch({ env: { ...env, GITHUB_TOKEN: "" }, request: () => assert.fail("must not ask") }), /GITHUB_TOKEN/);
});
