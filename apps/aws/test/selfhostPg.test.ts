import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { QueueMessage } from "@app/worker";
import { MAX_RECEIVES } from "../src/localQueues.js";
import { importDynamoItems, pgCoord } from "../src/pgCoord.js";
import { ackJob, claimJobs, listDead, pgQueues, pruneDead, queueStats, redriveDead, releaseHolds, retryJob, startQueueRunner, UNSETTLED_RETRY_S, type JobOutcome } from "../src/pgQueues.js";
import { claimTick, startSchedules } from "../src/schedules.js";

/**
 * The self-hosted runtime against a real PostgreSQL (docs/ikorex-migration): the queue keeps SQS's
 * contract, the coordinator DynamoDB's, the schedule ticks run once. Each run makes its own
 * throwaway database with only the runtime's migration in it, on the server CI starts (TEST_PG_PORT,
 * TEST_PG_PASSWORD) or SELFHOST_TEST_PG_URL; with neither, the suite is skipped.
 */
const adminUrl =
  process.env.SELFHOST_TEST_PG_URL ?? (process.env.TEST_PG_PORT ? `postgresql://app:${process.env.TEST_PG_PASSWORD ?? "app"}@127.0.0.1:${process.env.TEST_PG_PORT}/app` : undefined);
const migration = resolve(__dirname, "../../../packages/db/prisma/migrations/20261106120000_selfhost_runtime/migration.sql");

const T0 = Date.parse("2026-11-06T10:00:00Z");

describe.skipIf(!adminUrl)("self-hosted runtime on PostgreSQL", () => {
  const dbName = `selfhost_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let admin: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
    await pool.query(readFileSync(migration, "utf8"));
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE job_queue, job_dead, schedule_ticks, coord_entries");
  });

  describe("queue", () => {
    it("delivers a job after its delay, counts deliveries, and deletes it on ack", async () => {
      let now = T0;
      const queues = pgQueues(pool, { now: () => now });
      await queues.sync.send({ storeId: "s1" } as never, { delaySeconds: 30 });
      expect(await claimJobs(pool, "sync", 5, randomUUID(), now)).toEqual([]);
      now += 30_000;
      const token = randomUUID();
      const [job] = await claimJobs(pool, "sync", 5, token, now);
      expect(job).toMatchObject({ body: { storeId: "s1" }, receives: 1 });
      // Held: nobody else gets it while the hold lasts.
      expect(await claimJobs(pool, "sync", 5, randomUUID(), now + 1000)).toEqual([]);
      expect(await ackJob(pool, job!.id, token)).toBe(true);
      expect((await pool.query("SELECT count(*)::int AS n FROM job_queue")).rows[0].n).toBe(0);
    });

    it("brings a retried job back after its delay with the next delivery count; a lapsed hold can't settle it", async () => {
      const t1 = randomUUID();
      await pgQueues(pool, { now: () => T0 }).email.send({ kind: "team_invitation", deliveryId: "m" });
      const [job] = await claimJobs(pool, "email", 1, t1, T0, 60);
      await retryJob(pool, job!.id, t1, 10, T0);
      expect(await claimJobs(pool, "email", 1, randomUUID(), T0 + 9_000)).toEqual([]);
      const t2 = randomUUID();
      const [again] = await claimJobs(pool, "email", 1, t2, T0 + 10_000, 60);
      expect(again).toMatchObject({ id: job!.id, receives: 2 });
      // The hold lapses (the worker died); another takes it; the first can no longer ack.
      const t3 = randomUUID();
      const [third] = await claimJobs(pool, "email", 1, t3, T0 + 71_000, 60);
      expect(third).toMatchObject({ id: job!.id, receives: 3 });
      expect(await ackJob(pool, job!.id, t2)).toBe(false);
      expect(await ackJob(pool, job!.id, t3)).toBe(true);
    });

    it("never hands one job to two claimers at once", async () => {
      const queues = pgQueues(pool, { now: () => T0 });
      for (let i = 0; i < 20; i++) await queues.webhooks.send({ eventId: `e${i}` } as never);
      const claims = await Promise.all(Array.from({ length: 10 }, () => claimJobs(pool, "webhooks", 3, randomUUID(), T0)));
      const ids = claims.flat().map((j) => j.id);
      expect(ids.length).toBe(20);
      expect(new Set(ids).size).toBe(20);
    });

    it("runs jobs through the runner with SQS's outcomes, and buries one after MAX_RECEIVES deliveries", async () => {
      const outcomes: Array<[string, JobOutcome]> = [];
      const seen: number[] = [];
      const queues = pgQueues(pool);
      await queues.aggregate.send({ storeId: "ok", days: [] });
      await queues.aggregate.send({ storeId: "retry-once", days: [] });
      await queues.aggregate.send({ storeId: "silent", days: [] });
      const runner = startQueueRunner({
        pool,
        pollMs: 20,
        concurrency: { sync: 0, webhooks: 0, aggregate: 2, email: 0, whatsapp: 0 },
        run: async (_q, msg: QueueMessage) => {
          const body = msg.body as { storeId: string };
          seen.push(msg.attempts);
          if (body.storeId === "ok") msg.ack();
          else if (body.storeId === "retry-once") {
            if (msg.attempts === 1) msg.retry({ delaySeconds: 0 });
            else msg.ack();
          }
          // "silent": neither ack nor retry.
        },
        onSettled: (q, outcome) => outcomes.push([q, outcome]),
      });
      const until = Date.now() + 5_000;
      while (outcomes.length < 4 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      await runner.stop(1_000);
      expect(outcomes.map((o) => o[1]).sort()).toEqual(["ack", "ack", "retry", "unsettled"]);
      const left = await pool.query("SELECT body->>'storeId' AS store, receives, run_after > now() AS later FROM job_queue");
      expect(left.rows).toEqual([{ store: "silent", receives: 1, later: true }]);
      expect(UNSETTLED_RETRY_S).toBe(60);

      // A job already delivered MAX_RECEIVES times goes to the dead-letter queue on its next claim.
      await pool.query("UPDATE job_queue SET receives = $1, run_after = now() - interval '1 second'", [MAX_RECEIVES]);
      const buried: JobOutcome[] = [];
      const second = startQueueRunner({
        pool,
        pollMs: 20,
        concurrency: { sync: 0, webhooks: 0, aggregate: 1, email: 0, whatsapp: 0 },
        run: async () => {
          throw new Error("must not run");
        },
        onSettled: (_q, outcome) => buried.push(outcome),
      });
      const until2 = Date.now() + 5_000;
      while (!buried.length && Date.now() < until2) await new Promise((r) => setTimeout(r, 25));
      await second.stop(1_000);
      expect(buried).toEqual(["dead"]);
      const dead = await listDead(pool, "aggregate");
      expect(dead).toHaveLength(1);
      expect(dead[0]).toMatchObject({ queue: "aggregate", receives: MAX_RECEIVES + 1 });
      expect(JSON.stringify(dead[0])).not.toContain("silent"); // no bodies in the listing

      const stats = await queueStats(pool, Date.now());
      expect(stats.find((s) => s.queue === "aggregate")).toMatchObject({ ready: 0, dead: 1 });
      expect(stats.map((s) => s.queue)).toEqual(expect.arrayContaining(["sync", "webhooks", "aggregate", "email", "whatsapp"]));

      expect(await redriveDead(pool, { queue: "aggregate" })).toBe(1);
      const [back] = (await pool.query("SELECT receives, body->>'storeId' AS store FROM job_queue")).rows;
      expect(back).toEqual({ receives: 0, store: "silent" });
      expect(await listDead(pool)).toEqual([]);
    });

    it("retries a job that throws or runs past its limit, and gives back holds still running at stop", async () => {
      const queues = pgQueues(pool);
      await queues.whatsapp.send({ kind: "wapp_send", messageId: "throws" });
      await queues.whatsapp.send({ kind: "wapp_send", messageId: "hangs" });
      const outcomes: JobOutcome[] = [];
      const runner = startQueueRunner({
        pool,
        pollMs: 20,
        jobTimeoutMs: 200,
        concurrency: { sync: 0, webhooks: 0, aggregate: 0, email: 0, whatsapp: 2 },
        run: async (_q, msg) => {
          if ((msg.body as { messageId: string }).messageId === "throws") throw new Error("boom");
          await new Promise(() => {}); // never settles
        },
        onSettled: (_q, outcome) => outcomes.push(outcome),
      });
      const until = Date.now() + 5_000;
      while (outcomes.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      await runner.stop(100);
      expect(outcomes.sort()).toEqual(["threw", "timeout"]);
      const rows = (await pool.query("SELECT body->>'messageId' AS m, last_error, claim_token FROM job_queue ORDER BY 1")).rows;
      expect(rows).toEqual([
        { m: "hangs", last_error: "time limit", claim_token: null },
        { m: "throws", last_error: "threw", claim_token: null },
      ]);

      // Stopping mid-job gives the hold back at once.
      await pool.query("UPDATE job_queue SET run_after = now() - interval '1 second'");
      let started = 0;
      const slow = startQueueRunner({
        pool,
        pollMs: 20,
        jobTimeoutMs: 300,
        concurrency: { sync: 0, webhooks: 0, aggregate: 0, email: 0, whatsapp: 1 },
        run: async () => {
          started++;
          await new Promise(() => {});
        },
      });
      const until2 = Date.now() + 5_000;
      while (!started && Date.now() < until2) await new Promise((r) => setTimeout(r, 25));
      expect(await slow.stop(50)).toEqual({ unfinished: 1 });
      expect((await pool.query("SELECT count(*)::int AS n FROM job_queue WHERE claim_token IS NOT NULL")).rows[0].n).toBe(0);
      expect(await releaseHolds(pool, [])).toBe(0);
      // Its time limit still fires after the stop; its retry finds the hold gone and changes nothing.
      await new Promise((r) => setTimeout(r, 400));
      expect((await pool.query("SELECT count(*)::int AS n FROM job_queue WHERE claim_token IS NOT NULL")).rows[0].n).toBe(0);
    });

    it("prunes dead jobs after 14 days", async () => {
      await pool.query("INSERT INTO job_dead (id, queue, body, receives, created_at, died_at) VALUES ($1, 'sync', '{}', 11, now(), now() - interval '15 days'), ($2, 'sync', '{}', 11, now(), now())", [randomUUID(), randomUUID()]);
      expect(await pruneDead(pool, Date.now())).toBe(1);
    });
  });

  describe("coordinator", () => {
    it("counts hits in a fixed window and starts again after it", async () => {
      let now = T0;
      const coord = pgCoord(pool, { now: () => now });
      expect(await coord.hit("rl:a", 60)).toBe(1);
      expect(await coord.hit("rl:a", 60)).toBe(2);
      now += 60_000;
      expect(await coord.hit("rl:a", 60)).toBe(1);
    });

    it("takes a value once, peeks without taking, and forgets it after its time", async () => {
      let now = T0;
      const coord = pgCoord(pool, { now: () => now });
      await coord.put("oauth:x", "state", 600);
      expect(await coord.peek("oauth:x")).toBe("state");
      expect(await coord.take("oauth:x")).toBe("state");
      expect(await coord.take("oauth:x")).toBeNull();
      await coord.put("signedout:s", "1", 10);
      now += 11_000;
      expect(await coord.peek("signedout:s")).toBeNull();
      expect(await coord.take("signedout:s")).toBeNull();
    });

    it("lets one holder take a lock until it is released or expires", async () => {
      let now = T0;
      const coord = pgCoord(pool, { now: () => now });
      const results = await Promise.all(Array.from({ length: 8 }, () => coord.acquire("lock:store", 5_000)));
      expect(results.filter(Boolean)).toHaveLength(1);
      await coord.release("lock:store");
      expect(await coord.acquire("lock:store", 5_000)).toBe(true);
      expect(await coord.acquire("lock:store", 5_000)).toBe(false);
      now += 5_000;
      expect(await coord.acquire("lock:store", 5_000)).toBe(true);
      expect(await coord.ping()).toBe(true);
      now += 10_000;
      expect(await coord.prune()).toBe(1);
    });

    it("imports DynamoDB's live items and skips expired ones", async () => {
      const n = await importDynamoItems(
        pool,
        [
          { k: { S: "signedout:abc" }, v: { S: "1" }, n: { N: "0" }, until: { N: String(T0 + 3_600_000) } },
          { k: { S: "old" }, v: { S: "x" }, until: { N: String(T0 - 1) } },
        ],
        T0,
      );
      expect(n).toBe(1);
      expect(await pgCoord(pool, { now: () => T0 }).peek("signedout:abc")).toBe("1");
    });
  });

  describe("schedule ticks", () => {
    it("lets one caller take a tick, again only after its lease when unfinished, and at most maxAttempts times", async () => {
      const lease = 20 * 60_000;
      const tick = Date.parse("2026-11-06T03:15:00Z");
      expect(await claimTick(pool, "nightly", tick, tick + 1_000, lease, 3)).toBe(true);
      expect(await claimTick(pool, "nightly", tick, tick + 2_000, lease, 3)).toBe(false);
      expect(await claimTick(pool, "nightly", tick, tick + 1_000 + lease, lease, 3)).toBe(true);
      expect(await claimTick(pool, "nightly", tick, tick + 1_000 + 2 * lease, lease, 3)).toBe(true);
      expect(await claimTick(pool, "nightly", tick, tick + 1_000 + 3 * lease, lease, 3)).toBe(false);
      await pool.query("UPDATE schedule_ticks SET finished_at = now()");
      expect(await claimTick(pool, "every15min", tick, tick, lease, 3)).toBe(true);
    });

    it("runs a due tick once across two workers and records its result", async () => {
      const now = () => Date.parse("2026-11-06T10:07:00Z");
      let runs = 0;
      const schedules = [{ name: "every15min", cron: "*/15 * * * *", timeZone: "UTC", catchUpMinutes: 14, run: async () => ({ run: ++runs }) }];
      const a = startSchedules({ pool, schedules, now }, { timer: false });
      const b = startSchedules({ pool, schedules, now }, { timer: false });
      const started = await Promise.all([a.check(), b.check()]);
      expect(started.flat()).toEqual(["every15min"]);
      expect(runs).toBe(1);
      expect(await a.check()).toEqual([]);
      const [row] = (await pool.query("SELECT tick, finished_at IS NOT NULL AS done, result FROM schedule_ticks")).rows;
      expect(row).toEqual({ tick: new Date("2026-11-06T10:00:00Z"), done: true, result: { run: 1 } });
      await a.stop();
      await b.stop();
    });

    it("records a failed run's error, for the next attempt after its lease", async () => {
      const now = () => Date.parse("2026-11-06T03:20:00Z");
      const s = startSchedules({ pool, schedules: [{ name: "nightly", cron: "15 3 * * *", timeZone: "UTC", catchUpMinutes: 720, run: async () => Promise.reject(new Error("db away")) }], now }, { timer: false });
      expect(await s.check()).toEqual(["nightly"]);
      const [row] = (await pool.query("SELECT finished_at, error, attempts FROM schedule_ticks")).rows;
      expect(row).toEqual({ finished_at: null, error: "db away", attempts: 1 });
      await s.stop();
    });
  });
});
