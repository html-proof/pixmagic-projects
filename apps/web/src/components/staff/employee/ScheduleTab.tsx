"use client";
/** The Schedule tab: the next four weeks of planned shifts. */
import Link from "next/link";
import { useMemo } from "react";
import { localDayOf, shiftDay } from "@app/shared/staff";
import { LoadError } from "@/components/LoadError";
import { useApi } from "@/lib/api";
import { fmtDay, fmtHours, fmtSpan, fmtTime, useStaff, type EmployeeRow, type StaffConfig } from "@/lib/staff";

const enc = encodeURIComponent;

interface ScheduleItem {
  id: string;
  employeeId: string;
  day: string;
  startsAt: string;
  endsAt: string;
  breakMinutes: number;
  plannedSeconds: number;
  location: string | null;
  note: string | null;
}

export function ScheduleTab({ employee, config }: { employee: EmployeeRow; config: StaffConfig }) {
  const { base } = useStaff();
  const tz = config.settings.timezone;
  const today = localDayOf(Date.now(), tz);
  const to = shiftDay(today, 27);
  const list = useApi<{ timezone: string; items: ScheduleItem[] }>(`${base}/schedules?from=${today}&to=${to}&employeeId=${enc(employee.id)}`);

  const byDay = useMemo(() => {
    const m = new Map<string, ScheduleItem[]>();
    for (const s of list.data?.items ?? []) m.set(s.day, [...(m.get(s.day) ?? []), s]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [list.data]);
  const planned = (list.data?.items ?? []).reduce((a, s) => a + s.plannedSeconds, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Scheduled shifts {fmtSpan(today, to)}
          {list.data && list.data.items.length > 0 ? ` · ${fmtHours(planned)} planned` : ""}. Times in {tz}.
        </p>
        <Link href="/staff/schedules" className="btn-secondary">
          Open shift schedules
        </Link>
      </div>
      {list.error ? (
        <LoadError what="the schedule" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
      ) : !list.data ? (
        <div className="skeleton h-32" aria-busy="true" aria-label="Loading" />
      ) : byDay.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">No shifts scheduled for {employee.fullName} in the next four weeks.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {byDay.map(([day, shifts]) => (
            <li key={day} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:gap-6">
              <p className={`w-40 shrink-0 text-sm font-medium ${day === today ? "text-accent" : ""}`}>
                {day === today ? "Today · " : ""}
                {fmtDay(day, { weekday: true, year: false })}
              </p>
              <ul className="min-w-0 flex-1 space-y-1">
                {shifts.map((s) => (
                  <li key={s.id} className="text-sm">
                    <span className="font-medium tabular-nums">
                      {fmtTime(s.startsAt, tz)}–{fmtTime(s.endsAt, tz)}
                    </span>
                    {localDayOf(new Date(s.endsAt).getTime() - 1, tz) !== s.day && <span className="text-xs text-muted"> (ends next day)</span>}
                    <span className="text-muted">
                      {" "}
                      · {fmtHours(s.plannedSeconds)}
                      {s.breakMinutes ? ` · ${s.breakMinutes} min unpaid break` : ""}
                      {s.location ? ` · ${s.location}` : ""}
                    </span>
                    {s.note && <p className="text-xs text-muted">{s.note}</p>}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
