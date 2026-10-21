#!/usr/bin/env node
// Roll the app back to the release before the live one: moves the `live` alias of the api, jobs
// and cron functions to their previous published version, together (the UI ships inside the api
// package, so it rolls back too). Takes effect within seconds; the next `cdk deploy` moves them
// forward again.
//
//   node infra/cdk/scripts/rollback.mjs [--env production] [--to api=3,jobs=3,cron=3] [--dry-run]
//
// Without --to, each alias moves to the version just before its current one.
//
// Database migrations are not undone: releases are written to run on the newer schema.
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const envName = opt("--env", "production");
const region = opt("--region", "ap-southeast-2");
/** --to "api=3,jobs=3,cron=3" (what the deploy workflow records before it deploys). */
const to = Object.fromEntries((opt("--to", "") || "").split(",").filter((p) => /^[a-z]+=\d+$/.test(p)).map((p) => p.split("=")));
const dryRun = args.includes("--dry-run");
const aws = (a) => JSON.parse(execFileSync("aws", [...a, "--region", region, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

for (const part of ["api", "jobs", "cron"]) {
  const fn = `insights-${envName}-${part}`;
  const alias = aws(["lambda", "get-alias", "--function-name", fn, "--name", "live"]);
  const versions = aws(["lambda", "list-versions-by-function", "--function-name", fn])
    .Versions.map((v) => v.Version)
    .filter((v) => v !== "$LATEST")
    .map(Number)
    .sort((a, b) => a - b);
  const current = Number(alias.FunctionVersion);
  const target = to[part] ? Number(to[part]) : versions.filter((v) => v < current).pop();
  if (target === current) {
    console.log(`${fn}: already on ${current}`);
    continue;
  }
  if (!target || !versions.includes(target)) {
    console.log(`${fn}: no earlier version than ${current} to roll back to`);
    continue;
  }
  console.log(`${fn}: live ${current} -> ${target}${dryRun ? " (dry run)" : ""}`);
  if (!dryRun) aws(["lambda", "update-alias", "--function-name", fn, "--name", "live", "--function-version", String(target)]);
}
