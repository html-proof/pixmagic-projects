import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Where scripts/rollback.mjs moves each `live` alias (decide), and the Deploy workflow's step that
 * moves them to the App stack's versions after `cdk deploy`. A rollback moves the aliases behind
 * CloudFormation's back; Deploy 41661760406 (2026-11-03), run again for the same commit, then found
 * "no changes", left live on release 160 and failed its smoke tests.
 */
type Next = { to?: number; stay?: string };
const { decide, parseVersions } = (await import(new URL("../scripts/rollback.mjs", import.meta.url).href)) as {
  decide: (a: { current: number; versions: number[]; target?: number; fromStack?: boolean; sameCode?: (a: number, b: number) => boolean }) => Next;
  parseVersions: (s: string) => Record<string, string>;
};
const { REPO_ROOT } = await import("../lib/config.js");

const versions = [158, 159, 160, 161];

describe("rollback.mjs", () => {
  it("reads the workflow's record and the stack's LiveVersions alike", () => {
    expect(parseVersions("api=161,jobs=161,cron=161")).toEqual({ api: "161", jobs: "161", cron: "161" });
    expect(parseVersions("api=,jobs=x,cron=3")).toEqual({ cron: "3" });
    expect(parseVersions("stack")).toEqual({});
  });

  it("goes back one version, or to the one asked for, as before", () => {
    expect(decide({ current: 161, versions })).toEqual({ to: 160 });
    expect(decide({ current: 161, versions, target: 159 })).toEqual({ to: 159 });
    expect(decide({ current: 160, versions, target: 160 })).toEqual({ stay: "already on 160" });
    expect(decide({ current: 158, versions })).toEqual({ stay: "no earlier version than 158 to roll back to" });
  });

  it("moves live forward to the stack's version after a rollback (the run again for the same commit)", () => {
    expect(decide({ current: 160, versions, target: 161, fromStack: true, sameCode: () => false })).toEqual({ to: 161 });
  });

  it("leaves live alone after a normal deploy, and after a restart for runtime settings (same code, newer version)", () => {
    const asked: number[][] = [];
    expect(decide({ current: 161, versions, target: 161, fromStack: true, sameCode: (a, b) => (asked.push([a, b]), false) })).toEqual({ stay: "already on 161" });
    expect(asked).toEqual([]);
    expect(decide({ current: 162, versions: [...versions, 162], target: 161, fromStack: true, sameCode: () => true })).toEqual({
      stay: "live 162 runs the code the stack deployed (version 161)",
    });
  });

  it("never reads a missing stack version as 'the one before'", () => {
    expect(() => decide({ current: 161, versions, target: undefined, fromStack: true })).toThrow(/isn't among the published versions/);
    expect(() => decide({ current: 161, versions, target: 170, fromStack: true })).toThrow(/170 isn't among/);
  });

  it("runs in the Deploy workflow right after cdk deploy, before the restart and everything that uses live", () => {
    const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/aws-deploy.yml"), "utf8").replace(/\r\n/g, "\n");
    const at = (name: string) => workflow.indexOf(`      - name: ${name}\n`);
    const step = at("The live aliases run what the App stack deployed");
    expect(step).toBeGreaterThan(at("Deploy (CDK)"));
    // The restart refuses an alias whose code isn't $LATEST's; the migrate and smoke tests run on live.
    for (const later of ["Restart the functions on changed runtime settings", "Database migrations", "Smoke tests"]) expect(step).toBeLessThan(at(later));
    const body = workflow.slice(step, workflow.indexOf("\n      - ", step + 1));
    expect(body).toContain("node infra/cdk/scripts/rollback.mjs --env production --to stack");
    // An older commit's rollback.mjs would take "--to stack" as no versions at all: one step back.
    expect(body).toContain('if ! grep -q -- "--to stack" infra/cdk/scripts/rollback.mjs; then');
    expect(readFileSync(join(REPO_ROOT, "infra/cdk/scripts/rollback.mjs"), "utf8")).toContain("--to stack");
  });
});
