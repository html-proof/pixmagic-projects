"use client";
import { fmtNum } from "@/lib/api";
import { fmtDay, fmtRelative } from "./format";
import { Dot, type Tone } from "./primitives";
import type { ImportedData, OverviewStore } from "./types";

const STATUS: Record<string, { tone: Tone; label: string }> = {
  active: { tone: "good", label: "Connected" },
  syncing: { tone: "warn", label: "Importing your data…" },
  pending: { tone: "neutral", label: "Waiting to sync" },
  error: { tone: "danger", label: "Sync problem" },
  uninstalled: { tone: "neutral", label: "Disconnected" },
};

function Count({ n, one }: { n: number; one: string }) {
  return (
    <>
      <strong className="tabular-nums">{fmtNum(n)}</strong> {n === 1 ? one : `${one}s`}
    </>
  );
}

export type LiveState = "checking" | "live" | "stale";

/** "Good morning" in the store's own time zone, since that's the day the numbers describe. */
function greeting(timeZone: string): string {
  let hour = new Date().getHours();
  try {
    hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", hourCycle: "h23" }).format(new Date()));
  } catch {
    // Unknown zone: the viewer's clock will do.
  }
  return hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

const LIVE: Record<LiveState, { tone: Tone; label: string }> = {
  checking: { tone: "neutral", label: "Checking…" },
  live: { tone: "good", label: "Live" },
  stale: { tone: "warn", label: "Reconnecting…" },
};

/**
 * Store identity, connection status and what has been imported. The dashboard keeps itself
 * up to date (it re-checks every few seconds), so there is no refresh button: the "Live"
 * badge says so, and turns grey if the last check couldn't reach the server.
 */
export function StoreHeader({ store, data, live, everySec }: { store: OverviewStore; data: ImportedData | undefined; live: LiveState; everySec: number }) {
  const status = STATUS[store.status] ?? { tone: "neutral" as Tone, label: store.status };
  const synced = fmtRelative(store.lastSyncedAt);
  const fullHistory = store.grantedScopes.includes("read_all_orders");

  return (
    <section className="card animate-rise relative overflow-hidden" aria-label="Store" data-testid="store-header">
      {/* A slowly moving stripe of the brand colours along the top edge. */}
      <span aria-hidden className="brand-gradient animate-pan absolute inset-x-0 top-0 h-1" />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden className="brand-gradient animate-pan flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-xl font-bold text-white shadow-md">
            {(store.name ?? store.shopDomain).trim().charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-accent">{greeting(store.timezone)}</p>
            <h1 className="truncate text-xl font-semibold sm:text-2xl">{store.name ?? store.shopDomain}</h1>
            <p className="truncate text-sm text-muted">
              {store.shopDomain} · {store.currency} · {store.timezone}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-sm" data-testid="store-status">
            <Dot tone={status.tone} pulse={store.status === "syncing"} />
            {status.label}
          </span>
          <span
            className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-sm"
            title={`This page checks for new data every ${everySec} seconds`}
            data-testid="live-indicator"
          >
            <Dot tone={LIVE[live].tone} pulse={live === "live"} />
            {LIVE[live].label}
          </span>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-border pt-3 text-sm">
        {data ? (
          <p data-testid="imported-summary">
            Imported <Count n={data.orders} one="order" /> · <Count n={data.products} one="product" /> · <Count n={data.variants} one="variant" />
          </p>
        ) : (
          <p className="text-muted">Counting what&apos;s been imported…</p>
        )}
        {data?.oldestOrderDay && data.newestOrderDay && (
          <p className="text-muted">
            Orders from {fmtDay(data.oldestOrderDay)} to {fmtDay(data.newestOrderDay)}
          </p>
        )}
        {synced && <p className="text-muted">Synced with Shopify {synced}</p>}
        <p className="text-muted">Updates automatically every {everySec} seconds</p>
      </div>
      {data && store.status === "active" && data.orders === 0 && data.products === 0 && (
        <p className="mt-2 text-sm" data-testid="empty-store">
          Your Shopify store doesn&apos;t have any orders or products yet. Add a product or place a test order in Shopify and it will
          show up here automatically.
        </p>
      )}
      {!fullHistory && (
        <p className="mt-1 text-xs text-muted">Shopify shares the most recent 60 days of orders with apps, so older history isn&apos;t included.</p>
      )}
    </section>
  );
}
