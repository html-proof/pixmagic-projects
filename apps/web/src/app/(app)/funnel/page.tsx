"use client";
import Link from "next/link";
import { useState } from "react";
import { X } from "lucide-react";
import type { FunnelFilter } from "@app/shared/funnel";
import type { FunnelStep } from "@app/shared/journey";
import { canManage, StoresPending, useApp } from "@/components/AppContext";
import { comparedWith, versusWords } from "@/components/dashboard/DateRange";
import { fmtRange } from "@/components/dashboard/format";
import { JourneyCard } from "@/components/dashboard/Funnel";
import { ShopifySessionsCard } from "@/components/dashboard/ShopifyReports";
import { AboutFunnelData } from "@/components/funnel/AboutFunnelData";
import { ActionChecklist } from "@/components/funnel/ActionChecklist";
import { Breakdown } from "@/components/funnel/Breakdown";
import { DropOffs } from "@/components/funnel/DropOffs";
import { FunnelChart } from "@/components/funnel/FunnelChart";
import { FunnelHeader } from "@/components/funnel/FunnelHeader";
import { FunnelInsights } from "@/components/funnel/FunnelInsights";
import { FunnelKpis } from "@/components/funnel/FunnelKpis";
import { FunnelSkeleton, LockedFunnel, NoVisits } from "@/components/funnel/FunnelStates";
import { FunnelTrends } from "@/components/funnel/FunnelTrends";
import { segmentLabel, type SegmentDimension } from "@/components/funnel/FunnelUi";
import { ProductFunnel } from "@/components/funnel/ProductFunnel";
import { StageDetail } from "@/components/funnel/StageDetail";
import { useFunnel } from "@/components/funnel/useFunnel";
import { LoadError } from "@/components/LoadError";
import { Alert, EmptyState } from "@/components/ui";
import { friendlyError, isTransient } from "@/lib/api";

/**
 * Sales → Visitors (the shopping funnel): how tracked visits become customers, where they drop off, and what to do
 * about it, for the store and dates picked (components/funnel/, docs/kpis.md "Shopping Funnel page").
 * Every figure comes from the API (GET …/overview?parts=funnel); nothing here is estimated.
 */
export default function FunnelPage() {
  const { storesStatus, stores, store, workspace } = useApp();
  if (storesStatus !== "ready") return <StoresPending />;
  if (!stores.length || !store) {
    return (
      <EmptyState
        title="Connect your store to see your shopping funnel"
        body="Once your Shopify store is connected and storefront tracking is on, this page shows how visitors move from your store to a completed purchase."
        action={canManage(workspace.role) ? <Link className="btn-primary" href={`/onboarding?ws=${encodeURIComponent(workspace.id)}`}>Continue with Shopify</Link> : undefined}
      />
    );
  }
  // A store's own page: switching stores starts again (dates and filter stay in the address).
  return <FunnelView key={store.id} />;
}

const FILTER_WORDS: Array<[keyof FunnelFilter, SegmentDimension]> = [
  ["device", "device"],
  ["visitor", "visitor"],
  ["landing", "landing"],
  ["country", "country"],
  ["source", "source"],
];

function FunnelView() {
  const s = useFunnel();
  const [stage, setStage] = useState<FunnelStep | null>(null);
  const { ov, funnel: f } = s;
  const versus = versusWords(s.shown);
  const compared = comparedWith(s.shown);
  const period = ov ? `${fmtRange(ov.range.from, ov.range.to)}${compared ? ` (${compared.charAt(0).toLowerCase()}${compared.slice(1)})` : ""}` : "";
  const narrow = (dim: SegmentDimension, key: string) => {
    s.setFilter(dim, key);
    setStage(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  // A traffic source applies only for members who see sources (the answer then has their segment); the API leaves it out otherwise.
  const filterWords = FILTER_WORDS.filter(([k]) => s.filter[k] && (k !== "source" || f?.segments.source)).map(([k, dim]) => segmentLabel(dim, s.filter[k]!));

  return (
    <div className="space-y-5" data-print-root>
      <FunnelHeader s={s} />

      {s.error && !ov && <LoadError what="your shopping funnel" error={s.error} onRetry={s.refresh} busy={s.loading} />}
      {s.error && ov && s.older && (
        <Alert kind={isTransient(s.error) ? "info" : "error"}>
          Couldn&apos;t load {s.dates.asking?.label}, so the figures below are still for {fmtRange(ov.range.from, ov.range.to)}. {friendlyError(s.error)}
        </Alert>
      )}
      {!ov && !s.error && (
        <>
          <p className="sr-only" role="status">
            Loading your shopping funnel…
          </p>
          <FunnelSkeleton />
        </>
      )}

      {ov && ov.store.status === "syncing" && <Alert kind="info">We&apos;re still importing your orders. Order figures fill in over the next few minutes; visits are counted as they happen.</Alert>}
      {ov && ov.store.status === "error" && (
        <Alert kind="info">Syncing this store&apos;s orders has stopped, so order figures may be out of date. The dashboard says why and what fixes it; visits keep being counted.</Alert>
      )}

      {ov && !f && (
        <>
          {ov.capabilities.some((c) => c.id === "funnel" && !c.enabled) && <LockedFunnel ov={ov} />}
          {ov.modules.shopify_sessions && <ShopifySessionsCard m={ov.modules.shopify_sessions} versus={versus} />}
          <AboutFunnelData f={null} ov={ov} />
        </>
      )}

      {ov && f && (
        <>
          {filterWords.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-accent/40 bg-accent/5 px-4 py-3 text-sm" role="status" data-testid="funnel-filter-banner">
              <span>
                Showing only <strong>{filterWords.join(" · ")}</strong>. Every visit figure is narrowed to them; orders, revenue and product sales are for all orders.
              </span>
              <button type="button" className="inline-flex items-center gap-1 font-medium text-accent" onClick={s.clearFilter} data-print-hide>
                <X aria-hidden className="h-4 w-4" />
                Show all visits
              </button>
            </div>
          )}

          {f.visits === 0 ? (
            <NoVisits f={f} to={ov.range.to} filtered={s.filtered} onClear={s.clearFilter} />
          ) : (
            <>
              <p className="text-xs text-muted">
                Visits are counted by the bizinsights storefront pixel for shoppers who accept analytics tracking (one shopper on one day); orders and revenue come from your Shopify orders.{" "}
                <a href="#about" className="underline underline-offset-2">
                  How these numbers work
                </a>
              </p>
              <FunnelKpis f={f} ov={ov} versus={versus} onOpen={setStage} />
              <FunnelChart f={f} versus={versus} onOpen={setStage} />
              <FunnelInsights f={f} period={period} onOpen={setStage} />
              <DropOffs f={f} />
              <Breakdown f={f} ov={ov} onFilter={narrow} />
              <JourneyCard m={f} />
              <FunnelTrends f={f} today={ov.today} />
              <ProductFunnel f={f} shop={ov.store.shopDomain} currency={ov.store.currency} />
            </>
          )}
          <ActionChecklist f={f} />
          {ov.modules.shopify_sessions && <ShopifySessionsCard m={ov.modules.shopify_sessions} versus={versus} />}
          <AboutFunnelData f={f} ov={ov} />
        </>
      )}

      {stage && ov && f && <StageDetail step={stage} f={f} ov={ov} onClose={() => setStage(null)} onFilter={narrow} />}
    </div>
  );
}
