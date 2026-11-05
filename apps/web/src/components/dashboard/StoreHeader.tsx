"use client";
import { fmtNum } from "@/lib/api";
import { fmtDay, fmtRelative } from "./format";
import { Dot, type Tone } from "./Primitives";
import { CheckDetails, CheckPill, checkPill } from "./ShopifyCheck";
import type { CheckSummary, Freshness, ImportedData, OverviewStore } from "./types";

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

/** Whether this page reaches bizinsights: its own connection, not how current the data is. */
export type LiveState = "checking" | "live" | "stale";

/** Numbers that matched Shopify this recently read as up to date. */
const FRESH_MS = 15 * 60_000;
/** Changes from Shopify waiting this long to be counted read as a delay. */
const WAITING_LATE_MS = 5 * 60_000;

/**
 * What the second pill says: how current the numbers are, from when they last matched Shopify and
 * whether Shopify's changes are waiting or failed (Freshness from the API). It used to say "Live"
 * whenever the page was polling, which said nothing about the data. While the page can't reach
 * bizinsights, that comes first: the numbers on screen are from its last answer.
 */
export function freshnessPill(live: LiveState, f: Freshness | undefined, now: number): { tone: Tone; label: string; title: string } {
  if (live === "stale") return { tone: "warn", label: "Reconnecting…", title: "This page can't reach bizinsights right now. The numbers are from its last answer." };
  if (live === "checking" || !f) return { tone: "neutral", label: "Checking…", title: "Asking bizinsights for the latest numbers." };
  const updated = fmtRelative(f.asOf, now);
  const since = updated ? `Up to date with Shopify as of ${updated}.` : "Not synced with Shopify yet.";
  if (f.failed > 0)
    return {
      tone: "danger",
      label: "Some updates failed",
      title: `${f.failed === 1 ? "1 change" : `${fmtNum(f.failed)} changes`} from Shopify couldn't be counted in the last 24 hours. bizinsights reads those orders again overnight. ${since}`,
    };
  if (f.waiting > 0 && f.waitingSince && now - Date.parse(f.waitingSince) > WAITING_LATE_MS)
    return {
      tone: "warn",
      label: "Catching up",
      title: `${f.waiting === 1 ? "1 change" : `${fmtNum(f.waiting)} changes`} from Shopify since ${fmtRelative(f.waitingSince, now)} are still being counted. ${since}`,
    };
  if (!f.asOf) return { tone: "neutral", label: "Not synced yet", title: since };
  const fresh = now - Date.parse(f.asOf) <= FRESH_MS;
  return {
    tone: fresh ? "good" : "neutral",
    label: `Updated ${updated}`,
    title: `${since} While this page is open, bizinsights checks Shopify for new orders and refunds about every 5 minutes, and every night it reads the latest days again. Shopify's own reports can take a few minutes to include new orders too.`,
  };
}

const pill = "inline-flex h-9 items-center gap-2 rounded-full border border-border bg-surface px-3.5 text-sm font-medium shadow-[var(--shadow)]";

/**
 * The store's connection, and how current its numbers are. The dashboard keeps itself up to date
 * (it re-checks every few seconds), so there is no refresh button: the second pill says when the
 * numbers last matched Shopify (freshnessPill), or "Reconnecting…" if the page lost the server.
 */
export function StoreStatus({ store, live, freshness, check, now }: { store: OverviewStore; live: LiveState; freshness: Freshness | undefined; check?: CheckSummary; now: number }) {
  const status = STATUS[store.status] ?? { tone: "neutral" as Tone, label: store.status };
  const synced = fmtRelative(store.lastSyncedAt);
  const fresh = freshnessPill(live, freshness, now);
  return (
    <>
      <span className={pill} data-testid="store-status" title={synced ? `Synced with Shopify ${synced}` : "Waiting for the first sync with Shopify"}>
        <Dot tone={status.tone} pulse={store.status === "syncing"} />
        {status.label}
      </span>
      <span className={pill} title={fresh.title} data-testid="live-indicator">
        <Dot tone={fresh.tone} />
        {fresh.label}
      </span>
      <CheckPill check={check} now={now} />
    </>
  );
}

/**
 * The simple Home's line under the greeting (the Stitch design): "Updated 3 min ago · Matches
 * Shopify". The same words as the full dashboard's pills (freshnessPill, checkPill) with their
 * tooltips; the store's connection only when it isn't simply connected ("Importing your data…").
 */
export function StatusWords({ store, live, freshness, check, now }: { store: OverviewStore; live: LiveState; freshness: Freshness | undefined; check?: CheckSummary; now: number }) {
  const status = STATUS[store.status] ?? { tone: "neutral" as Tone, label: store.status };
  const fresh = freshnessPill(live, freshness, now);
  const checked = checkPill(check, now);
  const synced = fmtRelative(store.lastSyncedAt);
  return (
    <>
      {store.status !== "active" && (
        <>
          <span className="inline-flex items-center gap-1.5" data-testid="store-status" title={synced ? `Synced with Shopify ${synced}` : "Waiting for the first sync with Shopify"}>
            <Dot tone={status.tone} pulse={store.status === "syncing"} />
            {status.label}
          </span>
          {" · "}
        </>
      )}
      <span className="inline-flex items-center gap-1.5" title={fresh.title} data-testid="live-indicator">
        <Dot tone={fresh.tone} />
        {fresh.label}
      </span>
      {checked && (
        <>
          {" · "}
          <span title={checked.title} data-testid="shopify-check" className={checked.tone === "danger" || checked.tone === "warn" ? "text-warn" : undefined}>
            {checked.label}
          </span>
        </>
      )}
    </>
  );
}

/** What has been imported and how the numbers are counted, folded away at the foot of the page. */
export function AboutThisData({
  store,
  data,
  freshness,
  everySec,
  check,
  ws,
  seesFigures = false,
  canCheck = false,
  brief = false,
}: {
  store: OverviewStore;
  data: ImportedData | undefined;
  freshness: Freshness | undefined;
  everySec: number;
  check?: CheckSummary;
  ws?: string;
  seesFigures?: boolean;
  canCheck?: boolean;
  /** The simple Home: its header already says how current the numbers are, so only the fold. */
  brief?: boolean;
}) {
  const synced = fmtRelative(freshness?.asOf ?? store.lastSyncedAt);
  const fullHistory = store.grantedScopes.includes("read_all_orders");
  return (
    <section aria-label="About this data" className={`text-sm text-muted ${brief ? "text-center" : ""}`} data-testid="about-data">
      {!brief && (
        <p>
          {synced ? <>Up to date with Shopify as of {synced}</> : <>Waiting for the first sync with Shopify</>} · this page updates by itself
        </p>
      )}
      <details className={brief ? "" : "mt-1"}>
        <summary className={`w-fit cursor-pointer underline decoration-border underline-offset-4 hover:text-text ${brief ? "mx-auto text-[13px]" : ""}`}>About this data</summary>
        <div className={`mt-2 space-y-1 ${brief ? "mx-auto max-w-2xl text-left" : ""}`}>
          {data ? (
            // Only the counts this member may see (Team & Access leaves out the others).
            (data.orders !== undefined || data.products !== undefined) && (
              <p data-testid="imported-summary" className="text-text">
                Imported{" "}
                {[
                  data.orders !== undefined && <Count key="o" n={data.orders} one="order" />,
                  data.products !== undefined && <Count key="p" n={data.products} one="product" />,
                  data.variants !== undefined && <Count key="v" n={data.variants} one="variant" />,
                ]
                  .filter(Boolean)
                  .flatMap((c, i) => (i ? [" · ", c] : [c]))}
              </p>
            )
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
          <p>
            This page asks for new numbers every {everySec} seconds. While it is open, bizinsights checks Shopify for new orders and refunds about every 5
            minutes (Sync now in Settings → Shopify checks straight away), and every night it reads the latest days again, so Shopify&apos;s reports and
            these may briefly differ. Test orders aren&apos;t counted, as in Shopify&apos;s reports.
          </p>
          {!fullHistory && <p>Shopify shares the most recent 60 days of orders with apps, so older history isn&apos;t included.</p>}
          {ws && store.status !== "uninstalled" && <CheckDetails ws={ws} storeId={store.id} check={check} seesFigures={seesFigures} canRun={canCheck && store.status === "active"} />}
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
      Your Shopify store doesn&apos;t have any orders or products yet. Add a product, or create an order in Shopify (Orders → Create order, then mark it
      as paid), and it shows up here the next time bizinsights checks Shopify; Sync now in Settings → Shopify checks straight away. Test orders
      aren&apos;t counted, as in Shopify&apos;s reports.
    </p>
  );
}
