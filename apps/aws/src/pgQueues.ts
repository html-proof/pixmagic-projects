import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { logger, withLogContext, type Producer, type QueueName, type Queues } from "@app/core";
import type { QueueMessage } from "@app/worker";
import { MAX_RECEIVES } from "./localQueues.js";

/**
 * Background jobs on PostgreSQL, for bizinsights on a server of its own (server.ts,
 * docs/ikorex-migration). The same contract as SQS and the jobs function on AWS (sqsQueues.ts,
 * consumer.ts), so no handler can tell the difference:
 *
 *   send(body, { delaySeconds })   a row in job_queue, due after the delay (no 15-minute cap here)
 *   attempts                       `receives`: every claim adds one (SQS's ApproximateReceiveCount)
 *   ack()                          the row is deleted
 *   retry({ delaySeconds })        the row is due again after the delay
 *   neither, or the job throws     due again after UNSETTLED_RETRY_S, logged (SQS: the visibility timeout)
 *   a claim                        a hold until `locked_until` (SQS's visibility timeout): a worker that
 *                                  dies mid-job loses its hold, and the job comes back by itself
 *   more than MAX_RECEIVES claims  the row moves to job_dead (SQS's redrive to the dead-letter queue)
 *
 * Claims take rows FOR UPDATE SKIP LOCKED, so any number of worker processes share the queues and no
 * job is held by two at once. Every hold has its own token: a worker whose hold lapsed (and was taken
 * over) can no longer settle the job, so the job is never deleted by the wrong worker.
 *
 * The rows are written on the system login (DATABASE_URL) through their own small pool, outside
 * @app/db's row scopes: the tables carry no tenant data (the body names its workspace, and the
 * handler runs under row-level security as it does on AWS).
 */

/** A job that neither acks nor retries, or throws, comes back after this (consume() itself never throws). */
export const UNSETTLED_RETRY_S = 60;
/** The longest a job may run: the jobs function's timeout on AWS (infra/cdk). */
export const JOB_TIMEOUT_MS = 900_000;
/** How long a claim holds a job: its time limit and a minute more, so a slow job is never taken twice. */
export const HOLD_S = JOB_TIMEOUT_MS / 1000 + 60;

export const QUEUE_NAMES: QueueName[] = ["sync", "webhooks", "aggregate", "email", "smsEvents", "whatsapp"];

/** Jobs at once per queue in one worker process: the jobs function's maxConcurrency per queue on AWS (infra/cdk app-stack.ts). */
export const DEFAULT_CONCURRENCY: Record<QueueName, number> = { sync: 2, webhooks: 2, aggregate: 2, email: 2, smsEvents: 2, whatsapp: 3 };

/**
 * QUEUE_CONCURRENCY ({"sync":4,...}) over the defaults. Each running job holds a database
 * connection, so the worker's DB_POOL_MAX has to cover the total.
 */
export function queueConcurrency(raw: string | undefined): Record<QueueName, number> {
  const out = { ...DEFAULT_CONCURRENCY };
  if (!raw) return out;
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  for (const [k, v] of Object.entries(parsed)) {
    if (!QUEUE_NAMES.includes(k as QueueName)) throw new Error(`QUEUE_CONCURRENCY names an unknown queue "${k}"`);
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 50) throw new Error(`QUEUE_CONCURRENCY.${k} must be a whole number from 0 to 50`);
    out[k as QueueName] = v;
  }
  return out;
}

const at = (ms: number) => new Date(ms).toISOString();

/** The producers: one row per message. */
export function pgQueues(pool: Pool, o: { now?: () => number } = {}): Queues {
  const now = o.now ?? Date.now;
  const producer = <T>(queue: QueueName): Producer<T> => ({
    async send(body, opts) {
      const delayMs = Math.max(0, Math.ceil(opts?.delaySeconds ?? 0)) * 1000;
      await pool.query("INSERT INTO job_queue (id, queue, body, run_after) VALUES ($1, $2, $3::jsonb, $4::timestamptz)", [
        randomUUID(),
        queue,
        JSON.stringify(body),
        at(now() + delayMs),
      ]);
    },
  });
  return { sync: producer("sync"), webhooks: producer("webhooks"), aggregate: producer("aggregate"), email: producer("email"), smsEvents: producer("smsEvents"), whatsapp: producer("whatsapp") };
}

interface Claimed {
  id: string;
  body: unknown;
  receives: number;
}

/** Take up to `limit` due jobs of one queue, holding each until now + holdS. */
export async function claimJobs(pool: Pool, queue: QueueName, limit: number, token: string, nowMs: number, holdS = HOLD_S): Promise<Claimed[]> {
  const { rows } = await pool.query<Claimed>(
    `UPDATE job_queue j SET receives = j.receives + 1, locked_until = $3::timestamptz, claim_token = $4::uuid
       FROM (SELECT id FROM job_queue
              WHERE queue = $1 AND run_after <= $5::timestamptz AND (locked_until IS NULL OR locked_until <= $5::timestamptz)
              ORDER BY priority DESC, run_after
              LIMIT $2
              FOR UPDATE SKIP LOCKED) due
      WHERE j.id = due.id
      RETURNING j.id, j.body, j.receives`,
    [queue, limit, at(nowMs + holdS * 1000), token, at(nowMs)],
  );
  return rows;
}

/** Done: the row goes, if this hold is still the job's. */
export async function ackJob(pool: Pool, id: string, token: string): Promise<boolean> {
  const r = await pool.query("DELETE FROM job_queue WHERE id = $1 AND claim_token = $2::uuid", [id, token]);
  return r.rowCount === 1;
}

/** Due again after `delaySeconds`, if this hold is still the job's. */
export async function retryJob(pool: Pool, id: string, token: string, delaySeconds: number, nowMs: number, error?: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE job_queue SET run_after = $3::timestamptz, locked_until = NULL, claim_token = NULL, last_error = COALESCE($4, last_error)
      WHERE id = $1 AND claim_token = $2::uuid`,
    [id, token, at(nowMs + Math.max(0, Math.ceil(delaySeconds)) * 1000), error ?? null],
  );
  return r.rowCount === 1;
}

/** Into job_dead (the dead-letter queue), if this hold is still the job's. */
export async function buryJob(pool: Pool, id: string, token: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const moved = await client.query(
      `INSERT INTO job_dead (id, queue, body, receives, last_error, created_at)
       SELECT id, queue, body, receives, last_error, created_at FROM job_queue WHERE id = $1 AND claim_token = $2::uuid
       ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, receives = EXCLUDED.receives, last_error = EXCLUDED.last_error, died_at = now()`,
      [id, token],
    );
    await client.query("DELETE FROM job_queue WHERE id = $1 AND claim_token = $2::uuid", [id, token]);
    await client.query("COMMIT");
    return moved.rowCount === 1;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Give back every hold in `tokens` at once (shutdown: the jobs are taken up again by the next worker). */
export async function releaseHolds(pool: Pool, tokens: string[]): Promise<number> {
  if (!tokens.length) return 0;
  const r = await pool.query("UPDATE job_queue SET locked_until = NULL, claim_token = NULL WHERE claim_token = ANY($1::uuid[])", [tokens]);
  return r.rowCount ?? 0;
}

export interface QueueStat {
  queue: string;
  /** Due and not held. */
  ready: number;
  /** Waiting for a delay or a retry's backoff. */
  delayed: number;
  /** Held by a worker now. */
  inFlight: number;
  /** In job_dead. */
  dead: number;
  /** How long the oldest due job has waited (seconds), 0 when none. */
  oldestReadyS: number;
}

/** Per queue, for /metrics and the admin command (every queue listed, even when empty). */
export async function queueStats(pool: Pool, nowMs: number): Promise<QueueStat[]> {
  const live = await pool.query<{ queue: string; ready: string; delayed: string; in_flight: string; oldest: string | null }>(
    `SELECT queue,
            count(*) FILTER (WHERE run_after <= $1::timestamptz AND (locked_until IS NULL OR locked_until <= $1::timestamptz)) AS ready,
            count(*) FILTER (WHERE run_after > $1::timestamptz AND (locked_until IS NULL OR locked_until <= $1::timestamptz)) AS delayed,
            count(*) FILTER (WHERE locked_until > $1::timestamptz) AS in_flight,
            extract(epoch FROM $1::timestamptz - min(run_after) FILTER (WHERE run_after <= $1::timestamptz AND (locked_until IS NULL OR locked_until <= $1::timestamptz))) AS oldest
       FROM job_queue GROUP BY queue`,
    [at(nowMs)],
  );
  const dead = await pool.query<{ queue: string; n: string }>("SELECT queue, count(*) AS n FROM job_dead GROUP BY queue");
  const names = new Set<string>([...QUEUE_NAMES, ...live.rows.map((r) => r.queue), ...dead.rows.map((r) => r.queue)]);
  return [...names].map((queue) => {
    const l = live.rows.find((r) => r.queue === queue);
    return {
      queue,
      ready: Number(l?.ready ?? 0),
      delayed: Number(l?.delayed ?? 0),
      inFlight: Number(l?.in_flight ?? 0),
      dead: Number(dead.rows.find((r) => r.queue === queue)?.n ?? 0),
      oldestReadyS: Math.max(0, Math.round(Number(l?.oldest ?? 0))),
    };
  });
}

export interface DeadJobRow {
  id: string;
  queue: string;
  receives: number;
  lastError: string | null;
  createdAt: string;
  diedAt: string;
}

/** The dead-letter queue's newest rows (no bodies: they can hold customer data). */
export async function listDead(pool: Pool, queue?: string, limit = 50): Promise<DeadJobRow[]> {
  const { rows } = await pool.query<{ id: string; queue: string; receives: number; last_error: string | null; created_at: Date; died_at: Date }>(
    `SELECT id, queue, receives, last_error, created_at, died_at FROM job_dead
      WHERE ($1::text IS NULL OR queue = $1) ORDER BY died_at DESC LIMIT $2`,
    [queue ?? null, limit],
  );
  return rows.map((r) => ({ id: r.id, queue: r.queue, receives: r.receives, lastError: r.last_error, createdAt: r.created_at.toISOString(), diedAt: r.died_at.toISOString() }));
}

/** Back into their queue with a fresh count (dlq.mjs's redrive on AWS). All of one queue, or one job by id. */
export async function redriveDead(pool: Pool, which: { queue?: string; id?: string }): Promise<number> {
  if (!which.queue && !which.id) throw new Error("redrive needs a queue or a job id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const moved = await client.query(
      `WITH gone AS (DELETE FROM job_dead WHERE ($1::text IS NULL OR queue = $1) AND ($2::uuid IS NULL OR id = $2::uuid) RETURNING id, queue, body)
       INSERT INTO job_queue (id, queue, body) SELECT id, queue, body FROM gone ON CONFLICT (id) DO NOTHING`,
      [which.queue ?? null, which.id ?? null],
    );
    await client.query("COMMIT");
    return moved.rowCount ?? 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Dead jobs older than `days` go (SQS keeps its dead-letter queue 14 days). */
export async function pruneDead(pool: Pool, nowMs: number, days = 14): Promise<number> {
  const r = await pool.query("DELETE FROM job_dead WHERE died_at < $1::timestamptz", [at(nowMs - days * 86_400_000)]);
  return r.rowCount ?? 0;
}

export type JobOutcome = "ack" | "retry" | "unsettled" | "threw" | "timeout" | "dead";

export interface RunnerOptions {
  pool: Pool;
  run: (queue: QueueName, msg: QueueMessage) => Promise<void>;
  concurrency: Record<QueueName, number>;
  /** Wait between empty polls of a queue. */
  pollMs?: number;
  jobTimeoutMs?: number;
  holdS?: number;
  now?: () => number;
  /** After each job (metrics). */
  onSettled?: (queue: QueueName, outcome: JobOutcome, ms: number) => void;
}

export interface QueueRunner {
  /** Jobs running in this process now, per queue. */
  running(): Record<QueueName, number>;
  /**
   * Stop claiming; wait up to `graceMs` for the running jobs, then give back the holds of any still
   * running, so another worker takes them up at once instead of after the hold.
   */
  stop(graceMs?: number): Promise<{ unfinished: number }>;
}

const TIMED_OUT = Symbol("timed out");

/** Claims and runs jobs of every queue with a concurrency above 0, until stopped. */
export function startQueueRunner(o: RunnerOptions): QueueRunner {
  const now = o.now ?? Date.now;
  const pollMs = o.pollMs ?? 1000;
  const jobTimeoutMs = o.jobTimeoutMs ?? JOB_TIMEOUT_MS;
  const holdS = o.holdS ?? HOLD_S;
  const running = Object.fromEntries(QUEUE_NAMES.map((q) => [q, 0])) as Record<QueueName, number>;
  const holds = new Map<string, QueueName>();
  const waiters = new Set<() => void>();
  let stopping = false;
  const finished: Array<() => void> = [];

  const wake = () => {
    for (const w of [...waiters]) w();
  };
  /** Resolves after `ms`, or as soon as a job finishes or the runner stops. */
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      waiters.add(done);
    });

  async function settle(queue: QueueName, job: Claimed, token: string): Promise<JobOutcome> {
    if (job.receives > MAX_RECEIVES) {
      logger.error({ queue, messageId: job.id, receives: job.receives }, "job moved to the dead-letter queue after its last delivery");
      await buryJob(o.pool, job.id, token);
      return "dead";
    }
    const state: { outcome: { kind: "ack" } | { kind: "retry"; delaySeconds: number } | null } = { outcome: null };
    const msg: QueueMessage = {
      id: job.id,
      body: job.body,
      attempts: job.receives,
      ack: () => {
        state.outcome = { kind: "ack" };
      },
      retry: (opts) => {
        state.outcome = { kind: "retry", delaySeconds: opts?.delaySeconds ?? 0 };
      },
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), jobTimeoutMs);
    });
    let result: typeof TIMED_OUT | "threw" | undefined;
    try {
      result = await Promise.race([withLogContext({ queue, messageId: job.id }, () => o.run(queue, msg)).then(() => undefined), limit]);
    } catch (err) {
      // consume() never throws; anything else that does gets the queue's own retry, as on SQS.
      logger.error({ err, queue, messageId: job.id }, "job threw");
      result = "threw";
    } finally {
      clearTimeout(timer);
    }
    if (result === TIMED_OUT) {
      // The work may still finish in the background; its ack can't land any more (the hold is given back).
      logger.error({ queue, messageId: job.id, limitMs: jobTimeoutMs }, "job ran past its time limit: retrying");
      await retryJob(o.pool, job.id, token, UNSETTLED_RETRY_S, now(), "time limit");
      return "timeout";
    }
    if (result === "threw") {
      await retryJob(o.pool, job.id, token, UNSETTLED_RETRY_S, now(), "threw");
      return "threw";
    }
    const settled = state.outcome;
    if (settled?.kind === "ack") {
      await ackJob(o.pool, job.id, token);
      return "ack";
    }
    if (settled?.kind === "retry") {
      await retryJob(o.pool, job.id, token, settled.delaySeconds, now());
      return "retry";
    }
    logger.error({ queue, messageId: job.id }, "job neither acked nor retried: retrying");
    await retryJob(o.pool, job.id, token, UNSETTLED_RETRY_S, now(), "unsettled");
    return "unsettled";
  }

  function handle(queue: QueueName, job: Claimed, token: string) {
    running[queue]++;
    holds.set(token, queue);
    const started = now();
    void settle(queue, job, token)
      .then((outcome) => o.onSettled?.(queue, outcome, now() - started))
      .catch((err: unknown) => {
        // Settling failed (the database went away): the hold lapses and the job comes back by itself.
        logger.error({ err, queue, messageId: job.id }, "could not settle a job; it comes back when its hold ends");
      })
      .finally(() => {
        running[queue]--;
        holds.delete(token);
        wake();
        if (stopping && Object.values(running).every((n) => n === 0)) for (const f of finished.splice(0)) f();
      });
  }

  async function loop(queue: QueueName) {
    const limit = o.concurrency[queue];
    while (!stopping) {
      const free = limit - running[queue];
      if (free <= 0) {
        await pause(pollMs);
        continue;
      }
      let jobs: Claimed[];
      // One token per job: each is settled, released or taken over on its own.
      const token = randomUUID();
      try {
        jobs = await claimJobs(o.pool, queue, 1, token, now(), holdS);
      } catch (err) {
        logger.error({ err, queue }, "claiming jobs failed; trying again shortly");
        await pause(pollMs * 5);
        continue;
      }
      const job = jobs[0];
      if (!job) {
        await pause(pollMs);
        continue;
      }
      handle(queue, job, token);
    }
  }

  for (const q of QUEUE_NAMES) if (o.concurrency[q] > 0) void loop(q);

  return {
    running: () => ({ ...running }),
    async stop(graceMs = 30_000) {
      stopping = true;
      wake();
      if (Object.values(running).some((n) => n > 0)) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, graceMs);
          finished.push(() => {
            clearTimeout(t);
            resolve();
          });
        });
      }
      const left = [...holds.keys()];
      if (left.length) {
        logger.warn({ jobs: left.length }, "stopping with jobs still running: their holds are given back");
        await releaseHolds(o.pool, left).catch((err: unknown) => logger.error({ err }, "giving back holds failed; they come back when the holds end"));
      }
      return { unfinished: left.length };
    },
  };
}
