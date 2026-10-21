"use client";
import type { ReactNode } from "react";
import { trendHealth, refundHealth, stockHealth, shippingHealth, worstHealth, type Health } from "@app/shared/health";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { fmtDay, fmtMonth, fmtRange, fmtRelative, hourRange, plural } from "./format";
import { STEP_LABEL } from "./Funnel";
import { AreaPreview } from "./Previews";
import { Icon } from "./Icons";
import { Panel, Stat, type Tone } from "./Primitives";
import { topicInfo, topicSummary, type Topic } from "./topics";
import type { Overview } from "./types";

// ---------------------------------------------------------------------------
// The whole business at a glance: one health check per area, worked out from the numbers the
// page already has, each opening the area's own details.
// ---------------------------------------------------------------------------

export type { Health } from "@app/shared/health";

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
  good: { label: "Looks good", tone: "good", order: 2 },
  info: { label: "For your info", tone: "neutral", order: 3 },
};


const changeWords = (d: number | null) => (d === null ? "" : d === 0 ? ", level with the period before" : `, ${d > 0 ? "up" : "down"} ${fmtPct(Math.abs(d))} on the period before`);

export function businessHealth(ov: Overview, currency: string): Check[] {
  const m = ov.modules;
  const money = (n: number) => fmtMoney(n, currency);
  const running = ov.range.from === ov.range.to && ov.range.to === ov.today;
  const still = running ? " Today isn't over yet, so it isn't graded." : "";
  const out: Check[] = [];

  const s = m.sales_overview;
  if (s) {
    const c = s.current;
    out.push({ id: "net", topic: "sales", area: "Sales", health: trendHealth(s.deltas.netSales, running), text: `${money(c.netSales)} in net sales${changeWords(s.deltas.netSales)}.${still}` });
    out.push({ id: "orders", topic: "sales", area: "Orders", health: trendHealth(s.deltas.orders, running), text: `${plural(c.orders, "order")}${changeWords(s.deltas.orders)}.${still}` });
    if (c.averageOrderValue !== null) {
      out.push({ id: "aov", topic: "sales", area: "Average order", health: trendHealth(s.deltas.averageOrderValue, running), text: `${money(c.averageOrderValue)} per order${changeWords(s.deltas.averageOrderValue)}.` });
    }
  }
  const r = m.refunds?.current;
  if (r && r.refundRate !== null) {
    const health: Health = refundHealth(r.refundRate);
    out.push({ id: "refunds", topic: "sales", area: "Refunds", health, text: `${fmtPct(r.refundRate)} of sales refunded (${money(r.refunds)} on ${plural(r.refundedOrders, "order")}).` });
  }
  const f = m.funnel;
  if (f && f.visits > 0) {
    out.push({ id: "conversion", topic: "shoppers", area: "Visitors who bought", health: trendHealth(f.deltas.conversionRate, running), text: `${fmtPct(f.conversionRate)} of ${plural(f.visits, "visit")} ended in a purchase${changeWords(f.deltas.conversionRate)}.` });
  }
  const cu = m.customers;
  if (cu && cu.current.returningCustomerRate !== null) {
    const now = cu.current.returningCustomerRate;
    const before = cu.previous.returningCustomerRate;
    const d = before !== null && before > 0 ? (now - before) / before : null;
    out.push({ id: "returning", topic: "customers", area: "Returning customers", health: trendHealth(d, running), text: `${fmtPct(now)} of orders came from returning customers${before !== null ? ` (${fmtPct(before)} before)` : ""}.` });
  }
  const inv = m.inventory?.current;
  if (inv && inv.trackedVariants > 0) {
    const health: Health = stockHealth(inv.outOfStock, inv.lowStock);
    const text = inv.outOfStock + inv.lowStock === 0 ? "Nothing is running low." : `${fmtNum(inv.outOfStock)} sold out and ${fmtNum(inv.lowStock)} running low.`;
    out.push({ id: "stock", topic: "stock", area: "Stock", health, text });
  }
  const ful = m.fulfillment;
  if (ful) {
    const health: Health = shippingHealth(ful.openNow, ful.oldestOpenDays);
    const text = ful.openNow === 0 ? "Every order has shipped." : `${plural(ful.openNow, "order")} waiting to ship${ful.oldestOpenDays !== null ? `, the oldest for ${plural(ful.oldestOpenDays, "day")}` : ""}.`;
    out.push({ id: "shipping", topic: "shipping", area: "Shipping", health, text });
  }
  const ads = m.ads;
  if (ads && ads.current.spend > 0) {
    const back = ads.current.roas !== null ? `; the platforms count ${fmtMoney(ads.current.conversionValue, ads.currency)} in sales from them (${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(ads.current.roas)}×)` : "";
    out.push({ id: "ads", topic: "ads", area: "Ads", health: "info", text: `${fmtMoney(ads.current.spend, ads.currency)} spent on ads for ${plural(ads.current.clicks, "click")}${back}.` });
  }
  const adsense = m.adsense;
  if (adsense && adsense.current.pageViews > 0) {
    const rpm = adsense.current.pageRpm !== null ? `, ${fmtMoney(adsense.current.pageRpm, adsense.currency)} per 1,000 views` : "";
    out.push({ id: "adsense", topic: "adsense", area: "Ad earnings", health: "info", text: `${fmtMoney(adsense.current.earnings, adsense.currency)} earned from AdSense ads on your site${rpm}.` });
  }
  const top = m.top_products?.items[0];
  if (top) out.push({ id: "best", topic: "products", area: "Best seller", health: "info", text: `${top.title}: ${money(top.revenue)} from ${plural(top.units, "unit")}.` });
  const ch = m.channels?.items[0];
  if (ch && ch.share !== null) out.push({ id: "channel", topic: "channels", area: "Top channel", health: "info", text: `${ch.label} brings in ${fmtPct(ch.share)} of sales.` });
  const t = m.order_timing;
  if (t?.busiestDay && t.busiestHour !== null) out.push({ id: "timing", topic: "timing", area: "Busiest time", health: "info", text: `${t.busiestDay}s, especially ${hourRange(t.busiestHour)}.` });

  return out.sort((a, b) => HEALTH[a.health].order - HEALTH[b.health].order);
}

function HealthBadge({ health }: { health: Health }) {
  const h = HEALTH[health];
  const dot = { good: "bg-good", warn: "bg-warn", danger: "bg-danger", neutral: "bg-muted" }[h.tone];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-xs">
      <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${dot}`} />
      {h.label}
    </span>
  );
}

function countsOf(checks: Check[]) {
  const n = (h: Health) => checks.filter((c) => c.health === h).length;
  return { attention: n("attention"), watch: n("watch"), good: n("good"), graded: checks.filter((c) => c.health !== "info").length };
}

const B = ({ children }: { children: ReactNode }) => <strong className="font-semibold">{children}</strong>;


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
    const health = worstHealth(own.map((c) => c.health));
    let text = own.find((c) => c.health === health)?.text ?? own[0]?.text ?? topicSummary(t, ov, currency);
    if (t === "sales") text = own.find((c) => c.id === "net")?.text ?? text;
    if (t === "shoppers" && m.funnel && m.funnel.visits > 0) {
      const f = m.funnel;
      const leak = f.steps.length > 1 ? f.steps.slice(0, -1).reduce((a, b) => (b.left > a.left ? b : a)) : null;
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
  return (
    <p className="text-sm leading-relaxed">
      From {fmtDay(ov.range.from, { year: false })} to {fmtDay(ov.range.to, { year: false })} you made <B>{fmtMoney(s.current.netSales, currency)}</B> from{" "}
      <B>{plural(s.current.orders, "order")}</B>
      {changeWords(s.deltas.netSales)}.{" "}
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
function AreaCard({
  topic,
  title,
  icon,
  health,
  text,
  preview,
  wide,
  onOpen,
}: {
  topic: Topic;
  title: string;
  icon: ReactNode;
  health?: Health;
  text: string;
  preview: ReactNode;
  wide?: boolean;
  onOpen: () => void;
}) {
  return (
    <li className={`card lift group animate-rise relative flex flex-col gap-3 p-4 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${wide ? "sm:col-span-2" : ""}`}>
      <div className="flex items-start gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-medium">
              <button onClick={onOpen} className="text-left outline-none after:absolute after:inset-0 after:rounded-xl after:content-['']" data-testid={`area-${topic}`}>
                {title}
                <span className="sr-only"> – open details</span>
              </button>
            </h3>
            {health && health !== "info" && <HealthBadge health={health} />}
          </div>
          <p className="mt-0.5 text-sm text-muted">{text}</p>
        </div>
      </div>
      {preview && <div aria-hidden>{preview}</div>}
      <p className="mt-auto flex items-center gap-1 text-xs font-medium text-accent">
        See details
        <Icon name="chevronRight" className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </p>
    </li>
  );
}

/** Every part of the store, each with a small picture of it: the full overview first, then each area, worst first. */
export function AreaList({ ov, currency, topics, onOpen }: { ov: Overview; currency: string; topics: Topic[]; onOpen: (t: Topic) => void }) {
  const rows = areaRows(ov, currency, topics);
  const counts = countsOf(businessHealth(ov, currency));
  return (
    <section aria-labelledby="areas-h">
      <h2 id="areas-h" className="mb-1 flex items-center gap-2 font-semibold">
        <Icon name="store" className="h-5 w-5 text-accent" />
        Your store, area by area
      </h2>
      <p className="mb-3 text-xs text-muted">What needs attention comes first. Tap any card to see every detail, explained.</p>
      <ul className="grid gap-3 sm:grid-cols-2">
        <AreaCard
          topic="overview"
          title="Business overview"
          wide
          icon={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-accent-2 text-white">
              <Icon name="sparkle" className="h-5 w-5" />
            </span>
          }
          text="Everything on one page: how each area is doing, every key figure and this year so far. You can print it."
          preview={counts.graded > 0 ? <AreaPreview topic="overview" ov={ov} currency={currency} health={{ attention: counts.attention, watch: counts.watch, good: counts.good, info: 0 }} /> : null}
          onOpen={() => onOpen("overview")}
        />
        {rows.map((r) => (
          <AreaCard
            key={r.topic}
            topic={r.topic}
            title={topicInfo(r.topic).title}
            health={r.health}
            icon={
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/12 text-accent">
                <Icon name={topicInfo(r.topic).icon} className="h-5 w-5" />
              </span>
            }
            text={r.text}
            preview={<AreaPreview topic={r.topic} ov={ov} currency={currency} />}
            onOpen={() => onOpen(r.topic)}
          />
        ))}
      </ul>
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

function Change({ value, invert = false }: { value: number | null | undefined; invert?: boolean }) {
  if (value === null || value === undefined) return <span className="text-muted">—</span>;
  const good = invert ? value < 0 : value > 0;
  return <span className={value === 0 ? "text-muted" : good ? "text-good" : "text-danger"}>{value > 0 ? "▲" : value < 0 ? "▼" : "■"} {fmtPct(Math.abs(value))}</span>;
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
  const before = fmtRange(ov.previous.from, ov.previous.to);
  const refunds = s ? Math.round((s.current.grossSales - s.current.discounts - s.current.netSales) * 100) / 100 : 0;
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
              From {range} you made <B>{money(s.current.netSales)}</B> from <B>{plural(s.current.orders, "order")}</B>
              {s.current.averageOrderValue !== null ? <>, about {money(s.current.averageOrderValue)} each</> : null}
              {changeWords(s.deltas.netSales)}.
            </p>
          )}
          {f && f.visits > 0 && (
            <p>
              <B>{plural(f.visits, "visit")}</B> to your store, and <B>{fmtPct(f.conversionRate)}</B> of them bought.
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
        <Panel id="d-key-figures" title="Every key figure" help={`${range}, against ${before} (the same number of days just before).`}>
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
                <Row label="Net sales" now={money(s.current.netSales)} before={money(s.previous.netSales)} change={<Change value={s.deltas.netSales} />} />
                <Row label="Gross sales" now={money(s.current.grossSales)} before={money(s.previous.grossSales)} change={<Change value={s.deltas.grossSales} />} />
                <Row label="Discounts" now={money(s.current.discounts)} />
                <Row label="Refunds" now={money(refunds)} change={m.refunds ? <Change value={m.refunds.deltas.refunds} invert /> : undefined} />
                <Row label="Orders" now={fmtNum(s.current.orders)} before={fmtNum(s.previous.orders)} change={<Change value={s.deltas.orders} />} />
                <Row label="Average order" now={s.current.averageOrderValue !== null ? money(s.current.averageOrderValue) : "—"} before={s.previous.averageOrderValue !== null ? money(s.previous.averageOrderValue) : null} change={<Change value={s.deltas.averageOrderValue} />} />
                <Row label="Items sold" now={fmtNum(s.current.units)} />
                <Row label="Tax collected" now={money(s.current.tax)} />
                <Row label="Shipping charged" now={money(s.current.shipping)} />
                {f && <Row label="Store visits" now={fmtNum(f.visits)} before={fmtNum(f.previous.visits)} change={<Change value={f.deltas.visits} />} />}
                {f && <Row label="Visitors who bought" now={fmtPct(f.conversionRate)} before={f.previous.conversionRate !== null ? fmtPct(f.previous.conversionRate) : null} change={<Change value={f.deltas.conversionRate} />} />}
                {m.ads && <Row label={`Ad spend (${m.ads.currency})`} now={fmtMoney(m.ads.current.spend, m.ads.currency)} before={fmtMoney(m.ads.previous.spend, m.ads.currency)} change={<Change value={m.ads.deltas.spend} invert />} />}
                {m.ads && <Row label="Return on ad spend" now={m.ads.current.roas !== null ? `${m.ads.current.roas.toFixed(2)}×` : "—"} before={m.ads.previous.roas !== null ? `${m.ads.previous.roas.toFixed(2)}×` : null} change={<Change value={m.ads.deltas.roas} />} />}
                {m.adsense && <Row label={`AdSense earnings (${m.adsense.currency})`} now={fmtMoney(m.adsense.current.earnings, m.adsense.currency)} before={fmtMoney(m.adsense.previous.earnings, m.adsense.currency)} change={<Change value={m.adsense.deltas.earnings} />} />}
                {m.customers && m.customers.current.returningCustomerRate !== null && <Row label="Returning customers" now={fmtPct(m.customers.current.returningCustomerRate)} before={m.customers.previous.returningCustomerRate !== null ? fmtPct(m.customers.previous.returningCustomerRate) : null} />}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">Refunds are booked on the day they were made. Tax and shipping are collected on top of your sales, so they aren&apos;t part of net sales.</p>
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

      <Panel id="d-store" title="Your store" help="What Insights holds for this store right now.">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
          {cat && <Fact label="Products" value={fmtNum(cat.products.total)} note={`${fmtNum(cat.products.active)} active · ${fmtNum(cat.products.draft)} draft · ${fmtNum(cat.products.archived)} archived`} />}
          {cat && <Fact label="Variants" value={fmtNum(cat.variants)} />}
          {inv && inv.trackedVariants > 0 && <Fact label="Units in stock" value={fmtNum(inv.unitsInStock)} note={`${money(inv.retailValue)} at today's prices`} />}
          {inv && inv.stockValueAtCost !== null && <Fact label="Stock value at cost" value={money(inv.stockValueAtCost)} />}
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
          <Fact label="Last synced with Shopify" value={fmtRelative(ov.store.lastSyncedAt) ?? "Not yet"} note="New orders arrive within a minute" />
        </dl>
      </Panel>
    </>
  );
}
