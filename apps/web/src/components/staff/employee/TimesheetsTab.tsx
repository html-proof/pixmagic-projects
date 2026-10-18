"use client";
/** The Timesheets tab: the employee's shifts over a chosen range, with totals and export. */
import Link from "next/link";
import { useState } from "react";
import { localDayOf, resolveRange, startOfMonth, type RangePreset } from "@app/shared/staff";
import { LoadError } from "@/components/LoadError";
import { Alert } from "@/components/ui";
import { ApprovalBadge, Flags, Pagination, RangeFilter, rangeReady, Table, Td, Th, type RangeValue } from "@/components/staff/ui";
import { useApi } from "@/lib/api";
import { fmtDay, fmtHours, fmtSpan, fmtTime, useStaff, type EmployeeRow, type StaffConfig, type TimesheetList } from "@/lib/staff";

const enc = encodeURIComponent;

const TIMESHEET_PRESETS: readonly RangePreset[] = ["this_week", "last_week", "this_month", "last_month", "this_year", "last_year", "custom"];
const TIMESHEET_PAGE = 50;

export function TimesheetsTab({ employee, config }: { employee: EmployeeRow; config: StaffConfig }) {
  const { base } = useStaff();
  const tz = config.settings.timezone;
  const today = localDayOf(Date.now(), tz);
  const [range, setRange] = useState<RangeValue>({ preset: "this_month", from: startOfMonth(today), to: today });
  const [paging, setPaging] = useState({ key: "", page: 1 });

  let resolved: { from: string; to: string } | null = null;
  let rangeProblem: string | null = null;
  if (rangeReady(range)) {
    try {
      resolved = resolveRange(range.preset, today, config.settings.weekStartsOn, { from: range.from, to: range.to }).range;
    } catch (e) {
      rangeProblem = (e as Error).message;
    }
  }
  const key = resolved ? `${resolved.from}|${resolved.to}` : "";
  const page = paging.key === key ? paging.page : 1;
  const ts = useApi<TimesheetList>(resolved ? `${base}/timesheets?from=${resolved.from}&to=${resolved.to}&employeeId=${enc(employee.id)}&page=${page}&pageSize=${TIMESHEET_PAGE}` : null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <RangeFilter value={range} onChange={setRange} presets={TIMESHEET_PRESETS} />
        <Link href={`/staff/timesheets?employeeId=${enc(employee.id)}`} className="btn-secondary">
          Open in Timesheets
        </Link>
      </div>
      {rangeProblem && <Alert>{rangeProblem}</Alert>}
      {ts.error ? (
        <LoadError what="timesheets" error={ts.error} onRetry={() => void ts.reload()} busy={ts.loading} />
      ) : !resolved ? null : !ts.data ? (
        <div className="skeleton h-40" aria-busy="true" aria-label="Loading" />
      ) : ts.data.items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">No shifts in {fmtSpan(resolved.from, resolved.to)}.</p>
      ) : (
        <>
          <p className="text-sm text-muted">
            {fmtSpan(resolved.from, resolved.to)} · approve, reject or correct hours in Timesheets.
          </p>
          <Table label="Timesheet">
            <thead>
              <tr>
                <Th>Day</Th>
                <Th>Hours</Th>
                <Th right>Worked</Th>
                <Th right>Unpaid breaks</Th>
                <Th>Approval</Th>
                <Th>Flags</Th>
              </tr>
            </thead>
            <tbody>
              {ts.data.items.map((s) => (
                <tr key={s.id}>
                  <Td className="whitespace-nowrap">{fmtDay(s.day ?? localDayOf(new Date(s.clockInAt).getTime(), tz))}</Td>
                  <Td className="whitespace-nowrap">
                    {fmtTime(s.clockInAt, tz)}–{s.clockOutAt ? fmtTime(s.clockOutAt, tz) : "now"}
                  </Td>
                  <Td right>{fmtHours(s.workedSeconds)}</Td>
                  <Td right>{s.unpaidBreakSeconds ? fmtHours(s.unpaidBreakSeconds) : "—"}</Td>
                  <Td>
                    {s.open ? <span className="text-xs text-muted">In progress</span> : <ApprovalBadge status={s.approvalStatus} />}
                    {s.locked && <p className="mt-1 text-[11px] text-muted">In approved payroll</p>}
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-1">
                      <Flags flags={s.flags} />
                      {s.pendingCorrection && <span className="w-fit rounded-full bg-warn/12 px-2 py-0.5 text-[11px] text-warn">Correction requested</span>}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={ts.data.page} pageSize={ts.data.pageSize} total={ts.data.total} onPage={(p) => setPaging({ key, page: p })} />
        </>
      )}
    </div>
  );
}
