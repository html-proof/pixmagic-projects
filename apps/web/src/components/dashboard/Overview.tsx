"use client";
import type { ReactNode } from "react";
import { ArrowRight, HeartPulse } from "lucide-react";
import { gradeRefundRate, gradeShipping, gradeStock, gradeTrend, type Health } from "@app/shared/health";
import { biggestDropOff } from "@app/shared/journey";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { fmtDay, fmtMonth, fmtRange, fmtRelative, hourRange, plural } from "./format";
import { throughLabel } from "./AdsCommon";
import { shownFigures, upToWords } from "./adFigures";
import { comparisonHelp, noEarlierData } from "./DateRange";
import { STEP_LABEL } from "./Funnel";
import { AreaPreview } from "./Previews";
import { Icon } from "./Icons";
import { B, Change, changeWords, comparedOn } from "./Narrative";
import { Panel, Stat, type Tone } from "./Primitives";
import { topicInfo, topicSummary, type Topic } from "./topics";
import { breakdownOf } from "./redacted";
import type { AdFigures, Overview } from "./types";

// ---------------------------------------------------------------------------
// The whole business at a glance: one health check per area, worked out from the numbers the
// page already has, each opening the area's own details.
// ---------------------------------------------------------------------------

export interface Check {
  id: string;
  topic: Topic;
  area: string;
  health: Health;
  text: string;
}

const HEALTH: Record<Health, { label: string; tone: Tone; order: number }> = {
  attention: { label: "Needs attention", tone: "danger", order: 0 },
  watch: { label: "Keep an eye on", tone: "warn", order: 1 },
  good: { label: "Looking good", tone: "good", order: 2 },
  info: { label: "For your info", tone: "neutral", order: 3 },
};

// The grading rules (trends, refunds, stock, shipping) live in @app/shared/health and are listed in
// docs/kpis.md. While the only day picked is today, it isn't over, so trends aren't graded.

/** How this page says a change of exactly 0 on `on` (the ads panels say ", the same as …"). */
const level = (on: string) => `, level with ${on}`;

/**
 * A change in sales to end a sentence: ", up 12% on the period before", or, when the imported
 * orders don't reach back to the dates compared with, that there is nothing to compare with.
 */
const salesChange = (ov: Overview, d: number | null) =>
  d === null && ov.previous.imported === false ? ", with no earlier data to compare" : changeWords(d, level(comparedOn(ov)), comparedOn(ov));

export function businessHealth(ov: Overview, currency: string): Check[] {
  const m = ov.modules;
  const money = (n: number) => fmtMoney(n, currency);
  const running = ov.range.from === ov.range.to && ov.range.to === ov.today;
  const still = running ? " Today isn't over yet, so it isn't graded." : "";
  const on = comparedOn(ov);
  const out: Check[] = [];

  const s = m.sales_overview;
  if (s) {
    const c = s.current;
    out.push({ id: "net", topic: "sales", area: "Sales", health: gradeTrend(s.deltas.netSales, running), text: `${money(c.netSales)} in net sales${salesChange(ov, s.deltas.netSales)}.${still}` });
    out.push({ id: "orders", topic: "sales", area: "Orders", health: gradeTrend(s.deltas.orders, running), text: `${plural(c.orders, "order")}${salesChange(ov, s.deltas.orders)}.${still}` });
    if (c.averageOrderValue !== null) {
      out.push({ id: "aov", topic: "sales", area: "Average order", health: gradeTrend(s.deltas.averageOrderValue, running), text: `${money(c.averageOrderValue)} per order${salesChange(ov, s.deltas.averageOrderValue)}.` });
    }
  }
  const r = m.refunds?.current;
  if (r && r.refundRate !== null) {
    const health: Health = gradeRefundRate(r.refundRate);
    out.push({ id: "refunds", topic: "sales", area: "Returns", health, text: `${fmtPct(r.refundRate)} of sales taken back by refunds and cancellations (${money(r.refunds)} on ${plural(r.refundedOrders, "order")}).` });
  }
  const f = m.funnel;
  if (f && f.visits > 0) {
    // Before the pixel counted visits there is nothing to compare with, as for sales.
    const change = f.previous.imported === false ? ", with no earlier data to compare" : changeWords(f.deltas.conversionRate, level(on), on);
    out.push({ id: "conversion", topic: "shoppers", area: "Tracked visits that bought", health: gradeTrend(f.deltas.conversionRate, running), text: `${fmtPct(f.conversionRate)} of ${plural(f.visits, "visit")} ended in a purchase${change}.` });
  }
  const cu = m.customers;
  if (cu && cu.current.returningCustomerRate !== null) {
    const now = cu.current.returningCustomerRate;
    const before = cu.previous.returningCustomerRate;
    const d = before !== null && before > 0 ? (now - before) / before : null;
    out.push({ id: "returning", topic: "customers", area: "Returning customers", health: gradeTrend(d, running), text: `${fmtPct(now)} of customers had bought before${before !== null ? ` (${fmtPct(before)} before)` : ""}.` });
  }
  const inv = m.inventory?.current;
  if (inv && inv.trackedVariants > 0) {
    const health: Health = gradeStock(inv.outOfStock, inv.lowStock);
    const text = inv.outOfStock + inv.lowStock === 0 ? "Nothing is running low." : `${fmtNum(inv.outOfStock)} sold out and ${fmtNum(inv.lowStock)} running low.`;
    out.push({ id: "stock", topic: "stock", area: "Stock", health, text });
  }
  const ful = m.fulfillment;
  if (ful) {
    const health: Health = gradeShipping(ful.openNow, ful.oldestOpenDays);
    const text = ful.openNow === 0 ? "Every order has shipped." : `${plural(ful.openNow, "order")} waiting to ship${ful.oldestOpenDays !== null ? `, the oldest for ${plural(ful.oldestOpenDays, "day")}` : ""}.`;
    out.push({ id: "shipping", topic: "shipping", area: "Shipping", health, text });
  }
  const ads = m.ads;
  // The whole range, or the days so far while only days not over yet are missing ("up to 18 Oct").
  const adsShown = ads ? shownFigures(ads) : null;
  const upTo = (through: string | null) => (through ? ` ${upToWords(through)}` : "");
  if (ads && !adsShown?.totals) {
    // Some account lacks days of the range: say so rather than give a short total.
    out.push({ id: "ads", topic: "ads", area: "Ads", health: "info", text: "Ad figures for these dates are unavailable: some ad accounts haven't been read for all of them yet." });
  } else if (ads && adsShown?.totals && adsShown.totals.spend > 0) {
    const c = adsShown.totals;
    const clicks = c.linkClicks === null ? "" : ` for ${plural(c.linkClicks, "link click")}`;
    const back =
      c.roas !== null && c.purchaseValue !== null
        ? `; the platforms credit ${fmtMoney(c.purchaseValue, ads.currency)} in purchases to them (${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(c.roas)}×)`
        : "";
    out.push({ id: "ads", topic: "ads", area: "Ads", health: "info", text: `${fmtMoney(c.spend, ads.currency)} spent on ads${upTo(adsShown.through)}${clicks}${back}.` });
  }
  const adsense = m.adsense;
  const senseShown = adsense ? shownFigures(adsense) : null;
  if (adsense && !senseShown?.totals) {
    out.push({ id: "adsense", topic: "adsense", area: "Ad earnings", health: "info", text: "AdSense figures for these dates are unavailable: the account hasn't been read for all of them yet." });
  } else if (adsense && senseShown?.totals && senseShown.totals.pageViews > 0) {
    const c = senseShown.totals;
    const rpm = c.pageRpm !== null ? `, ${fmtMoney(c.pageRpm, adsense.currency)} per 1,000 page views` : "";
    out.push({ id: "adsense", topic: "adsense", area: "Ad earnings", health: "info", text: `${fmtMoney(c.earnings, adsense.currency)} estimated earnings from AdSense ads on your site${upTo(senseShown.through)}${rpm}.` });
  }
  const top = m.top_products?.items[0];
  if (top) out.push({ id: "best", topic: "products", area: "Best seller", health: "info", text: `${top.title}: ${money(top.revenue)} from ${plural(top.units, "unit")}.` });
  const ch = m.channels?.items[0];
  if (ch && ch.share !== null) out.push({ id: "channel", topic: "channels", area: "Top channel", health: "info", text: `${ch.label} brings in ${fmtPct(ch.share)} of sales.` });
  const t = m.order_timing;
  if (t?.busiestDay && t.busiestHour !== null) out.push({ id: "timing", topic: "timing", area: "Busiest time", health: "info", text: `${t.busiestDay}s, especially ${hourRange(t.busiestHour)}.` });

  return out.sort((a, b) => HEALTH[a.health].order - HEALTH[b.health].order);
}

/** A status as a tinted pill: the label carries the meaning, the colour only reinforces it. */
const BADGE: Record<Tone, { pill: string; dot: string }> = {
  danger: { pill: "bg-danger/10 text-danger", dot: "bg-fill-danger" },
  warn: { pill: "bg-warn/12 text-warn", dot: "bg-fill-warn" },
  good: { pill: "bg-good/10 text-good", dot: "bg-fill-good" },
  neutral: { pill: "bg-text/[0.06] text-muted", dot: "bg-muted" },
};

function HealthBadge({ health }: { health: Health }) {
  const h = HEALTH[health];
  const b = BADGE[h.tone];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${b.pill}`}>
      <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${b.dot}`} />
      {h.label}
    </span>
  );
}

/** The round icon beside a card's title, tinted by how that area is doing. */
const TILE: Record<Health, string> = {
  attention: "bg-danger/10 text-danger",
  watch: "bg-warn/12 text-warn",
  good: "bg-accent/10 text-accent",
  info: "bg-accent/10 text-accent",
};

function countsOf(checks: Check[]) {
  const n = (h: Health) => checks.filter((c) => c.health === h).length;
  return { attention: n("attention"), watch: n("watch"), good: n("good"), graded: checks.filter((c) => c.health !== "info").length };
}

const worst = (hs: Health[]): Health => hs.reduce<Health>((a, h) => (HEALTH[h].order < HEALTH[a].order ? h : a), "info");

interface AreaRow {
  topic: Topic;
  health: Health;
  text: string;
}

/**
 * One row per part of the store for the main page, worst first: the same health check as the
 * overview, folded to one status and one sentence per area so nothing is said twice.
 */
export function areaRows(ov: Overview, currency: string, topics: Topic[]): AreaRow[] {
  const checks = businessHealth(ov, currency);
  const byTopic = (t: Topic) => checks.filter((c) => c.topic === t);
  const m = ov.modules;
  const rows = topics.map((t): AreaRow => {
    const own = byTopic(t);
    const health = worst(own.map((c) => c.health));
    let text = own.find((c) => c.health === health)?.text ?? own[0]?.text ?? topicSummary(t, ov, currency);
    if (t === "sales") text = own.find((c) => c.id === "net")?.text ?? text;
    if (t === "shoppers" && m.funnel && m.funnel.visits > 0) {
      const f = m.funnel;
      const leak = biggestDropOff(f.steps);
      text = `${fmtPct(f.conversionRate)} of ${plural(f.visits, "visit")} bought.${leak && leak.left > 0 ? ` Most who left stopped at “${STEP_LABEL[leak.step].toLowerCase()}” (${fmtNum(leak.left)}).` : ""}`;
    }
    return { topic: t, health, text };
  });
  // Stable: areas with the same status keep the page's usual order.
  return rows.map((r, i) => ({ r, i })).sort((a, b) => HEALTH[a.r.health].order - HEALTH[b.r.health].order || a.i - b.i).map((x) => x.r);
}

/** The answer first, in one or two sentences, above the numbers. */
export function StoreSummary({ ov, currency }: { ov: Overview; currency: string }) {
  const s = ov.modules.sales_overview;
  if (!s) return null;
  const attention = businessHealth(ov, currency).filter((c) => c.health === "attention").length;
  const when =
    ov.range.from !== ov.range.to
      ? `From ${fmtDay(ov.range.from, { year: false })} to ${fmtDay(ov.range.to, { year: false })}`
      : ov.range.to === ov.today
        ? "So far today"
        : `On ${fmtDay(ov.range.to, { year: false })}`;
  return (
    <p className="text-sm leading-relaxed">
      {when} you had <B>{fmtMoney(s.current.netSales, currency)}</B> in net sales from{" "}
      <B>{plural(s.current.orders, "order")}</B>
      {salesChange(ov, s.deltas.netSales)}.{" "}
      {attention > 0 ? (
        <>
          <B>{plural(attention, "thing needs", "things need")} your attention</B>; they&apos;re at the top of the list below.
        </>
      ) : (
        <>Nothing needs your attention right now.</>
      )}
    </p>
  );
}

/**
 * One card. The whole card opens the details (the title's button is stretched over it), so the
 * picture inside can be real markup rather than something squeezed into a <button>.
 */
function AreaCard({ topic, health, text, preview, onOpen }: { topic: Topic; health: Health; text: string; preview: ReactNode; onOpen: () => void }) {
  const info = topicInfo(topic);
  return (
    <li className="card lift group animate-rise relative flex flex-col gap-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent">
      <div className="flex items-start gap-4">
        <span aria-hidden className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${TILE[health]}`}>
          <Icon name={info.icon} className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h3 className="font-semibold">
              <button onClick={onOpen} className="text-left outline-none after:absolute after:inset-0 after:rounded-xl after:content-['']" data-testid={`area-${topic}`}>
                {info.title}
                <span className="sr-only"> – open details</span>
              </button>
            </h3>
            {health !== "info" && <HealthBadge health={health} />}
          </div>
          <p className="mt-1 text-sm text-muted">{text}</p>
        </div>
      </div>
      {preview && <div aria-hidden>{preview}</div>}
      <p aria-hidden className="mt-auto flex items-center gap-1 pt-1 text-sm font-semibold text-accent">
        View details
        <Icon name="chevronRight" className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </p>
    </li>
  );
}

/** Every part of the store, each with a small picture of it, worst first. */
export function AreaList({ ov, currency, topics, onOpen }: { ov: Overview; currency: string; topics: Topic[]; onOpen: (t: Topic) => void }) {
  const rows = areaRows(ov, currency, topics);
  if (!rows.length) return null;
  return (
    <section aria-labelledby="areas-h">
      <h2 id="areas-h" className="sr-only">Your store, area by area (what needs attention first)</h2>
      <ul className="grid gap-4 md:grid-cols-2">
        {rows.map((r) => (
          <AreaCard key={r.topic} topic={r.topic} health={r.health} text={r.text} preview={<AreaPreview topic={r.topic} ov={ov} currency={currency} />} onOpen={() => onOpen(r.topic)} />
        ))}
      </ul>
    </section>
  );
}

/**
 * Every graded check at once: one bar split by status, and the count of each. Opens the full
 * report (the overview panel), which lists every check worst first.
 */
/** `report`: whether the detailed report (the overview panel) is shared with this member ("View reports"). */
export function HealthOverview({ ov, currency, onOpen, report = true }: { ov: Overview; currency: string; onOpen: (t: Topic) => void; report?: boolean }) {
  const c = countsOf(businessHealth(ov, currency));
  const parts = [
    { label: HEALTH.attention.label, n: c.attention, fill: "bg-fill-danger" },
    { label: HEALTH.watch.label, n: c.watch, fill: "bg-fill-warn" },
    { label: HEALTH.good.label, n: c.good, fill: "bg-fill-good" },
  ];
  return (
    <section className="card animate-rise flex min-w-0 flex-col" aria-labelledby="health-h" data-testid="health-overview">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3.5">
          <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
            <HeartPulse className="h-5 w-5" strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <h2 id="health-h" className="font-semibold">Business health overview</h2>
            <p className="mt-0.5 text-sm text-muted">All key metrics at a glance.</p>
          </div>
        </div>
        {report && (
          <button type="button" onClick={() => onOpen("overview")} className="btn-secondary h-9 shrink-0 px-3 text-xs shadow-[var(--shadow)]" data-testid="area-overview">
            View detailed report
            <ArrowRight aria-hidden className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {c.graded > 0 ? (
        <>
          <div
            className="animate-grow-x mt-6 flex h-3 gap-1"
            role="img"
            aria-label={`${parts.map((p) => `${p.label}: ${fmtNum(p.n)}`).join(", ")}, of ${plural(c.graded, "graded check")}.`}
          >
            {parts
              .filter((p) => p.n > 0)
              .map((p) => (
                <span key={p.label} className={`h-full rounded-full ${p.fill}`} style={{ flexGrow: p.n, flexBasis: 0 }} />
              ))}
          </div>
          <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm" aria-hidden>
            {parts.map((p) => (
              <li key={p.label} className="inline-flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-[3px] ${p.fill}`} />
                <span className="text-text/80">{p.label}</span>
                <strong className="font-semibold tabular-nums">{fmtNum(p.n)}</strong>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-5 text-sm text-muted">Nothing to grade yet. Each area gets a status here once orders come in.</p>
      )}
    </section>
  );
}

function Row({ label, now, before, change }: { label: string; now: string; before?: string | null; change?: ReactNode }) {
  return (
    <tr className="border-t border-border">
      <td className="px-1 py-2 font-medium">{label}</td>
      <td className="px-1 py-2 text-right tabular-nums">{now}</td>
      <td className="px-1 py-2 text-right tabular-nums text-muted">{before ?? "—"}</td>
      <td className="px-1 py-2 text-right tabular-nums">{change ?? <span className="text-muted">—</span>}</td>
    </tr>
  );
}

function Fact({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
      {note && <dd className="text-xs text-muted">{note}</dd>}
    </div>
  );
}

/** The overview panel's contents. */
export function OverviewDetail({ ov, currency, onOpen }: { ov: Overview; currency: string; onOpen: (t: Topic) => void }) {
  const m = ov.modules;
  const money = (n: number) => fmtMoney(n, currency);
  const checks = businessHealth(ov, currency);
  const counts = countsOf(checks);
  const s = m.sales_overview;
  const f = m.funnel;
  const y = s?.year;
  const range = fmtRange(ov.range.from, ov.range.to);
  // Why the figures with a history of their own aren't compared, if they aren't (one sentence for
  // ads and AdSense when their figures start on the same day).
  const adsMissing = m.ads?.notCompared === "no_history" ? noEarlierData(m.ads.historyFrom, "ads") : null;
  const notCompared = [
    f?.previous.imported === false ? noEarlierData(f.historyFrom, "visits") : null,
    adsMissing,
    m.adsense?.notCompared === "no_history" && !(adsMissing && m.adsense.historyFrom === m.ads?.historyFrom) ? noEarlierData(m.adsense.historyFrom, "adsense") : null,
  ].filter(Boolean);
  // The ad rows show what their change compares: with today left out of both sides, the dates up to
  // yesterday. With nothing compared, the dates' figures, or the days so far, dated.
  const nowOf = <T,>(fig: AdFigures<T>): { totals: T | null; label: string | null } => {
    if (fig.compared) return { totals: fig.compared.current.totals, label: fig.compared.trimmed ? throughLabel(fig, ov) : null };
    const { totals, through } = shownFigures(fig);
    return { totals, label: through ? upToWords(through) : null };
  };
  const adsNowOf = m.ads ? nowOf(m.ads) : null;
  const adsNow = adsNowOf?.totals ?? null;
  const adsLabel = (what: string) => (adsNowOf?.label ? `${what}, ${adsNowOf.label}` : what);
  const senseNowOf = m.adsense ? nowOf(m.adsense) : null;
  const senseNow = senseNowOf?.totals ?? null;
  // Gross sales, discounts, tax, shipping and total sales, and returns, only for someone who may
  // see them (Team & Access).
  const bd = s ? breakdownOf(s.current) : null;
  const returns = s?.current.returns ?? null;
  const finishedMonths = y?.months.filter((x) => !x.current && x.coverage === "full") ?? [];
  const bestMonth = y?.months.filter((x) => x.coverage !== "none" && x.netSales > 0).reduce<(typeof y.months)[number] | null>((a, x) => (!a || x.netSales > a.netSales ? x : a), null);
  const thisMonth = y?.months.at(-1);
  const inv = m.inventory?.current;
  const cat = m.catalog;

  return (
    <>
      <div className="card flex items-start gap-3 border-accent/30 bg-accent/5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
          <Icon name="sparkle" className="h-4 w-4" />
        </span>
        <div className="min-w-0 space-y-1 text-sm leading-relaxed">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">In short</p>
          {s && (
            <p>
              From {range} you had <B>{money(s.current.netSales)}</B> in net sales from <B>{plural(s.current.orders, "order")}</B>
              {s.current.averageOrderValue !== null ? <>, about {money(s.current.averageOrderValue)} each</> : null}
              {salesChange(ov, s.deltas.netSales)}.
            </p>
          )}
          {f && f.visits > 0 && (
            <p>
              <B>{plural(f.visits, "tracked visit")}</B> to your store, and <B>{fmtPct(f.conversionRate)}</B> of them bought.
            </p>
          )}
          {counts.graded > 0 && (
            <p>
              <B>{fmtNum(counts.good)} of {fmtNum(counts.graded)}</B> areas look good
              {counts.watch ? <>, {fmtNum(counts.watch)} to keep an eye on</> : null}
              {counts.attention ? <> and <B>{plural(counts.attention, "needs", "need")} attention</B></> : null}. Tap any row below for its details.
            </p>
          )}
        </div>
      </div>

      <Panel id="d-health" title="How each part of your business is doing" help="Worst first. Tap a row to see everything behind it.">
        {checks.length === 0 ? (
          <p className="text-sm text-muted">Nothing to check yet. Numbers appear here once orders come in.</p>
        ) : (
          <ul className="-mx-2 divide-y divide-border">
            {checks.map((c) => (
              <li key={c.id}>
                <button onClick={() => onOpen(c.topic)} className="group flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left transition hover:bg-bg" data-testid={`health-${c.id}`}>
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
                    <Icon name={topicInfo(c.topic).icon} className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium">{c.area}</span>
                      <HealthBadge health={c.health} />
                    </span>
                    <span className="mt-0.5 block text-sm text-muted">{c.text}</span>
                  </span>
                  <Icon name="chevronRight" className="h-5 w-5 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {s && (
        <Panel
          id="d-key-figures"
          title="Every key figure"
          help={`${range}, against ${comparisonHelp(ov.previous)}.${ov.previous.imported === false ? ` ${noEarlierData(ov.data?.historyFrom)}` : ""}${
            ov.previous.until && (m.ads || m.adsense) ? " Ad platforms report whole days, so while these dates include today their figures compare whole days only, up to yesterday." : ""
          }${notCompared.map((x) => ` ${x}`).join("")}`}
        >
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full min-w-[26rem] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="px-1 pb-2 font-normal" />
                  <th className="px-1 pb-2 text-right font-normal">These dates</th>
                  <th className="px-1 pb-2 text-right font-normal">Before</th>
                  <th className="px-1 pb-2 text-right font-normal">Change</th>
                </tr>
              </thead>
              <tbody>
                {/* Shopify's "Total sales breakdown", line for line and in its order. */}
                {bd && <Row label="Gross sales" now={money(bd.grossSales)} before={s.previous?.grossSales !== undefined ? money(s.previous.grossSales) : null} change={<Change value={s.deltas.grossSales ?? null} />} />}
                {bd && <Row label="Discounts" now={money(-bd.discounts)} />}
                {returns !== null && <Row label="Returns" now={money(-returns)} change={m.refunds ? <Change value={m.refunds.deltas.refunds} invert /> : undefined} />}
                <Row label="Net sales" now={money(s.current.netSales)} before={s.previous ? money(s.previous.netSales) : null} change={<Change value={s.deltas.netSales} />} />
                {bd?.shipping != null && <Row label="Shipping charges" now={money(bd.shipping)} />}
                {bd?.tax != null && <Row label="Taxes" now={money(bd.tax)} />}
                {s.current.totalSales !== undefined && (
                  <Row
                    label="Total sales"
                    now={money(s.current.totalSales)}
                    before={s.previous?.totalSales !== undefined ? money(s.previous.totalSales) : null}
                    change={<Change value={s.deltas.totalSales ?? null} />}
                  />
                )}
                <Row label="Orders" now={fmtNum(s.current.orders)} before={s.previous ? fmtNum(s.previous.orders) : null} change={<Change value={s.deltas.orders} />} />
                <Row label="Average order" now={s.current.averageOrderValue !== null ? money(s.current.averageOrderValue) : "—"} before={s.previous && s.previous.averageOrderValue !== null ? money(s.previous.averageOrderValue) : null} change={<Change value={s.deltas.averageOrderValue} />} />
                <Row label="Items sold" now={fmtNum(s.current.units)} />
                {m.shopify_sessions?.current && (
                  <Row label="Sessions (Shopify)" now={fmtNum(m.shopify_sessions.current.sessions ?? 0)} before={m.shopify_sessions.previous ? fmtNum(m.shopify_sessions.previous.sessions ?? 0) : null} change={<Change value={m.shopify_sessions.deltas.sessions} />} />
                )}
                {m.shopify_sessions?.current && (
                  <Row label="Conversion rate (Shopify)" now={fmtPct(m.shopify_sessions.current.conversionRate)} before={m.shopify_sessions.previous ? fmtPct(m.shopify_sessions.previous.conversionRate) : null} change={<Change value={m.shopify_sessions.deltas.conversionRate} />} />
                )}
                {m.profit?.current && m.profit.current.grossProfit !== null && (
                  <Row label="Gross profit (Shopify)" now={money(m.profit.current.grossProfit)} before={m.profit.previous?.grossProfit != null ? money(m.profit.previous.grossProfit) : null} change={<Change value={m.profit.deltas.grossProfit} />} />
                )}
                {f && <Row label="Tracked visits (pixel)" now={fmtNum(f.visits)} before={f.previous.visits !== null ? fmtNum(f.previous.visits) : null} change={<Change value={f.deltas.visits} />} />}
                {f && <Row label="Tracked visits that bought" now={fmtPct(f.conversionRate)} before={f.previous.conversionRate !== null ? fmtPct(f.previous.conversionRate) : null} change={<Change value={f.deltas.conversionRate} />} />}
                {m.ads && (
                  <Row
                    label={adsLabel(`Ad spend (${m.ads.currency})`)}
                    now={adsNow ? fmtMoney(adsNow.spend, m.ads.currency) : "Unavailable"}
                    before={m.ads.previous.spend !== null ? fmtMoney(m.ads.previous.spend, m.ads.currency) : null}
                    change={<Change value={m.ads.deltas.spend} invert />}
                  />
                )}
                {m.ads && (
                  <Row
                    label={adsLabel("Return on ad spend (platforms' own)")}
                    now={!adsNow ? "Unavailable" : adsNow.purchases === null ? "Being re-read" : adsNow.roas !== null ? `${adsNow.roas.toFixed(2)}×` : "—"}
                    before={m.ads.previous.roas !== null ? `${m.ads.previous.roas.toFixed(2)}×` : null}
                    change={<Change value={m.ads.deltas.roas} />}
                  />
                )}
                {m.adsense && (
                  <Row
                    label={senseNowOf?.label ? `Estimated AdSense earnings (${m.adsense.currency}), ${senseNowOf.label}` : `Estimated AdSense earnings (${m.adsense.currency})`}
                    now={senseNow ? fmtMoney(senseNow.earnings, m.adsense.currency) : "Unavailable"}
                    before={m.adsense.previous.earnings !== null ? fmtMoney(m.adsense.previous.earnings, m.adsense.currency) : null}
                    change={<Change value={m.adsense.deltas.earnings} />}
                  />
                )}
                {m.customers && m.customers.current.returningCustomerRate !== null && <Row label="Returning customers" now={fmtPct(m.customers.current.returningCustomerRate)} before={m.customers.previous.returningCustomerRate !== null ? fmtPct(m.customers.previous.returningCustomerRate) : null} />}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">
            The sales figures are the same as Shopify&apos;s sales reports, worked out from Shopify&apos;s own sales records: a sale counts on the day the order was placed,
            and a refund, cancellation or edit on the day it was made. Net sales leave out shipping and taxes; total sales add them back. Test orders aren&apos;t counted.
            Tracked visits come from the bizinsights pixel (one shopper on one day, only those who allow tracking), so they aren&apos;t Shopify&apos;s sessions.
          </p>
        </Panel>
      )}

      {y && y.orders > 0 && (
        <Panel
          id="d-year"
          title={`${y.year} so far`}
          help={`1 January to ${fmtDay(ov.today, { year: false })}, whatever dates are picked above.`}
          aside={<button onClick={() => onOpen("sales")} className="text-xs text-muted underline">Month by month</button>}
        >
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Net sales this year" value={money(y.total)} note={plural(y.orders, "order")} />
            <Stat label="Best month" value={bestMonth ? money(bestMonth.netSales) : "—"} note={bestMonth ? fmtMonth(bestMonth.month) : undefined} />
            <Stat
              label="Average month"
              value={finishedMonths.length ? money(finishedMonths.reduce((a, x) => a + x.netSales, 0) / finishedMonths.length) : "—"}
              note={finishedMonths.length ? `over ${plural(finishedMonths.length, "full month")}` : "no full month yet"}
            />
            {thisMonth && (
              <Stat
                label={`${fmtMonth(thisMonth.month)} so far`}
                value={money(thisMonth.netSales)}
                note={thisMonth.change !== null && thisMonth.comparedWith ? <><Change value={thisMonth.change} /> vs the same days last month</> : "nothing comparable before it"}
              />
            )}
          </div>
        </Panel>
      )}

      <Panel id="d-store" title="Your store" help="What bizinsights holds for this store right now.">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
          {cat && <Fact label="Products" value={fmtNum(cat.products.total)} note={`${fmtNum(cat.products.active)} active · ${fmtNum(cat.products.draft)} draft · ${fmtNum(cat.products.archived)} archived`} />}
          {cat && <Fact label="Variants" value={fmtNum(cat.variants)} />}
          {inv && inv.trackedVariants > 0 && <Fact label="Units in stock" value={fmtNum(inv.unitsInStock)} note={inv.retailValue !== undefined ? `${money(inv.retailValue)} at today's prices` : undefined} />}
          {inv && inv.stockValueAtCost != null && <Fact label="Stock value at cost" value={money(inv.stockValueAtCost)} />}
          {ov.data && (
            <Fact
              label="Orders imported"
              value={fmtNum(ov.data.orders)}
              note={ov.data.oldestOrderDay ? `${fmtDay(ov.data.oldestOrderDay)} to ${fmtDay(ov.data.newestOrderDay)}` : "none yet"}
            />
          )}
          {m.channels && <Fact label="Sales channels used" value={fmtNum(m.channels.items.length)} note="In these dates" />}
          {m.discount_codes && <Fact label="Discount codes used" value={fmtNum(m.discount_codes.items.length)} note="In these dates (top 10)" />}
          <Fact label="Currency and time zone" value={ov.store.currency} note={ov.store.timezone} />
          <Fact label="Up to date with Shopify" value={fmtRelative(ov.freshness?.asOf ?? ov.store.lastSyncedAt) ?? "Not yet"} note="Checked about every 5 minutes while the dashboard is open, and again every night" />
        </dl>
      </Panel>
    </>
  );
}
