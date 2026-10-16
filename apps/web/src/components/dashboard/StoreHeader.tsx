"use client";
import { fmtNum } from "@/lib/api";
import { fmtDay, fmtRelative } from "./format";
import { Dot, type Tone } from "./Primitives";
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

const LIVE: Record<LiveState, { tone: Tone; label: string }> = {
  checking: { tone: "neutral", label: "Checking…" },
  live: { tone: "good", label: "Live" },
  stale: { tone: "warn", label: "Reconnecting…" },
};

const pill = "inline-flex h-9 items-center gap-2 rounded-full border border-border bg-surface px-3.5 text-sm font-medium shadow-[var(--shadow)]";

/**
 * The store's connection, and whether this page is live. The dashboard keeps itself up to date
 * (it re-checks every few seconds), so there is no refresh button: "Live" says so, and turns to
 * "Reconnecting…" if the last checks couldn't reach the server.
 */
export function StoreStatus({ store, live, everySec }: { store: OverviewStore; live: LiveState; everySec: number }) {
  const status = STATUS[store.status] ?? { tone: "neutral" as Tone, label: store.status };
  const synced = fmtRelative(store.lastSyncedAt);
  return (
    <>
      <span className={pill} data-testid="store-status" title={synced ? `Synced with Shopify ${synced}` : "Waiting for the first sync with Shopify"}>
        <Dot tone={status.tone} pulse={store.status === "syncing"} />
        {status.label}
      </span>
      <span className={pill} title={`This page checks for new data every ${everySec} seconds`} data-testid="live-indicator">
        <Dot tone={LIVE[live].tone} pulse={live === "live"} />
        {LIVE[live].label}
      </span>
    </>
  );
}

/** What has been imported and how the numbers are counted, folded away at the foot of the page. */
export function AboutThisData({ store, data, everySec }: { store: OverviewStore; data: ImportedData | undefined; everySec: number }) {
  const synced = fmtRelative(store.lastSyncedAt);
  const fullHistory = store.grantedScopes.includes("read_all_orders");
  return (
    <section aria-label="About this data" className="text-sm text-muted" data-testid="about-data">
      <p>
        {synced ? <>Synced with Shopify {synced}</> : <>Waiting for the first sync with Shopify</>} · this page updates by itself
      </p>
      <details className="mt-1">
        <summary className="w-fit cursor-pointer underline decoration-border underline-offset-4 hover:text-text">About this data</summary>
        <div className="mt-2 space-y-1">
          {data ? (
            <p data-testid="imported-summary" className="text-text">
              Imported <Count n={data.orders ?? 0} one="order" /> · <Count n={data.products ?? 0} one="product" /> · <Count n={data.variants ?? 0} one="variant" />
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
    </section>
  );
}

/** A connected store with nothing in it yet reads as broken unless the page says so. */
export function EmptyStoreNote({ store, data }: { store: OverviewStore; data: ImportedData | undefined }) {
  if (!data || store.status !== "active" || data.orders !== 0 || data.products !== 0) return null;
  return (
    <p className="alert alert-info" data-testid="empty-store">
      Your Shopify store doesn&apos;t have any orders or products yet. Add a product or place a test order in Shopify and it will show up here
      automatically.
    </p>
  );
}
