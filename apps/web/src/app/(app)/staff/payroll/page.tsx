"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type FormEvent } from "react";
import { dayDiff, PAY_CYCLE_LABEL, PAYROLL_STATUS_LABEL, PAYROLL_STATUSES, type DayRange, type PayCycle, type PayrollStatus } from "@app/shared/staff";
import { Empty } from "@/components/dashboard/Primitives";
import { LoadError } from "@/components/LoadError";
import { EstimateNote, Field, Pagination, PayrollBadge, Table, Td, Th } from "@/components/staff/ui";
import { Alert, EmptyState } from "@/components/ui";
import { PageHeader, Skeleton } from "@/components/AppUi";
import { actionError, api, ApiError, useApi } from "@/lib/api";
import { fmtDay, fmtHoursDec, fmtMoney, fmtSpan, useStaff } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// Payroll home: how a pay run works, starting one for the next period (or any dates), and every
// pay run so far with its totals.
// ---------------------------------------------------------------------------------------------

type MoneyTotals = { gross: string; otherEarnings: string; deductions: string; net: string; paid: string; outstanding: string };

interface PeriodSummary {
  id: string;
  startDate: string;
  endDate: string;
  payDate: string | null;
  payCycle: PayCycle;
  status: PayrollStatus;
  version: number;
  calculatedAt: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  locked: boolean;
  notes: string | null;
  employees: number;
  regularSeconds: number;
  overtimeSeconds: number;
  breakSeconds: number;
  totals: Record<string, MoneyTotals>;
}

interface Suggestions {
  payCycle: PayCycle;
  today: string;
  current: DayRange;
  previous: DayRange;
  next: DayRange;
  lastRun: { from: string; to: string; status: string } | null;
}

const PAGE_SIZE = 20;
const MAX_PERIOD_DAYS = 62;

const STEPS: ReadonlyArray<readonly [string, string]> = [
  ["Draft", "Insights adds up approved hours at each person's pay rate. Add bonuses or deductions and recalculate as often as you like."],
  ["Waiting for approval", "When the figures look right, send them for approval. Someone who may approve payroll checks them."],
  ["Approved", "Approving locks the hours and figures, so nothing changes underneath you. Payslips are ready to download."],
  ["Partly paid / Paid", "Pay people through your bank or provider as usual, then record each payment here to keep track of what's owed."],
];

/** Money per currency, one line each. */
function PerCurrency({ totals, pick }: { totals: Record<string, MoneyTotals>; pick: keyof MoneyTotals }) {
  const entries = Object.entries(totals);
  if (!entries.length) return <span className="text-muted">—</span>;
  return (
    <>
      {entries.map(([c, t]) => (
        <span key={c} className="block whitespace-nowrap">
          {fmtMoney(t[pick], c)}
        </span>
      ))}
    </>
  );
}

export default function PayrollPage() {
  const id = useId();
  const router = useRouter();
  const { base, can } = useStaff();
  const manage = can("payroll:manage");
  const suggestions = useApi<Suggestions>(`${base}/payroll/suggestions`);

  const [status, setStatus] = useState<PayrollStatus | "">("");
  const [page, setPage] = useState(1);
  const list = useApi<{ total: number; page: number; pageSize: number; items: PeriodSummary[] }>(
    `${base}/payroll/periods?page=${page}&pageSize=${PAGE_SIZE}${status ? `&status=${status}` : ""}`,
  );
  const [shown, setShown] = useState(list.data);
  useEffect(() => {
    if (list.data) setShown(list.data);
  }, [list.data]);

  // Starting a pay run (one-click from a suggestion, or custom dates).
  const [creating, setCreating] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ message: string; periodId?: string } | null>(null);
  const [form, setForm] = useState({ startDate: "", endDate: "", payDate: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const today = suggestions.data?.today ?? null;

  async function start(key: string, startDate: string, endDate: string, payDate: string | null) {
    if (creating) return;
    setCreating(key);
    setProblem(null);
    try {
      const { period } = await api<{ period: { id: string } }>(`${base}/payroll/periods`, { method: "POST", body: { startDate, endDate, payDate } });
      router.push(`/staff/payroll/period?id=${encodeURIComponent(period.id)}`);
    } catch (e) {
      const detail = e instanceof ApiError ? (e.data.detail as { periodId?: string } | undefined) : undefined;
      setProblem({ message: actionError(e, "start the pay run"), periodId: e instanceof ApiError && e.code === "overlap" ? detail?.periodId : undefined });
      setCreating(null);
    }
  }

  const submitCustom = (e: FormEvent) => {
    e.preventDefault();
    const er: Record<string, string> = {};
    if (!form.startDate) er.startDate = "Choose the first day of the period.";
    if (!form.endDate) er.endDate = "Choose the last day of the period.";
    if (form.startDate && form.endDate) {
      if (form.startDate > form.endDate) er.endDate = "The period has to end on or after the day it starts.";
      else if (dayDiff(form.startDate, form.endDate) + 1 > MAX_PERIOD_DAYS) er.endDate = `A pay period can be at most ${MAX_PERIOD_DAYS} days.`;
    }
    if (form.startDate && today && form.startDate > today) er.startDate = "A pay period can't start in the future.";
    if (form.payDate && form.startDate && form.payDate < form.startDate) er.payDate = "The pay date can't be before the period starts.";
    setErrors(er);
    if (Object.keys(er).length) return;
    void start("custom", form.startDate, form.endDate, form.payDate || null);
  };

  const s = suggestions.data;
  const offers: Array<{ key: string; label: string; range: DayRange; primary: boolean }> = [];
  if (s) {
    const same = (a: DayRange, b: DayRange) => a.from === b.from && a.to === b.to;
    offers.push({ key: "next", label: s.lastRun ? "Next pay run" : "Suggested pay run", range: s.next, primary: true });
    if (!same(s.previous, s.next)) offers.push({ key: "previous", label: "Last finished period", range: s.previous, primary: false });
    if (!same(s.current, s.next) && !same(s.current, s.previous)) offers.push({ key: "current", label: "Current period (still running)", range: s.current, primary: false });
  }

  const rows = shown?.items ?? [];
  return (
    <>
      <PageHeader
        title="Payroll"
        sub="Turn approved hours into pay for a period, get it approved, then keep track of what you've paid."
      />

      <section className="card animate-rise" aria-labelledby={`${id}-how`}>
        <h2 id={`${id}-how`} className="font-semibold">
          How a pay run works
        </h2>
        <ol className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(([title, text], i) => (
            <li key={title} className="relative rounded-lg border border-border bg-bg/50 p-3">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <span aria-hidden className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs text-accent-ink">
                  {i + 1}
                </span>
                {title}
                {i < STEPS.length - 1 && (
                  <span aria-hidden className="ml-auto hidden text-muted lg:inline">
                    →
                  </span>
                )}
              </p>
              <p className="mt-1.5 text-xs text-muted">{text}</p>
            </li>
          ))}
        </ol>
      </section>

      {manage && (
        <section className="card animate-rise" aria-labelledby={`${id}-start`}>
          <h2 id={`${id}-start`} className="font-semibold">
            Start a pay run
          </h2>
          {suggestions.error && !s ? (
            <div className="mt-3">
              <LoadError what="the suggested pay periods" error={suggestions.error} onRetry={() => void suggestions.reload()} busy={suggestions.loading} />
            </div>
          ) : !s ? (
            <div className="mt-3 space-y-2" aria-busy="true" aria-label="Loading">
              <div className="skeleton h-12" />
              <div className="skeleton h-12 w-3/4" />
            </div>
          ) : (
            <>
              <p className="mt-1 text-xs text-muted">
                You pay {PAY_CYCLE_LABEL[s.payCycle]?.toLowerCase() ?? s.payCycle} (change this in Staff settings).
                {s.lastRun ? ` Your latest pay run covered ${fmtSpan(s.lastRun.from, s.lastRun.to)}.` : " You haven't run payroll here yet."}
              </p>
              <ul className="mt-3 space-y-2">
                {offers.map((o) => {
                  const future = o.range.from > s.today;
                  // The latest live pay run is known; one overlapping it would be refused.
                  const taken = !!s.lastRun && o.range.from <= s.lastRun.to && o.range.to >= s.lastRun.from;
                  return (
                    <li key={o.key} className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5 ${o.primary ? "border-accent/50 bg-accent/5" : "border-border"}`}>
                      <div className="min-w-0">
                        <p className="text-xs text-muted">{o.label}</p>
                        <p className="font-medium">{fmtSpan(o.range.from, o.range.to)}</p>
                        {future && <p className="text-xs text-muted">Can be started from {fmtDay(o.range.from)}.</p>}
                        {taken && <p className="text-xs text-muted">Already covered by your latest pay run.</p>}
                      </div>
                      <button
                        type="button"
                        className={o.primary ? "btn-primary" : "btn-secondary"}
                        disabled={!!creating || future || taken}
                        onClick={() => void start(o.key, o.range.from, o.range.to, null)}
                      >
                        {creating === o.key ? "Starting…" : "Start pay run"}
                        <span className="sr-only"> for {fmtSpan(o.range.from, o.range.to)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          <details className="mt-4 rounded-lg border border-border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Choose your own dates</summary>
            <form className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-start" onSubmit={submitCustom} noValidate>
              <Field label="First day" htmlFor={`${id}-s`} error={errors.startDate} required>
                <input id={`${id}-s`} type="date" className="input" value={form.startDate} max={today ?? undefined} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
              </Field>
              <Field label="Last day" htmlFor={`${id}-e`} error={errors.endDate} required>
                <input id={`${id}-e`} type="date" className="input" value={form.endDate} min={form.startDate || undefined} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
              </Field>
              <Field label="Pay date" htmlFor={`${id}-p`} error={errors.payDate} hint="Optional: when people will be paid.">
                <input id={`${id}-p`} type="date" className="input" value={form.payDate} min={form.startDate || undefined} onChange={(e) => setForm({ ...form, payDate: e.target.value })} />
              </Field>
              <div className="sm:pt-6">
                <button type="submit" className="btn-primary w-full" disabled={!!creating}>
                  {creating === "custom" ? "Starting…" : "Start pay run"}
                </button>
              </div>
            </form>
          </details>

          {problem && (
            <div className="mt-3">
              <Alert>
                {problem.message}
                {problem.periodId && (
                  <>
                    {" "}
                    <Link className="underline" href={`/staff/payroll/period?id=${encodeURIComponent(problem.periodId)}`}>
                      Open that pay run
                    </Link>
                  </>
                )}
              </Alert>
            </div>
          )}
        </section>
      )}

      <section className="card animate-rise" aria-labelledby={`${id}-list`}>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id={`${id}-list`} className="font-semibold">
            Pay runs
          </h2>
          <label className="min-w-[11rem]">
            <span className="label text-xs text-muted">Status</span>
            <select
              className="input"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as PayrollStatus | "");
                setPage(1);
              }}
            >
              <option value="">Any status</option>
              {PAYROLL_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {PAYROLL_STATUS_LABEL[st]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-4">
          {list.error && !list.data ? (
            <LoadError what="your pay runs" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
          ) : !shown ? (
            <Skeleton lines={4} />
          ) : !rows.length ? (
            status ? (
              <Empty>No pay runs with this status.</Empty>
            ) : (
              <EmptyState
                title="No pay runs yet"
                body={manage ? "Start your first pay run above. Insights adds up the approved hours for the period and prices them at each person's pay rate." : "When someone starts a pay run, it shows up here."}
              />
            )
          ) : (
            <div className={list.loading ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={list.loading}>
              <Table label="Pay runs">
                <thead>
                  <tr>
                    <Th>Pay period</Th>
                    <Th>Status</Th>
                    <Th right>Employees</Th>
                    <Th right>Regular hours</Th>
                    <Th right>Overtime hours</Th>
                    <Th right>Gross</Th>
                    <Th right>Net (estimated)</Th>
                    <Th right>Paid</Th>
                    <Th right>Outstanding</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                      <tr key={p.id}>
                        <Td>
                          <Link className="font-medium text-accent underline-offset-2 hover:underline" href={`/staff/payroll/period?id=${encodeURIComponent(p.id)}`}>
                            {fmtSpan(p.startDate, p.endDate)}
                          </Link>
                          {p.payDate && <p className="text-xs text-muted">Pay date {fmtDay(p.payDate, { weekday: false, year: true })}</p>}
                        </Td>
                        <Td>
                          <PayrollBadge status={p.status} />
                        </Td>
                        <Td right>{new Intl.NumberFormat().format(p.employees)}</Td>
                        <Td right>{fmtHoursDec(p.regularSeconds)}</Td>
                        <Td right>{fmtHoursDec(p.overtimeSeconds)}</Td>
                        <Td right>
                          <PerCurrency totals={p.totals} pick="gross" />
                        </Td>
                        <Td right>
                          <PerCurrency totals={p.totals} pick="net" />
                        </Td>
                        <Td right>
                          <PerCurrency totals={p.totals} pick="paid" />
                        </Td>
                        <Td right>
                          <PerCurrency totals={p.totals} pick="outstanding" />
                        </Td>
                      </tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={shown.page} pageSize={shown.pageSize} total={shown.total} onPage={setPage} />
            </div>
          )}
        </div>
        {rows.length > 0 && (
          <div className="mt-4">
            <EstimateNote />
          </div>
        )}
      </section>
    </>
  );
}
