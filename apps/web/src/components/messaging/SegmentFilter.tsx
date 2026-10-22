"use client";
import { useEffect, useId, useRef, useState } from "react";
import { describeSegment, segmentFilterSchema, type SegmentFilter } from "@app/shared/sms";
import { api, fmtNum } from "@/lib/api";
import { countryName, CountryPicker, smsError } from "./MessagingUi";
import type { SegmentEstimate } from "./types";

// ---------------------------------------------------------------------------
// Who a segment or campaign reaches (segmentFilterSchema), edited as text fields and checked with
// the shared schema. Marketing consent is always required on top: the API adds it.
// ---------------------------------------------------------------------------

export interface FilterDraft {
  countries: string[];
  minOrders: string;
  maxOrders: string;
  minSpent: string;
  orderedWithinDays: string;
  inactiveForDays: string;
}

export const blankFilter = (): FilterDraft => ({ countries: [], minOrders: "", maxOrders: "", minSpent: "", orderedWithinDays: "", inactiveForDays: "" });

const s = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));
export const fromFilter = (f: SegmentFilter): FilterDraft => ({
  countries: f.countries,
  minOrders: s(f.minOrders),
  maxOrders: s(f.maxOrders),
  minSpent: s(f.minSpent),
  orderedWithinDays: s(f.orderedWithinDays),
  inactiveForDays: s(f.inactiveForDays),
});

const opt = (v: string) => (v.trim() === "" ? null : Number(v));
const raw = (d: FilterDraft) => ({
  countries: d.countries,
  minOrders: opt(d.minOrders),
  maxOrders: opt(d.maxOrders),
  minSpent: opt(d.minSpent),
  orderedWithinDays: opt(d.orderedWithinDays),
  inactiveForDays: opt(d.inactiveForDays),
});

/** The draft as a filter, or what is wrong with it. */
export function parseFilter(d: FilterDraft): { ok: true; filter: SegmentFilter } | { ok: false; problems: string[] } {
  const r = segmentFilterSchema.safeParse(raw(d));
  if (r.success) return { ok: true, filter: r.data };
  const LABEL: Record<string, string> = { minOrders: "At least … orders", maxOrders: "At most … orders", minSpent: "Spent at least", orderedWithinDays: "Ordered in the last … days", inactiveForDays: "No order for … days", countries: "Countries" };
  return { ok: false, problems: r.error.issues.map((i) => `${LABEL[String(i.path[0])] ?? String(i.path[0])}: ${i.message}`) };
}

function NumberField({ label, value, onChange, disabled, min = 0, step = "1", hint }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; min?: number; step?: string; hint?: string }) {
  const id = useId();
  return (
    <div>
      <label className="text-xs text-muted" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="input" type="number" min={min} step={step} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} placeholder="Any" />
      {hint && <p className="mt-0.5 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

export function SegmentFilterFields({ value, onChange, disabled = false, currency }: { value: FilterDraft; onChange: (d: FilterDraft) => void; disabled?: boolean; currency?: string }) {
  const set = (patch: Partial<FilterDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-3">
      <CountryPicker label="Customers in (none chosen: any country)" value={value.countries} onChange={(countries) => set({ countries })} disabled={disabled} />
      <fieldset className="grid min-w-0 gap-3 sm:grid-cols-3" disabled={disabled}>
        <legend className="sr-only">Orders and spend</legend>
        <NumberField label="At least … orders" value={value.minOrders} onChange={(minOrders) => set({ minOrders })} />
        <NumberField label="At most … orders" value={value.maxOrders} onChange={(maxOrders) => set({ maxOrders })} />
        <NumberField label={`Spent at least${currency ? ` (${currency})` : ""}`} value={value.minSpent} step="0.01" onChange={(minSpent) => set({ minSpent })} />
        <NumberField label="Ordered in the last … days" value={value.orderedWithinDays} min={1} onChange={(orderedWithinDays) => set({ orderedWithinDays })} />
        <NumberField label="No order for … days or more" value={value.inactiveForDays} min={1} onChange={(inactiveForDays) => set({ inactiveForDays })} />
      </fieldset>
    </div>
  );
}

/** How many customers a filter reaches right now (POST segments/estimate), and in words. */
export function SegmentReach({ base, draft }: { base: string; draft: FilterDraft }) {
  const parsed = parseFilter(draft);
  const key = parsed.ok ? JSON.stringify(parsed.filter) : null;
  const [state, setState] = useState<{ key: string; data: SegmentEstimate | null; error: string | null } | null>(null);
  const latest = useRef(0);
  useEffect(() => {
    if (!key) return;
    const request = ++latest.current;
    const t = window.setTimeout(() => {
      api<SegmentEstimate>(`${base}/segments/estimate`, { method: "POST", body: { filter: JSON.parse(key) } })
        .then((data) => request === latest.current && setState({ key, data, error: null }))
        .catch((e) => request === latest.current && setState({ key, data: null, error: smsError(e, "count the customers") }));
    }, 500);
    return () => window.clearTimeout(t);
  }, [base, key]);
  if (!parsed.ok) {
    return (
      <ul className="space-y-0.5 text-sm text-danger">
        {parsed.problems.map((p) => <li key={p}>{p}</li>)}
      </ul>
    );
  }
  const fresh = state && state.key === key ? state : null;
  return (
    <div className="rounded-lg border border-border bg-bg/50 p-3 text-sm" aria-live="polite">
      <p className="text-muted">{describeSegment(parsed.filter)}.</p>
      {!fresh ? (
        <p className="mt-1">Counting…</p>
      ) : fresh.error ? (
        <p className="mt-1 text-danger">{fresh.error}</p>
      ) : (
        <>
          <p className="mt-1">
            <strong className="text-lg tabular-nums">{fmtNum(fresh.data!.recipients)}</strong> customer{fresh.data!.recipients === 1 ? "" : "s"} right now
          </p>
          {fresh.data!.byCountry.length > 0 && (
            <p className="mt-0.5 text-xs text-muted">{fresh.data!.byCountry.map((c) => `${countryName(c.country)} ${fmtNum(c.count)}`).join(" · ")}</p>
          )}
        </>
      )}
      <p className="mt-2 text-xs text-muted">Only customers subscribed to your SMS marketing in Shopify, and not opted out, are ever included, whatever the filter says.</p>
    </div>
  );
}
