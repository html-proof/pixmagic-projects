import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cron's migrate action ({"action":"migrate"}), against a stand-in database that records every
 * statement: one run at a time (the advisory lock the deploy's gate relies on), pending migrations
 * in order, each in its own transaction.
 */

const db = vi.hoisted(() => ({ statements: [] as string[], recorded: [] as string[], failOn: "", ended: 0 }));
vi.mock("pg", () => ({
  default: {
    Client: class {
      async connect() {}
      async end() {
        db.ended++;
      }
      async query(sql: string) {
        db.statements.push(sql);
        if (sql === db.failOn) throw new Error("column \"x\" already exists");
        if (sql.startsWith("SELECT migration_name")) return { rows: db.recorded.map((migration_name) => ({ migration_name })), rowCount: db.recorded.length };
        if (sql.includes("rolsuper OR rolbypassrls")) return { rows: [{ loose: false }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    },
  },
}));

const { migrate, MIGRATE_LOCK } = await import("../src/migrate.js");

const A = "ALTER TABLE stores ADD COLUMN a integer;";
const B = "ALTER TABLE stores ADD COLUMN b integer;";
const INIT = "-- init.sql\nGRANT SELECT ON ALL TABLES IN SCHEMA public TO app_rls;";
const dir = mkdtempSync(join(tmpdir(), "insights-migrations-"));
for (const [name, sql] of [["20260101000000_a", A], ["20260102000000_b", B]]) {
  mkdirSync(join(dir, name!));
  writeFileSync(join(dir, name!, "migration.sql"), sql!);
}
const run = () => migrate({ databaseUrl: "postgresql://owner@db/insights", migrationsDir: dir, initSql: INIT });
const at = (sql: string) => db.statements.indexOf(sql);

beforeEach(() => {
  db.statements = [];
  db.recorded = [];
  db.failOn = "";
  db.ended = 0;
});

describe("migrate", () => {
  it("takes the advisory lock first, before it reads what has run", async () => {
    await run();
    const lock = `SELECT pg_advisory_lock(${MIGRATE_LOCK})`;
    expect(db.statements[0]).toBe(lock);
    expect(db.statements.filter((s) => s === lock)).toHaveLength(1);
    expect(at(lock)).toBeLessThan(db.statements.findIndex((s) => s.startsWith('CREATE TABLE IF NOT EXISTS "_prisma_migrations"')));
    expect(at(lock)).toBeLessThan(db.statements.findIndex((s) => s.startsWith("SELECT migration_name")));
    expect(MIGRATE_LOCK).toBe(4172906301);
  });

  it("applies pending migrations in name order, each between BEGIN and COMMIT, then init.sql", async () => {
    expect(await run()).toEqual({ applied: ["20260101000000_a", "20260102000000_b"], total: 2 });
    for (const sql of [A, B]) {
      expect(db.statements[at(sql) - 1]).toBe("BEGIN");
      expect(db.statements[at(sql) + 2]).toBe("COMMIT");
    }
    expect(at(A)).toBeLessThan(at(B));
    expect(at(B)).toBeLessThan(at(INIT));
    expect(db.ended).toBe(1);
  });

  it("rolls a failed migration back, records why, says which, and still lets the lock go", async () => {
    db.failOn = B;
    await expect(run()).rejects.toThrow('Migration 20260102000000_b failed: column "x" already exists');
    expect(db.statements[at(B) + 1]).toBe("ROLLBACK");
    expect(db.statements[at(B) + 2]).toMatch(/^UPDATE "_prisma_migrations" SET logs/);
    expect(at(INIT)).toBe(-1);
    expect(db.ended).toBe(1);
  });

  it("applies nothing when every migration has run (the deploy's second run)", async () => {
    db.recorded = ["20260101000000_a", "20260102000000_b"];
    expect(await run()).toEqual({ applied: [], total: 2 });
    expect(at(A)).toBe(-1);
    expect(at(B)).toBe(-1);
    expect(at(INIT)).toBeGreaterThan(0);
  });
});
