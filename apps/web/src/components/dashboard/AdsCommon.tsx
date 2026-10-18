"use client";
import { weekdayOf } from "@app/shared/sales";
import { fmtDay, fmtMoneyWhole, fmtRelative, fmtWeekday } from "./format";
import type { Column } from "./ColumnsWithTotal";

// ---------------------------------------------------------------------------
// What the Ads panel (money spent) and the Ad earnings panel (money earned) draw the same way:
// the day-by-day chart's columns and the state of each connected account.
// ---------------------------------------------------------------------------

/**
 * One column per day of a money figure (ad spend, AdSense earnings) for ColumnsWithTotal: the
 * biggest day highlighted and always labelled, weekends shaded, today faded, a running total.
 */
export function dailyMoneyColumns<D extends { day: string }>(series: D[], value: (d: D) => number, today: string, currency: string): Column[] {
  const n = series.length;
  const max = Math.max(0, ...series.map((d) => value(d)));
  let running = 0;
  return series.map((d) => {
    const v = value(d);
    running = Math.round((running + v) * 100) / 100;
    const weekend = weekdayOf(d.day) >= 5;
    const isToday = d.day === today;
    return {
      key: d.day,
      value: v,
      fill: v === max && max > 0 ? "var(--viz-tier-3)" : "var(--viz-tier-2)",
      faded: isToday,
      shaded: weekend,
      running,
      tick: {
        top: n <= 31 ? String(Number(d.day.slice(8))) : fmtDay(d.day, { year: false }),
        bottom: isToday ? "Today" : fmtWeekday(d.day),
        strong: weekend || isToday,
        major: n <= 31 || (n <= 120 ? weekdayOf(d.day) === 0 : d.day.endsWith("-01")),
      },
      label: v ? fmtMoneyWhole(v, currency) : undefined,
      keepLabel: v === max && max > 0,
    };
  });
}

interface AccountState {
  counted: boolean;
  status: string;
  lastSyncedAt: string | null;
}

/** Accounts left out of the totals (another currency), and those not read yet: still fetching, or stuck. */
export function accountGroups<A extends AccountState>(accounts: A[]) {
  return {
    left: accounts.filter((acc) => !acc.counted),
    // Never synced: still fetching while the account is fine; stuck if its first sync failed.
    waiting: accounts.filter((acc) => acc.counted && !acc.lastSyncedAt && acc.status === "active"),
    failing: accounts.filter((acc) => acc.counted && !acc.lastSyncedAt && acc.status !== "active"),
  };
}

/** An account's sync state, at the end of its row in the accounts list. */
export function AccountStatus({ acc }: { acc: Pick<AccountState, "status" | "lastSyncedAt"> }) {
  return (
    <span className={`text-xs ${acc.status === "reconnect" ? "text-danger" : acc.status === "error" ? "text-warn" : "text-muted"}`}>
      {acc.status === "reconnect" ? "Needs reconnecting" : acc.status === "error" ? "Sync problem" : acc.lastSyncedAt ? `Synced ${fmtRelative(acc.lastSyncedAt)}` : "Fetching history…"}
    </span>
  );
}
