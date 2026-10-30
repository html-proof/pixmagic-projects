import { test } from "node:test";
import assert from "node:assert/strict";
import { watch } from "./stop-when-superseded.mjs";

const head = "1".repeat(40);
const env = { GITHUB_API_URL: "https://api.test", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "9", GITHUB_TOKEN: "t", PR_NUMBER: "7", PR_HEAD: head };
const file = (path, id) => ({ path, mode: "100644", type: "blob", sha: id.repeat(40) });
const listing = (files) => files.map((f) => `${f.mode} ${f.type} ${f.sha}\t${f.path}\0`).join("");
// The code this run tests (its checkout: the pull request merged into main).
const testedFiles = [file("apps/api/src/app.ts", "a"), file("package.json", "b"), file("README.md", "c"), file("docs/zapier.md", "d")];

// GitHub, minute by minute: rounds[i] is the pull request in minute i (the last one stays), either
// "closed" or { sha, files } (its merge into main), with mergeable (default true) and stale (the
// merge GitHub hands out is still the previous head's).
function fixture(rounds, { fail = () => false } = {}) {
  let clock = 0;
  const calls = [];
  const lines = [];
  const round = () => rounds[Math.min(Math.floor(clock / 60_000), rounds.length - 1)];
  const request = async (url, { method }) => {
    const path = url.replace("https://api.test/repos/o/r/", "");
    calls.push(`${method} ${path}`);
    if (fail(path, calls.length)) return { ok: false, status: 502 };
    const r = round();
    if (path === "pulls/7") {
      if (r === "closed") return { ok: true, json: async () => ({ state: "closed", merged: true, head: { sha: head } }) };
      return { ok: true, json: async () => ({ state: "open", head: { sha: r.sha }, mergeable: "mergeable" in r ? r.mergeable : true, merge_commit_sha: `merge-${r.sha}` }) };
    }
    if (path === `git/commits/merge-${r.sha}`) return { ok: true, json: async () => ({ parents: [{ sha: "main" }, { sha: r.stale ? head : r.sha }], tree: { sha: `tree-${r.sha}` } }) };
    if (path === `git/trees/tree-${r.sha}?recursive=1`) return { ok: true, json: async () => ({ truncated: false, tree: [{ path: "apps", mode: "040000", type: "tree", sha: "e".repeat(40) }, ...r.files] }) };
    if (path === "actions/runs/9/cancel") return { ok: true, status: 202 };
    throw new Error(`unexpected ${path}`);
  };
  const options = { env, tested: listing(testedFiles), request, wait: async (ms) => { clock += ms; }, now: () => clock, log: (line) => lines.push(line) };
  return { calls, lines, options };
}

test("an unchanged head never cancels, and the watch ends after 3 hours", async () => {
  const { calls, options } = fixture([{ sha: head }]);
  assert.equal(await watch(options), undefined);
  assert.equal(calls.length, 180);
  assert.ok(calls.every((c) => c === "GET pulls/7"));
});

test("a newer push that leaves the tested code as it is (docs only, or main merged in) lets the run carry on", async () => {
  const newer = "2".repeat(40);
  // Other docs, and the files in another order: the same code.
  const files = [file("docs/zapier.md", "f"), file("package.json", "b"), file("apps/api/src/app.ts", "a")];
  const { calls, lines, options } = fixture([{ sha: head }, { sha: newer, files }]);
  assert.equal(await watch(options), undefined);
  assert.equal(calls.filter((c) => c.startsWith("GET git/trees/")).length, 1, "compared once");
  assert.ok(!calls.some((c) => c.startsWith("POST")));
  assert.match(lines.join("\n"), /^::notice::A newer push to this pull request \(2222222\) leaves the code this run tests as it is/m);
});

test("a newer push that changes the tested code cancels the run and says where", async () => {
  const newer = "3".repeat(40);
  const files = [file("apps/api/src/app.ts", "9"), file("apps/api/src/new.ts", "8"), file("package.json", "b")];
  const { calls, lines, options } = fixture([{ sha: head }, { sha: head }, { sha: newer, files }]);
  assert.equal(await watch(options), "cancelled");
  assert.deepEqual(calls.slice(-4), ["GET pulls/7", `GET git/commits/merge-${newer}`, `GET git/trees/tree-${newer}?recursive=1`, "POST actions/runs/9/cancel"]);
  assert.equal(lines.at(-1), "::notice::Stopped: a newer push to this pull request (3333333) changes the code this run tests (apps/api/src/app.ts and 1 more). The run for that push tests it.");
});

test("it waits for GitHub to merge the newer head into main before comparing", async () => {
  const newer = "4".repeat(40);
  const files = [file("apps/api/src/app.ts", "9")];
  const { calls, options } = fixture([{ sha: head }, { sha: newer, files, mergeable: null }, { sha: newer, files, stale: true }, { sha: newer, files }]);
  assert.equal(await watch(options), "cancelled");
  assert.equal(calls.filter((c) => c.startsWith("GET git/trees/")).length, 1, "not the stale merge's tree");
  assert.equal(calls.filter((c) => c === "GET pulls/7").length, 4);
});

test("a newer push that conflicts with main cancels the run", async () => {
  const newer = "5".repeat(40);
  const { calls, lines, options } = fixture([{ sha: newer, mergeable: false }]);
  assert.equal(await watch(options), "cancelled");
  assert.deepEqual(calls, ["GET pulls/7", "POST actions/runs/9/cancel"]);
  assert.equal(lines.at(-1), "::notice::Stopped: a newer push to this pull request (5555555) conflicts with main, so this run's result can't count for it.");
});

test("GitHub errors are asked again, never a reason to stop", async () => {
  const newer = "6".repeat(40);
  // The first request and the first cancel fail: the next rounds compare again and cancel.
  const { calls, lines, options } = fixture([{ sha: newer, files: [file("apps/web/src/app.tsx", "7")] }], { fail: (path, n) => n === 1 || (path.endsWith("/cancel") && n < 6) });
  assert.equal(await watch(options), "cancelled");
  assert.equal(calls.filter((c) => c === "POST actions/runs/9/cancel").length, 2);
  assert.equal(lines.filter((l) => l.includes("Couldn't check for a newer push")).length, 2);
});

test("a closed pull request ends the watch without cancelling", async () => {
  const { calls, lines, options } = fixture([{ sha: head }, "closed"]);
  assert.equal(await watch(options), undefined);
  assert.ok(!calls.some((c) => c.startsWith("POST")));
  assert.match(lines.at(-1), /^Pull request #7 was merged/);
});

test("missing settings fail before asking GitHub anything", async () => {
  const request = () => assert.fail("must not ask");
  await assert.rejects(watch({ env: { ...env, GITHUB_TOKEN: "" }, tested: listing(testedFiles), request }), /GITHUB_TOKEN/);
  await assert.rejects(watch({ env, request }), /tested listing/);
});
