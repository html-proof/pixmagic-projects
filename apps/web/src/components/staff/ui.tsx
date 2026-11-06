"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { Info } from "lucide-react";
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
import type { Tone } from "@/components/dashboard/Primitives";
import { ChangeTag, FigureTile } from "@/components/PageKit";
import { overlay } from "@/components/AppUi";
import { fmtPct } from "@/lib/api";
import { fmtHours, fmtMoney } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// Pieces shared by the Staff pages and the employee portal, in the owner's approved Stitch design
// (prototype v2, screens 25–29): statuses as small tinted pills, a page's figures as the design's
// tiles (components/PageKit.tsx), tables with a soft header row and hairline rows, a row of tabs
// with a green underline. Nothing here holds business rules.
// ---------------------------------------------------------------------------------------------

const PILL_TONE: Record<Tone, string> = {
  good: "bg-good/12 text-good",
  warn: "bg-warn/12 text-warn",
  danger: "bg-danger/12 text-danger",
  neutral: "bg-home-soft text-muted",
};

/** A status as the design draws it (a dot and its words on a tint); the words always carry the meaning. */
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${PILL_TONE[tone]}`}>
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      {children}
    </span>
  );
}

/** A person's initials in the design's soft square, beside their name (decorative: the name is next to it). */
export function Initials({ name, small = false }: { name: string; small?: boolean }) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[parts.length - 1]![0]}` : (parts[0]?.slice(0, 2) ?? "?");
  return (
    <span aria-hidden className={`flex shrink-0 items-center justify-center rounded-lg bg-home-tag font-semibold text-text uppercase ${small ? "h-8 w-8 text-[11px]" : "h-10 w-10 text-xs"}`}>
      {letters}
    </span>
  );
}

/** The design's plain-words strip at the top of a page ("bizinsights works out pay from approved hours…"). */
export function InfoStrip({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="home-card animate-rise flex items-start gap-3 px-4 py-3 text-sm sm:px-5" data-testid={testId}>
      <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

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
export const liveTone = (s: LiveStatus): Tone => LIVE_TONE[s];
export const LiveBadge = ({ status }: { status: LiveStatus }) => <Pill tone={LIVE_TONE[status]}>{LIVE_STATUS_LABEL[status]}</Pill>;

const APPROVAL_TONE: Record<ApprovalStatus, Tone> = { pending: "warn", approved: "good", rejected: "danger" };
export const ApprovalBadge = ({ status }: { status: ApprovalStatus }) => <Pill tone={APPROVAL_TONE[status]}>{APPROVAL_STATUS_LABEL[status]}</Pill>;

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
export const PayrollBadge = ({ status }: { status: PayrollStatus }) => <Pill tone={PAYROLL_TONE[status] ?? "neutral"}>{PAYROLL_STATUS_LABEL[status] ?? status}</Pill>;

const PAYMENT_TONE: Record<PaymentStatus, Tone> = { completed: "good", failed: "danger", reversed: "neutral" };
export const PaymentBadge = ({ status }: { status: PaymentStatus }) => <Pill tone={PAYMENT_TONE[status] ?? "neutral"}>{PAYMENT_STATUS_LABEL[status] ?? status}</Pill>;

const ACCOUNT: Record<string, { tone: Tone; label: string }> = {
  active: { tone: "good", label: "Account active" },
  invited: { tone: "warn", label: "Invited" },
  expired: { tone: "danger", label: "Invitation expired" },
  not_invited: { tone: "neutral", label: "Not invited" },
};
export const AccountBadge = ({ account }: { account: string }) => <Pill tone={ACCOUNT[account]?.tone ?? "neutral"}>{ACCOUNT[account]?.label ?? account}</Pill>;

const EMP_STATUS_TONE: Record<EmployeeStatus, Tone> = { active: "good", on_leave: "warn", inactive: "neutral" };
export const EmployeeStatusBadge = ({ status }: { status: string }) => (
  <Pill tone={EMP_STATUS_TONE[status as EmployeeStatus] ?? "neutral"}>{EMPLOYEE_STATUS_LABEL[status as EmployeeStatus] ?? status}</Pill>
);

/** A shift's flags as small chips. */
export function Flags({ flags }: { flags: string[] }) {
  const shown = flags.filter((f) => f in SESSION_FLAG_LABEL);
  if (!shown.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {shown.map((f) => (
        <span key={f} className={`rounded-full px-2 py-0.5 text-[11px] ${f === "stale" || f === "long_break" || f === "too_many_breaks" ? "bg-warn/12 text-warn" : "bg-home-soft text-muted"}`}>
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

/** A change with no good or bad direction (more hours isn't good or bad by itself): muted, its words for screen readers. */
function NeutralChange({ value, versus }: { value: number | null; versus: string }) {
  if (value === null) return <span className="text-xs text-muted">Nothing to compare with</span>;
  return (
    <span className="text-xs font-medium text-muted tabular-nums">
      <span className="sr-only">{value > 0 ? "up " : value < 0 ? "down " : "unchanged, "}</span>
      <span aria-hidden>{value > 0 ? "+" : value < 0 ? "−" : ""}</span>
      {fmtPct(Math.abs(value))}
      <span className="sr-only"> {versus}</span>
    </span>
  );
}

/** One of the API's staff figures as the design's tile: its name, the figure, its change, what it was before and what it counts. */
export function KpiCard({ kpi, currency, asOf }: { kpi: KpiData; currency: string | null; asOf?: string | null }) {
  const value = formatKpi(kpi, kpi.value, currency);
  const change =
    kpi.compareLabel === null ? undefined : GOOD_UP.has(kpi.key) || GOOD_DOWN.has(kpi.key) ? (
      <ChangeTag value={kpi.change} invert={GOOD_DOWN.has(kpi.key)} versus={kpi.compareLabel} missing="Nothing to compare with" />
    ) : (
      <NeutralChange value={kpi.change} versus={kpi.compareLabel} />
    );
  return (
    <FigureTile
      testId={`kpi-${kpi.key}`}
      title={kpi.label}
      value={value}
      change={change}
      sub={
        <>
          {kpi.previous !== null && kpi.compareLabel && (
            <span className="block">
              Before: {formatKpi(kpi, kpi.previous, currency)} <span className="opacity-80">({kpi.compareLabel.replace(/^vs /, "")})</span>
            </span>
          )}
          <span className="block">{kpi.help}</span>
          {asOf && <span className="mt-1 block text-[11px]">Updated {new Date(asOf).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>}
        </>
      }
    />
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

/**
 * A table as the design draws one (SalesViews' OrdersTable): a soft header row of small capitals
 * and hairline rows. On a phone it scrolls sideways inside its card instead of widening the page.
 */
export function Table({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-collapse text-sm [&_tbody>tr:last-child>td]:border-b-0" aria-label={label}>
        {children}
      </table>
    </div>
  );
}
export const Th = ({ children, right = false, className = "" }: { children?: ReactNode; right?: boolean; className?: string }) => (
  <th scope="col" className={`bg-home-soft px-3 py-2.5 text-[11px] font-semibold tracking-wider whitespace-nowrap text-muted uppercase first:rounded-l last:rounded-r ${right ? "text-right" : "text-left"} ${className}`}>
    {children}
  </th>
);
export const Td = ({ children, right = false, className = "" }: { children?: ReactNode; right?: boolean; className?: string }) => (
  <td className={`border-b border-home-line px-3 py-3 align-top ${right ? "text-right tabular-nums" : ""} ${className}`}>{children}</td>
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

/** A row of tabs inside a page, as PageTabs draws them: the current one green and underlined; scrolls sideways on a phone. */
export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: ReadonlyArray<readonly [T, string]>; value: T; onChange: (t: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-6 overflow-x-auto overflow-y-hidden border-b border-home-line">
      {tabs.map(([id, text]) => (
        <button
          key={id}
          role="tab"
          aria-selected={value === id}
          className={`-mb-px rounded-t-sm border-b-2 px-0.5 pt-1 pb-2.5 text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:bg-home-soft focus-visible:text-accent ${value === id ? "border-accent text-accent" : "border-transparent text-muted hover:text-text"}`}
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
          <h2 id={id} className="home-h2">
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

/** "Estimate" note shown wherever pay figures appear: the design's "estimated, before tax" line. */
export function EstimateNote({ children }: { children?: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded bg-home-soft px-3 py-2 text-xs text-muted">
      <Info aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">{children ?? "Pay figures are estimated gross wages from recorded hours and pay rates, before tax. bizinsights doesn't calculate tax or statutory deductions."}</span>
    </p>
  );
}

/** A small figure inside a card (a pay run's totals, a shift's summary): the design's soft tile. */
export function Figure({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded bg-home-soft p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </div>
  );
}
