import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { findBash } from "./bash.js";

/**
 * The database copy to the iKorex server (infra/ikorex/scripts/copy-db.sh, docs/ikorex-migration/
 * DATABASE_MIGRATION_REPORT.md) against a real PostgreSQL: the whole schema from the migrations,
 * with its row-level security, dumped while writes keep arriving, restored, and checked table by
 * table. Needs the server CI starts (TEST_PG_PORT, TEST_PG_PASSWORD) or SELFHOST_TEST_PG_URL, and
 * bash with pg_dump, pg_restore and psql; with any of them missing, the suite is skipped.
 */
const adminUrl =
  process.env.SELFHOST_TEST_PG_URL ?? (process.env.TEST_PG_PORT ? `postgresql://app:${process.env.TEST_PG_PASSWORD ?? "app"}@127.0.0.1:${process.env.TEST_PG_PORT}/app` : undefined);
const root = resolve(__dirname, "../../..");
const script = join(root, "infra/ikorex/scripts/copy-db.sh").replace(/\\/g, "/");
const bash = findBash();
const hasPgTools = (() => {
  try {
    for (const tool of ["pg_dump", "pg_restore", "psql"]) execFileSync(tool, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

interface Facts {
  counts: Record<string, number>;
  rls: string[];
  policies: number;
  policies_md5: string;
}
interface Result {
  db: string;
  bytes?: number;
  sha256: string;
  facts: Facts;
}

describe.skipIf(!adminUrl || !bash || !hasPgTools)("database copy to the iKorex server (copy-db.sh)", () => {
  const id = randomUUID().replace(/-/g, "").slice(0, 10);
  const src = `copy_src_${id}`;
  const evo = `copy_evo_${id}`;
  const evoRole = `copy_evo_${id}`;
  const made: string[] = [];
  // Set in beforeAll, and the database address read only in hooks and tests: Vitest runs a skipped
  // suite's body too (to list its tests), where there is no database (Deploy to AWS's unit tests).
  let work = "";
  let admin: pg.Client;
  const url = (db: string) => {
    const u = new URL(adminUrl!);
    u.pathname = `/${db}`;
    return u.toString();
  };
  const pgEnv = () => {
    const conn = new URL(adminUrl!);
    return { PGHOST: conn.hostname, PGPORT: conn.port || "5432", PGUSER: decodeURIComponent(conn.username), PGPASSWORD: decodeURIComponent(conn.password), TMPDIR_COPY: work };
  };

  function run(command: "dump" | "restore" | "facts", env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string; result?: Record<string, Result> }> {
    return new Promise((done) => {
      execFile(bash!, [script, command], { env: { ...process.env, ...pgEnv(), ...env }, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        const line = stdout.split(/\r?\n/).find((l) => l.startsWith("COPY-RESULT "));
        done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr, result: line ? JSON.parse(line.slice("COPY-RESULT ".length)) : undefined });
      });
    });
  }
  const dbExists = async (name: string) => (await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name])).rowCount === 1;
  const sql = async (db: string, text: string) => {
    const c = new pg.Client({ connectionString: url(db) });
    await c.connect();
    try {
      return await c.query(text);
    } finally {
      await c.end();
    }
  };

  let dumped: Record<string, Result>;
  let liveCoordRows = 0;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "copy-db-")).replace(/\\/g, "/");
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    // The app's database as on RDS: its public schema made again (as the move to AWS did), then
    // every migration and init.sql's grants and policies.
    await admin.query(`CREATE DATABASE ${src}`);
    made.push(src);
    await sql(src, "DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate({
      databaseUrl: url(src),
      migrationsDir: join(root, "packages/db/prisma/migrations"),
      initSql: readFileSync(join(root, "infra/postgres/init.sql"), "utf8"),
    });
    await sql(src, `INSERT INTO coord_entries (k, v, n, "until") SELECT 'seed-' || g, 'v', g, 0 FROM generate_series(1, 50) g`);
    await sql(src, `INSERT INTO job_queue (id, queue, body) SELECT gen_random_uuid(), 'shopify', '{}'::jsonb FROM generate_series(1, 20)`);
    // The WhatsApp service's database: owned by a role of its own, as on RDS.
    await admin.query(`CREATE ROLE ${evoRole} NOLOGIN`);
    await admin.query(`CREATE DATABASE ${evo} OWNER ${evoRole}`);
    made.push(evo);
    await sql(evo, `SET ROLE ${evoRole}; CREATE TABLE "Instance" (id text PRIMARY KEY, name text); INSERT INTO "Instance" SELECT 'i' || g, 'n' FROM generate_series(1, 3) g`);
  }, 120_000);

  afterAll(async () => {
    for (const db of made.reverse()) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${evoRole}`).catch(() => {});
    await admin?.end();
    rmSync(work, { recursive: true, force: true });
  });

  it("dumps one snapshot while writes go on, its counts read inside it", async () => {
    // Writes the whole time the dump runs: the counts must be the snapshot's, not the live ones.
    const writer = new pg.Client({ connectionString: url(src) });
    await writer.connect();
    let writing = true;
    let n = 0;
    const writes = (async () => {
      while (writing) await writer.query(`INSERT INTO coord_entries (k, "until") VALUES ($1, 0)`, [`live-${n++}`]);
    })();
    await new Promise((r) => setTimeout(r, 200));
    const out = await run("dump", { DBS: "app evolution", DB_app: src, DB_evolution: evo, DEST_app: `${work}/app.dump`, DEST_evolution: `${work}/evolution.dump` });
    await new Promise((r) => setTimeout(r, 200));
    writing = false;
    await writes;
    liveCoordRows = Number((await writer.query(`SELECT count(*) FROM coord_entries`)).rows[0].count);
    await writer.end();

    expect(out.stderr).not.toContain("REFUSED");
    expect(out.code).toBe(0);
    dumped = out.result!;
    expect(Object.keys(dumped)).toEqual(["app", "evolution"]);
    const app = dumped.app!;
    expect(app.bytes).toBeGreaterThan(0);
    expect(app.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(app.facts.counts["public.job_queue"]).toBe(20);
    expect(app.facts.counts["public._prisma_migrations"]).toBeGreaterThan(50);
    // Rows written after the snapshot are not in it.
    expect(app.facts.counts["public.coord_entries"]).toBeGreaterThan(50);
    expect(app.facts.counts["public.coord_entries"]).toBeLessThan(liveCoordRows);
    // The real schema's row-level security came along in the facts.
    expect(app.facts.rls.length).toBeGreaterThan(20);
    expect(app.facts.policies).toBeGreaterThan(20);
    expect(dumped.evolution!.facts.counts).toEqual({ "public.Instance": 3 });
  }, 120_000);

  it("refuses a dump whose checksum is wrong, before any database changes", async () => {
    const target = `copy_bad_${id}`;
    const out = await run("restore", { DBS: "app", MODE: "fresh", SOURCE_app: `${work}/app.dump`, SHA_app: "0".repeat(64), TARGET_app: target });
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain("not restoring anything");
    expect(await dbExists(target)).toBe(false);
  });

  it("restores into new databases exactly what the snapshot held, Evolution's tables its own", async () => {
    const appTarget = `copy_app_${id}`;
    const evoTarget = `copy_evot_${id}`;
    made.push(appTarget, evoTarget);
    const out = await run("restore", {
      DBS: "app evolution",
      MODE: "fresh",
      SOURCE_app: `${work}/app.dump`,
      SHA_app: dumped.app!.sha256,
      TARGET_app: appTarget,
      NEED_ROLES_app: "app_rls app_system",
      SOURCE_evolution: `${work}/evolution.dump`,
      SHA_evolution: dumped.evolution!.sha256,
      TARGET_evolution: evoTarget,
      ROLE_evolution: evoRole,
    });
    expect(out.stderr).not.toContain("REFUSED");
    expect(out.code).toBe(0);
    const restored = out.result!;
    expect(restored.app!.facts).toEqual(dumped.app!.facts);
    expect(restored.evolution!.facts).toEqual(dumped.evolution!.facts);
    expect(restored.app!.sha256).toBe(dumped.app!.sha256);
    // Restored as its role: the WhatsApp service can still change its own tables.
    expect((await sql(evoTarget, `SELECT tableowner FROM pg_tables WHERE tablename = 'Instance'`)).rows[0].tableowner).toBe(evoRole);
    // `facts` reads the same again (the cutover's check after the migrations).
    const again = await run("facts", { DBS: "app evolution", TARGET_app: appTarget, TARGET_evolution: evoTarget });
    expect(again.result!.app!.facts).toEqual(dumped.app!.facts);
  }, 120_000);

  it("replaces a database only when nothing else is connected to it", async () => {
    const target = `copy_repl_${id}`;
    made.push(target);
    await admin.query(`CREATE DATABASE ${target}`);
    await sql(target, "CREATE TABLE stale (id int); INSERT INTO stale VALUES (1)");
    const env = { DBS: "app", SOURCE_app: `${work}/app.dump`, SHA_app: dumped.app!.sha256, TARGET_app: target };

    const empty = await run("restore", { ...env, MODE: "empty" });
    expect(empty.code).not.toBe(0);
    expect(empty.stderr).toContain("MODE=replace empties it");

    const holder = new pg.Client({ connectionString: url(target) });
    await holder.connect();
    const busy = await run("restore", { ...env, MODE: "replace" });
    await holder.end();
    expect(busy.code).not.toBe(0);
    expect(busy.stderr).toContain("other connection(s)");
    expect((await sql(target, "SELECT count(*) FROM stale")).rows[0].count).toBe("1");

    const replaced = await run("restore", { ...env, MODE: "replace" });
    expect(replaced.stderr).not.toContain("REFUSED");
    expect(replaced.code).toBe(0);
    expect(replaced.result!.app!.facts).toEqual(dumped.app!.facts);
  }, 120_000);

  it("drops a rehearsal's databases when it is done", async () => {
    const target = `copy_reh_${id}`;
    const out = await run("restore", { DBS: "evolution", MODE: "fresh", DROP_AFTER: "1", SOURCE_evolution: `${work}/evolution.dump`, SHA_evolution: dumped.evolution!.sha256, TARGET_evolution: target });
    expect(out.code).toBe(0);
    expect(out.result!.evolution!.facts).toEqual(dumped.evolution!.facts);
    expect(await dbExists(target)).toBe(false);
  }, 60_000);

  it("ships with LF line endings (bash on Linux refuses CR)", () => {
    const text = readFileSync(script, "utf8");
    expect(text).not.toContain("\r");
    expect(dirname(script)).toMatch(/infra\/ikorex\/scripts$/);
  });
});
