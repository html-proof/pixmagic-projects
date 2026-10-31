"use client";
import { hasCapability } from "@app/shared/capabilities";
import { useApp } from "@/components/AppContext";
import { useLiveApi } from "@/lib/api";

// ---------------------------------------------------------------------------
// Shopify's own abandoned checkouts for the Shopping Funnel page's dates (GET …/abandoned-checkouts,
// apps/api/src/routes/checkouts.ts; packages/core/src/reports/abandonedCheckouts.ts). The API
// answers from what it keeps of Shopify's answers and asks Shopify for the rest in the background,
// so the card looks again every minute until the figures are in.
// ---------------------------------------------------------------------------

const LIVE_EVERY_MS = 60_000;

/** Why there are no figures: still asking Shopify, refused or failed, or older than Shopify shares. */
export type CheckoutsStatus = "ready" | "loading" | "access_denied" | "unsupported" | "failed" | "beyond_history";

export interface CheckoutDay {
  day: string;
  abandoned: number;
  recovered: number;
  value: number;
}

export interface CheckoutFigures {
  abandoned: number;
  /** False: Shopify gave the count as a lower bound. */
  abandonedExact: boolean;
  recovered: number;
  recoveredExact: boolean;
  recoveredRate: number | null;
  /** Null when `valueGap` says why it isn't added up. */
  value: number | null;
  recoveredValue: number | null;
  valueGap: "too_many" | "mixed_currency" | "withheld" | null;
  currency: string | null;
  days?: CheckoutDay[] | null;
}

export interface AbandonedCheckoutsModule {
  status: CheckoutsStatus;
  previousStatus: CheckoutsStatus;
  asOf: string | null;
  until: string | null;
  /** The first day Shopify shares checkouts for; null when the store granted older orders too. */
  visibleFrom: string | null;
  current: CheckoutFigures | null;
  previous: CheckoutFigures | null;
  deltas: { abandoned: number | null; value: number | null; recoveredRate: number | null };
}

export interface AbandonedCheckoutsAnswer {
  range: { from: string; to: string };
  previous: { from: string; to: string; until?: string };
  module: AbandonedCheckoutsModule;
}

/**
 * The card's figures for the dates asked (`qs`, the dashboard's dates question), for a member who
 * may see checkout abandonment, on a store that shares its orders. `shown` is false otherwise: the
 * card isn't on the page at all.
 */
export function useAbandonedCheckouts(qs: string | null) {
  const { workspace, store, allowed } = useApp();
  const shown = !!store && allowed("analytics.abandonment") && hasCapability(store.grantedScopes, "abandoned_checkouts");
  const path = shown && store && qs ? `/workspaces/${workspace.id}/stores/${store.id}/abandoned-checkouts?${qs}` : null;
  const live = useLiveApi<AbandonedCheckoutsAnswer>(path, LIVE_EVERY_MS);
  return {
    shown,
    data: live.data,
    error: live.error,
    loading: live.loading,
    /** The figures on screen are still for the dates asked before. */
    older: live.data !== null && live.dataPath !== path,
    /** Whether "Customers to follow up" (who left them, on the dashboard) is there for this member. */
    contacts: !!store && allowed("customers.list") && hasCapability(store.grantedScopes, "contacts"),
    refresh: () => window.dispatchEvent(new Event("insights:retry")),
  };
}
