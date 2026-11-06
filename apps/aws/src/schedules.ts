import type { Pool } from "pg";
import { logger, withLogContext } from "@app/core";

/**
 * Schedules for bizinsights on a server of its own (server.ts): EventBridge Scheduler's job on AWS
 * (infra/cdk app-stack.ts). Each worker process checks every `everyMs` which tick of each schedule
 * is due, and a tick runs only once however many workers there are: the first to insert its row
 * in schedule_ticks runs it. A restart finds a tick it missed (within the schedule's catch-up
 * window) and runs it then; a tick whose run failed, or whose worker died, is taken up again after
 * `leaseMs`, up to `maxAttempts` times (EventBridge retries a failed invocation twice).
 */

/** Five-field cron (minute hour day-of-month month day-of-week), with *, lists, ranges and steps. */
export function cronField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`Unreadable cron field "${field}"`);
    const step = m[4] ? Number(m[4]) : 1;
    const from = m[1] === "*" ? min : Number(m[2]);
    const to = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : from;
    if (step < 1 || from < min || to > max || from > to) throw new Error(`Cron field "${field}" is out of range`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

export interface CronExpr {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

export function parseCron(expr: string): CronExpr {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`Cron "${expr}" needs five fields`);
  const weekday = cronField(f[4]!, 0, 7);
  if (weekday.has(7)) weekday.add(0);
  return {
    minute: cronField(f[0]!, 0, 59),
    hour: cronField(f[1]!, 0, 23),
    day: cronField(f[2]!, 1, 31),
    month: cronField(f[3]!, 1, 12),
    weekday,
    dayRestricted: f[2] !== "*",
    weekdayRestricted: f[4] !== "*",
  };
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const zoneFormat = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock minute, hour, day, month and weekday of `ms` in `timeZone`. */
export function zonedParts(ms: number, timeZone: string) {
  let fmt = zoneFormat.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    zoneFormat.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { minute: Number(p.minute), hour: Number(p.hour), day: Number(p.day), month: Number(p.month), weekday: WEEKDAY[p.weekday!] ?? 0 };
}

export function cronMatches(c: CronExpr, ms: number, timeZone: string): boolean {
  const t = zonedParts(ms, timeZone);
  if (!c.minute.has(t.minute) || !c.hour.has(t.hour) || !c.month.has(t.month)) return false;
  // Standard cron: when both day fields are restricted, either may match.
  const day = c.day.has(t.day);
  const weekday = c.weekday.has(t.weekday);
  if (c.dayRestricted && c.weekdayRestricted) return day || weekday;
  return day && weekday;
}

/** The latest minute at or before `nowMs` (and no more than `lookbackMinutes` before it) that the cron names, or null. */
export function latestDue(c: CronExpr, timeZone: string, nowMs: number, lookbackMinutes: number): number | null {
  const start = Math.floor(nowMs / 60_000) * 60_000;
  for (let i = 0; i <= lookbackMinutes; i++) {
    const ms = start - i * 60_000;
    if (cronMatches(c, ms, timeZone)) return ms;
  }
  return null;
}

export interface Schedule {
  name: string;
  cron: string;
  timeZone: string;
  /** How late a missed tick may still run (a restart at 05:00 runs a 03:15 nightly with 120 or more). */
  catchUpMinutes: number;
  run: () => Promise<unknown>;
}

const at = (ms: number) => new Date(ms).toISOString();

/**
 * Take a tick: a new row, or one whose last attempt failed or was abandoned more than `leaseMs` ago
 * and has attempts left. True when this caller is to run it.
 */
export async function claimTick(pool: Pool, name: string, tickMs: number, nowMs: number, leaseMs: number, maxAttempts: number): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO schedule_ticks (name, tick, attempts, started_at) VALUES ($1, $2::timestamptz, 1, $3::timestamptz)
     ON CONFLICT (name, tick) DO UPDATE SET attempts = schedule_ticks.attempts + 1, started_at = EXCLUDED.started_at, error = NULL
       WHERE schedule_ticks.finished_at IS NULL AND schedule_ticks.started_at <= $4::timestamptz AND schedule_ticks.attempts < $5
     RETURNING attempts`,
    [name, at(tickMs), at(nowMs), at(nowMs - leaseMs), maxAttempts],
  );
  return r.rowCount === 1;
}

export interface ScheduleRunnerOptions {
  pool: Pool;
  schedules: Schedule[];
  everyMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  now?: () => number;
  onRun?: (name: string, ok: boolean, ms: number) => void;
}

export interface ScheduleRunner {
  /** One pass over every schedule (the timer calls it; tests call it directly). Resolves when the ticks it started have finished. */
  check(): Promise<string[]>;
  stop(): Promise<void>;
}

export function startSchedules(o: ScheduleRunnerOptions, opts: { timer?: boolean } = {}): ScheduleRunner {
  const now = o.now ?? Date.now;
  const leaseMs = o.leaseMs ?? 20 * 60_000;
  const maxAttempts = o.maxAttempts ?? 3;
  const parsed = o.schedules.map((s) => ({ ...s, expr: parseCron(s.cron) }));
  const busy = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  let stopped = false;

  async function runTick(s: (typeof parsed)[number], tick: number) {
    const started = now();
    busy.add(s.name);
    try {
      const result = await withLogContext({ schedule: s.name, tick: at(tick) }, () => s.run());
      await o.pool.query("UPDATE schedule_ticks SET finished_at = $3::timestamptz, result = $4::jsonb, error = NULL WHERE name = $1 AND tick = $2::timestamptz", [
        s.name,
        at(tick),
        at(now()),
        JSON.stringify(result ?? null),
      ]);
      logger.info({ schedule: s.name, tick: at(tick), result }, "scheduled run finished");
      o.onRun?.(s.name, true, now() - started);
    } catch (err) {
      logger.error({ err, schedule: s.name, tick: at(tick) }, "scheduled run failed; it is tried again after its lease");
      await o.pool
        .query("UPDATE schedule_ticks SET error = $3 WHERE name = $1 AND tick = $2::timestamptz", [s.name, at(tick), err instanceof Error ? err.message.slice(0, 500) : "failed"])
        .catch(() => {});
      o.onRun?.(s.name, false, now() - started);
    } finally {
      busy.delete(s.name);
    }
  }

  async function check(): Promise<string[]> {
    const started: string[] = [];
    const runs: Array<Promise<void>> = [];
    for (const s of parsed) {
      if (stopped || busy.has(s.name)) continue;
      const t = now();
      const tick = latestDue(s.expr, s.timeZone, t, s.catchUpMinutes);
      if (tick === null) continue;
      let mine: boolean;
      try {
        mine = await claimTick(o.pool, s.name, tick, t, leaseMs, maxAttempts);
      } catch (err) {
        logger.error({ err, schedule: s.name }, "could not check a schedule; the next pass tries again");
        continue;
      }
      if (!mine) continue;
      started.push(s.name);
      const p = runTick(s, tick);
      inFlight.add(p);
      runs.push(p.finally(() => inFlight.delete(p)));
    }
    await Promise.all(runs);
    return started;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  if (opts.timer !== false) {
    // Each pass is started without waiting for the last: a 15-minute run must not hold up another schedule.
    const pass = () => void check().catch((err: unknown) => logger.error({ err }, "schedule pass failed"));
    timer = setInterval(pass, o.everyMs ?? 20_000);
    pass();
  }

  return {
    check,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await Promise.allSettled([...inFlight]);
    },
  };
}

/** Tick records older than `days` go (the nightly schedule). */
export async function pruneTicks(pool: Pool, nowMs: number, days = 30): Promise<number> {
  const r = await pool.query("DELETE FROM schedule_ticks WHERE started_at < $1::timestamptz", [at(nowMs - days * 86_400_000)]);
  return r.rowCount ?? 0;
}
