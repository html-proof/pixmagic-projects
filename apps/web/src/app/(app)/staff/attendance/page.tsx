"use client";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { LIVE_STATUS_LABEL, LIVE_STATUSES, type LiveStatus } from "@app/shared/staff";
import { Dot, Empty, Stat } from "@/components/dashboard/primitives";
import { LoadError } from "@/components/LoadError";
import { EstimateNote, LiveBadge, Table, Td, Th } from "@/components/staff/ui";
import { Alert, EmptyState } from "@/components/ui";
import { PageHeader, Skeleton } from "@/components/whatsapp/common";
import { useApi, useLiveApi } from "@/lib/api";
import { fmtHours, fmtMoney, fmtTime, useStaff, type StaffConfig } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// Live attendance: who is working right now. The board re-checks every 10 seconds while the page
// is visible (useLiveApi); running shifts tick every second in between, from the server's clock.
// ---------------------------------------------------------------------------------------------

interface LiveRow {
  employee: { id: string; fullName: string; employeeNumber: string; jobTitle: string; department: string | null; managerUserId: string | null };
  status: LiveStatus;
  clockInAt: string | null;
  clockOutAt: string | null;
  openSessionId: string | null;
  onBreakSince: string | null;
  breakSeconds: number;
  workedSeconds: number;
  overtimeSeconds: number;
  lateToday: boolean;
  scheduled: boolean;
  pendingCorrections: number;
  /** Only for those who may see pay. */
  currency?: string;
  estimatedEarnings?: string;
  rateMissing?: boolean;
}

interface LiveBoard {
  serverTime: string;
  timezone: string;
  day: string;
  holiday: { name: string } | null;
  kpis: {
    totalEmployees: number;
    working: number;
    onBreak: number;
    clockedOut: number;
    scheduledToday: number;
    absent: number;
    pendingReview: number;
    pendingCorrections: number;
    workedSecondsToday: number;
    currency?: string;
    estimatedCostToday?: string;
    otherCurrencies?: Array<{ currency: string; amount: string }>;
  };
  rows: LiveRow[];
}

const nf = new Intl.NumberFormat();

/** A running duration with seconds, so it visibly ticks: "2:05:31". */
function fmtClock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Wait a moment after typing before asking the API again. */
function useDebounced(value: string, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function LiveAttendancePage() {
  const id = useId();
  const { base, can } = useStaff();
  const seePay = can("pay:view");
  const config = useApi<StaffConfig>(`${base}/config`);

  const [search, setSearch] = useState("");
  const [position, setPosition] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [managerUserId, setManagerUserId] = useState("");
  const [status, setStatus] = useState<LiveStatus | "">("");
  const q = useDebounced(search.trim());
  const jobTitle = useDebounced(position.trim());

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (departmentId) params.set("departmentId", departmentId);
  if (jobTitle) params.set("jobTitle", jobTitle);
  if (managerUserId) params.set("managerUserId", managerUserId);
  if (status) params.set("status", status);
  const qs = params.toString();
  const live = useLiveApi<LiveBoard>(`${base}/attendance/live${qs ? `?${qs}` : ""}`, 10_000);
  const data = live.data;
  const tz = data?.timezone ?? config.data?.settings.timezone ?? "UTC";

  // The server's clock, as an offset from this device's: running shifts tick from it (display only).
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (data) setOffset(Date.parse(data.serverTime) - Date.now());
  }, [data]);
  const running = !!data?.rows.some((r) => r.openSessionId && (r.status === "working" || r.status === "on_break"));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);
  const serverNow = now + offset;
  const serverAt = data ? Date.parse(data.serverTime) : serverNow;
  /** Seconds since the board's answer was computed on the server. */
  const sinceAnswer = Math.max(0, (serverNow - serverAt) / 1000);
  const since = (iso: string | null) => (iso ? Math.max(0, (serverNow - Date.parse(iso)) / 1000) : 0);

  // Positions seen so far, for the position filter's suggestions (the API filters on exact title).
  const [positions, setPositions] = useState<string[]>([]);
  useEffect(() => {
    if (!data) return;
    setPositions((prev) => {
      const all = new Set(prev);
      for (const r of data.rows) if (r.employee.jobTitle) all.add(r.employee.jobTitle);
      return all.size === prev.length ? prev : [...all].sort((a, b) => a.localeCompare(b));
    });
  }, [data]);

  const filtered = !!(q || departmentId || jobTitle || managerUserId || status);
  const clear = () => {
    setSearch("");
    setPosition("");
    setDepartmentId("");
    setManagerUserId("");
    setStatus("");
  };

  const updated = live.checkedAt ? new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(live.checkedAt)) : null;
  const k = data?.kpis;
  const workingNow = k?.working ?? 0;
  const workedToday = k ? k.workedSecondsToday + sinceAnswer * workingNow : 0;

  const header = (
    <PageHeader
      title="Live attendance"
      sub={
        <span>
          Who&apos;s working right now, today&apos;s hours and anyone missing. Times are in {tz.replace(/_/g, " ")}.
        </span>
      }
      actions={
        <span className="inline-flex items-center gap-2 text-xs text-muted">
          <Dot tone={live.failing ? "warn" : "good"} pulse={!live.failing && !!updated} />
          {updated ? `Live · updated ${updated}` : "Connecting…"}
        </span>
      }
    />
  );

  if (live.error && !data) {
    return (
      <>
        {header}
        <LoadError what="live attendance" error={live.error} onRetry={() => window.location.reload()} />
      </>
    );
  }

  return (
    <>
      {header}

      {live.failing && data && (
        <Alert kind="info">We can&apos;t reach Insights at the moment, so these figures may be a little behind{updated ? ` (last updated ${updated})` : ""}. We&apos;ll keep trying.</Alert>
      )}

      {data?.holiday && (
        <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm" role="status">
          <span className="font-medium">Today is a public holiday: {data.holiday.name}.</span>{" "}
          <span className="text-muted">Nobody is marked as missing today. Anyone who works is still recorded as usual.</span>
        </div>
      )}

      {!data || !k ? (
        <Skeleton lines={6} />
      ) : (
        <>
          <section aria-label="Today at a glance" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Total employees" value={nf.format(k.totalEmployees)} note="Active and on leave" />
            <Stat label="Clocked in" value={nf.format(k.working)} tone={k.working ? "good" : undefined} note="Working now" />
            <Stat label="On break" value={nf.format(k.onBreak)} tone={k.onBreak ? "warn" : undefined} />
            <Stat label="Clocked out" value={nf.format(k.clockedOut)} note="Finished for today" />
            <Stat label="Scheduled today" value={nf.format(k.scheduledToday)} />
            <Stat label="Missing" value={nf.format(k.absent)} tone={k.absent ? "danger" : undefined} note="Scheduled, not clocked in" />
            <Stat
              label="Pending corrections"
              value={nf.format(k.pendingCorrections)}
              tone={k.pendingCorrections ? "warn" : undefined}
              note={
                k.pendingCorrections ? (
                  <Link className="text-accent underline-offset-2 hover:underline" href="/staff/timesheets?tab=requests">
                    Review requests
                  </Link>
                ) : (
                  "Change requests waiting"
                )
              }
            />
            <Stat label="Hours worked today" value={<span className="tabular-nums">{fmtHours(workedToday)}</span>} note={k.pendingReview ? `${nf.format(k.pendingReview)} need a look` : "Paid time so far"} />
            {k.estimatedCostToday !== undefined && k.currency && (
              <Stat
                label="Estimated payroll cost today"
                value={fmtMoney(k.estimatedCostToday, k.currency)}
                note={k.otherCurrencies?.length ? `Plus ${k.otherCurrencies.map((o) => fmtMoney(o.amount, o.currency)).join(", ")}` : "Estimate from hours so far"}
              />
            )}
          </section>

          <section className="card animate-rise" aria-labelledby={`${id}-board`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h2 id={`${id}-board`} className="font-semibold">
                Today&apos;s board
              </h2>
              {filtered && (
                <button type="button" className="text-sm text-accent underline-offset-2 hover:underline" onClick={clear}>
                  Clear filters
                </button>
              )}
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5" role="search" aria-label="Filter the board">
              <label className="min-w-0">
                <span className="label text-xs text-muted">Employee</span>
                <input className="input" type="search" placeholder="Name or number" value={search} onChange={(e) => setSearch(e.target.value)} maxLength={100} />
              </label>
              <label className="min-w-0">
                <span className="label text-xs text-muted">Department</span>
                <select className="input" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                  <option value="">All departments</option>
                  {config.data?.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-0">
                <span className="label text-xs text-muted">Position</span>
                <input className="input" list={`${id}-positions`} placeholder="Any position" value={position} onChange={(e) => setPosition(e.target.value)} maxLength={80} />
                <datalist id={`${id}-positions`}>
                  {positions.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </label>
              <label className="min-w-0">
                <span className="label text-xs text-muted">Manager</span>
                <select className="input" value={managerUserId} onChange={(e) => setManagerUserId(e.target.value)}>
                  <option value="">Any manager</option>
                  {config.data?.managers.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-0">
                <span className="label text-xs text-muted">Status</span>
                <select className="input" value={status} onChange={(e) => setStatus(e.target.value as LiveStatus | "")}>
                  <option value="">Everyone</option>
                  {LIVE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {LIVE_STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-4">
              {!data.rows.length ? (
                filtered ? (
                  <Empty>Nobody matches these filters right now.</Empty>
                ) : (
                  <EmptyState
                    title="No employees yet"
                    body="Once you add employees and they start clocking in, you'll see who's working here."
                    action={
                      can("staff:manage") ? (
                        <Link className="btn-primary" href="/staff/employees/new">
                          Add employee
                        </Link>
                      ) : undefined
                    }
                  />
                )
              ) : (
                <Table label="Today's attendance">
                  <thead>
                    <tr>
                      <Th>Employee</Th>
                      <Th>Position</Th>
                      <Th>Status</Th>
                      <Th>Clock In</Th>
                      <Th>Clock Out</Th>
                      <Th>Break</Th>
                      <Th right>Worked Hours</Th>
                      {seePay && <Th right>Estimated Earnings</Th>}
                      <Th>Action</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => {
                      const onShift = !!r.openSessionId && (r.status === "working" || r.status === "on_break");
                      const worked = r.status === "working" && r.openSessionId ? r.workedSeconds + sinceAnswer : r.workedSeconds;
                      return (
                        <tr key={r.employee.id}>
                          <Td>
                            <Link className="font-medium hover:underline" href={`/staff/employee?id=${encodeURIComponent(r.employee.id)}`}>
                              {r.employee.fullName}
                            </Link>
                            <p className="text-xs text-muted">
                              {r.employee.employeeNumber}
                              {r.employee.department ? ` · ${r.employee.department}` : ""}
                            </p>
                          </Td>
                          <Td>{r.employee.jobTitle || <span className="text-muted">—</span>}</Td>
                          <Td>
                            <span className="flex flex-col items-start gap-1">
                              <LiveBadge status={r.status} />
                              {r.lateToday && <span className="rounded-full bg-warn/12 px-2 py-0.5 text-[11px] text-warn">Late start</span>}
                              {r.pendingCorrections > 0 && (
                                <span className="text-[11px] text-muted">{r.pendingCorrections === 1 ? "1 change request" : `${r.pendingCorrections} change requests`}</span>
                              )}
                            </span>
                          </Td>
                          <Td className="whitespace-nowrap">
                            {fmtTime(r.clockInAt, tz)}
                            {onShift && r.clockInAt && (
                              <p className="text-xs tabular-nums text-muted" aria-label={`On shift for ${fmtHours(since(r.clockInAt))}`}>
                                on shift {fmtClock(since(r.clockInAt))}
                              </p>
                            )}
                          </Td>
                          <Td className="whitespace-nowrap">
                            {r.openSessionId ? <span className="text-muted">Still clocked in</span> : fmtTime(r.clockOutAt, tz)}
                          </Td>
                          <Td className="whitespace-nowrap">
                            {r.breakSeconds > 0 ? fmtHours(r.breakSeconds) : <span className="text-muted">—</span>}
                            {r.status === "on_break" && r.onBreakSince && (
                              <p className="text-xs tabular-nums text-warn" aria-label={`On break for ${fmtHours(since(r.onBreakSince))}`}>
                                on break {fmtClock(since(r.onBreakSince))}
                              </p>
                            )}
                          </Td>
                          <Td right className="whitespace-nowrap">
                            {worked > 0 || r.clockInAt ? fmtHours(worked) : <span className="text-muted">—</span>}
                            {r.overtimeSeconds > 0 && <p className="text-xs text-muted">incl. {fmtHours(r.overtimeSeconds)} overtime</p>}
                          </Td>
                          {seePay && (
                            <Td right className="whitespace-nowrap">
                              {r.estimatedEarnings !== undefined ? fmtMoney(r.estimatedEarnings, r.currency) : <span className="text-muted">—</span>}
                              {r.rateMissing && <p className="text-xs text-warn">No pay rate set</p>}
                            </Td>
                          )}
                          <Td className="whitespace-nowrap">
                            <span className="flex flex-col items-start gap-1">
                              <Link className="text-sm text-accent underline-offset-2 hover:underline" href={`/staff/employee?id=${encodeURIComponent(r.employee.id)}`}>
                                View<span className="sr-only"> {r.employee.fullName}</span>
                              </Link>
                              {(r.status === "pending_review" || r.status === "absent") && (
                                <Link className="text-sm text-accent underline-offset-2 hover:underline" href={`/staff/timesheets?employeeId=${encodeURIComponent(r.employee.id)}`}>
                                  Review hours<span className="sr-only"> for {r.employee.fullName}</span>
                                </Link>
                              )}
                            </span>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              )}
            </div>
            {seePay && data.rows.length > 0 && (
              <div className="mt-4">
                <EstimateNote />
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
