import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setupPnpm } from "./setup-pnpm.mjs";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "pnpm setup test "));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ packageManager: "pnpm@9.15.0" }));
  const node = join(cwd, "node", "node.exe");
  const npm = join(dirname(node), "node_modules/npm/bin/npm-cli.js");
  mkdirSync(dirname(npm), { recursive: true });
  writeFileSync(npm, "");
  const env = { RUNNER_TOOL_CACHE: join(cwd, "tools"), GITHUB_PATH: join(cwd, "github-path") };
  return { cwd, node, env };
}

test("cold installs pin pnpm, retry downloads and publish a reusable CLI", (t) => {
  const options = fixture(t);
  const installs = [];
  options.run = (node, args) => {
    assert.equal(node, options.node);
    if (args[1] === "install") {
      installs.push(args);
      assert.ok(args.includes("pnpm@9.15.0"));
      assert.ok(args.includes("--fetch-retries=4"));
      assert.ok(args.includes("--ignore-scripts"));
      const prefix = args[args.indexOf("--prefix") + 1];
      const pkg = join(prefix, "node_modules/pnpm");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "9.15.0" }));
      const bin = join(prefix, "node_modules/.bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), "");
    } else assert.equal(args[1], "--version");
    return { status: 0 };
  };
  const first = setupPnpm(options);
  assert.equal(first.version, "9.15.0");
  assert.equal(readFileSync(options.env.GITHUB_PATH, "utf8"), `${first.bin}\n`);
  setupPnpm(options);
  assert.equal(installs.length, 1, "warm jobs must not download the bootstrap again");
});

test("failed installs do not publish a broken package manager", (t) => {
  const options = fixture(t);
  assert.throws(() => setupPnpm({ ...options, run: () => ({ status: 1 }) }), /Installing pnpm@9.15.0 failed/);
  assert.equal(existsSync(options.env.GITHUB_PATH), false);
});

test("unversioned package managers are rejected before execution", (t) => {
  const options = fixture(t);
  writeFileSync(join(options.cwd, "package.json"), JSON.stringify({ packageManager: "pnpm@latest" }));
  assert.throws(() => setupPnpm({ ...options, run: () => assert.fail("must not execute") }), /exact pnpm version/);
});
