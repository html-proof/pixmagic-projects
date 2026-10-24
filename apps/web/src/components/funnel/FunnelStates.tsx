"use client";
import Link from "next/link";
import { useState } from "react";
import { scopeList } from "@app/shared/capabilities";
import { canManage, useApp } from "@/components/AppContext";
import { fmtDay } from "@/components/dashboard/format";
import type { FunnelPageModule, Overview } from "@/components/dashboard/types";
import { Alert } from "@/components/ui";
import { api, ApiError } from "@/lib/api";

/** Read by the dashboard when the merchant comes back from Shopify's grant screen (app/(app)/dashboard/page.tsx). */
const AWAITING = "insights:awaiting-scope-grant";

/** Placeholder shapes in the page's own layout while the first answer loads. */
export function FunnelSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="skeleton h-40 rounded-2xl" />
        ))}
      </div>
      <div className="skeleton h-[28rem] rounded-2xl" />
      <div className="skeleton h-64 rounded-2xl" />
    </div>
  );
}

/**
 * The store hasn't the funnel: the visit-tracking permissions (or the pixel, which a job adds once
 * they're granted). What will fix it, and the button that does when there is one: reconnect, ask
 * Shopify (owners and admins), or wait.
 */
export function LockedFunnel({ ov }: { ov: Overview }) {
  const { workspace } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = ov.capabilities.find((x) => x.id === "funnel");
  if (!c) return null;
  const manage = canManage(workspace.role);
  const reconnect = c.reconnectableScopes.length > 0;
  const requestable = !reconnect && c.missingScopes.length > 0 && c.requestableScopes.length === c.missingScopes.length;
  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ url: string | null }>(`/workspaces/${workspace.id}/stores/${ov.store.id}/scopes/request`, { method: "POST", body: { module: "funnel" } });
      if (!r.url) return;
      try {
        window.sessionStorage.setItem(AWAITING, ov.store.id);
      } catch {
        // Blocked storage: the app/scopes_update webhook still unlocks it.
      }
      window.location.assign(r.url);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "We couldn't open Shopify. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card border-dashed" data-testid="funnel-locked">
      <h2 className="font-semibold">Turn on storefront tracking to see your shopping funnel</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        The funnel counts visits with a Shopify web pixel that bizinsights adds to your store: which pages shoppers view, what they add to cart and whether they check out. It only runs for shoppers who accept analytics tracking, and keeps no names, emails or addresses.
      </p>
      <p className="mt-2 text-sm">
        {c.missingScopes.length === 0
          ? "Setting up storefront tracking. Visits appear here within a minute of someone browsing your store; this page updates by itself."
          : reconnect
            ? `bizinsights needs access to ${scopeList(c.missingScopes)}. Reconnect the store to grant it.`
            : requestable
              ? `Needs your permission in Shopify for ${scopeList(c.missingScopes)}. We'll take you there to approve it.`
              : `Needs access to ${scopeList(c.missingScopes)}, which bizinsights is waiting on Shopify to approve. It isn't something you can turn on.`}
      </p>
      {error && (
        <div className="mt-2">
          <Alert>{error}</Alert>
        </div>
      )}
      {reconnect && manage && (
        <Link className="btn-primary mt-3 inline-flex" href={`/onboarding?${new URLSearchParams({ ws: workspace.id, shop: ov.store.shopDomain })}`}>
          Reconnect
        </Link>
      )}
      {requestable && manage && (
        <button type="button" className="btn-primary mt-3" onClick={() => void ask()} disabled={busy}>
          {busy ? "Opening Shopify…" : "Enable"}
        </button>
      )}
      {(reconnect || requestable) && !manage && <p className="mt-2 text-xs text-muted">Ask a workspace owner or admin to turn it on.</p>}
    </section>
  );
}

/** No visit in these dates (or none matching the filter): why that may be, rather than a page of zeros. */
export function NoVisits({ f, to, filtered, onClear }: { f: FunnelPageModule; to: string; filtered: boolean; onClear: () => void }) {
  const before = !!f.historyFrom && to < f.historyFrom;
  return (
    <section className="card flex flex-col items-start gap-2" data-testid="funnel-empty">
      <h2 className="font-semibold">{filtered ? "No visits match these filters" : "No storefront visits in these dates"}</h2>
      <p className="max-w-3xl text-sm text-muted">
        {filtered
          ? "None of the tracked visits in these dates fits every filter picked. Clear a filter, or pick other dates."
          : before
            ? `These dates are before the bizinsights pixel was added to your store: visits are counted from ${fmtDay(f.historyFrom, { year: true })}. Pick dates since then.`
            : f.historyFrom
              ? `Visits are counted from ${fmtDay(f.historyFrom, { year: true })}. No tracked shopper visited in these dates: shoppers who decline analytics tracking aren't counted.`
            : "No visits have been recorded yet. They show up here within a minute of someone browsing your store, for shoppers who accept analytics tracking."}
      </p>
      {filtered && (
        <button type="button" className="btn-secondary h-9 px-3 text-sm" onClick={onClear}>
          Clear filters
        </button>
      )}
    </section>
  );
}
