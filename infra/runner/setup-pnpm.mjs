import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Install the repository's exact pnpm version without a second package-manager bootstrap. */
export function setupPnpm({ env = process.env, cwd = process.cwd(), node = process.execPath, run = spawnSync } = {}) {
  const manager = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).packageManager;
  const match = /^pnpm@(\d+\.\d+\.\d+)(?:\+sha(?:224|256|384|512)\.[a-f0-9]+)?$/.exec(manager ?? "");
  if (!match) throw new Error("packageManager must pin an exact pnpm version");
  if (!env.RUNNER_TOOL_CACHE || !env.GITHUB_PATH) throw new Error("RUNNER_TOOL_CACHE and GITHUB_PATH are required");
  const version = match[1];
  const prefix = join(env.RUNNER_TOOL_CACHE, "project-pnpm", version);
  const manifest = join(prefix, "node_modules", "pnpm", "package.json");
  const bin = join(prefix, "node_modules", ".bin");
  let installed;
  try { installed = JSON.parse(readFileSync(manifest, "utf8")).version; } catch { /* cold or incomplete cache */ }
  if (installed !== version || !existsSync(join(bin, process.platform === "win32" ? "pnpm.cmd" : "pnpm"))) {
    // setup-node's npm lives here on Windows and under ../lib on Linux/macOS.
    const npm = [join(dirname(node), "node_modules/npm/bin/npm-cli.js"), join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js")].find(existsSync);
    if (!npm) throw new Error("npm CLI not found beside Node; run actions/setup-node first");
    mkdirSync(prefix, { recursive: true });
    const result = run(node, [npm, "install", "--prefix", prefix, "--no-audit", "--no-fund", "--ignore-scripts", "--package-lock=false",
      "--fetch-retries=4", "--fetch-retry-mintimeout=10000", "--fetch-retry-maxtimeout=60000", `pnpm@${version}`], { stdio: "inherit", env });
    if (result.error || result.status !== 0) throw new Error(`Installing pnpm@${version} failed (${result.error?.message ?? result.status})`);
  }
  const actual = JSON.parse(readFileSync(manifest, "utf8")).version;
  if (actual !== version) throw new Error(`Expected pnpm@${version}, found ${actual}`);
  const cli = join(prefix, "node_modules", "pnpm", "bin", "pnpm.cjs");
  const check = run(node, [cli, "--version"], { stdio: "inherit", env });
  if (check.error || check.status !== 0) throw new Error(`pnpm@${version} did not start`);
  appendFileSync(env.GITHUB_PATH, `${bin}\n`);
  return { version, bin };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) setupPnpm();
