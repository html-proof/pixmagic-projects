"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, X } from "lucide-react";
import { FUNNEL_ACTIONS, largestDropOff, MIN_COMPARED, proportionZ, significant, type SegmentFunnel } from "@app/shared/funnel";
import { FUNNEL_STEPS, type FunnelStep, type SiteSection } from "@app/shared/journey";
import { SECTION_LABEL } from "@/components/dashboard/Funnel";
import type { FunnelPageModule, Overview } from "@/components/dashboard/types";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { filterable, fmtPts, segmentLabel, type SegmentDimension } from "./FunnelUi";
import { FORMULAS, STAGES } from "./stageGuide";

/** A panel over the page's right side, closed by its X, Escape or a click outside; keyboard focus stays inside while it's open. */
export function Drawer({ title, sub, onClose, children, testId }: { title: string; sub?: string; onClose: () => void; children: ReactNode; testId?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
      if (e.key !== "Tab" || !panel.current) return;
      const focusable = panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])');
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      before?.focus?.();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-labelledby="funnel-drawer-title" data-testid={testId} data-print-hide>
      <div className="animate-fade absolute inset-0 bg-black/45" onClick={onClose} aria-hidden />
      <div ref={panel} className="animate-sheet relative flex h-full w-full max-w-2xl flex-col bg-bg shadow-2xl sm:border-l sm:border-border">
        <header className="flex items-start gap-3 border-b border-border bg-surface px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <h2 id="funnel-drawer-title" className="text-lg font-semibold">
              {title}
            </h2>
            {sub && <p className="text-xs text-muted">{sub}</p>}
          </div>
          <button ref={closeBtn} type="button" onClick={onClose} className="grid size-10 shrink-0 place-items-center rounded-full border border-border bg-surface text-muted transition hover:text-text" aria-label="Close">
            <X aria-hidden className="h-5 w-5" />
          </button>
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-6">{children}</div>
      </div>
    </div>
  );
}

function Part({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`stage-part-${n}`} className="space-y-2">
      <h3 id={`stage-part-${n}`} className="flex items-center gap-2 text-sm font-semibold">
        <span aria-hidden className="grid size-6 place-items-center rounded-full bg-accent/12 text-xs text-accent">
          {n}
        </span>
        {title}
      </h3>
      <div className="space-y-2 pl-8 text-sm leading-relaxed">{children}</div>
    </section>
  );
}

function Point({ good, children }: { good: boolean; children: ReactNode }) {
  const Icon = good ? CheckCircle2 : CircleAlert;
  return (
    <li className="flex gap-2">
      <Icon aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 ${good ? "text-good" : "text-warn"}`} />
      <span>{children}</span>
    </li>
  );
}

function Rows({ rows, empty }: { rows: Array<[ReactNode, ReactNode]>; empty: string }) {
  if (!rows.length) return <p className="text-muted">{empty}</p>;
  return (
    <dl className="divide-y divide-border rounded-lg border border-border bg-surface">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-center justify-between gap-3 px-3 py-2">
          <dt className="min-w-0 truncate">{k}</dt>
          <dd className="shrink-0 tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Segments that go on to this stage (from the one before) more or less often than the rest of the
 * visits, by more than chance would explain (proportionZ): what the numbers show, never why.
 */
function segmentDifferences(segments: FunnelPageModule["segments"], k: number) {
  const out: Array<{ good: boolean; text: string }> = [];
  for (const dim of ["device", "visitor", "landing", "source"] as const satisfies readonly SegmentDimension[]) {
    const list = (segments[dim] ?? []).filter((s) => s.key !== "not_recorded");
    const total = list.reduce((a, s) => ({ from: a.from + s.reached[k - 1]!, to: a.to + s.reached[k]! }), { from: 0, to: 0 });
    for (const s of list) {
      const from = s.reached[k - 1]!;
      const to = s.reached[k]!;
      if (from < MIN_COMPARED) continue;
      const z = proportionZ(to, from, total.to - to, total.from - from);
      if (!significant(z)) continue;
      const rest = (total.to - to) / (total.from - from);
      out.push({ good: z! > 0, text: `${segmentLabel(dim, s.key)}: ${fmtPct(to / from)} went on, against ${fmtPct(rest)} for other visits (${fmtNum(from)} visits).` });
    }
  }
  return out.slice(0, 4);
}

const lastPages = (rows: Array<{ section: SiteSection | null; visits: number }>) =>
  rows.slice(0, 5).map((x): [ReactNode, ReactNode] => [x.section ? SECTION_LABEL[x.section] : "Page not recorded", `${fmtNum(x.visits)} visits`]);

/** One stage explained: what it means, why it matters, its numbers, how they're calculated, what stands out, what to try, and the data behind it. */
export function StageDetail({ step, f, ov, onClose, onFilter }: { step: FunnelStep; f: FunnelPageModule; ov: Overview; onClose: () => void; onFilter: (dim: SegmentDimension, key: string) => void }) {
  const k = FUNNEL_STEPS.indexOf(step);
  const g = STAGES[step];
  const s = f.steps[k]!;
  const into = k > 0 ? f.transitions[k - 1]! : null;
  const out = f.transitions[k] ?? null;
  const worst = largestDropOff(f.transitions);
  const currency = ov.store.currency;
  const sales = ov.modules.sales_overview;
  const compared = f.previous.reached !== null && f.previous.reached !== undefined;

  // What is going well, and what may be a problem: only what a test on the numbers supports.
  const good: ReactNode[] = [];
  const bad: ReactNode[] = [];
  if (k === 0) {
    const v = f.insights.find((i) => i.kind === "visits");
    if (v && v.kind === "visits") (v.tone === "positive" ? good : bad).push(`Tracked visits ${v.tone === "positive" ? "rose" : "fell"} from ${fmtNum(v.previous)} to ${fmtNum(v.current)} (${fmtPct(Math.abs(v.change))}), more than day-to-day variation would explain.`);
  } else if (into?.previous && into.change !== null && into.significant) {
    const text = `${fmtPct(into.progression)} of visits at the stage before ${g.wentOn}, against ${fmtPct(into.previous.progression)} in the dates compared with (${fmtPts(into.change)}). The difference is larger than chance would explain.`;
    (into.change > 0 ? good : bad).push(text);
  }
  if (k > 0) for (const d of segmentDifferences(f.segments, k)) (d.good ? good : bad).push(d.text);
  if (into && worst === k - 1) bad.push(`This is where most visits stop: ${fmtNum(into.lost)} of ${fmtNum(into.fromCount)} (${fmtPct(into.dropOff)}) didn't ${g.wentOn.replace(/^went on to /, "")}.`);
  if (step === "added_to_cart") {
    for (const i of f.insights) if (i.kind === "product_interest") bad.push(`${i.title ?? i.handle}: ${fmtNum(i.added)} of ${fmtNum(i.viewed)} visits that viewed it added it to cart (${fmtPct(i.rate)}), against ${fmtPct(i.othersRate)} for your other products.`);
  }

  const actions = FUNNEL_ACTIONS.filter((a) => a.step === step);
  const done = new Set(f.actions.map((a) => a.id));
  const products = (by: "viewed" | "added" | "checkouts" | "purchased") =>
    f.products
      .filter((p) => (p[by] ?? 0) > 0)
      .sort((a, b) => (b[by] ?? 0) - (a[by] ?? 0))
      .slice(0, 5)
      .map((p): [ReactNode, ReactNode] => [p.title ?? p.handle, `${fmtNum(p[by])} visits`]);
  const segmentRows = (dim: SegmentDimension, list: SegmentFunnel[]) =>
    list.slice(0, 6).map((x): [ReactNode, ReactNode] => [
      !filterable(dim, x.key) ? (
        segmentLabel(dim, x.key)
      ) : (
        <button type="button" className="text-left underline decoration-border underline-offset-2 hover:decoration-text" onClick={() => onFilter(dim, x.key)}>
          {segmentLabel(dim, x.key)}
        </button>
      ),
      `${fmtNum(x.reached[k])} of ${fmtNum(x.visits)} visits (${fmtPct(x.visits ? x.reached[k]! / x.visits : null)})`,
    ]);

  return (
    <Drawer title={`${k + 1}. ${g.name}`} sub={`${fmtNum(s.reached)} visits · ${fmtPct(s.shareOfVisits)} of all visits`} onClose={onClose} testId="funnel-stage-detail">
      <Part n={1} title="What this stage means">
        <p>{g.meaning}</p>
      </Part>
      <Part n={2} title="Why it matters">
        <p>{g.why}</p>
      </Part>
      <Part n={3} title="What the numbers mean">
        <p>
          <strong>{fmtNum(s.reached)}</strong> {s.reached === 1 ? "visit" : "visits"} reached this stage: <strong>{fmtPct(s.shareOfVisits)}</strong> of the {fmtNum(f.visits)} visits in these dates.
        </p>
        {into && (
          <p>
            Of the {fmtNum(into.fromCount)} visits at the stage before, <strong>{fmtPct(into.progression)}</strong> {g.wentOn} (progression rate) and <strong>{fmtNum(into.lost)}</strong> didn&apos;t: a{" "}
            <strong>{fmtPct(into.dropOff)}</strong> drop-off.
          </p>
        )}
        {out && (
          <p>
            From here, {fmtPct(out.progression)} {STAGES[out.to].wentOn} and {fmtNum(out.lost)} stopped at this stage.
          </p>
        )}
        {step === "started_checkout" && out && (
          <p>
            Checkout abandonment: {fmtNum(out.lost)} of {fmtNum(out.fromCount)} visits that started checkout didn&apos;t complete it ({fmtPct(out.dropOff)}).
          </p>
        )}
        {step === "purchased" && sales && (
          <p>
            Your Shopify orders in these dates (every order, from every channel): <strong>{fmtNum(sales.current.orders)}</strong>, {fmtMoney(sales.current.netSales, currency)} net sales, average order value {fmtMoney(sales.current.averageOrderValue, currency)}.
          </p>
        )}
      </Part>
      <Part n={4} title="How it's calculated">
        <ul className="list-disc space-y-1 pl-4">
          <li>{g.counted}</li>
          {k > 0 && <li>Share of visits = {FORMULAS.share}.</li>}
          {k > 0 && <li>Progression rate = {FORMULAS.progression}.</li>}
          {k > 0 && <li>Drop-off rate = {FORMULAS.dropOff}.</li>}
          {step === "purchased" && <li>Checkout completion = {FORMULAS.checkoutCompletion}.</li>}
          {step === "purchased" && <li>Average order value = {FORMULAS.aov}, from your Shopify orders.</li>}
        </ul>
        <p className="text-xs text-muted">The denominator is always tracked visits in the same dates and filter, so every rate compares the same visits with themselves.</p>
      </Part>
      <Part n={5} title="What is going well">
        {good.length ? (
          <ul className="space-y-1.5">
            {good.map((x, i) => (
              <Point key={i} good>
                {x}
              </Point>
            ))}
          </ul>
        ) : (
          <p className="text-muted">{compared ? "Nothing here is clearly better than in the dates compared with, or for one kind of visit over the others." : "There's no earlier data to compare with yet, and no kind of visit does clearly better than the others."}</p>
        )}
      </Part>
      <Part n={6} title="Potential problems">
        {bad.length ? (
          <ul className="space-y-1.5">
            {bad.map((x, i) => (
              <Point key={i} good={false}>
                {x}
              </Point>
            ))}
          </ul>
        ) : (
          <p className="text-muted">The numbers don&apos;t point to a clear problem at this stage{compared ? "" : " (there's no earlier data to compare with)"}.</p>
        )}
        {g.dropReasons.length > 0 && (
          <>
            <p className="pt-1 text-xs font-medium text-muted">Common reasons visits stop before this stage (possible causes, not measured here):</p>
            <ul className="list-disc space-y-1 pl-4 text-muted">
              {g.dropReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </>
        )}
      </Part>
      <Part n={7} title="Recommended actions">
        <ul className="space-y-2">
          {actions.map((a) => (
            <li key={a.id} className="rounded-lg border border-border bg-surface p-3">
              <p className="flex items-center justify-between gap-2 font-medium">
                {a.label}
                {done.has(a.id) && <span className="inline-flex items-center gap-1 text-xs font-normal text-good"><CheckCircle2 aria-hidden className="h-3.5 w-3.5" />Done</span>}
              </p>
              <p className="text-muted">{a.detail}</p>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">Suggestions to try, then watch this stage in the weeks after. Tick them off in the checklist on the page.</p>
      </Part>
      <Part n={8} title="Supporting data">
        {step === "visited" && (
          <>
            <p className="text-xs font-medium text-muted">Where visits started</p>
            <Rows rows={segmentRows("landing", f.segments.landing)} empty="No landing pages recorded." />
            <p className="text-xs font-medium text-muted">By device</p>
            <Rows rows={segmentRows("device", f.segments.device)} empty="No devices recorded." />
            {f.segments.source && (
              <>
                <p className="text-xs font-medium text-muted">By traffic source</p>
                <Rows rows={segmentRows("source", f.segments.source)} empty="No visits in these dates." />
                {!f.sourcesFrom && <p className="text-xs text-muted">Traffic sources are recorded once your store runs the updated bizinsights pixel; the Breakdown section shows your orders by source meanwhile.</p>}
              </>
            )}
          </>
        )}
        {step === "viewed_product" && (
          <>
            <p className="text-xs font-medium text-muted">Most-viewed products</p>
            <Rows rows={products("viewed")} empty={f.detailsFrom ? "No product pages viewed in these dates." : "Product pages are recorded from now on; none yet."} />
            <p className="text-xs font-medium text-muted">Last page of visits that left before viewing a product</p>
            <Rows rows={lastPages(f.steps[0]!.leftFrom)} empty="Every visit viewed a product." />
          </>
        )}
        {step === "added_to_cart" && (
          <>
            <p className="text-xs font-medium text-muted">Products most often added to cart from their page</p>
            <Rows rows={products("added")} empty={f.detailsFrom ? "No adds to cart from a product page in these dates." : "Product pages are recorded from now on; none yet."} />
            <p className="text-xs font-medium text-muted">Last page of visits that viewed a product but didn&apos;t add to cart</p>
            <Rows rows={lastPages(f.steps[1]!.leftFrom)} empty="Nobody stopped here." />
          </>
        )}
        {step === "started_checkout" && (
          <>
            <p className="text-xs font-medium text-muted">Last page of visits that added to cart but didn&apos;t start checkout</p>
            <Rows rows={lastPages(f.steps[2]!.leftFrom)} empty="Nobody stopped here." />
            <p className="text-xs font-medium text-muted">Products most often taken to checkout</p>
            <Rows rows={products("checkouts")} empty={f.sourcesFrom ? "No checkout started in these dates." : "Checkouts per product are recorded once your store runs the updated bizinsights pixel."} />
            <p className="text-xs font-medium text-muted">Checkout start by device</p>
            <Rows rows={segmentRows("device", f.segments.device)} empty="No devices recorded." />
          </>
        )}
        {step === "purchased" && (
          <>
            <p className="text-xs font-medium text-muted">Landing pages whose visits bought</p>
            <Rows rows={f.entryPages.filter((p) => p.purchases > 0).map((p): [ReactNode, ReactNode] => [p.path === "/" ? "Home page" : p.path, `${fmtNum(p.purchases)} of ${fmtNum(p.visits)} visits bought`])} empty="No visit that bought started on one of the top landing pages." />
            <p className="text-xs font-medium text-muted">Products tracked visits bought most often</p>
            <Rows rows={products("purchased")} empty={f.sourcesFrom ? "No tracked purchase in these dates." : "Purchases per product are recorded once your store runs the updated bizinsights pixel."} />
            {ov.modules.traffic && (
              <>
                <p className="text-xs font-medium text-muted">Orders by traffic source (Shopify&apos;s record of each order&apos;s last visit)</p>
                <Rows rows={ov.modules.traffic.items.slice(0, 5).map((t): [ReactNode, ReactNode] => [t.label, `${fmtNum(t.orders)} orders · ${fmtMoney(t.sales, currency)}`])} empty="No orders in these dates." />
              </>
            )}
            <p className="text-xs font-medium text-muted">Purchases by device</p>
            <Rows rows={segmentRows("device", f.segments.device)} empty="No devices recorded." />
          </>
        )}
      </Part>
    </Drawer>
  );
}
