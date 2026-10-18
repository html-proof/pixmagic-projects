"use client";
/** The Payroll tab: the employee's pay by pay period. */
import Link from "next/link";
import { localDayOf, shiftDay } from "@app/shared/staff";
import { LoadError } from "@/components/LoadError";
import { EstimateNote, Table, Td, Th } from "@/components/staff/ui";
import { useApi } from "@/lib/api";
import { fmtHours, fmtMoney, fmtSpan, useStaff, type EmployeeRow, type StaffConfig } from "@/lib/staff";

interface ReportTable {
  columns: Array<{ key: string; label: string; kind: "text" | "hours" | "money" | "count" }>;
  rows: Array<Record<string, string | number | null>>;
  totals: Record<string, string | number | null> | null;
  notes: string[];
}

/** Longest custom report range is a little over three years; this stays inside it with a month ahead. */
const PAYROLL_LOOKBACK_DAYS = 3 * 365;
const PERIOD_RE = /^(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})(?: \((.+)\))?$/;

function reportCell(kind: ReportTable["columns"][number]["kind"], v: string | number | null | undefined, currency: string | null) {
  if (v === null || v === undefined || v === "") return "—";
  if (kind === "hours") return fmtHours(Number(v));
  if (kind === "money") return fmtMoney(String(v), currency);
  if (kind === "count") return new Intl.NumberFormat().format(Number(v));
  return String(v);
}

export function PayrollTab({ employee, config }: { employee: EmployeeRow; config: StaffConfig }) {
  const { base } = useStaff();
  const today = localDayOf(Date.now(), config.settings.timezone);
  // Periods are found by their end day: look a month ahead so a period still running is included.
  const to = shiftDay(today, 31);
  const earliest = shiftDay(today, -PAYROLL_LOOKBACK_DAYS);
  const from = employee.joinedOn > to ? to : employee.joinedOn < earliest ? earliest : employee.joinedOn;
  const q = new URLSearchParams({ type: "payroll", groupBy: "period", preset: "custom", from, to, employeeId: employee.id });
  const report = useApi<ReportTable>(`${base}/reports?${q.toString()}`);

  if (report.error) return <LoadError what="this employee's payroll" error={report.error} onRetry={() => void report.reload()} busy={report.loading} />;
  if (!report.data) return <div className="skeleton h-40" aria-busy="true" aria-label="Loading" />;
  const r = report.data;
  const rows = [...r.rows].reverse();
  const currencies = new Set(rows.map((x) => String(x.currency ?? "")));
  const columns = r.columns.filter((c) => c.key !== "group" && !(c.key === "currency" && currencies.size <= 1));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Pay periods ending {fmtSpan(from, to)}{employee.joinedOn < earliest ? " (the last three years)" : ""}, newest first.
        </p>
        <Link href="/staff/payroll" className="btn-secondary">
          Open Payroll
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">{employee.fullName} hasn&apos;t been included in a payroll yet.</p>
      ) : (
        <Table label="Payroll by pay period">
          <thead>
            <tr>
              <Th>Pay period</Th>
              {columns.map((c) => (
                <Th key={c.key} right={c.kind !== "text"}>
                  {c.label}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const label = String(row.group ?? "");
              const m = PERIOD_RE.exec(label);
              const cur = String(row.currency ?? employee.currency);
              return (
                <tr key={`${label}-${i}`}>
                  <Td className="whitespace-nowrap">
                    {m ? (
                      <>
                        <span className="font-medium">{fmtSpan(m[1]!, m[2]!)}</span>
                        {m[3] && <p className="text-xs text-muted">{m[3]}</p>}
                      </>
                    ) : (
                      label
                    )}
                  </Td>
                  {columns.map((c) => (
                    <Td key={c.key} right={c.kind !== "text"} className={c.key === "outstanding" && row.outstanding && Number(row.outstanding) > 0 ? "font-medium text-warn" : ""}>
                      {reportCell(c.kind, row[c.key], cur)}
                    </Td>
                  ))}
                </tr>
              );
            })}
          </tbody>
          {r.totals && rows.length > 1 && (
            <tfoot>
              <tr className="font-semibold">
                <Td>Total</Td>
                {columns.map((c) => (
                  <Td key={c.key} right={c.kind !== "text"}>
                    {c.key === "approved" ? "" : reportCell(c.kind, r.totals?.[c.key], String(r.totals?.currency ?? employee.currency))}
                  </Td>
                ))}
              </tr>
            </tfoot>
          )}
        </Table>
      )}
      {r.notes.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
          {r.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <EstimateNote />
    </div>
  );
}
