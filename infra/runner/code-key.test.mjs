import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CI_IGNORES, codeChange, codeKey, ignoredByCi } from "./code-key.mjs";

test("ignoredByCi is ci.yml's paths-ignore", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const lists = [...workflow.matchAll(/paths-ignore: (\[.*\])/g)].map((m) => JSON.parse(m[1]));
  assert.equal(lists.length, 2, "push and pull_request");
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
  assert.notEqual(codeKey(entry("apps/api/src/app.ts", "f".repeat(40)) + entry("package.json", "b".repeat(40))), key);
  assert.notEqual(codeKey(code + entry("apps/api/src/new.ts", "a".repeat(40))), key);
  assert.notEqual(codeKey(entry("apps/api/src/moved.ts", "a".repeat(40)) + entry("package.json", "b".repeat(40))), key);
});

test("codeChange names the first file CI tests, or why it can't tell", () => {
  const ahead = (...files) => ({ status: "ahead", files: files.map((f) => (typeof f === "string" ? { filename: f } : f)) });
  assert.equal(codeChange(ahead("docs/zapier.md", "README.md")), null);
  assert.equal(codeChange(ahead()), null);
  assert.equal(codeChange({ status: "identical", files: [] }), null);
  assert.equal(codeChange(ahead("docs/zapier.md", "apps/api/src/app.ts")), "changed apps/api/src/app.ts");
  assert.equal(codeChange(ahead({ filename: "docs/old-script.md", previous_filename: "scripts/old.mjs" })), "changed docs/old-script.md");
  assert.equal(codeChange({ status: "diverged", files: [{ filename: "README.md" }] }), "rewrote the branch (diverged)");
  assert.equal(codeChange(ahead(...Array.from({ length: 300 }, (_, i) => `docs/${i}.md`))), "changed 300 or more files");
});
