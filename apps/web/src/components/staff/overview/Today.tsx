"use client";
import Link from "next/link";
import { localDayOf, localTimeOf, type LiveStatus } from "@app/shared/staff";
import { Card } from "@/components/PageKit";
import { LoadError } from "@/components/LoadError";
import { Initials, LiveBadge } from "@/components/staff/ui";
import { fmtHours, fmtTime } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// The Staff overview's "today", as the Stitch design's screen 25 draws it: how many people are in
// each state, who is clocked in right now, and today's planned shifts on one timeline. Everything
// is the live board's answer (GET …/attendance/live) and today's schedule (GET …/schedules).
// ---------------------------------------------------------------------------------------------

export interface TodayRow {
  employee: { id: string; fullName: string; jobTitle: string; department: string | null };
  status: LiveStatus;
  clockInAt: string | null;
  openSessionId: string | null;
  onBreakSince: string | null;
  workedSeconds: number;
  pendingCorrections: number;
}

export interface TodayBoard {
  serverTime: string;
  timezone: string;
  day: string;
  holiday: { name: string } | null;
  kpis: { totalEmployees: number; working: number; onBreak: number; clockedOut: number; scheduledToday: number; absent: number; pendingReview: number; pendingCorrections: number; workedSecondsToday: number };
  rows: TodayRow[];
}

export interface TodayShift {
  id: string;
  employeeId: string;
  employee?: { fullName: string; jobTitle: string };
  day: string;
  startsAt: string;
  endsAt: string;
  breakMinutes: number;
  location: string | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Working 2 · On break 1 · Not in yet 1 · Clocked out 0", and the two that need a look. */
export function StatusChips({ board }: { board: TodayBoard }) {
  const k = board.kpis;
  const chips: Array<{ key: string; label: string; value: number; note: string; dot: string }> = [
    { key: "working", label: "Working", value: k.working, note: "clocked in now", dot: "bg-good" },
    { key: "on-break", label: "On break", value: k.onBreak, note: "out on a break", dot: "bg-warn" },
    { key: "not-in-yet", label: "Not in yet", value: board.rows.filter((r) => r.status === "not_in_yet").length, note: "their shift hasn't started", dot: "bg-muted" },
    { key: "clocked-out", label: "Clocked out", value: k.clockedOut, note: "finished for today", dot: "bg-home-tag" },
    { key: "absent", label: "Absent", value: k.absent, note: "scheduled, didn't clock in", dot: "bg-danger" },
    { key: "pending-review", label: "Pending review", value: k.pendingReview, note: "shifts that need a look", dot: "bg-warn" },
  ];
  return (
    <ul className="home-card animate-rise flex flex-wrap gap-2 p-3" aria-label="Who's in right now" data-testid="live-snapshot">
      {chips.map((c) => (
        <li key={c.key} className="flex items-center gap-2 rounded bg-home-soft px-3 py-1.5 text-sm" title={c.note} data-testid={`live-${c.key}`}>
          <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${c.dot}`} />
          <span className="font-medium">{c.label}</span>
          <span className="font-semibold tabular-nums">{c.value}</span>
          <span className="sr-only">({c.note})</span>
        </li>
      ))}
    </ul>
  );
}

/** Everyone clocked in now, with when they came in and what they've worked (as of the board's last update). */
export function WhoIsWorking({ board }: { board: TodayBoard }) {
  const tz = board.timezone;
  const now = Date.parse(board.serverTime);
  const inNow = board.rows.filter((r) => r.openSessionId);
  return (
    <Card
      id="who-is-working"
      title="Who's working"
      aside={
        <Link href="/staff/attendance" className="font-medium text-accent hover:underline">
          Open live attendance
        </Link>
      }
    >
      {inNow.length === 0 ? (
        <p className="text-sm text-muted">
          Nobody is clocked in right now.
          {board.kpis.scheduledToday > 0 ? ` ${plural(board.kpis.scheduledToday, "person is", "people are")} scheduled today.` : ""}
        </p>
      ) : (
        <ul className="divide-y divide-home-line">
          {inNow.map((r) => {
            const breakFor = r.onBreakSince ? Math.max(0, (now - Date.parse(r.onBreakSince)) / 1000) : 0;
            return (
              <li key={r.employee.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <Initials name={r.employee.fullName} />
                <div className="min-w-0 flex-1">
                  <p className="min-w-0 truncate">
                    <Link href={`/staff/employee?id=${encodeURIComponent(r.employee.id)}`} className="font-semibold hover:text-accent hover:underline">
                      {r.employee.fullName}
                    </Link>
                    {r.employee.jobTitle && <span className="text-sm text-muted"> · {r.employee.jobTitle}</span>}
                  </p>
                  <p className="text-sm text-muted">
                    {r.clockInAt ? `in ${fmtTime(r.clockInAt, tz)}` : "clocked in"}
                    {r.status === "on_break" && r.onBreakSince
                      ? `, on a break since ${fmtTime(r.onBreakSince, tz)} (${fmtHours(breakFor)})`
                      : `, ${fmtHours(r.workedSeconds)} worked`}
                    {r.pendingCorrections > 0 && ` · ${plural(r.pendingCorrections, "change request", "change requests")}`}
                  </p>
                </div>
                <LiveBadge status={r.status} />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** Minutes after local midnight of `iso` in `tz`, counted from `day` (a shift ending tomorrow is past 1440). */
function minutesOf(iso: string, day: string, tz: string): number {
  const ms = Date.parse(iso);
  const [h, m] = localTimeOf(ms, tz).split(":").map(Number) as [number, number];
  return h * 60 + m + (localDayOf(ms, tz) > day ? 1440 : 0);
}

const hourLabel = (h: number) => new Intl.DateTimeFormat(undefined, { hour: "numeric", timeZone: "UTC" }).format(Date.UTC(2000, 0, 1, h % 24));

/**
 * Today's planned shifts on one timeline (screen 25's "Today's shifts"): a row per person, a bar
 * per shift, and a line at the time it is now. The bars carry their times as words, so it reads
 * the same without the picture.
 */
export function TodaysShifts({ board, shifts, error, loading, onRetry }: { board: TodayBoard; shifts: TodayShift[] | null; error: unknown; loading: boolean; onRetry: () => void }) {
  const tz = board.timezone;
  const day = board.day;
  const aside = (
    <Link href="/staff/schedules" className="font-medium text-accent hover:underline">
      Shift schedules
    </Link>
  );
  if (error && !shifts) {
    return (
      <Card id="todays-shifts" title="Today's shifts" aside={aside}>
        <LoadError what="today's shifts" error={error} onRetry={onRetry} busy={loading} />
      </Card>
    );
  }
  if (!shifts) {
    return (
      <Card id="todays-shifts" title="Today's shifts" aside={aside}>
        <div className="skeleton h-32" aria-busy="true" aria-label="Loading" />
      </Card>
    );
  }
  if (!shifts.length) {
    return (
      <Card id="todays-shifts" title="Today's shifts" aside={aside}>
        <p className="text-sm text-muted">No shifts are planned for today. Planning shifts lets bizinsights spot late starts and absences.</p>
      </Card>
    );
  }
  const bars = shifts.map((s) => {
    const start = minutesOf(s.startsAt, day, tz);
    const end = Math.max(start + 1, minutesOf(s.endsAt, day, tz));
    return { s, start, end };
  });
  const from = Math.floor(Math.min(...bars.map((b) => b.start)) / 60) * 60;
  const to = Math.max(from + 60, Math.ceil(Math.max(...bars.map((b) => b.end)) / 60) * 60);
  const span = to - from;
  const at = (min: number) => `${((min - from) / span) * 100}%`;
  const now = minutesOf(board.serverTime, day, tz);
  const showNow = now >= from && now <= to;
  const hours = Array.from({ length: span / 60 + 1 }, (_, i) => from / 60 + i);
  // A label every hour on a short day, every other hour on a long one (they'd crowd a phone).
  const every = hours.length > 9 ? 2 : 1;
  // A row per person, in the order their first shift starts.
  const people = new Map<string, { name: string; bars: typeof bars }>();
  for (const b of [...bars].sort((x, y) => x.start - y.start)) {
    const p = people.get(b.s.employeeId) ?? { name: b.s.employee?.fullName ?? "Employee", bars: [] };
    p.bars.push(b);
    people.set(b.s.employeeId, p);
  }
  return (
    <Card id="todays-shifts" title="Today's shifts" aside={aside}>
      <div className="relative">
        <ul className="space-y-2" aria-label="Today's planned shifts">
          {[...people.entries()].map(([id, p]) => (
            <li key={id} className="flex items-center gap-3">
              <span className="w-20 shrink-0 truncate text-sm sm:w-28">{p.name}</span>
              <span className="relative h-7 min-w-0 flex-1 rounded bg-home-soft">
                {p.bars.map(({ s, start, end }) => {
                  const live = showNow && now >= start && now < end;
                  return (
                    <span
                      key={s.id}
                      className={`absolute inset-y-0 flex items-center overflow-hidden rounded px-2 text-[11px] font-medium whitespace-nowrap ${live ? "bg-accent text-accent-ink" : "bg-accent/25 text-text"}`}
                      style={{ left: at(start), width: `calc(${at(end)} - ${at(start)})` }}
                      title={`${p.name}: ${fmtTime(s.startsAt, tz)}–${fmtTime(s.endsAt, tz)}${s.location ? ` · ${s.location}` : ""}`}
                    >
                      <span className="truncate">
                        {fmtTime(s.startsAt, tz)}–{fmtTime(s.endsAt, tz)}
                        {live && <span className="sr-only"> (on now)</span>}
                      </span>
                    </span>
                  );
                })}
              </span>
            </li>
          ))}
        </ul>
        {showNow && (
          <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 left-23 sm:left-31">
            <span className="absolute inset-y-0 w-px bg-danger" style={{ left: at(now) }} />
          </div>
        )}
      </div>
      <div aria-hidden className="mt-2 flex gap-3">
        <span className="w-20 shrink-0 sm:w-28" />
        <span className="relative h-4 min-w-0 flex-1 text-[11px] text-muted tabular-nums">
          {hours.map((h, i) =>
            i % every === 0 ? (
              <span key={h} className={`absolute top-0 whitespace-nowrap ${i === 0 ? "" : i === hours.length - 1 ? "-translate-x-full" : "-translate-x-1/2"}`} style={{ left: at(h * 60) }}>
                {hourLabel(h)}
              </span>
            ) : null,
          )}
        </span>
      </div>
      {showNow && <p className="mt-2 text-xs text-muted">The red line is now, {fmtTime(board.serverTime, tz)} ({tz.replace(/_/g, " ")}).</p>}
    </Card>
  );
}
