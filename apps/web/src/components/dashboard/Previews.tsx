"use client";
import type { ReactNode } from "react";
import type { Health } from "@app/shared/health";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { fmtDay, fmtMoneyWhole, fmtRelative, fmtWeekday, weekdayNames } from "./format";
import type { Topic } from "./topics";
import type { Overview } from "./types";

// ---------------------------------------------------------------------------
// A small picture of each part of the store, on its card on the main page: the same bars the
// details use, cut down to what fits in a glance. Decorative for screen readers (the card's
// sentence says the same thing, and the details hold every number), but never color alone:
// every segment and bar carries its own label.
// ---------------------------------------------------------------------------

/** Thin columns on one baseline (the Sales chart, in miniature). */
function MiniColumns({ values, emphasis, faded, labels }: { values: number[]; emphasis?: number | null; faded?: number | null; labels?: string[] }) {
  const max = Math.max(0, ...values);
  return (
    <div>
      <div className="flex h-12 items-end gap-[2px] border-b border-border">
        {values.map((v, i) => (
          <span
            key={i}
            className="min-w-0 flex-1 rounded-t-[3px]"
            style={{
              height: max > 0 && v > 0 ? `${Math.max(6, (v / max) * 100)}%` : "0%",
              background: i === emphasis ? "var(--viz-tier-3)" : "var(--viz-tier-2)",
              opacity: i === faded ? 0.45 : i === emphasis || emphasis === undefined || emphasis === null ? 1 : 0.75,
            }}
          />
        ))}
      </div>
      {labels && (
        <div className="mt-1 flex gap-[2px] text-[10px] text-muted">
          {labels.map((l, i) => (
            <span key={i} className={`min-w-0 flex-1 text-center ${i === emphasis ? "font-semibold text-text" : ""}`}>{l}</span>
          ))}
        </div>
      )}
    </div>
  );
}

interface Segment {
  label: string;
  value: number;
  color: string;
  note?: string;
}

/** One bar split into parts, with every part named beside a matching dot. */
function MiniStack({ segments }: { segments: Segment[] }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const shown = segments.filter((s) => s.value > 0);
  return (
    <div>
      <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full bg-bg">
        {total > 0 && shown.map((s) => <span key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} />)}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
        {segments.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: s.color }} />
            {s.label} <strong className="font-semibold text-text">{s.note ?? fmtNum(s.value)}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

/** A few labelled bars, longest first (top products, funnel steps, codes). */
function MiniBars({ rows }: { rows: Array<{ label: ReactNode; value: number; display: string }> }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-1.5">
      {rows.map((r, i) => (
        <li key={i} className="text-xs">
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate">{r.label}</span>
            <span className="shrink-0 font-medium tabular-nums">{r.display}</span>
          </div>
          <div className="mt-0.5 h-1.5 rounded-full bg-bg">
            <div className="h-1.5 rounded-full" style={{ width: `${max > 0 ? Math.max(2, (r.value / max) * 100) : 0}%`, background: "var(--viz-tier-2)" }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

const Caption = ({ children }: { children: ReactNode }) => <p className="mt-1.5 text-[11px] text-muted">{children}</p>;

const STEP_SHORT = ["Visited", "Viewed a product", "Added to cart", "Started checkout", "Bought"];

/** The picture on a topic's card, or null when there's nothing worth drawing yet. */
export function AreaPreview({ topic, ov, currency, health }: { topic: Topic; ov: Overview; currency: string; health?: Record<Health, number> }) {
  const m = ov.modules;
  const whole = (n: number) => fmtMoneyWhole(n, currency);
  switch (topic) {
    case "overview": {
      if (!health) return null;
      return (
        <MiniStack
          segments={[
            { label: "Needs attention", value: health.attention, color: "var(--fill-danger)" },
            { label: "Keep an eye on", value: health.watch, color: "var(--fill-warn)" },
            { label: "Looking good", value: health.good, color: "var(--fill-good)" },
          ]}
        />
      );
    }
    case "sales": {
      const s = m.sales_overview;
      if (!s || s.series.length < 2 || !ov.hasData) return null;
      const values = s.series.map((d) => Math.max(0, d.netSales));
      const best = values.indexOf(Math.max(...values));
      const today = s.series.findIndex((d) => d.day === ov.today);
      return (
        <>
          <MiniColumns values={values} emphasis={values[best]! > 0 ? best : null} faded={today >= 0 ? today : null} />
          <Caption>
            Net sales per day, {fmtDay(s.series[0]!.day, { year: false })} – {fmtDay(s.series.at(-1)!.day, { year: false })}
            {values[best]! > 0 ? <> · best day {fmtWeekday(s.series[best]!.day)} {fmtDay(s.series[best]!.day, { year: false })}, {whole(values[best]!)}</> : null}
          </Caption>
        </>
      );
    }
    case "ads": {
      const a = m.ads;
      if (!a || a.series.length < 2) return null;
      const values = a.series.map((d) => d.spend);
      const top = values.indexOf(Math.max(...values));
      const today = a.series.findIndex((d) => d.day === ov.today);
      const split = a.byProvider.length > 1 && a.current.spend > 0 ? a.byProvider.map((p) => `${p.provider === "meta" ? "Meta" : "Google"} ${fmtPct(p.spend / a.current.spend)}`).join(" · ") : null;
      return (
        <>
          <MiniColumns values={values} emphasis={values[top]! > 0 ? top : null} faded={today >= 0 ? today : null} />
          <Caption>
            Ad spend per day{split ? <> · {split}</> : null}
            {a.current.roas !== null ? <> · platforms report {new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(a.current.roas)}× back</> : null}
          </Caption>
        </>
      );
    }
    case "adsense": {
      const a = m.adsense;
      if (!a || a.series.length < 2) return null;
      const values = a.series.map((d) => d.earnings);
      const top = values.indexOf(Math.max(...values));
      const today = a.series.findIndex((d) => d.day === ov.today);
      return (
        <>
          <MiniColumns values={values} emphasis={values[top]! > 0 ? top : null} faded={today >= 0 ? today : null} />
          <Caption>
            Ad earnings per day
            {a.current.pageRpm !== null ? <> · {fmtMoney(a.current.pageRpm, a.currency)} per 1,000 views</> : null}
          </Caption>
        </>
      );
    }
    case "shipping": {
      const f = m.fulfillment;
      if (!f || f.current.orders === 0) return null;
      const c = f.current;
      return (
        <>
          <MiniStack
            segments={[
              { label: "Shipped", value: c.fulfilled, color: "var(--fill-good)" },
              { label: "Partly shipped", value: c.partiallyFulfilled, color: "var(--fill-warn)" },
              { label: "Not shipped yet", value: c.unfulfilled, color: "var(--fill-danger)" },
            ]}
          />
          <Caption>Orders placed in these dates, by where they are now</Caption>
        </>
      );
    }
    case "stock": {
      const c = m.inventory?.current;
      if (!c || c.trackedVariants === 0) return null;
      return (
        <>
          <MiniStack
            segments={[
              { label: "Plenty", value: Math.max(0, c.trackedVariants - c.lowStock - c.outOfStock), color: "var(--fill-good)" },
              { label: "Running low", value: c.lowStock, color: "var(--fill-warn)" },
              { label: "Sold out", value: c.outOfStock, color: "var(--fill-danger)" },
            ]}
          />
          <Caption>Your {fmtNum(c.trackedVariants)} tracked variants, by how much stock is left</Caption>
          {/* What to do about it, not just how many. */}
          {m.inventory!.lowStockItems.length > 0 && (
            <ul className="mt-2 space-y-1 border-t border-border pt-2 text-xs">
              <li className="text-muted">Reorder first</li>
              {m.inventory!.lowStockItems.slice(0, 3).map((i, idx) => (
                <li key={`${i.productTitle}-${i.variantTitle}-${idx}`} className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate">
                    {i.productTitle}
                    {i.variantTitle && i.variantTitle !== "Default Title" ? <span className="text-muted"> · {i.variantTitle}</span> : null}
                  </span>
                  <span className={`shrink-0 font-medium tabular-nums ${i.quantity <= 0 ? "text-danger" : ""}`}>{i.quantity <= 0 ? "Sold out" : `${fmtNum(i.quantity)} left`}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    case "shoppers": {
      const f = m.funnel;
      if (!f || f.visits === 0) return null;
      return (
        <MiniBars
          rows={f.steps.map((st, i) => ({ label: STEP_SHORT[i] ?? st.step, value: st.reached, display: `${fmtNum(st.reached)} · ${fmtPct(st.shareOfVisits)}` }))}
        />
      );
    }
    case "products": {
      const items = m.top_products?.items ?? [];
      if (!items.length) return null;
      return <MiniBars rows={items.slice(0, 3).map((p, i) => ({ label: <>{i + 1}. {p.title}</>, value: p.revenue, display: whole(p.revenue) }))} />;
    }
    case "timing": {
      const t = m.order_timing;
      if (!t || !t.byWeekday.some((n) => n > 0)) return null;
      const busiest = t.byWeekday.indexOf(Math.max(...t.byWeekday));
      const labels = weekdayNames("short").map((d) => d.slice(0, 2));
      return (
        <>
          <MiniColumns values={t.byWeekday} emphasis={busiest} labels={labels} />
          <Caption>Orders by day of the week</Caption>
        </>
      );
    }
    case "channels": {
      const items = m.channels?.items ?? [];
      if (!items.length) return null;
      const colors = ["var(--viz-cat-1)", "var(--viz-cat-2)", "var(--viz-cat-3)"];
      const top = items.slice(0, 3);
      const rest = items.slice(3).reduce((a, c) => a + c.sales, 0);
      return (
        <MiniStack
          segments={[
            ...top.map((c, i) => ({ label: c.label, value: c.sales, color: colors[i]!, note: fmtPct(c.share) })),
            ...(rest > 0 ? [{ label: "Other", value: rest, color: "var(--border)", note: fmtPct(items.slice(3).reduce((a, c) => a + (c.share ?? 0), 0)) }] : []),
          ]}
        />
      );
    }
    case "discounts": {
      const items = m.discount_codes?.items ?? [];
      if (!items.length) return null;
      return <MiniBars rows={items.slice(0, 3).map((d) => ({ label: <span className="font-mono">{d.code}</span>, value: d.orders, display: `${fmtNum(d.orders)} order${d.orders === 1 ? "" : "s"}` }))} />;
    }
    case "customers": {
      const r = m.customers?.current.returningCustomerRate;
      if (r === undefined || r === null) return null;
      return (
        <>
          <MiniStack
            segments={[
              { label: "Returning", value: r, color: "var(--viz-cat-1)", note: fmtPct(r) },
              { label: "First order", value: 1 - r, color: "var(--viz-cat-3)", note: fmtPct(1 - r) },
            ]}
          />
          <Caption>Orders with a known customer, by whether they had bought before</Caption>
        </>
      );
    }
    case "orders": {
      const items = m.recent_orders?.items ?? [];
      if (!items.length) return null;
      return (
        <ul className="space-y-1 text-xs">
          {items.slice(0, 3).map((o) => (
            <li key={o.id} className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate">
                <span className="font-medium">{o.name}</span>
                <span className="text-muted"> · {fmtRelative(o.createdAt) ?? ""}{o.cancelled ? " · cancelled" : ""}</span>
              </span>
              <span className="shrink-0 font-medium tabular-nums">{fmtMoneyWhole(o.total, currency)}</span>
            </li>
          ))}
        </ul>
      );
    }
  }
}
