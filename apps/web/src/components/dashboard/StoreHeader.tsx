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
 * Store identity and connection status, with what has been imported folded under "About this data". The dashboard keeps itself
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
            <p className="truncate text-sm text-muted">{store.shopDomain}</p>
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

      {/* One line that matters; the rest of what we know about the data is a tap away. */}
      <p className="mt-4 border-t border-border pt-3 text-sm text-muted">
        {synced ? <>Synced with Shopify {synced}</> : <>Waiting for the first sync with Shopify</>} · this page updates by itself
      </p>
      <details className="mt-1 text-sm">
        <summary className="w-fit cursor-pointer text-muted underline decoration-border underline-offset-4 hover:text-text">About this data</summary>
        <div className="mt-2 space-y-1 text-muted">
          {data ? (
            <p data-testid="imported-summary" className="text-text">
              Imported <Count n={data.orders} one="order" /> · <Count n={data.products} one="product" /> · <Count n={data.variants} one="variant" />
            </p>
          ) : (
            <p>Counting what&apos;s been imported…</p>
          )}
          {data?.oldestOrderDay && data.newestOrderDay && (
            <p>
              Orders from {fmtDay(data.oldestOrderDay)} to {fmtDay(data.newestOrderDay)}
            </p>
          )}
          <p>
            Money in {store.currency}. Days and times follow the store&apos;s time zone ({store.timezone}). {store.shopDomain}
          </p>
          <p>New numbers are checked every {everySec} seconds.</p>
          {!fullHistory && <p>Shopify shares the most recent 60 days of orders with apps, so older history isn&apos;t included.</p>}
        </div>
      </details>
      {data && store.status === "active" && data.orders === 0 && data.products === 0 && (
        <p className="mt-2 text-sm" data-testid="empty-store">
          Your Shopify store doesn&apos;t have any orders or products yet. Add a product or place a test order in Shopify and it will
          show up here automatically.
        </p>
      )}
    </section>
  );
}
