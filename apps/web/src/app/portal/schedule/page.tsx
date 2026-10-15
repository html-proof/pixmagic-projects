"use client";
import { localDayOf } from "@app/shared/staff";
import { Badge } from "@/components/dashboard/Primitives";
import { LoadError } from "@/components/LoadError";
import { usePortal, type MySchedule } from "@/components/staff/PortalContext";
import { EmptyState } from "@/components/ui";
import { Skeleton } from "@/components/AppUi";
import { useApi } from "@/lib/api";
import { fmtDateTime, fmtDay, fmtHours, fmtTime } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// The employee's shift schedule, a week back and four weeks ahead, grouped by day.
// ---------------------------------------------------------------------------------------------

export default function PortalSchedule() {
  const { ws } = usePortal();
  const q = useApi<MySchedule>(`/employee/${ws}/schedule`);
  const d = q.data;

  let today = "";
  if (d) {
    try {
      today = localDayOf(Date.now(), d.timezone);
    } catch {
      today = new Date().toISOString().slice(0, 10);
    }
  }
  const days: Array<[string, MySchedule["items"]]> = [];
  for (const s of d?.items ?? []) {
    const last = days[days.length - 1];
    if (last && last[0] === s.day) last[1].push(s);
    else days.push([s.day, [s]]);
  }
  const upcoming = days.filter(([day]) => day >= today);
  const past = days.filter(([day]) => day < today);

  return (
    <>
      <section className="card animate-rise">
        <h1 className="text-xl font-semibold">Schedule</h1>
        <p className="mt-1 text-sm text-muted">Your shifts for the next four weeks{d ? ` (times in ${d.timezone})` : ""}. Your manager plans them in Insights.</p>
      </section>

      {q.error && !d ? (
        <LoadError what="your schedule" error={q.error} onRetry={() => void q.reload()} busy={q.loading} />
      ) : !d ? (
        <Skeleton lines={5} />
      ) : d.items.length === 0 ? (
        <EmptyState title="No shifts scheduled" body="Nothing is planned for you in the next four weeks. You can still clock in when you work; ask your manager if you expected shifts here." />
      ) : (
        <>
          {upcoming.length === 0 ? (
            <EmptyState title="No upcoming shifts" body="Nothing is planned for you from today. Ask your manager if you expected shifts here." />
          ) : (
            <DayList days={upcoming} today={today} tz={d.timezone} label="Upcoming shifts" />
          )}
          {past.length > 0 && (
            <details className="card">
              <summary className="cursor-pointer text-sm font-medium">Last 7 days ({past.reduce((a, [, s]) => a + s.length, 0)})</summary>
              <div className="mt-3 opacity-80">
                <DayList days={past} today={today} tz={d.timezone} label="Past shifts" />
              </div>
            </details>
          )}
        </>
      )}
    </>
  );
}

function DayList({ days, today, tz, label }: { days: Array<[string, MySchedule["items"]]>; today: string; tz: string; label: string }) {
  return (
    <ol className="space-y-3" aria-label={label}>
      {days.map(([day, shifts]) => (
        <li key={day} className={`card !p-4 ${day === today ? "border-accent" : ""}`}>
          <p className="flex items-center gap-2 font-semibold">
            {fmtDay(day)} {day === today && <Badge tone="good">Today</Badge>}
          </p>
          <ul className="mt-2 divide-y divide-border">
            {shifts.map((s) => {
              const overnight = localDayOf(Date.parse(s.endsAt), tz) !== s.day;
              return (
                <li key={s.id} className="py-2 text-sm">
                  <p className="font-medium tabular-nums">
                    {fmtTime(s.startsAt, tz)} – {overnight ? fmtDateTime(s.endsAt, tz) : fmtTime(s.endsAt, tz)}
                  </p>
                  <p className="text-xs text-muted">
                    {[`${fmtHours(s.plannedSeconds)} planned`, s.breakMinutes ? `${s.breakMinutes} min break` : null, s.location].filter(Boolean).join(" · ")}
                  </p>
                  {s.note && <p className="mt-0.5 text-xs">{s.note}</p>}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}
