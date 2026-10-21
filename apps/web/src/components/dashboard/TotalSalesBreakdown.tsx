"use client";
import { useId, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import {
  BUILT_IN_PRESETS,
  builtInPreset,
  COMPONENT_INFO,
  CUSTOM_NAME,
  customSales,
  DEFAULT_CALCULATION,
  differenceFromShopify,
  isStandard,
  MAX_SAVED_PRESETS,
  SALES_COMPONENTS,
  sameSelection,
  SHOPIFY_STANDARD,
  splitTotal,
  type ComponentSelection,
  type SalesCalculation,
  type SalesComponent,
} from "@app/shared/salesCalculation";
import { useApp } from "@/components/AppContext";
import { useAction } from "@/components/AppUi";
import { api, fmtMoney, liveDataChanged } from "@/lib/api";
import { checkPill } from "./ShopifyCheck";
import { freshnessPill } from "./StoreHeader";
import { fmtRange } from "./format";
import { Change } from "./Narrative";
import { Dot, Panel } from "./Primitives";
import { salesLinesOf } from "./redacted";
import type { Overview } from "./types";

// ---------------------------------------------------------------------------
// Total sales breakdown: Shopify's total sales line by line (net sales, additional fees, duties,
// shipping charges, taxes), and the store's own calculation from those lines, Custom sales. Every
// amount is the store's own for the dates on screen, from Shopify's sales records; the switches
// only choose which lines Custom sales counts. Shopify's total sales is never changed by them:
// the two always show side by side, each named. docs/kpis.md, "Total sales breakdown and Custom sales".
// ---------------------------------------------------------------------------

/** One colour per line, always with its name beside it (never colour alone). */
const FILL: Record<SalesComponent, string> = {
  netSales: "bg-[var(--viz-cat-1)]",
  additionalFees: "bg-[var(--viz-tier-3)]",
  duties: "bg-[var(--viz-cat-3)]",
  shipping: "bg-[var(--viz-cat-2)]",
  taxes: "bg-[var(--viz-tier-1)]",
};

/** The draft being edited: what PUT .../sales-calculation takes. */
interface Draft {
  components: ComponentSelection;
  label: string | null;
  applyToDashboard: boolean;
  presets: SalesCalculation["presets"];
}

const draftOf = (c: SalesCalculation): Draft => ({ components: c.components, label: c.label, applyToDashboard: c.applyToDashboard, presets: c.presets });
const sameDraft = (a: Draft, b: Draft) =>
  sameSelection(a.components, b.components) &&
  (a.label ?? "") === (b.label ?? "") &&
  a.applyToDashboard === b.applyToDashboard &&
  JSON.stringify(a.presets) === JSON.stringify(b.presets);

/** What the draft's selection is called: a built-in calculation, a saved one, or the merchant's own name. */
function nameOf(d: Draft): string {
  return builtInPreset(d.components)?.label ?? d.presets.find((p) => sameSelection(p.components, d.components))?.name ?? d.label ?? CUSTOM_NAME;
}

/** A small "i" with the line's explanation, on hover and on keyboard focus. */
function Tip({ id, text }: { id: string; text: string }) {
  return (
    <span className="group relative inline-flex">
      <button type="button" className="rounded-full text-muted hover:text-text focus-visible:text-text" aria-describedby={id} aria-label="What this is">
        <Info aria-hidden className="h-3.5 w-3.5" />
      </button>
      <span
        role="tooltip"
        id={id}
        className="pointer-events-none absolute left-0 top-full z-20 mt-1.5 hidden w-64 max-w-[calc(100vw-4rem)] rounded-lg border border-border bg-surface p-2.5 text-xs font-normal leading-relaxed text-text shadow-lg group-focus-within:block group-hover:block"
      >
        {text}
      </span>
    </span>
  );
}

function Figure({ label, badge, value, children, testId }: { label: string; badge?: ReactNode; value: string; children?: ReactNode; testId: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface p-3" data-testid={testId}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        {label}
        {badge}
      </p>
      <p className="mt-1 truncate text-xl font-semibold tabular-nums sm:text-2xl">{value}</p>
      {children && <div className="mt-1 text-xs text-muted">{children}</div>}
    </div>
  );
}

const chip = "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium";

/**
 * The breakdown card, for a member who may see the lines (Team & Access "View gross sales,
 * discounts, tax, shipping and total sales"): the caller shows it only then.
 */
export function TotalSalesBreakdown({ ov, currency }: { ov: Overview; currency: string }) {
  const s = ov.modules.sales_overview!;
  const saved = s.calculation ?? DEFAULT_CALCULATION;
  // Re-read from the saved calculation whenever it changes (a save here or by someone else).
  return <BreakdownCard key={saved.updatedAt ?? "default"} ov={ov} currency={currency} saved={saved} />;
}

function BreakdownCard({ ov, currency, saved }: { ov: Overview; currency: string; saved: SalesCalculation }) {
  const { workspace, allowed } = useApp();
  // Saving changes what the whole team sees: owners and admins (never a shared link).
  const canSave = allowed("stores:manage");
  const { busy, run } = useAction();
  const uid = useId();
  const s = ov.modules.sales_overview!;
  const now = salesLinesOf(s.current);
  const before = salesLinesOf(s.previous);
  const [base, setBase] = useState<Draft>(() => draftOf(saved));
  const [draft, setDraft] = useState<Draft>(() => draftOf(saved));
  const [showDetails, setShowDetails] = useState(false);
  const [newName, setNewName] = useState("");
  const dirty = !sameDraft(draft, base);
  const money = (n: number) => fmtMoney(n, currency);

  // Lines an answer of an older release doesn't carry: shown as not available, never as 0.
  const available: Record<SalesComponent, boolean> = { netSales: true, additionalFees: s.current.additionalFees !== undefined, duties: s.current.duties !== undefined, shipping: true, taxes: true };
  if (!now) return null;

  const { lines, unsplit } = splitTotal(now);
  const selection = draft.components;
  const custom = customSales(now, selection);
  const official = now.totalSales;
  const difference = differenceFromShopify(now, selection);
  const customBefore = before ? customSales(before, selection) : null;
  const customDelta = customBefore === null || customBefore === 0 ? null : (custom - customBefore) / Math.abs(customBefore);
  const name = nameOf(draft);
  const standard = isStandard(selection);
  const versus = ov.previous.imported === false ? null : `vs ${fmtRange(ov.previous.from, ov.previous.to)}`;
  const fresh = freshnessPill("live", ov.freshness, Date.now());
  const check = checkPill(ov.check, Date.now());

  const choice = builtInPreset(selection) ? `builtin:${builtInPreset(selection)!.id}` : (() => {
    const i = draft.presets.findIndex((p) => sameSelection(p.components, selection));
    return i >= 0 ? `saved:${i}` : "custom";
  })();
  const choose = (v: string) => {
    if (v.startsWith("builtin:")) {
      const p = BUILT_IN_PRESETS.find((x) => `builtin:${x.id}` === v);
      if (p) setDraft((d) => ({ ...d, components: p.components, label: null }));
    } else if (v.startsWith("saved:")) {
      const p = draft.presets[Number(v.slice(6))];
      if (p) setDraft((d) => ({ ...d, components: p.components, label: p.name }));
    }
  };
  const toggle = (k: SalesComponent, on: boolean) => {
    const next = { ...selection, [k]: on };
    // At least one line: a calculation of nothing isn't one.
    if (!SALES_COMPONENTS.some((c) => next[c])) return;
    setDraft((d) => ({ ...d, components: next, label: builtInPreset(next) ? null : (d.label ?? CUSTOM_NAME) }));
  };

  const save = (patch: Partial<Draft>, done: string) =>
    run("save", "save the sales calculation", async () => {
      const body = { ...draft, ...patch };
      const r = await api<{ calculation: SalesCalculation }>(`/workspaces/${workspace.id}/stores/${ov.store.id}/sales-calculation`, {
        method: "PUT",
        body: { components: body.components, label: builtInPreset(body.components) ? null : nameOf(body), applyToDashboard: body.applyToDashboard, presets: body.presets },
      });
      const next = draftOf(r.calculation);
      setBase(next);
      setDraft(next);
      // The dashboard behind this panel asks again now, so the tiles and the trend follow at once.
      liveDataChanged();
      return done;
    });

  const addPreset = () => {
    const n = newName.trim();
    if (!n || draft.presets.length >= MAX_SAVED_PRESETS || draft.presets.some((p) => p.name.toLowerCase() === n.toLowerCase())) return;
    setDraft((d) => ({ ...d, label: n, presets: [...d.presets, { name: n, components: d.components }] }));
    setNewName("");
  };
  const nameTaken = draft.presets.some((p) => p.name.toLowerCase() === newName.trim().toLowerCase());

  // Each line's share of Shopify's total sales, for the bar (only the parts above zero can be drawn).
  const drawable = SALES_COMPONENTS.filter((k) => available[k] && lines[k] > 0);
  const drawnTotal = drawable.reduce((a, k) => a + lines[k], 0);
  const share = (k: SalesComponent) => (official > 0 && available[k] ? lines[k] / official : null);
  const pct = (v: number | null) => (v === null ? "—" : new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(v));

  return (
    <Panel
      id="d-sales-breakdown"
      title="Total sales breakdown"
      help={<>Shopify&apos;s total sales line by line, from Shopify&apos;s own sales records for these dates. Turn a line off to count sales your own way: Shopify&apos;s figure never changes.</>}
      aside={
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5" title={fresh.title} data-testid="breakdown-freshness">
            <Dot tone={fresh.tone} />
            {fresh.label}
          </span>
          {check && (
            <span className="inline-flex items-center gap-1.5" title={check.title}>
              <Dot tone={check.tone} />
              {check.label}
            </span>
          )}
        </span>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Figure testId="breakdown-shopify-total" label="Shopify total sales" badge={<span className={`${chip} bg-good/10 text-good`}>Shopify&apos;s figure</span>} value={money(official)}>
          {versus ? <><Change value={s.deltas.totalSales ?? null} /> {versus}</> : "No earlier data to compare"}
        </Figure>
        <Figure testId="breakdown-custom" label="Custom sales" badge={<span className={`${chip} bg-accent/10 text-accent`} data-testid="breakdown-mode">{standard ? "Shopify standard" : name}</span>} value={money(custom)}>
          {versus && customBefore !== null ? <><Change value={customDelta} /> {versus}</> : versus ? "—" : "No earlier data to compare"}
        </Figure>
        <Figure testId="breakdown-difference" label="Difference" value={money(difference)}>
          {difference === 0 ? "Custom sales is Shopify's total sales." : "Shopify's total sales less Custom sales: the lines turned off."}
        </Figure>
      </div>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <label className="min-w-0 text-xs text-muted" htmlFor={`${uid}-preset`}>
          Calculation
          <select id={`${uid}-preset`} className="input mt-1 block h-9 w-full min-w-[14rem] py-1 text-sm sm:w-auto" value={choice} onChange={(e) => choose(e.target.value)}>
            {BUILT_IN_PRESETS.map((p) => (
              <option key={p.id} value={`builtin:${p.id}`}>{p.label}</option>
            ))}
            {draft.presets.map((p, i) => (
              <option key={`saved-${p.name}`} value={`saved:${i}`}>{p.name} (saved)</option>
            ))}
            {choice === "custom" && <option value="custom">{name} (your own lines)</option>}
          </select>
        </label>
        <p className="text-xs text-muted">{builtInPreset(selection)?.description ?? "Your own choice of lines."}</p>
      </div>

      {/* Each line's part of Shopify's total sales. Lines turned off stay drawn, faded: they are
          still in Shopify's figure, only not in Custom sales. */}
      {drawnTotal > 0 && (
        <figure className="mt-4">
          <div className="flex h-3 gap-[2px] overflow-hidden rounded-full bg-bg" role="img" aria-label={`Total sales by line: ${drawable.map((k) => `${COMPONENT_INFO[k].label} ${money(lines[k])}${selection[k] ? "" : " (not in Custom sales)"}`).join(", ")}`}>
            {drawable.map((k) => (
              <div key={k} className={`${FILL[k]} h-full transition-opacity ${selection[k] ? "" : "opacity-25"}`} style={{ flexGrow: lines[k], flexBasis: 0, minWidth: 4 }} title={`${COMPONENT_INFO[k].label}: ${money(lines[k])}`} />
            ))}
          </div>
        </figure>
      )}

      <ul className="mt-3 divide-y divide-border text-sm" data-testid="breakdown-lines">
        {SALES_COMPONENTS.map((k) => {
          const info = COMPONENT_INFO[k];
          const on = selection[k];
          const id = `${uid}-${k}`;
          const status = !available[k] ? (
            <span className={`${chip} bg-text/[0.06] text-muted`}>Not available</span>
          ) : !on ? (
            <span className={`${chip} bg-warn/10 text-warn`}>Excluded</span>
          ) : lines[k] === 0 ? (
            <span className={`${chip} bg-text/[0.06] text-muted`}>None in these dates</span>
          ) : null;
          return (
            <li key={k} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5" data-testid={`breakdown-line-${k}`} data-included={on && available[k] ? "yes" : "no"}>
              <input
                id={id}
                type="checkbox"
                role="switch"
                className="h-4 w-4 shrink-0 accent-[var(--accent)]"
                checked={on && available[k]}
                disabled={!available[k]}
                onChange={(e) => toggle(k, e.target.checked)}
                aria-label={`Count ${info.label} in Custom sales`}
              />
              <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${FILL[k]} ${on ? "" : "opacity-25"}`} />
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                <label htmlFor={id} className={`font-medium ${on ? "" : "text-muted"}`}>{info.label}</label>
                <Tip id={`${id}-tip`} text={info.help} />
                {status}
              </span>
              <span className="w-14 text-right text-xs tabular-nums text-muted">{pct(share(k))}</span>
              <span className={`w-28 text-right tabular-nums ${on ? "" : "text-muted line-through decoration-muted/60"}`}>{available[k] ? money(lines[k]) : "—"}</span>
            </li>
          );
        })}
        {unsplit !== 0 && (
          <li className="flex items-start justify-between gap-3 py-2.5" data-testid="breakdown-unsplit">
            <span className="min-w-0">
              <span className="font-medium">Not split into lines</span>
              <span className="block text-xs text-muted">
                Part of Shopify&apos;s total sales on days bizinsights stored before it read Shopify&apos;s sales records line by line. It is in Shopify&apos;s total sales; no
                line holds it, so Custom sales leaves it out.
              </span>
            </span>
            <span className="w-28 shrink-0 text-right tabular-nums">{money(unsplit)}</span>
          </li>
        )}
        <li className="flex items-center justify-between gap-3 py-2.5 font-semibold">
          <span>= Shopify total sales</span>
          <span className="tabular-nums">{money(official)}</span>
        </li>
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-2" data-print-hide>
        <button type="button" className="btn-secondary" disabled={standard} onClick={() => setDraft((d) => ({ ...d, components: SHOPIFY_STANDARD, label: null }))}>
          Reset to Shopify default
        </button>
        {canSave && (
          <button type="button" className="btn-primary" disabled={!dirty || busy === "save"} onClick={() => void save({}, "Saved. Everyone on this store's dashboard now sees this calculation.")}>
            {busy === "save" ? "Saving…" : "Save configuration"}
          </button>
        )}
        {canSave &&
          (base.applyToDashboard && !isStandard(base.components) ? (
            <button type="button" className="btn-secondary" disabled={busy === "save"} onClick={() => void save({ applyToDashboard: false }, "Custom sales is no longer shown on the dashboard.")}>
              Stop showing on dashboard
            </button>
          ) : (
            <button
              type="button"
              className="btn-secondary"
              disabled={standard || busy === "save"}
              title={standard ? "Turn a line off first: Shopify standard is what the dashboard shows already." : undefined}
              onClick={() => void save({ applyToDashboard: true }, "Custom sales now shows next to Shopify's total sales across the dashboard.")}
            >
              Apply to dashboard
            </button>
          ))}
        <button type="button" className="ml-auto text-sm font-medium text-accent underline-offset-2 hover:underline" aria-expanded={showDetails} aria-controls={`${uid}-details`} onClick={() => setShowDetails((v) => !v)}>
          {showDetails ? "Hide calculation details" : "View calculation details"}
        </button>
      </div>
      <p className="mt-2 text-xs text-muted" role="status">
        {base.applyToDashboard && !isStandard(base.components)
          ? `Shown on the dashboard as "Custom sales · ${nameOf(base)}", next to Shopify's figures.`
          : "The dashboard shows Shopify's figures only."}
        {dirty ? " You have changes that aren't saved." : ""}
        {!canSave ? " Only owners and admins can save the store's calculation; your switches here last until you leave." : ""}
      </p>

      {showDetails && (
        <div id={`${uid}-details`} className="mt-4 space-y-3 rounded-lg border border-border bg-bg/60 p-3 text-xs leading-relaxed" data-testid="breakdown-details">
          <p>
            <span className="font-semibold">Shopify total sales</span> = {SALES_COMPONENTS.filter((k) => available[k]).map((k) => `${COMPONENT_INFO[k].label} ${money(lines[k])}`).join(" + ")}
            {unsplit !== 0 ? ` + not split ${money(unsplit)}` : ""} = <span className="font-semibold">{money(official)}</span>
          </p>
          <p>
            <span className="font-semibold">Custom sales ({standard ? "Shopify standard" : name})</span> ={" "}
            {SALES_COMPONENTS.filter((k) => selection[k] && available[k]).map((k) => `${COMPONENT_INFO[k].label} ${money(lines[k])}`).join(" + ")} ={" "}
            <span className="font-semibold">{money(custom)}</span>
          </p>
          {difference !== 0 && (
            <p>
              <span className="font-semibold">Difference</span> = {money(difference)}: {SALES_COMPONENTS.filter((k) => !selection[k] && available[k]).map((k) => `${COMPONENT_INFO[k].label} ${money(lines[k])}`).join(", ")}
              {unsplit !== 0 ? `${SALES_COMPONENTS.some((k) => !selection[k]) ? ", " : ""}not split ${money(unsplit)}` : ""} left out.
            </p>
          )}
          {s.current.grossSales !== undefined && s.current.discounts !== undefined && (
            <p>
              <span className="font-semibold">Net sales</span> = gross sales {money(s.current.grossSales)} − discounts {money(s.current.discounts)} − returns{" "}
              {money(s.current.returns ?? Math.round((s.current.grossSales - s.current.discounts - s.current.netSales) * 100) / 100)} = {money(s.current.netSales)}.
            </p>
          )}
          <p className="text-muted">
            Every amount is added up, to the cent, from Shopify&apos;s own sales records for {fmtRange(ov.range.from, ov.range.to)} in the store&apos;s time zone (
            {ov.store.timezone}) and currency ({currency}), the way Shopify&apos;s sales reports add them up: refunds, returns, cancellations and order edits count on the
            day they were made, discounts before tax, shipping after shipping discounts and refunds, and tax once, whether it was on items, shipping, duties or fees. Test
            orders, gift card sales and tips aren&apos;t in any line, as in Shopify. Custom sales is only ever shown beside Shopify&apos;s figures, named, and never
            replaces them.
          </p>
        </div>
      )}

      {canSave && (
        <div className="mt-4 border-t border-border pt-4" data-print-hide>
          <p className="text-xs font-semibold text-muted">Saved calculations</p>
          {draft.presets.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {draft.presets.map((p, i) => (
                <li key={p.name} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface py-0.5 pl-3 pr-1 text-xs">
                  <button type="button" className="font-medium hover:text-accent" onClick={() => choose(`saved:${i}`)}>{p.name}</button>
                  <button type="button" className="rounded-full px-1.5 text-muted hover:text-danger" aria-label={`Remove ${p.name}`} onClick={() => setDraft((d) => ({ ...d, presets: d.presets.filter((_, j) => j !== i) }))}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-muted">Keep calculations you switch between, such as one for wholesale and one for retail.</p>
          )}
          {draft.presets.length < MAX_SAVED_PRESETS && (
            <form
              className="mt-2 flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                addPreset();
              }}
            >
              <label className="sr-only" htmlFor={`${uid}-name`}>Name for these lines</label>
              <input id={`${uid}-name`} className="input h-9 w-56 py-1 text-sm" maxLength={60} placeholder={CUSTOM_NAME} value={newName} onChange={(e) => setNewName(e.target.value)} />
              <button type="submit" className="btn-secondary" disabled={!newName.trim() || nameTaken}>Keep these lines</button>
              {nameTaken && <span className="text-xs text-danger">A saved calculation already has that name.</span>}
            </form>
          )}
          {dirty && <p className="mt-2 text-xs text-muted">Saved calculations are kept once you press Save configuration.</p>}
        </div>
      )}
    </Panel>
  );
}
