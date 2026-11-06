"use client";
/**
 * The sections of a pay run's page, each drawn from the pay run the API returned: what stands in
 * the way of approving it, the totals, the pay per employee (with each row's breakdown), earnings
 * and deductions, and the history. The page (app/(app)/staff/payroll/period) owns the actions.
 * Laid out as the Stitch design's screen 28 ("Pay") draws a pay run: its figure and what stands
 * in the way side by side, then a row per person, then everything else on white cards.
 */
import { ChevronDown, ChevronRight, CircleAlert, CircleCheck } from "lucide-react";
import Link from "next/link";
import { Fragment, useState, type ReactNode } from "react";
import { PAY_CATEGORY_LABEL } from "@app/shared/staff";
import type { Tone } from "@/components/dashboard/Primitives";
import { EstimateNote, Figure, Initials, Pill as Badge, Table, Td, Th } from "@/components/staff/ui";
import { EmptyState } from "@/components/ui";
import { fmtDateTime, fmtDay, fmtHoursDec, fmtMoney } from "@/lib/staff";
import { HISTORY_LABEL, hours, isZero, PAYMENT_STATUS, WARNING_LABEL, type Adjustment, type Issue, type Item, type Period } from "@/components/staff/payroll/payRun";

/** Where each kind of issue gets fixed. */
function issueLink(p: Period, i: Issue): { href: string; text: string } | null {
  const range = `from=${p.startDate}&to=${p.endDate}`;
  switch (i.code) {
    case "open_shifts":
      return { href: `/staff/timesheets?status=open&${range}`, text: "Set the clock-out times" };
    case "unapproved_hours":
      return { href: `/staff/timesheets?status=pending&${range}`, text: "Review the hours" };
    case "pending_corrections":
      return { href: "/staff/timesheets?tab=requests", text: "Review the requests" };
    case "missing_rates":
      return { href: "/staff/employees", text: "Open employees" };
    case "negative_net":
      return { href: "#adjustments", text: "Check the adjustments" };
    default:
      return null;
  }
}

/**
 * "Before you can approve" (the Stitch design's screen 28): what has to be sorted out before the
 * payroll can be sent for approval or approved, each with where it gets fixed. While the payroll
 * can still be approved and nothing is open, it says so.
 */
export function IssuesPanel({ period: p, open = false }: { period: Period; open?: boolean }) {
  if (!p.issues.length) {
    if (!open) return null;
    return (
      <section className="home-card animate-rise p-5 sm:p-6" aria-labelledby="issues-h">
        <h2 id="issues-h" className="home-h2">
          Before you can approve
        </h2>
        <p className="mt-3 flex items-center gap-2 text-sm text-muted">
          <CircleCheck aria-hidden className="h-4 w-4 shrink-0 text-good" strokeWidth={2.25} />
          Nothing is in the way of approval.
        </p>
      </section>
    );
  }
  return (
    <section className="home-card animate-rise border border-warn/60 p-5 sm:p-6" aria-label="Issues to sort out">
      <h2 className="home-h2">Before you can approve</h2>
      <p className="mt-0.5 text-xs text-muted">The payroll can&apos;t be sent for approval or approved while these are open.</p>
      <ul className="mt-3 space-y-2">
        {p.issues.map((i) => {
          const link = issueLink(p, i);
          return (
            <li key={i.code} className="flex items-start gap-3 rounded bg-home-soft px-3 py-2.5 text-sm">
              <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
              <span className="min-w-0">
                <span className="block">
                  <span className="font-medium">{i.message}</span> <span className="text-muted">({i.count})</span>
                </span>
                {i.employees.length > 0 && (
                  <span className="block text-xs text-muted">
                    {i.employees.join(", ")}
                    {i.count > i.employees.length ? " and others" : ""}
                  </span>
                )}
                {link && (
                  <Link className="mt-1 inline-block text-sm font-medium text-accent underline-offset-2 hover:underline" href={link.href}>
                    {link.text}
                  </Link>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * "This pay run" (screen 28): its dates and status, how many people, and its pay so far as one
 * figure, estimated and before tax, with what is paid and still to pay under it. One block per
 * currency when people are paid in more than one.
 */
export function RunSummary({ period: p, label, status }: { period: Period; label: string; status: ReactNode }) {
  const currencies = Object.entries(p.totals);
  return (
    <section className="home-card animate-rise p-5 sm:p-6" aria-label="This pay run">
      <p className="text-[11px] font-semibold tracking-wider text-muted uppercase">This pay run · {label}</p>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        {status}
        <span>{p.employees === 1 ? "1 person" : `${new Intl.NumberFormat().format(p.employees)} people`}</span>
        {p.payDate && <span>Pay date {fmtDay(p.payDate)}</span>}
      </p>
      {currencies.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No pay worked out for these dates yet.</p>
      ) : (
        <div className="mt-4 flex flex-wrap gap-x-10 gap-y-4">
          {currencies.map(([c, t]) => (
            <div key={c} className="min-w-0">
              <p className="text-[32px] leading-10 font-semibold tracking-[-0.02em] tabular-nums">{fmtMoney(t.gross, c)}</p>
              <p className="text-xs text-muted">gross pay, estimated, before tax{currencies.length > 1 ? ` (${c})` : ""}</p>
              <p className="mt-2 text-sm">
                Net {fmtMoney(t.net, c)} · Paid {fmtMoney(t.paid, c)} · <span className="font-medium">Still to pay {fmtMoney(t.outstanding, c)}</span>
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function TotalsPanel({ period: p }: { period: Period }) {
  const currencies = Object.entries(p.totals);
  return (
    <section className="home-card animate-rise p-5 sm:p-6" aria-label="Totals">
      <h2 className="home-h2 mb-4">Totals</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="Employees" value={new Intl.NumberFormat().format(p.employees)} />
        <Figure label="Regular hours" value={hours(p.regularSeconds)} />
        <Figure label="Overtime hours" value={hours(p.overtimeSeconds)} />
        <Figure label="Break hours" value={hours(p.breakSeconds)} />
      </div>
      {currencies.map(([c, t]) => (
        <div key={c} className="mt-4">
          {currencies.length > 1 && <p className="mb-2 text-xs font-medium text-muted">In {c}</p>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Figure label="Gross pay" value={fmtMoney(t.gross, c)} />
            <Figure label="Other earnings" value={fmtMoney(t.otherEarnings, c)} />
            <Figure label="Deductions" value={fmtMoney(t.deductions, c)} />
            <Figure label="Net pay (estimated)" value={fmtMoney(t.net, c)} />
            <Figure label="Paid" value={fmtMoney(t.paid, c)} />
            <Figure label="Outstanding" value={fmtMoney(t.outstanding, c)} />
          </div>
        </div>
      ))}
      <div className="mt-4">
        <EstimateNote>{p.estimateNotice}</EstimateNote>
      </div>
    </section>
  );
}

/** The pay per employee; each row opens how its gross pay adds up and its earnings and deductions. */
export function PayItems({
  period: p,
  editable,
  payable,
  canPay: pay,
  canExport: exportOk,
  busy,
  onExport,
  onPayslip,
  onPay,
}: {
  period: Period;
  /** A draft or sent back: figures can still change. */
  editable: boolean;
  /** Approved: payments can be recorded. */
  payable: boolean;
  canPay: boolean;
  canExport: boolean;
  /** The page's running action (useAction), so the export and payslip buttons show their progress. */
  busy: string | null;
  onExport: (format: "csv" | "xlsx" | "pdf") => Promise<unknown>;
  onPayslip: (item: Item) => Promise<unknown>;
  onPay: (target: { employeeId: string; payrollItemId: string }) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (itemId: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  const colSpan = 11;
  return (
    <section className="home-card animate-rise p-5 sm:p-6" aria-labelledby="pay-items">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="pay-items" className="home-h2">
            Pay per employee
          </h2>
          <p className="mt-0.5 text-xs text-muted">From approved hours at each person&apos;s pay rate: estimated, before tax.</p>
        </div>
        {exportOk && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Download this pay run">
            <span className="text-xs text-muted">Download:</span>
            {(
              [
                ["csv", "CSV"],
                ["xlsx", "Excel"],
                ["pdf", "PDF"],
              ] as const
            ).map(([f, l]) => (
              <button key={f} type="button" className="btn-secondary px-3 py-1" disabled={busy !== null} onClick={() => void onExport(f)}>
                {busy === `export:${f}` ? "Preparing…" : l}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="mt-4">
        {!p.items.length ? (
          <EmptyState
            title="Nothing to pay in this period yet"
            body={
              editable
                ? "No approved hours or adjustments fall in these dates. Approve hours in Timesheets, then recalculate."
                : "This pay run has no pay entries."
            }
          />
        ) : (
          <Table label="Pay per employee">
            <thead>
              <tr>
                <Th className="w-8">
                  <span className="sr-only">Details</span>
                </Th>
                <Th>Employee</Th>
                <Th right>Regular</Th>
                <Th right>Overtime</Th>
                <Th right>Gross</Th>
                <Th right>Other</Th>
                <Th right>Deductions</Th>
                <Th right>Net</Th>
                <Th right>Paid</Th>
                <Th right>Outstanding</Th>
                <Th>Payment</Th>
              </tr>
            </thead>
            <tbody>
              {p.items.map((i) => {
                const open = expanded.has(i.id);
                const adjustments = p.adjustments.filter((a) => a.employeeId === i.employee.id);
                const st = PAYMENT_STATUS[i.paymentStatus] ?? { tone: "neutral" as Tone, label: i.paymentStatus };
                return (
                  <Fragment key={i.id}>
                    <tr>
                      <Td>
                        <button type="button" className="text-muted hover:text-text" aria-expanded={open} aria-controls={`item-${i.id}`} onClick={() => toggle(i.id)}>
                          {open ? <ChevronDown aria-hidden size={16} /> : <ChevronRight aria-hidden size={16} />}
                          <span className="sr-only">
                            {open ? "Hide" : "Show"} details for {i.employee.fullName}
                          </span>
                        </button>
                      </Td>
                      <Td>
                        <div className="flex items-start gap-3">
                          <Initials name={i.employee.fullName} small />
                          <div className="min-w-0">
                            <p className="font-medium">{i.employee.fullName}</p>
                            <p className="text-xs text-muted">
                              {i.employee.employeeNumber}
                              {i.employee.jobTitle ? ` · ${i.employee.jobTitle}` : ""}
                            </p>
                            {i.warnings.length > 0 && (
                              <p className="mt-0.5 text-[11px] text-warn">{i.warnings.map((w) => WARNING_LABEL[w] ?? w).join(" · ")}</p>
                            )}
                          </div>
                        </div>
                      </Td>
                      <Td right>{fmtHoursDec(i.regularSeconds + i.holidaySeconds)}</Td>
                      <Td right>{fmtHoursDec(i.overtimeSeconds + i.doubleTimeSeconds)}</Td>
                      <Td right>{fmtMoney(i.gross, i.currency)}</Td>
                      <Td right>{fmtMoney(i.otherEarnings, i.currency)}</Td>
                      <Td right>{fmtMoney(i.deductions, i.currency)}</Td>
                      <Td right className="font-medium">
                        {fmtMoney(i.net, i.currency)}
                      </Td>
                      <Td right>{fmtMoney(i.paid, i.currency)}</Td>
                      <Td right>{fmtMoney(i.outstanding, i.currency)}</Td>
                      <Td>
                        <span className="flex flex-col items-start gap-1.5">
                          {payable ? <Badge tone={st.tone}>{st.label}</Badge> : <span className="text-xs text-muted">Not approved yet</span>}
                          {payable && pay && !isZero(i.outstanding) && (
                            <button
                              type="button"
                              className="inline-flex h-8 items-center rounded bg-accent px-2.5 text-xs font-medium whitespace-nowrap text-accent-ink transition-opacity outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
                              onClick={() => onPay({ employeeId: i.employee.id, payrollItemId: i.id })}
                            >
                              Record payment<span className="sr-only"> for {i.employee.fullName}</span>
                            </button>
                          )}
                          {exportOk && (
                            <button type="button" className="whitespace-nowrap text-sm text-accent underline-offset-2 hover:underline disabled:opacity-50" disabled={busy !== null} onClick={() => void onPayslip(i)}>
                              {busy === `slip:${i.id}` ? "Preparing…" : payable ? "Payslip (PDF)" : "Preview payslip"}
                              <span className="sr-only"> for {i.employee.fullName}</span>
                            </button>
                          )}
                        </span>
                      </Td>
                    </tr>
                    {open && (
                      <tr id={`item-${i.id}`}>
                        <td colSpan={colSpan} className="border-b border-home-line bg-home-soft/50 px-3 py-3">
                          <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-muted">How the gross pay adds up ({i.shifts === 1 ? "1 shift" : `${i.shifts} shifts`})</p>
                              {i.lines.length ? (
                                <table className="mt-1 w-full text-sm">
                                  <thead>
                                    <tr className="text-xs text-muted">
                                      <th scope="col" className="py-1 text-left font-medium">
                                        Pay type
                                      </th>
                                      <th scope="col" className="py-1 text-right font-medium">
                                        Hours
                                      </th>
                                      <th scope="col" className="py-1 text-right font-medium">
                                        Rate
                                      </th>
                                      <th scope="col" className="py-1 text-right font-medium">
                                        Multiplier
                                      </th>
                                      <th scope="col" className="py-1 text-right font-medium">
                                        Amount
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {i.lines.map((l, n) => (
                                      <tr key={n} className="border-t border-home-line">
                                        <td className="py-1">{PAY_CATEGORY_LABEL[l.category] ?? l.category}</td>
                                        <td className="py-1 text-right tabular-nums">{fmtHoursDec(l.seconds)}</td>
                                        <td className="py-1 text-right tabular-nums">{fmtMoney(l.hourlyRate, i.currency)}/h</td>
                                        <td className="py-1 text-right tabular-nums">{l.multiplier}×</td>
                                        <td className="py-1 text-right tabular-nums">{fmtMoney(l.amount, i.currency)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              ) : (
                                <p className="mt-1 text-xs text-muted">No paid hours in this period.</p>
                              )}
                              {i.unpricedSeconds > 0 && (
                                <p className="mt-2 text-xs text-warn">{fmtHoursDec(i.unpricedSeconds)} hours have no pay rate for their day and aren&apos;t included. Add a pay rate, then recalculate.</p>
                              )}
                              <p className="mt-2 text-xs text-muted">
                                Breaks: {fmtHoursDec(i.unpaidBreakSeconds)} h unpaid, {fmtHoursDec(i.paidBreakSeconds)} h paid ·{" "}
                                <Link className="text-accent underline-offset-2 hover:underline" href={`/staff/timesheets?employeeId=${encodeURIComponent(i.employee.id)}&from=${p.startDate}&to=${p.endDate}`}>
                                  See shifts
                                </Link>
                              </p>
                            </div>
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-muted">Earnings and deductions</p>
                              {adjustments.length ? (
                                <ul className="mt-1 space-y-1 text-sm">
                                  {adjustments.map((a) => (
                                    <li key={a.id} className="flex items-start justify-between gap-2">
                                      <span className="min-w-0">
                                        {a.label}
                                        {a.reason && <span className="block text-xs text-muted">{a.reason}</span>}
                                      </span>
                                      <span className={`whitespace-nowrap tabular-nums ${a.kind === "deduction" ? "text-danger" : ""}`}>
                                        {a.kind === "deduction" ? "−" : "+"}
                                        {fmtMoney(a.amount, a.currency)}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="mt-1 text-xs text-muted">None.</p>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        )}
      </div>
    </section>
  );
}

export function AdjustmentsPanel({
  period: p,
  editable,
  manage,
  names,
  onAdd,
  onRemove,
}: {
  period: Period;
  editable: boolean;
  /** May change earnings and deductions (payroll:manage). */
  manage: boolean;
  /** Employee id → name, for adjustments of people with no row in this pay run. */
  names: Map<string, string>;
  onAdd: () => void;
  onRemove: (a: Adjustment) => void;
}) {
  const tz = p.timezone;
  return (
    <section id="adjustments" className="home-card animate-rise scroll-mt-24 p-5 sm:p-6" aria-labelledby="adj-h">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="adj-h" className="home-h2">
            Earnings and deductions
          </h2>
          <p className="mt-0.5 text-xs text-muted">Bonuses, allowances, advances or other amounts added to or taken off pay for this period.</p>
        </div>
        {editable && manage && (
          <button type="button" className="btn-secondary" onClick={() => onAdd()}>
            Add earning or deduction
          </button>
        )}
      </div>
      {!p.adjustments.length ? (
        <p className="mt-3 text-sm text-muted">None for this pay run.</p>
      ) : (
        <ul className="mt-3 divide-y divide-home-line">
          {p.adjustments.map((a) => (
            <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5 text-sm">
              <div className="min-w-0">
                <p>
                  <span className="font-medium">{a.label}</span> <span className="text-muted">· {names.get(a.employeeId) ?? "Employee"}</span>
                </p>
                <p className="text-xs text-muted">
                  {a.kind === "earning" ? "Earning" : "Deduction"} · added by {a.createdBy} {fmtDateTime(a.createdAt, tz)}
                  {a.reason ? ` · ${a.reason}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`tabular-nums ${a.kind === "deduction" ? "text-danger" : ""}`}>
                  {a.kind === "deduction" ? "−" : "+"}
                  {fmtMoney(a.amount, a.currency)}
                </span>
                {editable && manage && (
                  <button type="button" className="text-sm text-muted underline-offset-2 hover:text-danger hover:underline" onClick={() => onRemove(a)}>
                    Remove<span className="sr-only"> {a.label}</span>
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {!editable && p.status !== "cancelled" && p.status !== "reversed" && (
        <p className="mt-2 text-xs text-muted">Earnings and deductions can only be changed while the payroll is a draft or has been sent back.</p>
      )}
    </section>
  );
}

export function PayRunHistory({ period: p }: { period: Period }) {
  const tz = p.timezone;
  return (
    <section className="home-card animate-rise p-5 sm:p-6" aria-labelledby="hist-h">
      <h2 id="hist-h" className="home-h2">
        History
      </h2>
      {!p.history.length ? (
        <p className="mt-3 text-sm text-muted">Nothing yet.</p>
      ) : (
        <ol className="mt-3 space-y-2 text-sm">
          {p.history.map((h) => (
            <li key={h.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span>
                <span className="font-medium">{HISTORY_LABEL[h.action] ?? h.action}</span> by {h.by}
                <span className="text-muted"> · version {h.version}</span>
                {h.comment && <span className="block text-xs text-muted">“{h.comment}”</span>}
              </span>
              <span className="text-xs text-muted">{fmtDateTime(h.at, tz)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
