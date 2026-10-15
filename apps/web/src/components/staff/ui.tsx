"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import {
  APPROVAL_STATUS_LABEL,
  EMPLOYEE_STATUS_LABEL,
  LIVE_STATUS_LABEL,
  PAYMENT_STATUS_LABEL,
  PAYROLL_STATUS_LABEL,
  RANGE_LABEL,
  RANGE_PRESETS,
  SESSION_FLAG_LABEL,
  type ApprovalStatus,
  type EmployeeStatus,
  type Granularity,
  type LiveStatus,
  type PaymentStatus,
  type PayrollStatus,
  type RangePreset,
  type SessionFlag,
} from "@app/shared/staff";
import { Badge, Delta, NeutralDelta, type Tone } from "@/components/dashboard/Primitives";
import { overlay } from "@/components/AppUi";
import { fmtHours, fmtMoney } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// Pieces shared by the Staff pages and the employee portal. Built on the app's own primitives
// (Badge, Delta, cards, buttons); nothing here holds business rules.
// ---------------------------------------------------------------------------------------------

const LIVE_TONE: Record<LiveStatus, Tone> = {
  working: "good",
  on_break: "warn",
  clocked_out: "neutral",
  absent: "danger",
  pending_review: "warn",
  not_in_yet: "neutral",
  off_today: "neutral",
  on_leave: "neutral",
};
export const LiveBadge = ({ status }: { status: LiveStatus }) => <Badge tone={LIVE_TONE[status]}>{LIVE_STATUS_LABEL[status]}</Badge>;

const APPROVAL_TONE: Record<ApprovalStatus, Tone> = { pending: "warn", approved: "good", rejected: "danger" };
export const ApprovalBadge = ({ status }: { status: ApprovalStatus }) => <Badge tone={APPROVAL_TONE[status]}>{APPROVAL_STATUS_LABEL[status]}</Badge>;

const PAYROLL_TONE: Record<PayrollStatus, Tone> = {
  draft: "neutral",
  pending_approval: "warn",
  approved: "good",
  partially_paid: "warn",
  paid: "good",
  cancelled: "neutral",
  correction_required: "danger",
  payment_failed: "danger",
  reversed: "neutral",
};
export const PayrollBadge = ({ status }: { status: PayrollStatus }) => <Badge tone={PAYROLL_TONE[status] ?? "neutral"}>{PAYROLL_STATUS_LABEL[status] ?? status}</Badge>;

const PAYMENT_TONE: Record<PaymentStatus, Tone> = { completed: "good", failed: "danger", reversed: "neutral" };
export const PaymentBadge = ({ status }: { status: PaymentStatus }) => <Badge tone={PAYMENT_TONE[status] ?? "neutral"}>{PAYMENT_STATUS_LABEL[status] ?? status}</Badge>;

const ACCOUNT: Record<string, { tone: Tone; label: string }> = {
  active: { tone: "good", label: "Account active" },
  invited: { tone: "warn", label: "Invited" },
  expired: { tone: "danger", label: "Invitation expired" },
  not_invited: { tone: "neutral", label: "Not invited" },
};
export const AccountBadge = ({ account }: { account: string }) => <Badge tone={ACCOUNT[account]?.tone ?? "neutral"}>{ACCOUNT[account]?.label ?? account}</Badge>;

const EMP_STATUS_TONE: Record<EmployeeStatus, Tone> = { active: "good", on_leave: "warn", inactive: "neutral" };
export const EmployeeStatusBadge = ({ status }: { status: string }) => (
  <Badge tone={EMP_STATUS_TONE[status as EmployeeStatus] ?? "neutral"}>{EMPLOYEE_STATUS_LABEL[status as EmployeeStatus] ?? status}</Badge>
);

/** A shift's flags as small chips. */
export function Flags({ flags }: { flags: string[] }) {
  const shown = flags.filter((f) => f in SESSION_FLAG_LABEL);
  if (!shown.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {shown.map((f) => (
        <span key={f} className={`rounded-full px-2 py-0.5 text-[11px] ${f === "stale" || f === "long_break" || f === "too_many_breaks" ? "bg-warn/12 text-warn" : "bg-border/60 text-muted"}`}>
          {SESSION_FLAG_LABEL[f as SessionFlag]}
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------------------------

export interface KpiData {
  key: string;
  label: string;
  unit: "hours" | "money" | "count" | "rate";
  value: number | string | null;
  previous: number | string | null;
  change: number | null;
  help: string;
  compareLabel: string | null;
}

/** Costs going up isn't "good"; hours and staff aren't good or bad either: deltas stay neutral there. */
const GOOD_UP = new Set(["amount_paid"]);
const GOOD_DOWN = new Set(["outstanding", "pending_approvals"]);

export function formatKpi(k: Pick<KpiData, "unit">, v: number | string | null, currency: string | null) {
  if (v === null || v === undefined) return "—";
  if (k.unit === "hours") return fmtHours(Number(v));
  if (k.unit === "money" || k.unit === "rate") return fmtMoney(String(v), currency) + (k.unit === "rate" ? "/h" : "");
  return new Intl.NumberFormat().format(Number(v));
}

export function KpiCard({ kpi, currency, asOf }: { kpi: KpiData; currency: string | null; asOf?: string | null }) {
  const value = formatKpi(kpi, kpi.value, currency);
  return (
    <div className="lift flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-surface p-4" data-testid={`kpi-${kpi.key}`}>
      <p className="text-xs font-medium text-muted">{kpi.label}</p>
      <p className="truncate text-2xl font-semibold tabular-nums">{value}</p>
      <div className="min-h-5">
        {kpi.compareLabel === null ? null : GOOD_UP.has(kpi.key) || GOOD_DOWN.has(kpi.key) ? (
          <Delta value={kpi.change} invert={GOOD_DOWN.has(kpi.key)} label={kpi.compareLabel} />
        ) : (
          <NeutralDelta value={kpi.change} />
        )}
      </div>
      {kpi.previous !== null && kpi.compareLabel && (
        <p className="text-xs text-muted">
          Before: {formatKpi(kpi, kpi.previous, currency)} <span className="opacity-80">({kpi.compareLabel.replace(/^vs /, "")})</span>
        </p>
      )}
      <p className="text-xs text-muted">{kpi.help}</p>
      {asOf && <p className="mt-auto pt-1 text-[11px] text-muted">Updated {new Date(asOf).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Date range filter (Live, Today, ... Custom) with optional bucket size
// ---------------------------------------------------------------------------------------------

export interface RangeValue {
  preset: RangePreset;
  from: string;
  to: string;
  granularity?: Granularity;
}

export const rangeQuery = (r: RangeValue) =>
  new URLSearchParams({ preset: r.preset === "live" ? "today" : r.preset, ...(r.preset === "custom" ? { from: r.from, to: r.to } : {}), ...(r.granularity ? { granularity: r.granularity } : {}) }).toString();

const GRAN_LABEL: Record<Granularity, string> = { hour: "By hour", day: "By day", week: "By week", month: "By month", quarter: "By quarter", year: "By year" };

export function RangeFilter({
  value,
  onChange,
  granularities,
  presets = RANGE_PRESETS,
}: {
  value: RangeValue;
  onChange: (v: RangeValue) => void;
  /** Bucket sizes to offer (from the API's allowedGranularities); none hides the control. */
  granularities?: Granularity[];
  presets?: readonly RangePreset[];
}) {
  const customBad = value.preset === "custom" && (!value.from || !value.to || value.from > value.to);
  return (
    <div className="flex flex-wrap items-end gap-2" role="group" aria-label="Date range">
      <label className="min-w-[9rem]">
        <span className="label text-xs text-muted">Period</span>
        <select className="input" value={value.preset} onChange={(e) => onChange({ ...value, preset: e.target.value as RangePreset, granularity: undefined })}>
          {presets.map((p) => (
            <option key={p} value={p}>
              {RANGE_LABEL[p]}
            </option>
          ))}
        </select>
      </label>
      {value.preset === "custom" && (
        <>
          <label>
            <span className="label text-xs text-muted">From</span>
            <input type="date" className="input" value={value.from} max={value.to || undefined} onChange={(e) => onChange({ ...value, from: e.target.value })} />
          </label>
          <label>
            <span className="label text-xs text-muted">To</span>
            <input type="date" className="input" value={value.to} min={value.from || undefined} onChange={(e) => onChange({ ...value, to: e.target.value })} />
          </label>
        </>
      )}
      {granularities && granularities.length > 0 && (
        <label className="min-w-[8rem]">
          <span className="label text-xs text-muted">Show</span>
          <select className="input" value={value.granularity ?? ""} onChange={(e) => onChange({ ...value, granularity: (e.target.value || undefined) as Granularity | undefined })}>
            <option value="">Automatic</option>
            {granularities.map((g) => (
              <option key={g} value={g}>
                {GRAN_LABEL[g]}
              </option>
            ))}
          </select>
        </label>
      )}
      {customBad && <p className="pb-2 text-xs text-danger">Choose a start date on or before the end date.</p>}
    </div>
  );
}

/** Whether a range is complete enough to ask the API about. */
export const rangeReady = (r: RangeValue) => r.preset !== "custom" || (!!r.from && !!r.to && r.from <= r.to);

// ---------------------------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------------------------

/** A horizontally scrollable table with the app's styling. */
export function Table({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="-mx-5 overflow-x-auto px-5">
      <table className="w-full min-w-[40rem] border-collapse text-sm" aria-label={label}>
        {children}
      </table>
    </div>
  );
}
export const Th = ({ children, right = false, className = "" }: { children?: ReactNode; right?: boolean; className?: string }) => (
  <th scope="col" className={`border-b border-border px-2 py-2 text-xs font-medium text-muted ${right ? "text-right" : "text-left"} ${className}`}>
    {children}
  </th>
);
export const Td = ({ children, right = false, className = "" }: { children?: ReactNode; right?: boolean; className?: string }) => (
  <td className={`border-b border-border/70 px-2 py-2.5 align-top ${right ? "text-right tabular-nums" : ""} ${className}`}>{children}</td>
);

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return <p className="mt-3 text-xs text-muted">{total === 1 ? "1 result" : `${new Intl.NumberFormat().format(total)} results`}</p>;
  return (
    <nav className="mt-3 flex items-center justify-between gap-2 text-sm" aria-label="Pages">
      <p className="text-xs text-muted">
        Page {page} of {pages} · {new Intl.NumberFormat().format(total)} results
      </p>
      <div className="flex gap-2">
        <button className="btn-secondary px-3 py-1" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <button className="btn-secondary px-3 py-1" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </nav>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: ReadonlyArray<readonly [T, string]>; value: T; onChange: (t: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border">
      {tabs.map(([id, text]) => (
        <button
          key={id}
          role="tab"
          aria-selected={value === id}
          className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition ${value === id ? "border-accent font-semibold text-text" : "border-transparent text-muted hover:text-text"}`}
          onClick={() => onChange(id)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** A labelled form field with its hint or error underneath. */
export function Field({ label, hint, error, children, htmlFor, required = false }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string; required?: boolean }) {
  return (
    <div className="min-w-0">
      <label className="label" htmlFor={htmlFor}>
        {label}
        {required && <span className="text-danger"> *</span>}
      </label>
      {children}
      {error ? <p className="mt-1 text-xs text-danger">{error}</p> : hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

/** A dialog for forms (Escape or the backdrop closes it; focus moves in and back). */
export function Modal({ open, title, onClose, children, wide = false }: { open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  // The latest onClose, read when a key is pressed: the focus effect must run only when the dialog
  // opens, not whenever a parent re-renders with a new callback (that pulled focus out of the form).
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input,select,textarea,button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [open]);
  if (!open) return null;
  return overlay(
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} className={`card animate-sheet max-h-[90vh] w-full overflow-y-auto ${wide ? "max-w-2xl" : "max-w-lg"}`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <h2 id={id} className="text-lg font-semibold">
            {title}
          </h2>
          <button type="button" className="text-muted hover:text-text" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="mt-3">{children}</div>
      </div>
    </div>,
  );
}

/** "Estimate" note shown wherever pay figures appear. */
export function EstimateNote({ children }: { children?: ReactNode }) {
  return (
    <p className="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted">
      {children ?? "Pay figures are estimated gross wages from recorded hours and pay rates. Insights doesn't calculate tax or statutory deductions."}
    </p>
  );
}

/** Hours, as a figure with a label underneath. */
export function Figure({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </div>
  );
}
