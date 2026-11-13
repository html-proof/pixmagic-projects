"use client";
import type { ReactNode } from "react";
import { Info, TrendingDown, TrendingUp } from "lucide-react";
import { MIN_COMPARED, type FunnelInsight } from "@app/shared/funnel";
import type { FunnelStep } from "@app/shared/journey";
import type { FunnelPageModule } from "@/components/dashboard/types";
import { fmtNum, fmtPct } from "@/lib/api";
import { FunnelSection, segmentLabel } from "./FunnelUi";
import { STAGES } from "./stageGuide";

/** The observations the page words: where most visits stop, and a segment or a product against the others. */
type ShownInsight = Extract<FunnelInsight, { kind: "largest_drop" | "segment_gap" | "product_interest" }>;
const isShown = (i: FunnelInsight): i is ShownInsight => i.kind === "largest_drop" || i.kind === "segment_gap" || i.kind === "product_interest";

interface Worded {
  title: string;
  /** The measured difference, with the figures behind it. */
  measured: string;
  /** The figure it is about. */
  metric: string;
  why: string;
  action: string;
  /** Where to look: a stage's details or a section of the page. */
  link: { label: string; step?: FunnelStep; anchor?: string };
}

const name = (s: FunnelStep) => `“${STAGES[s].name}”`;

/** One observation in words. Measured differences only: the reasons are offered as things to check. */
function word(i: ShownInsight): Worded {
  switch (i.kind) {
    case "largest_drop":
      return {
        title: `Most visits are lost between ${name(i.from)} and ${name(i.to)}`,
        measured: `${fmtNum(i.lost)} of ${fmtNum(i.fromCount)} visits (${fmtPct(i.dropOff)}) didn't go on.`,
        metric: "Drop-off rate",
        why: "It is the step where the most potential customers are lost, so a small improvement here reaches the most shoppers.",
        action: `Open the stage to see where those visits were last, and the checks worth making.`,
        link: { label: `Open "${STAGES[i.to].name}"`, step: i.to },
      };
    case "segment_gap": {
      const better = segmentLabel(i.dimension, i.better);
      const worse = segmentLabel(i.dimension, i.worse);
      const what = i.metric === "conversion" ? "buy" : "complete checkout";
      return {
        title: `${worse} ${what} less often than ${better.toLowerCase()}`,
        measured: `${fmtPct(i.worseRate)} of ${fmtNum(i.worseOf)} ${i.metric === "conversion" ? "visits" : "checkouts"} against ${fmtPct(i.betterRate)} of ${fmtNum(i.betterOf)}.`,
        metric: i.metric === "conversion" ? "Conversion rate" : "Checkout completion rate",
        why: i.dimension === "device" ? "A gap between devices often points at something that works less well on one of them." : "New and returning shoppers usually differ; a large gap shows how much repeat shoppers matter to you.",
        action: i.dimension === "device" ? `Go through your store and checkout on ${worse.toLowerCase()} as a shopper would.` : "Make it easy for first-time visitors to trust you: reviews, delivery and returns information.",
        link: { label: "See the breakdown", anchor: "breakdown" },
      };
    }
    case "product_interest":
      return {
        title: `${i.title ?? i.handle} gets attention, but few add it to cart`,
        measured: `${fmtNum(i.added)} of ${fmtNum(i.viewed)} visits that viewed it added it (${fmtPct(i.rate)}), against ${fmtPct(i.othersRate)} for your other products.`,
        metric: "View to cart rate",
        why: "Shoppers are interested enough to open it, so something on the page may be holding them back.",
        action: "Check its price, photos, description, sizes and shipping information against similar products.",
        link: { label: "See products", anchor: "products" },
      };
  }
}

const TONE: Record<FunnelInsight["tone"], { label: string; Icon: typeof Info; cls: string }> = {
  positive: { label: "Improvement", Icon: TrendingUp, cls: "text-good" },
  negative: { label: "Needs attention", Icon: TrendingDown, cls: "text-danger" },
  neutral: { label: "Observation", Icon: Info, cls: "text-info" },
};

/** "Shopping Funnel Insights": what stands out, by how much, over which dates, why it may matter and what to do, each only where the numbers support it. */
export function FunnelInsights({ f, period, onOpen }: { f: FunnelPageModule; period: ReactNode; onOpen: (step: FunnelStep) => void }) {
  const insights = f.insights.filter(isShown);
  const go = (link: Worded["link"]) => {
    if (link.step) onOpen(link.step);
    else if (link.anchor) document.getElementById(link.anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <FunnelSection id="insights" title="Shopping Funnel insights" sub={<>What the numbers show for {period}. Each appears only when the data supports it.</>}>
      {insights.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted">
          Nothing stands out yet. Observations need at least {MIN_COMPARED} visits in each group compared, and a difference larger than chance would explain; with more visits, or longer dates, they appear here.
        </p>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {insights.map((insight, n) => {
            const w = word(insight);
            const t = TONE[insight.tone];
            return (
              <li key={n} className="flex flex-col rounded-xl border border-border bg-surface p-4" data-testid={`funnel-insight-${insight.kind}`}>
                <p className={`flex items-center gap-1.5 text-xs font-medium ${t.cls}`}>
                  <t.Icon aria-hidden className="h-4 w-4" />
                  {t.label} · {w.metric}
                </p>
                <p className="mt-1 font-semibold">{w.title}</p>
                <p className="mt-1 text-sm">{w.measured}</p>
                <dl className="mt-2 space-y-1 text-sm text-muted">
                  <div>
                    <dt className="inline font-medium text-text">Why it might matter: </dt>
                    <dd className="inline">{w.why}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-text">What to do: </dt>
                    <dd className="inline">{w.action}</dd>
                  </div>
                </dl>
                <button type="button" className="mt-3 self-start text-sm font-medium text-accent underline underline-offset-2" onClick={() => go(w.link)} data-print-hide>
                  {w.link.label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">
        Differences are tested with a two-proportion test (95%) and need at least {MIN_COMPARED} visits on each side. Possible reasons are suggestions to check, not measured causes.
      </p>
    </FunnelSection>
  );
}
