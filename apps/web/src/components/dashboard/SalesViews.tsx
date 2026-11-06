"use client";
import { useState, type ReactNode } from "react";
import { ArrowRight, ArrowUpRight, CalendarDays, Clock, Sigma, Sparkles, Tag } from "lucide-react";
import { TRAFFIC_SPLIT_LABEL } from "@app/shared/traffic";
import { Card as KitCard, ChangeTag, FigureTile, InShortLine, ShareRow } from "@/components/PageKit";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { collectionName, CollectionSales, useCollectionSales, type CollectionChoice } from "./CollectionSales";
import { ContactsCard } from "./Contacts";
import { MonthlyCohorts, RepeatCustomers, useCustomerAnalytics } from "./CustomerCohorts";
import { comparisonHelp, noEarlierData, versusWords, comparedWith } from "./DateRange";
import { fmtDateTime, fmtDuration, fmtLongDay, fmtRange, fmtSpan, hourRange, plural, weekdayName } from "./format";
import { CatalogCard, FulfillmentBadge, OrderName, PaymentBadge } from "./Modules";
import { comparedOn, upDown } from "./Narrative";
import { breakdownOf, salesLinesOf } from "./redacted";
import { SalesByDay } from "./SimpleHome";
import { TopProducts } from "./TopProducts";
import type { Topic } from "./topics";
import type { Overview, RecentOrder } from "./types";

// ---------------------------------------------------------------------------
// The Sales tabs' own layouts, as the owner's approved Stitch design draws them (prototype v2,
// screens 05–08): a sentence in short, the tab's few numbers, then its panels on white cards. Every
// figure is one the API already returns for these dates (GET …/overview), redacted for the member
// by the API (Team & Access): a part the answer leaves out isn't drawn, and nothing is ever shown
// as a zero for want of data. The older panels with more detail follow on the same page
// (./Details.tsx), so nothing the detail panels showed is lost.
// ---------------------------------------------------------------------------

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A Sales card (components/PageKit.tsx), its test id `sales-<id>`. */
const Card = (p: Parameters<typeof KitCard>[0]) => <KitCard testId={`sales-${p.id}`} {...p} />;

/** The design's opening line: the tab's answer in one sentence, and the dates it is for. */
export function ShortLine({ ov, icon, children }: { ov: Overview; icon?: ReactNode; children: ReactNode }) {
  return (
    <InShortLine icon={icon} period={fmtSpan(ov.range.from, ov.range.to, { year: true })} testId="sales-in-short">
      {children}
    </InShortLine>
  );
}

const Change = ChangeTag;

/** One of a tab's numbers (components/PageKit.tsx), its test id `sales-figure-<title>`. */
const Figure = (p: Parameters<typeof FigureTile>[0]) => <FigureTile testId={`sales-figure-${p.title}`} {...p} />;

const SignChip = ({ children }: { children: ReactNode }) => (
  <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-full bg-home-soft text-sm font-semibold text-muted">
    {children}
  </span>
);

/**
 * "How your sales add up": gross sales less discounts and returns is net sales; with shipping,
 * taxes, duties and fees it is total sales, as Shopify's total sales breakdown adds it. Only for a
 * member who may see every line; duties and fees only where there were some.
 */
function SalesAddUp({ ov, currency }: { ov: Overview; currency: string }) {
  const c = ov.modules.sales_overview!.current;
  const bd = breakdownOf(c);
  const lines = salesLinesOf(c);
  if (!bd || !lines) return null;
  const returns = c.returns ?? r2(bd.grossSales - bd.discounts - c.netSales);
  const money = (n: number) => fmtMoney(n, currency);
  type Step = { key: string; label: string; amount: number; sign: "−" | "+" | "=" | null; tone?: "minus" | "total" | "sub" };
  const steps: Step[] = [
    { key: "gross", label: "Gross sales", amount: bd.grossSales, sign: null },
    { key: "discounts", label: "Discounts", amount: bd.discounts, sign: "−", tone: "minus" },
    { key: "returns", label: "Returns", amount: returns, sign: "−", tone: "minus" },
    { key: "net", label: "Net sales", amount: c.netSales, sign: "=", tone: "sub" },
    { key: "shipping", label: "Shipping", amount: lines.shipping, sign: "+" },
    ...(lines.duties ? [{ key: "duties", label: "Duties", amount: lines.duties, sign: "+" as const }] : []),
    ...(lines.additionalFees ? [{ key: "fees", label: "Additional fees", amount: lines.additionalFees, sign: "+" as const }] : []),
    { key: "taxes", label: "Taxes", amount: lines.taxes, sign: "+" },
    { key: "total", label: "Total sales", amount: lines.totalSales, sign: "=", tone: "total" },
  ];
  return (
    <Card id="adds-up" title="How your sales add up" aside="As Shopify adds them up · test orders aren't counted">
      <ol className="flex flex-wrap items-stretch gap-2" aria-label="Gross sales to total sales">
        {steps.map((s) => (
          <li key={s.key} className="flex items-stretch gap-2" data-testid={`adds-up-${s.key}`}>
            {s.sign && (
              <SignChip>
                <span>{s.sign}</span>
              </SignChip>
            )}
            <span className={`flex min-w-[6.5rem] flex-col justify-center rounded px-3 py-2.5 ${s.tone === "total" ? "bg-accent text-accent-ink" : s.tone === "sub" ? "bg-home-tag" : "bg-home-soft"}`}>
              <span className={`text-xs ${s.tone === "total" ? "text-accent-ink/90" : "text-muted"}`}>
                {s.sign === "−" && <span className="sr-only">minus </span>}
                {s.sign === "+" && <span className="sr-only">plus </span>}
                {s.sign === "=" && <span className="sr-only">equals </span>}
                {s.label}
              </span>
              <span className={`text-lg leading-6 font-semibold tabular-nums ${s.tone === "minus" && s.amount > 0 ? "text-danger" : ""}`}>{money(s.amount)}</span>
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** Under the chart: the best day, the weekday that sold most, and the average day. */
function DayFacts({ ov, currency }: { ov: Overview; currency: string }) {
  const series = ov.modules.sales_overview!.series;
  if (series.length < 2) return null;
  const valueOf = (d: (typeof series)[number]) => d.totalSales ?? d.netSales;
  const best = series.reduce((a, d) => (valueOf(d) > valueOf(a) ? d : a), series[0]!);
  const byWeekday = Array.from({ length: 7 }, () => 0);
  for (const d of series) byWeekday[(new Date(`${d.day}T00:00:00Z`).getUTCDay() + 6) % 7]! += valueOf(d);
  const topWeekday = byWeekday.indexOf(Math.max(...byWeekday));
  const sum = series.reduce((a, d) => a + valueOf(d), 0);
  if (sum <= 0) return null;
  const money = (n: number) => fmtMoney(n, currency);
  return (
    <ul className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded bg-home-soft px-4 py-2.5 text-xs sm:text-sm" data-testid="day-facts">
      <li className="flex items-center gap-1.5">
        <ArrowUpRight aria-hidden className="h-4 w-4 text-muted" />
        Best day: <span className="font-semibold">{fmtLongDay(best.day)} {money(valueOf(best))}</span>
      </li>
      <li className="flex items-center gap-1.5">
        <CalendarDays aria-hidden className="h-4 w-4 text-muted" />
        Best weekday: <span className="font-semibold">{weekdayName(topWeekday, "long")}</span>
      </li>
      <li className="flex items-center gap-1.5">
        <Sigma aria-hidden className="h-4 w-4 text-muted" />
        Average day: <span className="font-semibold">{money(r2(sum / series.length))}</span>
      </li>
    </ul>
  );
}

function ChannelsShare({ ov, currency, onOpen }: { ov: Overview; currency: string; onOpen: (t: Topic) => void }) {
  const items = ov.modules.channels?.items ?? [];
  const total = items.reduce((a, i) => a + i.sales, 0);
  const top = items[0]?.sales ?? 0;
  return (
    <Card id="channels-share" title="Sales by channel" aside="Net sales">
      {items.length === 0 ? (
        <p className="text-sm text-muted">No sales in these dates yet.</p>
      ) : (
        <>
          <ul className="space-y-3">
            {items.slice(0, 5).map((i) => (
              <ShareRow key={i.label} label={i.label} value={fmtMoney(i.sales, currency)} fraction={top > 0 ? i.sales / top : 0} />
            ))}
          </ul>
          <p className="mt-auto flex items-center justify-between gap-3 pt-4 text-sm">
            <span className="font-medium tabular-nums">{fmtMoney(total, currency)}</span>
            <button type="button" onClick={() => onOpen("channels")} className="text-[13px] font-medium text-accent hover:underline">
              More about channels
            </button>
          </p>
        </>
      )}
    </Card>
  );
}

/** Where buyers came from, in orders: paid ads, unpaid search and social, email, direct, not recorded (Shopify's record of each order's visit). */
function BuyersFrom({ ov }: { ov: Overview }) {
  const t = ov.modules.traffic!;
  const rows: Array<{ id: string; label: string; orders: number }> = t.split
    ? t.split.map((x) => ({ id: x.id, label: TRAFFIC_SPLIT_LABEL[x.id] ?? x.label, orders: x.orders }))
    : t.items.map((x) => ({ id: x.id, label: x.label, orders: x.orders }));
  const total = rows.reduce((a, r) => a + r.orders, 0);
  return (
    <Card id="buyers-from" title="Where buyers came from" aside="In orders">
      {t.pending > 0 && <p className="mb-3 text-xs text-muted">Reading where {plural(t.pending, "older order")} came from; {t.pending === 1 ? "it appears" : "they appear"} here within a few minutes.</p>}
      {rows.length === 0 ? (
        <p className="text-sm text-muted">No orders in these dates yet.</p>
      ) : (
        <>
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 rounded bg-home-soft px-3 py-2 text-sm">
                <span className="min-w-0 truncate">{r.label}</span>
                <span className="shrink-0 font-semibold tabular-nums">{fmtNum(r.orders)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-auto pt-4 text-xs text-muted">Total: {plural(total, "order")}. The last visit before each order, as Shopify recorded it.</p>
        </>
      )}
    </Card>
  );
}

function TopFive({ ov, currency, onOpen }: { ov: Overview; currency: string; onOpen: (t: Topic) => void }) {
  const tp = ov.modules.top_products!;
  const items = tp.items.slice(0, 5);
  return (
    <Card id="top-five" title="Top products by net sales" aside={tp.total > items.length ? `Showing top ${items.length} of ${fmtNum(tp.total)}` : undefined}>
      {items.length === 0 ? (
        <p className="text-sm text-muted">{tp.complete === false ? "Product rankings are waiting for complete sales data for these dates." : "No product sales in these dates yet."}</p>
      ) : (
        <>
          <table className="w-full text-sm">
            <thead className="bg-home-soft text-left text-[11px] font-semibold tracking-wider text-muted uppercase">
              <tr>
                <th scope="col" className="rounded-l px-3 py-2.5">Product</th>
                <th scope="col" className="hidden px-3 py-2.5 text-right sm:table-cell">Units</th>
                <th scope="col" className="rounded-r px-3 py-2.5 text-right">Net sales</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.key} className="border-b border-home-line last:border-0">
                  <td className="px-3 py-3">
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-home-soft text-xs font-medium text-muted tabular-nums">{p.rank}</span>
                      <span className="min-w-0 truncate">{p.title}</span>
                    </span>
                  </td>
                  <td className="hidden px-3 py-3 text-right tabular-nums sm:table-cell">{fmtNum(p.units)}</td>
                  <td className="px-3 py-3 text-right font-medium tabular-nums">{fmtMoney(p.revenue, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4 flex justify-center">
            <button type="button" onClick={() => onOpen("products")} className="home-btn text-accent" data-testid="see-all-products">
              See all products
              <ArrowRight aria-hidden className="h-4 w-4" />
            </button>
          </div>
        </>
      )}
    </Card>
  );
}

/** Orders by weekday and by hour (the API counts each on its own, so they are two strips, not a grid). */
function BusiestTimes({ ov, onOpen }: { ov: Overview; onOpen: (t: Topic) => void }) {
  const t = ov.modules.order_timing!;
  const total = t.byWeekday.reduce((a, b) => a + b, 0);
  const maxDay = Math.max(0, ...t.byWeekday);
  const maxHour = Math.max(0, ...t.byHour);
  const peak = t.busiestDay ? `Peak: ${t.busiestDay}s${t.busiestHour !== null ? `, ${hourRange(t.busiestHour)}` : ""}` : undefined;
  return (
    <Card id="busiest" title="Busiest times" aside={peak && <span className="font-medium text-accent">{peak}</span>}>
      {total === 0 ? (
        <p className="text-sm text-muted">Not enough orders in these dates to spot a pattern yet.</p>
      ) : (
        <>
          <ul className="space-y-1.5" aria-label="Orders by day of the week">
            {t.byWeekday.map((n, i) => (
              <li key={i} className="flex items-center gap-3 text-xs">
                <span className="w-9 shrink-0 text-muted">{weekdayName(i, "short")}</span>
                <span aria-hidden className="h-3.5 flex-1 overflow-hidden rounded-sm bg-home-soft">
                  <span className="block h-full rounded-sm bg-accent" style={{ width: `${maxDay ? (n / maxDay) * 100 : 0}%`, opacity: maxDay ? 0.35 + 0.65 * (n / maxDay) : 0 }} />
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums">{plural(n, "order")}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 mb-1.5 text-xs text-muted">By hour of the day ({ov.store.timezone})</p>
          <div aria-hidden className="grid grid-cols-24 gap-px" style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}>
            {t.byHour.map((n, h) => (
              <span key={h} title={`${hourRange(h)}: ${plural(n, "order")}`} className="h-6 rounded-[2px] bg-accent" style={{ opacity: maxHour ? 0.08 + 0.92 * (n / maxHour) : 0.08 }} />
            ))}
          </div>
          <div aria-hidden className="mt-1 flex justify-between text-[11px] text-muted tabular-nums">
            <span>12 am</span>
            <span>6 am</span>
            <span>12 pm</span>
            <span>6 pm</span>
            <span>11 pm</span>
          </div>
          <p className="sr-only">
            {t.byHour.map((n, h) => `${hourRange(h)}: ${plural(n, "order")}`).join("; ")}
          </p>
          <button type="button" onClick={() => onOpen("timing")} className="mt-auto self-start pt-4 text-[13px] font-medium text-accent hover:underline">
            More about busy times
          </button>
        </>
      )}
    </Card>
  );
}

function CodesUsed({ ov, currency, onOpen }: { ov: Overview; currency: string; onOpen: (t: Topic) => void }) {
  const items = ov.modules.discount_codes!.items;
  const c = ov.modules.sales_overview?.current;
  return (
    <Card id="codes" title="Discount codes">
      {items.length === 0 ? (
        <p className="text-sm text-muted">No discount codes were used in these dates.</p>
      ) : (
        <>
          <ul className="space-y-2">
            {items.slice(0, 3).map((d) => (
              <li key={d.code} className="flex items-center gap-3 rounded bg-home-soft px-3 py-3">
                <Tag aria-hidden className="h-4 w-4 shrink-0 text-accent" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-sm font-semibold">{d.code}</span>
                  <span className="text-xs text-muted">used {plural(d.orders, "time")}</span>
                </span>
                {d.discount !== undefined && <span className="shrink-0 text-sm font-semibold tabular-nums">{fmtMoney(d.discount, currency)} off</span>}
              </li>
            ))}
          </ul>
          <p className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4 text-xs">
            {c?.discounts !== undefined ? <span className="font-medium">{fmtMoney(c.discounts, currency)} total discount</span> : <span />}
            <button type="button" onClick={() => onOpen("discounts")} className="text-[13px] font-medium text-accent hover:underline">
              Every code
            </button>
          </p>
        </>
      )}
    </Card>
  );
}

// ---- The tabs -----------------------------------------------------------------------------------

/** Overview (screen 05): in short, four numbers, how sales add up, sales by day, channels, buyers, top products, busy times, codes. */
export function SalesOverviewTab({ ov, currency, onOpen }: { ov: Overview; currency: string; onOpen: (t: Topic) => void }) {
  const s = ov.modules.sales_overview!;
  const c = s.current;
  const money = (n: number) => fmtMoney(n, currency);
  const versus = versusWords(ov);
  const total = c.totalSales ?? null;
  const change = upDown(total !== null ? (s.deltas.totalSales ?? null) : s.deltas.netSales);
  const funnel = ov.modules.funnel && ov.modules.funnel.visits > 0 ? ov.modules.funnel : null;
  const m = ov.modules;
  return (
    <>
      <ShortLine ov={ov}>
        {total !== null ? "total sales" : "net sales"}
        {change ? ` ${change} to` : " of"} <strong className="font-semibold">{money(total ?? c.netSales)}</strong> from{" "}
        <strong className="font-semibold">{plural(c.orders, "order")}</strong>
        {c.units ? ` (${plural(c.units, "item")})` : ""}.
      </ShortLine>
      <section aria-label="Sales numbers" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {total !== null ? (
          <Figure title="Total sales" value={money(total)} change={<Change value={s.deltas.totalSales} versus={versus} />} />
        ) : (
          <Figure title="Net sales" value={money(c.netSales)} change={<Change value={s.deltas.netSales} versus={versus} />} />
        )}
        <Figure title="Orders" value={fmtNum(c.orders)} change={<Change value={s.deltas.orders} versus={versus} />} />
        <Figure title="Average order" value={c.averageOrderValue === null ? "—" : money(c.averageOrderValue)} change={<Change value={s.deltas.averageOrderValue} versus={versus} />} />
        {funnel ? (
          <Figure title="Visits that bought" value={fmtPct(funnel.conversionRate)} change={<Change value={funnel.previous.imported === false ? null : funnel.deltas.conversionRate} versus={versus} />} sub={`Of ${plural(funnel.visits, "tracked visit")}`} />
        ) : (
          <Figure title="Items sold" value={fmtNum(c.units)} change={<Change value={s.deltas.units} versus={versus} />} />
        )}
      </section>
      <SalesAddUp ov={ov} currency={currency} />
      {ov.hasData && s.series.length > 0 && (
        <div>
          <SalesByDay ov={ov} currency={currency} />
          <DayFacts ov={ov} currency={currency} />
        </div>
      )}
      {(m.channels || m.traffic) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {m.channels && <ChannelsShare ov={ov} currency={currency} onOpen={onOpen} />}
          {m.traffic && <BuyersFrom ov={ov} />}
        </div>
      )}
      {m.top_products && <TopFive ov={ov} currency={currency} onOpen={onOpen} />}
      {(m.order_timing || m.discount_codes) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {m.order_timing && <BusiestTimes ov={ov} onOpen={onOpen} />}
          {m.discount_codes && <CodesUsed ov={ov} currency={currency} onOpen={onOpen} />}
        </div>
      )}
    </>
  );
}

/** Products (screen 06): items sold, the top product, your shop; then every product, collections and the catalogue. */
export function ProductsTab({ ov, currency }: { ov: Overview; currency: string }) {
  const tp = ov.modules.top_products;
  const items = tp?.items ?? [];
  const c = ov.modules.sales_overview?.current;
  const s = ov.modules.sales_overview;
  const versus = versusWords(ov);
  const top = items[0];
  const share = top && c && c.netSales > 0 ? top.revenue / c.netSales : null;
  const topTotal = items.reduce((a, i) => a + i.revenue, 0);
  const catalog = ov.modules.catalog;
  // Top products narrowed to a collection, picked in Sales by collection or Top products' own list.
  const [collection, setCollection] = useState<CollectionChoice | null>(null);
  const collections = useCollectionSales(ov, !!tp);
  const choices = (collections.report?.items ?? []).map((x) => ({ id: x.collectionId, title: collectionName(x) }));
  const pick = (x: CollectionChoice) => {
    setCollection(x);
    document.getElementById("d-top-products")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <>
      <ShortLine ov={ov} icon={<Sparkles className="h-4 w-4" />}>
        {top ? (
          <>
            <strong className="font-semibold">{top.title}</strong> sold best: {fmtMoney(top.revenue, currency)} from {plural(top.units, "unit")}
            {share !== null ? `, ${fmtPct(share)} of net sales` : ""}.
            {items.length > 1 && c && c.netSales > 0 ? ` Your top ${items.length} made ${fmtPct(topTotal / c.netSales)} of sales.` : ""}
          </>
        ) : tp?.complete === false ? (
          "product rankings are waiting for complete sales data for these dates."
        ) : (
          "no product sales in these dates yet."
        )}
      </ShortLine>
      <section aria-label="Product numbers" className="grid gap-3 sm:grid-cols-3 sm:gap-4">
        {c && s && <Figure title="Items sold" value={fmtNum(c.units)} change={<Change value={s.deltas.units} versus={versus} />} sub={c.orders ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(c.units / c.orders)} per order` : undefined} />}
        {tp && <Figure title="Top product" value={<span className="text-lg sm:text-xl">{top ? top.title : "None yet"}</span>} sub={share !== null ? `${fmtPct(share)} of net sales` : top ? `${plural(top.units, "unit")} sold` : "No sales in these dates"} />}
        {catalog && (
          <Figure
            title="Products in your shop"
            value={fmtNum(catalog.products.active)}
            sub={`active · ${fmtNum(catalog.products.draft)} draft · ${fmtNum(catalog.products.archived)} archived`}
          />
        )}
      </section>
      {tp && (
        <div className="grid gap-4 xl:grid-cols-3">
          <div className="min-w-0 xl:col-span-2">
            <TopProducts ov={ov} currency={currency} collection={collection} collections={choices} onCollection={setCollection} />
          </div>
          <div className="min-w-0">
            <CollectionSales ov={ov} currency={currency} live={collections} onPick={pick} />
          </div>
        </div>
      )}
      {catalog && <CatalogCard m={catalog} currency={currency} />}
    </>
  );
}

/** Customers (screen 07): who ordered, new and returning, first purchase or bought before, repeat customers, monthly groups. */
export function CustomersTab({ ov, currency, contactsOn }: { ov: Overview; currency: string; contactsOn: boolean }) {
  const cu = ov.modules.customers;
  const [months, setMonths] = useState(12);
  const lifetime = useCustomerAnalytics(ov, !!cu, months);
  const rate = cu?.current.returningCustomerRate ?? null;
  const before = cu?.previous.returningCustomerRate ?? null;
  const missing = ov.previous.imported === false;
  return (
    <>
      {cu && (
        <>
          <ShortLine ov={ov}>
            {rate === null ? (
              "no orders with a known customer in these dates yet."
            ) : (
              <>
                <strong className="font-semibold">{fmtPct(rate)}</strong> of buyers had bought before
                {before !== null && !missing ? `, ${rate >= before ? "up" : "down"} from ${fmtPct(before)} for ${comparedOn(ov)}` : ""}.
              </>
            )}
          </ShortLine>
          <section aria-label="Customer numbers" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <Figure title="Customers who ordered" value={fmtNum(cu.current.customers)} sub="Each customer once, however many orders" />
            <Figure title="New" value={fmtNum(cu.current.newCustomers)} sub="Their first purchase ever" />
            <Figure title="Returning" value={fmtNum(cu.current.returningCustomers)} change={rate !== null ? <span className="text-xs font-medium text-good tabular-nums">({fmtPct(rate)})</span> : undefined} sub="Had bought from you before" />
            <Figure title="Returning before" value={missing ? "—" : fmtPct(before)} sub={missing ? noEarlierData(ov.data?.historyFrom) : comparisonHelp(ov.previous, ov.range)} />
          </section>
          {rate !== null && cu.current.customers > 0 && <FirstOrBefore customers={cu.current.customers} returning={cu.current.returningCustomers} />}
          {/* Each panel takes the page's width: both hold wide tables of their own. */}
          <RepeatCustomers currency={currency} live={lifetime} />
          <MonthlyCohorts currency={currency} live={lifetime} months={months} onMonths={setMonths} />
        </>
      )}
      {contactsOn && <ContactsCard key={ov.store.id} storeId={ov.store.id} storeName={ov.store.name ?? ov.store.shopDomain} shopDomain={ov.store.shopDomain} />}
    </>
  );
}

function FirstOrBefore({ customers, returning }: { customers: number; returning: number }) {
  const first = Math.max(0, customers - returning);
  const pct = (n: number) => fmtPct(customers ? n / customers : null);
  return (
    <Card
      id="first-or-before"
      title="First purchase or bought before"
      aside={
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-home-tag" />
            First purchase: <strong className="text-text">{fmtNum(first)}</strong> ({pct(first)})
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-accent" />
            Bought before: <strong className="text-text">{fmtNum(returning)}</strong> ({pct(returning)})
          </span>
        </span>
      }
    >
      <div role="img" aria-label={`${fmtNum(first)} customers made their first purchase, ${fmtNum(returning)} had bought before`} className="flex h-7 w-full gap-0.5 overflow-hidden rounded text-[11px] font-medium">
        {first > 0 && (
          <span className="flex items-center justify-center truncate bg-home-tag px-2" style={{ flex: `${first} 1 0%` }}>
            First purchase · {fmtNum(first)}
          </span>
        )}
        {returning > 0 && (
          <span className="flex items-center justify-center truncate bg-accent px-2 text-accent-ink" style={{ flex: `${returning} 1 0%` }}>
            Bought before · {fmtNum(returning)}
          </span>
        )}
      </div>
      <p className="mt-3 text-xs text-muted">Someone whose first order and a second one both fall in these dates counts as both new and returning, as Shopify counts them.</p>
    </Card>
  );
}

const outcomeRow = "flex items-center justify-between gap-3 rounded px-3 py-2 text-sm";

/** Orders & shipping (screen 08): in short, orders at a glance, shipping, recent orders, refunds. */
export function OrdersTab({ ov, currency }: { ov: Overview; currency: string }) {
  const f = ov.modules.fulfillment;
  const o = ov.modules.order_outcomes;
  const recent = ov.modules.recent_orders;
  const refunds = ov.modules.refunds;
  const shipped = f && f.current.orders > 0 ? f.current.fulfilled / f.current.orders : null;
  return (
    <>
      <ShortLine ov={ov} icon={<Clock className="h-4 w-4" />}>
        {f ? (
          f.openNow === 0 ? (
            "every order has shipped; nothing is waiting."
          ) : (
            <>
              <strong className="font-semibold">{plural(f.openNow, "order")}</strong> {f.openNow === 1 ? "is" : "are"} waiting to ship
              {f.oldestOpenDays !== null ? `; the oldest has waited ${plural(f.oldestOpenDays, "day")}` : ""}.
            </>
          )
        ) : recent?.items.length ? (
          <>
            the latest order is <strong className="font-semibold">{recent.items[0]!.name}</strong> for {fmtMoney(recent.items[0]!.total, currency)}.
          </>
        ) : (
          "no orders were placed in these dates."
        )}
      </ShortLine>
      {(o?.outcome || f) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {o?.outcome && (
            <Card id="glance" title="Orders at a glance">
              <ul className="space-y-1">
                <li className={`${outcomeRow} bg-home-soft`} data-testid="glance-completed">
                  <span>Completed</span>
                  <span className="font-semibold tabular-nums">{fmtNum(o.outcome.completed)}</span>
                </li>
                <li className={outcomeRow} data-testid="glance-awaiting">
                  <span>Awaiting payment</span>
                  <span className="font-semibold tabular-nums">{fmtNum(o.outcome.awaitingPayment)}</span>
                </li>
                <li className={`${outcomeRow} bg-home-soft`} data-testid="glance-unsuccessful">
                  <span>
                    Unsuccessful{" "}
                    <span className="text-xs text-muted">
                      ({[o.outcome.cancelled ? `${fmtNum(o.outcome.cancelled)} cancelled` : null, o.outcome.paymentFailed ? `${fmtNum(o.outcome.paymentFailed)} payment failed` : null, o.outcome.refunded ? `${fmtNum(o.outcome.refunded)} refunded` : null].filter(Boolean).join(", ") || "none"})
                    </span>
                  </span>
                  <span className="font-semibold tabular-nums">{fmtNum(o.outcome.unsuccessful)}</span>
                </li>
              </ul>
              <div className="mt-3 rounded bg-home-soft px-3 py-3">
                <p className="flex items-baseline justify-between gap-3">
                  <span className="font-semibold">Total</span>
                  <span className="text-2xl font-semibold text-accent tabular-nums" data-testid="glance-total">
                    = {plural(o.orders ?? o.outcome.completed + o.outcome.awaitingPayment + o.outcome.unsuccessful, "order")}
                  </span>
                </p>
                {o.checkouts !== undefined && (
                  <p className="mt-1 flex items-baseline justify-between gap-3 text-sm text-muted">
                    <span>Left at checkout</span>
                    <span className="tabular-nums">{o.checkouts ? fmtNum(o.checkouts.left) : "Not tracked"}</span>
                  </p>
                )}
              </div>
            </Card>
          )}
          {f && (
            <Card id="shipping" title="Shipping" aside={shipped !== null ? <span className="font-medium text-good">Shipped {fmtPct(shipped)}</span> : undefined}>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded bg-home-soft p-3">
                  <p className="text-xs text-muted">Waiting to ship</p>
                  <p className="mt-1 text-[28px] leading-8 font-semibold tabular-nums" data-testid="waiting-to-ship">{fmtNum(f.openNow)}</p>
                  <p className="mt-0.5 text-xs text-muted">{f.oldestOpenDays !== null && f.openNow > 0 ? `Oldest ${plural(f.oldestOpenDays, "day")}` : "From any date"}</p>
                </div>
                <div className="rounded bg-home-soft p-3">
                  <p className="text-xs text-muted">Average time to ship</p>
                  <p className="mt-1 text-[28px] leading-8 font-semibold">{fmtDuration(f.current.avgHoursToFulfill)}</p>
                  <p className="mt-0.5 text-xs text-muted">Orders placed in these dates</p>
                </div>
              </div>
              {shipped !== null && (
                <div className="mt-auto pt-5">
                  <div className="flex justify-between text-xs">
                    <span>Shipped</span>
                    <span className="font-medium text-good tabular-nums">{fmtPct(shipped)}</span>
                  </div>
                  <div aria-hidden className="mt-1.5 h-2 overflow-hidden rounded-full bg-home-soft">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${shipped * 100}%` }} />
                  </div>
                  <p className="mt-1.5 text-xs text-muted">
                    {fmtNum(f.current.fulfilled)} of {plural(f.current.orders, "order")} shipped
                    {f.current.partiallyFulfilled ? ` · ${fmtNum(f.current.partiallyFulfilled)} in part` : ""}
                  </p>
                </div>
              )}
            </Card>
          )}
        </div>
      )}
      {recent && <OrdersTable items={recent.items} currency={currency} timezone={ov.store.timezone} shopDomain={ov.store.shopDomain} cancelledInRange={recent.cancelledInRange} />}
      {refunds && (
        <Card id="refunds" title="Refunds" className="lg:max-w-md">
          <p className="text-[28px] leading-8 font-semibold tabular-nums">{fmtMoney(refunds.current.refunds, currency)}</p>
          <p className="mt-2 flex flex-wrap items-center gap-3 text-xs">
            {refunds.current.refundRate !== null && <span className="rounded bg-danger/10 px-2 py-1 font-medium text-danger">{fmtPct(refunds.current.refundRate)} of sales</span>}
            <span className="text-muted">{plural(refunds.current.refundedOrders, "order")} refunded, cancelled or edited down, on the day it happened</span>
          </p>
        </Card>
      )}
      <p className="text-xs text-muted">
        Shipping is done in Shopify: bizinsights reads it from there.
      </p>
    </>
  );
}

/** The latest orders as the design's table, each opening in Shopify. */
function OrdersTable({ items, currency, timezone, shopDomain, cancelledInRange }: { items: RecentOrder[]; currency: string; timezone: string; shopDomain: string; cancelledInRange?: number }) {
  const showPayment = items.some((o) => o.financialStatus !== undefined || o.cancelled !== undefined);
  const showShipping = items.some((o) => o.fulfillmentStatus !== undefined);
  const th = "px-3 py-2.5 text-[11px] font-semibold tracking-wider text-muted uppercase";
  return (
    <section aria-labelledby="recent-orders-h" className="home-card animate-rise min-w-0 overflow-hidden" data-testid="sales-recent-orders">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-5 pb-4 sm:px-6">
        <h2 id="recent-orders-h" className="home-h2">Recent orders</h2>
        <p className="text-xs text-muted">The 10 latest placed in these dates · times in {timezone}</p>
      </div>
      {cancelledInRange !== undefined && cancelledInRange > 0 && (
        <p className="px-5 pb-3 text-xs text-muted sm:px-6" data-testid="cancelled-in-range">
          {plural(cancelledInRange, "order")} {cancelledInRange === 1 ? "was" : "were"} cancelled in these dates, counted on the day of the cancellation.
        </p>
      )}
      {items.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted sm:px-6">No orders have been imported yet. They appear here as soon as they arrive from Shopify.</p>
      ) : (
        <>
          <ul className="divide-y divide-home-line border-t border-home-line sm:hidden">
            {items.map((o) => (
              <li key={o.id} className={`px-5 py-3 text-sm ${o.cancelled ? "text-muted" : ""}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">
                    <OrderName o={o} shopDomain={shopDomain} />
                  </span>
                  <span className="font-medium tabular-nums">{fmtMoney(o.total, currency)}</span>
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  {fmtDateTime(o.createdAt, timezone)} · {o.channel} · {plural(o.units, "item")}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <PaymentBadge o={o} />
                  <FulfillmentBadge o={o} />
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[44rem] text-sm">
              <thead className="bg-home-soft text-left">
                <tr>
                  <th scope="col" className={th}>Order</th>
                  <th scope="col" className={th}>Placed</th>
                  <th scope="col" className={th}>Channel</th>
                  <th scope="col" className={`${th} text-right`}>Items</th>
                  {showPayment && <th scope="col" className={th}>Payment</th>}
                  {showShipping && <th scope="col" className={th}>Shipping</th>}
                  <th scope="col" className={`${th} text-right`}>Total</th>
                  <th scope="col" className={`${th} text-right`}>
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={o.id} className={`border-b border-home-line last:border-0 ${o.cancelled ? "text-muted" : ""}`}>
                    <td className="px-3 py-3 font-semibold">{o.cancelled ? <span className="line-through">{o.name}</span> : o.name}</td>
                    <td className="px-3 py-3 whitespace-nowrap">{fmtDateTime(o.createdAt, timezone)}</td>
                    <td className="px-3 py-3">{o.channel}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{plural(o.units, "item")}</td>
                    {showPayment && (
                      <td className="px-3 py-3">
                        <PaymentBadge o={o} />
                      </td>
                    )}
                    {showShipping && (
                      <td className="px-3 py-3">
                        <FulfillmentBadge o={o} />
                      </td>
                    )}
                    <td className="px-3 py-3 text-right font-medium whitespace-nowrap tabular-nums">{fmtMoney(o.total, currency)}</td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      {o.shopifyId ? (
                        <a className="font-medium text-accent hover:underline" href={`https://${shopDomain}/admin/orders/${encodeURIComponent(o.shopifyId)}`} target="_blank" rel="noopener noreferrer">
                          Open in Shopify<span className="sr-only"> (order {o.name}, opens in a new tab)</span>
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/** What the dates are compared with, for a tab's foot ("Compared with 7 Sep – 6 Oct"). */
export function ComparedFoot({ ov }: { ov: Overview }) {
  return (
    <p className="text-xs text-muted" data-testid="sales-compared">
      {fmtRange(ov.range.from, ov.range.to)}. {comparedWith({ range: ov.range, previous: ov.previous, timezone: ov.store.timezone })}.
    </p>
  );
}
