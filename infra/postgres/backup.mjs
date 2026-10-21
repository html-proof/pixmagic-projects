#!/usr/bin/env node
/**
 * Back up a Postgres database that runs in Docker (production's runs in the compose project's
 * `postgres` container on the owner's PC: docs/RUNBOOK.md, "Back up and restore the database").
 *
 *   node infra/postgres/backup.mjs [--container saas-project20-postgres-1] [--database app]
 *                                  [--out <folder>] [--keep-days 30] [--user app]
 *
 * 1. `pg_dump -Fc` inside the container (custom format: compressed, restorable table by table).
 * 2. Checks the dump is readable (`pg_restore --list`) before keeping it.
 * 3. Copies it to --out as <database>-auto-<UTC timestamp>.dump (default: ~/insights-backups).
 * 4. Deletes this script's own older dumps (`<database>-auto-*.dump`) past --keep-days, never the
 *    newest one and never a file it didn't name (hand-made backups are left alone).
 *
 * Nothing is written to stdout but progress; exit code 0 only when the new dump was verified and
 * saved. Point --out at a folder that is copied off this machine (a synced cloud folder) for the
 * backup to survive the PC. Schedule it with Windows Task Scheduler (docs/RUNBOOK.md).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const container = arg("container", "saas-project20-postgres-1");
const database = arg("database", "app");
const user = arg("user", "app");
const out = resolve(arg("out", join(homedir(), "insights-backups")));
const keepDays = Number(arg("keep-days", "30"));
if (!/^[A-Za-z0-9_.-]+$/.test(container) || !/^[A-Za-z0-9_]+$/.test(database) || !/^[A-Za-z0-9_]+$/.test(user)) {
  console.error("container, database and user may only contain letters, digits, _ . -");
  process.exit(2);
}
if (!Number.isFinite(keepDays) || keepDays < 1) {
  console.error("--keep-days must be 1 or more");
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
const name = `${database}-auto-${stamp}.dump`;
const inContainer = `/tmp/${name}`;
const docker = (...args) => execFileSync("docker", args, { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 }).toString();

try {
  console.log(`Dumping ${database} from ${container}...`);
  docker("exec", container, "pg_dump", "-U", user, "-d", database, "-Fc", "-f", inContainer);
  const tables = docker("exec", container, "pg_restore", "--list", inContainer)
    .split("\n")
    .filter((l) => / TABLE DATA /.test(l)).length;
  if (tables === 0) throw new Error("the dump lists no table data; not keeping it");
  mkdirSync(out, { recursive: true });
  docker("cp", `${container}:${inContainer}`, join(out, name));
  const size = statSync(join(out, name)).size;
  console.log(`Saved ${join(out, name)} (${(size / 1024 / 1024).toFixed(1)} MB, ${tables} tables with data, verified readable).`);
} catch (err) {
  console.error(`Backup failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  try {
    docker("exec", container, "rm", "-f", inContainer);
  } catch {
    /* the container may be gone; nothing to clean */
  }
}

if (process.exitCode !== 1) {
  const mine = new RegExp(`^${database}-auto-\\d{8}-\\d{6}Z\\.dump$`);
  const cutoff = Date.now() - keepDays * 86_400_000;
  const dumps = readdirSync(out)
    .filter((f) => mine.test(f))
    .map((f) => ({ f, at: statSync(join(out, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { f, at } of dumps.slice(1)) {
    if (at < cutoff) {
      unlinkSync(join(out, f));
      console.log(`Removed ${f} (older than ${keepDays} days).`);
    }
  }
}
