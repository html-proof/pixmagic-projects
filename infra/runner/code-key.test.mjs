import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CI_IGNORES, codeEntries, codeKey, ignoredByCi, listingEntries, treeEntries } from "./code-key.mjs";

test("ignoredByCi is ci.yml's paths-ignore", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const lists = [...workflow.matchAll(/paths-ignore: (\[.*\])/g)].map((m) => JSON.parse(m[1]));
  // Pushes to main only: a pull request of only these still reports its checks (ci.yml, top).
  assert.equal(lists.length, 1, "push to main");
  for (const list of lists) assert.deepEqual(list, CI_IGNORES, "change ignoredByCi with paths-ignore");
  for (const path of ["README.md", "apps/web/README.md", "docs/aws-deployment.md", "docs/images/flow.png"]) assert.ok(ignoredByCi(path), path);
  for (const path of ["apps/docs/page.ts", "notes.mdx", "docs.ts", "readme.md.ts", ".github/workflows/ci.yml"]) assert.ok(!ignoredByCi(path), path);
});

const entry = (path, id) => `100644 blob ${id}\t${path}\0`;

test("codeKey ignores Markdown and docs/, and nothing else", () => {
  const code = entry("apps/api/src/app.ts", "a".repeat(40)) + entry("package.json", "b".repeat(40));
  const key = codeKey(code + entry("README.md", "c".repeat(40)));
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(codeKey(code + entry("README.md", "d".repeat(40)) + entry("docs/zapier.md", "e".repeat(40))), key);
  assert.equal(codeKey(entry("package.json", "b".repeat(40)) + entry("apps/api/src/app.ts", "a".repeat(40))), key, "order doesn't count");
  assert.notEqual(codeKey(entry("apps/api/src/app.ts", "f".repeat(40)) + entry("package.json", "b".repeat(40))), key);
  assert.notEqual(codeKey(code + entry("apps/api/src/new.ts", "a".repeat(40))), key);
  assert.notEqual(codeKey(entry("apps/api/src/moved.ts", "a".repeat(40)) + entry("package.json", "b".repeat(40))), key);
});

test("GitHub's tree of a commit gives git's entries", () => {
  const tree = [
    { path: "apps", mode: "040000", type: "tree", sha: "1".repeat(40) },
    { path: "apps/run.sh", mode: "100755", type: "blob", sha: "2".repeat(40) },
    { path: "docs/zapier.md", mode: "100644", type: "blob", sha: "3".repeat(40) },
    { path: "link", mode: "120000", type: "blob", sha: "4".repeat(40) },
  ];
  const listing = [`100755 blob ${"2".repeat(40)}\tapps/run.sh`, `100644 blob ${"3".repeat(40)}\tdocs/zapier.md`, `120000 blob ${"4".repeat(40)}\tlink`, ""].join("\0");
  assert.deepEqual(codeEntries(treeEntries(tree)), codeEntries(listingEntries(listing)));
  assert.deepEqual(codeEntries(listingEntries(listing)), [`100755 blob ${"2".repeat(40)}\tapps/run.sh`, `120000 blob ${"4".repeat(40)}\tlink`]);
});
