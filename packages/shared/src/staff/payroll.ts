// The pay engine: worked time -> regular / overtime / double-time / holiday hours -> gross pay.
//
// Pure and deterministic, so the API, the payroll run, the payslip and the tests all agree to the
// cent. Time is whole epoch seconds; money is bigint minor units (see money.ts).
//
// How time is classified (documented for merchants in docs/staff.md):
//  1. Each shift is cut at the organization's local midnights; a piece belongs to its local day.
//     (So an overnight shift's hours land on the days they were worked, and a shift crossing the
//     end of a pay period is split between the two periods.)
//  2. Pieces are taken in time order. Within a local day, time past the daily threshold is
//     overtime, and past the double-time threshold double time. Within a week (starting on the
//     organization's week start), regular time past the weekly threshold is overtime. Overtime
//     already counted for the day does not count again towards the weekly threshold.
//  3. On a public holiday with a premium, regular-tier time is "holiday" time at the holiday
//     multiplier, and overtime there is paid at whichever multiplier is higher.
// Jurisdictions differ (shift-based workdays, rest-day rules, penalty rates): this covers the
// common threshold rules and labels all results as estimates until a region's rules are configured.
//
// Imported by the UI through `@app/shared/staff`: relative imports stay extensionless.

import { earningsMinor, formatScaled, MULTIPLIER_SCALE, parseDecimal, RATE_SCALE } from "./money";
import { endOfLocalDay, localDayOf, startOfWeek } from "./time";

export const PAY_CATEGORIES = ["regular", "overtime", "double_time", "holiday"] as const;
export type PayCategory = (typeof PAY_CATEGORIES)[number];

export const PAY_CATEGORY_LABEL: Record<PayCategory, string> = {
  regular: "Regular hours",
  overtime: "Overtime",
  double_time: "Double time",
  holiday: "Public holiday",
};

/** An organization's or employee's overtime rules. Null thresholds are switched off. */
export interface OvertimeRules {
  dailyThresholdMinutes: number | null;
  weeklyThresholdMinutes: number | null;
  /** Overtime multiplier, e.g. "1.5". */
  multiplier: string;
  doubleTimeDailyThresholdMinutes: number | null;
  doubleTimeMultiplier: string | null;
  /** "1" means no holiday premium. */
  holidayMultiplier: string;
}

/** A stretch of paid working time (unpaid breaks already taken out), in epoch seconds. */
export interface WorkInterval {
  sessionId: string;
  start: number;
  end: number;
}

export interface WorkChunk {
  sessionId: string;
  start: number;
  end: number;
  seconds: number;
  /** Local day the time was worked on. */
  day: string;
  category: PayCategory;
  /** Scaled multiplier as a fixed decimal string ("1.5000"). */
  multiplier: string;
}

const ONE = 10n ** BigInt(MULTIPLIER_SCALE);
const mult = (s: string) => parseDecimal(s, MULTIPLIER_SCALE);
const multStr = (v: bigint) => formatScaled(v, MULTIPLIER_SCALE);

/** Overtime rules that classify everything as regular time. */
export const NO_OVERTIME: OvertimeRules = {
  dailyThresholdMinutes: null,
  weeklyThresholdMinutes: null,
  multiplier: "1",
  doubleTimeDailyThresholdMinutes: null,
  doubleTimeMultiplier: null,
  holidayMultiplier: "1",
};

/**
 * Classify paid working time. Overlapping intervals (two sessions covering the same minutes, which
 * the API refuses but old data could hold) are counted once: the later one is clipped.
 */
export function allocateWork(
  intervals: readonly WorkInterval[],
  opts: { timeZone: string; weekStartsOn: number; rules: OvertimeRules | null; holidays?: ReadonlySet<string> },
): WorkChunk[] {
  const rules = opts.rules ?? NO_OVERTIME;
  const holidays = opts.holidays ?? new Set<string>();
  const dailyTh = rules.dailyThresholdMinutes != null ? rules.dailyThresholdMinutes * 60 : null;
  const weeklyTh = rules.weeklyThresholdMinutes != null ? rules.weeklyThresholdMinutes * 60 : null;
  const dtTh = rules.doubleTimeDailyThresholdMinutes != null && rules.doubleTimeMultiplier ? rules.doubleTimeDailyThresholdMinutes * 60 : null;
  const otMult = mult(rules.multiplier);
  const dtMult = rules.doubleTimeMultiplier ? mult(rules.doubleTimeMultiplier) : otMult;
  const holMult = mult(rules.holidayMultiplier);

  const sorted = [...intervals].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const dayWorked = new Map<string, number>();
  const weekRegular = new Map<string, number>();
  const out: WorkChunk[] = [];
  let cursor = -Infinity;

  for (const iv of sorted) {
    let t = Math.max(iv.start, cursor);
    const end = iv.end;
    if (t >= end) continue;
    cursor = end;
    while (t < end) {
      const day = localDayOf(t * 1000, opts.timeZone);
      const dayEnd = Math.min(end, Math.floor(endOfLocalDay(day, opts.timeZone) / 1000));
      const week = startOfWeek(day, opts.weekStartsOn);
      while (t < dayEnd) {
        const dw = dayWorked.get(day) ?? 0;
        const wr = weekRegular.get(week) ?? 0;
        let category: PayCategory;
        let limit = Infinity;
        if (dtTh !== null && dw >= dtTh) {
          category = "double_time";
        } else if ((dailyTh !== null && dw >= dailyTh) || (weeklyTh !== null && wr >= weeklyTh)) {
          category = "overtime";
          if (dtTh !== null) limit = dtTh - dw;
        } else {
          category = "regular";
          if (dailyTh !== null) limit = Math.min(limit, dailyTh - dw);
          if (weeklyTh !== null) limit = Math.min(limit, weeklyTh - wr);
          if (dtTh !== null) limit = Math.min(limit, dtTh - dw);
        }
        const len = Math.min(dayEnd - t, limit);
        let m = category === "regular" ? ONE : category === "overtime" ? otMult : dtMult;
        if (holidays.has(day) && holMult > ONE) {
          if (category === "regular") {
            category = "holiday";
            m = holMult;
          } else if (holMult > m) {
            m = holMult;
          }
        }
        const prev = out[out.length - 1];
        // Consecutive time of the same kind is one chunk (two sessions back to back stay two).
        if (prev && prev.sessionId === iv.sessionId && prev.end === t && prev.day === day && prev.category === category && prev.multiplier === multStr(m)) {
          prev.end += len;
          prev.seconds += len;
        } else {
          out.push({ sessionId: iv.sessionId, start: t, end: t + len, seconds: len, day, category, multiplier: multStr(m) });
        }
        dayWorked.set(day, dw + len);
        if (category === "regular" || category === "holiday") weekRegular.set(week, wr + len);
        t += len;
      }
    }
  }
  return out;
}

/** A pay rate in force from a local day (inclusive) until the next one starts. */
export interface RateSpan {
  effectiveFrom: string;
  /** Major units per hour, e.g. "20.00". */
  hourlyRate: string;
}

/** The rate in force on `day`, or null when none had started yet. */
export function rateOn(rates: readonly RateSpan[], day: string): string | null {
  let best: RateSpan | null = null;
  for (const r of rates) {
    if (r.effectiveFrom <= day && (!best || r.effectiveFrom > best.effectiveFrom)) best = r;
  }
  return best?.hourlyRate ?? null;
}

export interface PayLine {
  category: PayCategory;
  /** Scaled rate string with RATE_SCALE places ("20.0000"). */
  hourlyRate: string;
  multiplier: string;
  seconds: number;
  amountMinor: bigint;
}

export interface PricedWork {
  lines: PayLine[];
  regularSeconds: number;
  overtimeSeconds: number;
  doubleTimeSeconds: number;
  holidaySeconds: number;
  /** Worked time on days with no pay rate set (not paid until one is). */
  unpricedSeconds: number;
  grossMinor: bigint;
}

/**
 * Price classified time. Time is grouped by category, rate and multiplier and each group is
 * rounded once, so a payslip's lines add up to its total exactly.
 */
export function priceWork(chunks: readonly WorkChunk[], rates: readonly RateSpan[], currency: string): PricedWork {
  const groups = new Map<string, { category: PayCategory; rate: bigint; multiplier: string; seconds: number }>();
  const result: PricedWork = { lines: [], regularSeconds: 0, overtimeSeconds: 0, doubleTimeSeconds: 0, holidaySeconds: 0, unpricedSeconds: 0, grossMinor: 0n };
  const rateCache = new Map<string, bigint | null>();
  for (const c of chunks) {
    if (c.category === "regular") result.regularSeconds += c.seconds;
    else if (c.category === "overtime") result.overtimeSeconds += c.seconds;
    else if (c.category === "double_time") result.doubleTimeSeconds += c.seconds;
    else result.holidaySeconds += c.seconds;
    let rate = rateCache.get(c.day);
    if (rate === undefined) {
      const r = rateOn(rates, c.day);
      rate = r === null ? null : parseDecimal(r, RATE_SCALE);
      rateCache.set(c.day, rate);
    }
    if (rate === null) {
      result.unpricedSeconds += c.seconds;
      continue;
    }
    const key = `${c.category}|${rate}|${c.multiplier}`;
    const g = groups.get(key);
    if (g) g.seconds += c.seconds;
    else groups.set(key, { category: c.category, rate, multiplier: c.multiplier, seconds: c.seconds });
  }
  const order = (c: PayCategory) => PAY_CATEGORIES.indexOf(c);
  for (const g of [...groups.values()].sort((a, b) => order(a.category) - order(b.category) || (a.rate < b.rate ? -1 : a.rate > b.rate ? 1 : 0))) {
    const amountMinor = earningsMinor(g.seconds, g.rate, mult(g.multiplier), currency);
    result.lines.push({ category: g.category, hourlyRate: formatScaled(g.rate, RATE_SCALE), multiplier: g.multiplier, seconds: g.seconds, amountMinor });
    result.grossMinor += amountMinor;
  }
  return result;
}

export interface BreakSpan {
  startAt: number;
  endAt: number | null;
  paid: boolean;
}

export interface SessionTime {
  intervals: WorkInterval[];
  /** Clock-in to clock-out (or to now), seconds. */
  spanSeconds: number;
  paidBreakSeconds: number;
  unpaidBreakSeconds: number;
  /** Time that counts as worked (span minus unpaid breaks). */
  workedSeconds: number;
}

/**
 * A session's paid working time: clock-in to clock-out minus unpaid breaks, in whole seconds.
 * An open session runs to `nowMs` but never past `capSeconds` after clock-in, so a forgotten
 * clock-out can't keep adding pay. Instants are epoch milliseconds in, seconds out.
 */
export function sessionWork(
  session: { id: string; clockInAt: number; clockOutAt: number | null },
  breaks: readonly BreakSpan[],
  nowMs: number,
  capSeconds?: number,
): SessionTime {
  const start = Math.floor(session.clockInAt / 1000);
  let end = Math.floor((session.clockOutAt ?? nowMs) / 1000);
  if (session.clockOutAt === null && capSeconds !== undefined) end = Math.min(end, start + capSeconds);
  end = Math.max(end, start);
  const clipped = breaks
    .map((b) => ({ s: Math.max(start, Math.floor(b.startAt / 1000)), e: Math.min(end, Math.floor((b.endAt ?? nowMs) / 1000)), paid: b.paid }))
    .filter((b) => b.e > b.s)
    .sort((a, b) => a.s - b.s);
  let paidBreak = 0;
  let unpaidBreak = 0;
  const intervals: WorkInterval[] = [];
  let t = start;
  let last = start;
  for (const b of clipped) {
    const s = Math.max(b.s, last);
    if (b.e <= s) continue;
    if (b.paid) paidBreak += b.e - s;
    else {
      unpaidBreak += b.e - s;
      if (s > t) intervals.push({ sessionId: session.id, start: t, end: s });
      t = b.e;
    }
    last = b.e;
  }
  if (end > t) intervals.push({ sessionId: session.id, start: t, end });
  const span = end - start;
  return { intervals, spanSeconds: span, paidBreakSeconds: paidBreak, unpaidBreakSeconds: unpaidBreak, workedSeconds: span - unpaidBreak };
}
