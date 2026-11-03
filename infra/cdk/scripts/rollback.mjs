#!/usr/bin/env node
// Roll the app back to the release before the live one: moves the `live` alias of the api, jobs
// and cron functions to their previous published version, together (the UI ships inside the api
// package, so it rolls back too). Takes effect within seconds. CloudFormation never hears of it:
// the next deploy of a new commit moves them forward again, and a Deploy run again for the same
// commit does with --to stack (below).
//
//   node infra/cdk/scripts/rollback.mjs [--env production] [--to api=3,jobs=3,cron=3] [--dry-run]
//   node infra/cdk/scripts/rollback.mjs [--env production] --to stack [--dry-run]
//
// Without --to, each alias moves to the version just before its current one.
//
// --to stack moves each alias to the version the App stack deployed as live (its LiveVersions
// output), unless the alias already runs that version's code. It's the Deploy workflow's step after
// `cdk deploy`: once a rollback has moved the aliases back, CloudFormation still records the new
// versions, so a Deploy run again for that commit changes nothing ("no changes") and would leave
// them on the release before. A restart for changed runtime settings publishes the same code again
// as a newer version, and that alias stays where it is.
//
// Database migrations are not undone: releases are written to run on the newer schema. The App
// stack runs a release's migrations before it moves `live` (lib/migrate-before-live.ts), so the
// release before runs on the newer schema for up to a minute of every deploy too; nothing re-runs a
// migrate on a rollback. The versions --to stack goes to passed that gate when the stack deployed them.
import { execFileSync } from "node:child_process";

/** "api=3,jobs=3,cron=3" (what the deploy workflow records before it deploys, and LiveVersions). */
export const parseVersions = (s) => Object.fromEntries((s || "").split(",").filter((p) => /^[a-z]+=\d+$/.test(p)).map((p) => p.split("=")));

/**
 * Where one function's `live` alias goes: { to } to move it there, or { stay } with why not.
 * `target` is the version asked for, or undefined for the one before `current`. From the stack, a
 * target that isn't there is an error, never "the one before", and an alias already running the
 * target's code stays (`sameCode` is asked only then: it costs two calls).
 */
export function decide({ current, versions, target, fromStack = false, sameCode = () => false }) {
  if (fromStack && !(target && versions.includes(target))) throw new Error(`the App stack's live version ${target ?? "(none in LiveVersions)"} isn't among the published versions`);
  const to = target ?? versions.filter((v) => v < current).pop();
  if (to === current) return { stay: `already on ${current}` };
  if (!to || !versions.includes(to)) return { stay: `no earlier version than ${current} to roll back to` };
  if (fromStack && sameCode(current, to)) return { stay: `live ${current} runs the code the stack deployed (version ${to})` };
  return { to };
}

if (!process.env.VITEST) main();

function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const envName = opt("--env", "production");
  const region = opt("--region", "ap-southeast-2");
  const fromStack = opt("--to", "") === "stack";
  const dryRun = args.includes("--dry-run");
  const aws = (a) => JSON.parse(execFileSync("aws", [...a, "--region", region, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

  let to = parseVersions(opt("--to", ""));
  if (fromStack) {
    const stack = `InsightsApp-${envName}`;
    const recorded = (aws(["cloudformation", "describe-stacks", "--stack-name", stack]).Stacks[0].Outputs ?? []).find((o) => o.OutputKey === "LiveVersions")?.OutputValue;
    // Deployed from a commit before the output: nothing to compare with.
    if (!recorded) return console.log(`${stack} has no LiveVersions output: nothing to compare.`);
    console.log(`${stack} deployed ${recorded} as live.`);
    to = parseVersions(recorded);
  }

  for (const part of ["api", "jobs", "cron"]) {
    const fn = `insights-${envName}-${part}`;
    const alias = aws(["lambda", "get-alias", "--function-name", fn, "--name", "live"]);
    const versions = aws(["lambda", "list-versions-by-function", "--function-name", fn])
      .Versions.map((v) => v.Version)
      .filter((v) => v !== "$LATEST")
      .map(Number)
      .sort((a, b) => a - b);
    const current = Number(alias.FunctionVersion);
    const code = (v) => aws(["lambda", "get-function-configuration", "--function-name", fn, "--qualifier", String(v)]).CodeSha256;
    const next = decide({ current, versions, target: to[part] ? Number(to[part]) : undefined, fromStack, sameCode: (a, b) => code(a) === code(b) });
    if (!next.to) {
      console.log(`${fn}: ${next.stay}`);
      continue;
    }
    console.log(`${fn}: live ${current} -> ${next.to}${dryRun ? " (dry run)" : ""}`);
    if (!dryRun) aws(["lambda", "update-alias", "--function-name", fn, "--name", "live", "--function-version", String(next.to)]);
  }
}
