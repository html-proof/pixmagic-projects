"use client";
import type { ReactNode } from "react";
import { Eye, Percent, ShoppingBag, ShoppingCart, Store, Wallet, type LucideIcon } from "lucide-react";
import { FUNNEL_STEPS, type FunnelStep } from "@app/shared/journey";
import { Sparkline } from "@/components/dashboard/HomeCards";
import type { FunnelPageModule, Overview } from "@/components/dashboard/types";
import { fmtNum, fmtPct } from "@/lib/api";
import { InfoTip } from "./FunnelUi";
import { FORMULAS, STAGES } from "./stageGuide";

/** One headline figure: its value, a plain question it answers, how it's counted, and its stage's details on a click. */
function Kpi({
  title,
  icon: Icon,
  value,
  question,
  measure,
  tip,
  spark,
  onOpen,
  testId,
}: {
  title: string;
  icon: LucideIcon;
  value: ReactNode;
  question: string;
  measure: ReactNode;
  tip: ReactNode;
  spark?: Array<number | null>;
  onOpen: () => void;
  testId: string;
}) {
  return (
    <div className="lift animate-rise relative flex min-w-0 flex-col rounded-lg border border-transparent bg-surface shadow-[var(--shadow)]" data-testid={testId}>
      {/* The tip sits beside the card's button, not inside it: a button can't hold another. */}
      <span className="absolute right-2 top-2 z-10">
        <InfoTip label={`How ${title.toLowerCase()} is counted`}>{tip}</InfoTip>
      </span>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 flex-col rounded-2xl p-4 pr-9 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <span className="flex items-center gap-2 text-sm font-medium text-muted">
          <Icon aria-hidden className="h-4 w-4 shrink-0 text-accent" />
          <span className="truncate">{title}</span>
        </span>
        <span className="mt-2 text-2xl font-bold tabular-nums tracking-tight">{value}</span>
        <span className="mt-2 text-xs text-muted">{measure}</span>
        <span className="mt-auto flex items-end justify-between gap-2 pt-2">
          <span className="text-xs text-text/80">{question}</span>
          {spark && <Sparkline values={spark} className="hidden h-8 w-16 shrink-0 text-accent min-[420px]:block" />}
        </span>
        <span className="sr-only"> – open the stage&apos;s details</span>
      </button>
    </div>
  );
}

const ICON: Record<FunnelStep, LucideIcon> = { visited: Store, viewed_product: Eye, added_to_cart: ShoppingCart, started_checkout: Wallet, purchased: ShoppingBag };
const QUESTION: Record<FunnelStep, string> = {
  visited: "How many people visited your online store?",
  viewed_product: "How many visitors explored your products?",
  added_to_cart: "How many visitors showed purchase intent?",
  started_checkout: "How many visitors moved closer to completing a purchase?",
  purchased: "How many customers completed their purchase?",
};
const TITLE: Record<FunnelStep, string> = { visited: "Store visitors", viewed_product: "Product views", added_to_cart: "Added to cart", started_checkout: "Reached checkout", purchased: "Completed purchases" };

/**
 * The six headline figures over the funnel: visits reaching each stage, then the conversion rate.
 * All are tracked visits (one rate can't divide one source by another); the store's orders are named
 * beside the purchases as what they are.
 */
export function FunnelKpis({ f, ov, onOpen }: { f: FunnelPageModule; ov: Overview; onOpen: (step: FunnelStep) => void }) {
  const orders = ov.modules.sales_overview?.current.orders;
  const sparkOf = (k: number) => f.daily.map((d) => d.reached?.[k] ?? null);
  return (
    <section aria-label="Funnel summary" className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
      {FUNNEL_STEPS.map((step, k) => {
        const s = f.steps[k]!;
        const guide = STAGES[step];
        return (
          <Kpi
            key={step}
            testId={`funnel-kpi-${step}`}
            title={TITLE[step]}
            icon={ICON[step]}
            value={fmtNum(s.reached)}
            question={QUESTION[step]}
            spark={sparkOf(k)}
            onOpen={() => onOpen(step)}
            measure={
              k === 0 ? (
                <>Tracked visits, from {fmtNum(f.browsers)} {f.browsers === 1 ? "browser" : "browsers"}</>
              ) : step === "purchased" && orders !== undefined ? (
                <>
                  {fmtPct(s.shareOfVisits)} of visits · Shopify recorded {fmtNum(orders)} {orders === 1 ? "order" : "orders"} in all
                </>
              ) : (
                <>{fmtPct(s.shareOfVisits)} of visits</>
              )
            }
            tip={
              <>
                <p className="font-medium">{guide.name}</p>
                <p className="mt-1">{guide.counted}</p>
                {k > 0 && <p className="mt-1 text-muted">Share of visits: {FORMULAS.share}.</p>}
                {step === "purchased" && orders !== undefined && (
                  <p className="mt-1 text-muted">
                    Shopify&apos;s order count includes every order in these dates (all sales channels, shoppers who declined tracking), so it is usually higher than the visits that bought.
                  </p>
                )}
              </>
            }
          />
        );
      })}
      <Kpi
        testId="funnel-kpi-conversion"
        title="Conversion rate"
        icon={Percent}
        value={fmtPct(f.conversionRate)}
        question="What share of visits ended in a purchase?"
        spark={f.daily.map((d) => (d.reached && d.reached[0]! > 0 ? d.reached[4]! / d.reached[0]! : null))}
        onOpen={() => onOpen("purchased")}
        measure={<>{fmtNum(f.purchases)} of {fmtNum(f.visits)} visits bought</>}
        tip={
          <>
            <p className="font-medium">Overall conversion rate</p>
            <p className="mt-1">{FORMULAS.conversion}.</p>
            <p className="mt-1 text-muted">Shopify Analytics divides by its own sessions instead, so its rate differs.</p>
          </>
        }
      />
    </section>
  );
}
