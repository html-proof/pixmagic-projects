import type { Pool } from "pg";
import type { Coord } from "@app/core";

/**
 * The coordinator (rate-limit counters, one-time OAuth state, signed-out sessions, locks) on
 * PostgreSQL, for bizinsights on a server of its own (server.ts): DynamoDB's `coord` table on AWS
 * (dynamoCoord.ts), with the same semantics as memoryCoord. One row per key in coord_entries:
 * k, v (value), n (counter), until (epoch ms: when it stops counting or holding). Every statement
 * is one atomic upsert or delete, so any number of processes share it safely. Expired rows are
 * ignored on read and removed by prune() (the nightly schedule).
 *
 * A logged table, not UNLOGGED: a signed-out session forgotten after a crash would let its cookie
 * work again until it expired.
 */
export function pgCoord(pool: Pool, o: { now?: () => number } = {}): Coord & { prune(): Promise<number> } {
  const now = o.now ?? Date.now;
  return {
    async hit(key, windowSec) {
      const t = now();
      const { rows } = await pool.query<{ n: number }>(
        `INSERT INTO coord_entries (k, v, n, until) VALUES ($1, '', 1, $3)
         ON CONFLICT (k) DO UPDATE SET
           n = CASE WHEN coord_entries.until > $2 THEN coord_entries.n + 1 ELSE 1 END,
           v = CASE WHEN coord_entries.until > $2 THEN coord_entries.v ELSE '' END,
           until = CASE WHEN coord_entries.until > $2 THEN coord_entries.until ELSE $3 END
         RETURNING n`,
        [key, t, t + windowSec * 1000],
      );
      return rows[0]!.n;
    },
    async put(key, value, ttlSec) {
      await pool.query(
        `INSERT INTO coord_entries (k, v, n, until) VALUES ($1, $2, 0, $3)
         ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, n = 0, until = EXCLUDED.until`,
        [key, value, now() + ttlSec * 1000],
      );
    },
    async take(key) {
      const { rows } = await pool.query<{ v: string; until: string }>("DELETE FROM coord_entries WHERE k = $1 RETURNING v, until", [key]);
      const row = rows[0];
      return row && Number(row.until) > now() ? row.v : null;
    },
    async peek(key) {
      const { rows } = await pool.query<{ v: string }>("SELECT v FROM coord_entries WHERE k = $1 AND until > $2", [key, now()]);
      return rows[0]?.v ?? null;
    },
    async acquire(key, ttlMs) {
      const t = now();
      const r = await pool.query(
        `INSERT INTO coord_entries (k, v, n, until) VALUES ($1, '1', 0, $3)
         ON CONFLICT (k) DO UPDATE SET v = '1', n = 0, until = EXCLUDED.until WHERE coord_entries.until <= $2
         RETURNING k`,
        [key, t, t + ttlMs],
      );
      return r.rowCount === 1;
    },
    async release(key) {
      await pool.query("DELETE FROM coord_entries WHERE k = $1", [key]);
    },
    async ping() {
      try {
        await pool.query("SELECT 1 FROM coord_entries LIMIT 1");
        return true;
      } catch {
        return false;
      }
    },
    async prune() {
      const r = await pool.query("DELETE FROM coord_entries WHERE until <= $1", [now()]);
      return r.rowCount ?? 0;
    },
  };
}

/**
 * Copy DynamoDB's live items in (the cutover, docs/ikorex-migration): `items` as `aws dynamodb scan`
 * prints them. Expired ones are skipped. Returns how many were written.
 */
export async function importDynamoItems(pool: Pool, items: Array<Record<string, { S?: string; N?: string }>>, nowMs = Date.now()): Promise<number> {
  let n = 0;
  for (const it of items) {
    const key = it.k?.S;
    const until = Number(it.until?.N ?? 0);
    if (!key || until <= nowMs) continue;
    await pool.query(
      `INSERT INTO coord_entries (k, v, n, until) VALUES ($1, $2, $3, $4)
       ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, n = EXCLUDED.n, until = EXCLUDED.until`,
      [key, it.v?.S ?? "", Number(it.n?.N ?? 0), until],
    );
    n++;
  }
  return n;
}
