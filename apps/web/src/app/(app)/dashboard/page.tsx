"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useApp, canManage, StoresPending } from "@/components/AppContext";
import { EmptyState, Alert } from "@/components/ui";
import { StoreHeader, type LiveState } from "@/components/dashboard/StoreHeader";
import { DateRangeBar, useDateRange } from "@/components/dashboard/DateRange";
import { TopicDetail } from "@/components/dashboard/TopicDetail";
import { availableTopics, useDetailView } from "@/components/dashboard/topics";
import { AreaList, StoreSummary } from "@/components/dashboard/Overview";
import { AdvertisingSection } from "@/components/dashboard/Advertising";
import { fmtRange, fmtRelative } from "@/components/dashboard/format";
import { Icon, type IconName } from "@/components/dashboard/Icons";
import { AnimatedNumber, Sparkline } from "@/components/dashboard/Motion";
import { Delta } from "@/components/dashboard/primitives";
import type { Capability, Overview } from "@/components/dashboard/types";
import { api, ApiError, fmtMoney, fmtNum, fmtPct, friendlyError, isTransient, useLiveApi } from "@/lib/api";
import { scopeList } from "@app/shared/capabilities";

/**
 * Set just before we hand the browser to Shopify's optional-scope screen, and read when the
 * merchant comes back. Shopify's request URL takes no redirect_uri and no state, so it returns
 * them to the app's own URL with nothing to say what happened — this is the only thread between
 * the two halves, and it has to survive a full page load, which is why it is sessionStorage
 * rather than React state. `app/scopes_update` covers the merchant who never comes back.
 */
const AWAITING_GRANT_KEY = "insights:awaiting-scope-grant";

/**
 * One locked module, and what the merchant can actually do about it. A missing scope has three
 * possible answers (see `resolveCapabilities`), and the order below is the order of usefulness:
 *
 * 1. the app asks for it at install but this store never granted it → reconnecting fixes it;
 * 2. it's an optional scope we may ask for now → "Enable", which sends them to Shopify;
 * 3. neither → nothing they can do; say we're waiting on Shopify and offer no button, because a
 *    button that lands them on a Shopify error page reads as the app being broken.
 *
 * A missing *pixel* with the scopes already granted is none of these: a background job creates
 * it, so it resolves itself and the card just says so.
 */
function LockedModule({ c, onRequest, pending }: { c: Capability; onRequest: (c: Capability) => void; pending: boolean }) {
  const { workspace } = useApp();
  const reconnect = c.reconnectableScopes.length > 0;
  const requestable = !reconnect && c.missingScopes.length > 0 && c.requestableScopes.length === c.missingScopes.length;
  return (
    <li className="card lift border-dashed text-sm" data-testid={`locked-${c.id}`}>
      <p className="font-medium">{c.title}</p>
      <p className="text-muted">{c.description}</p>
      <p className="mt-1 text-xs text-muted">
        {/* Named in plain words, not as scope strings: the merchant is being asked to decide
            about their own data, and `read_customer_events` doesn't tell them what that is. */}
        {c.missingScopes.length === 0
          ? "Setting up storefront tracking. This page will update by itself."
          : reconnect
            ? `Insights needs access to ${scopeList(c.missingScopes)}. Reconnect the store to grant it.`
            : requestable
              ? `Needs your permission in Shopify to read ${scopeList(c.missingScopes)}. We'll take you there to approve it.`
              : `Needs access to ${scopeList(c.missingScopes)}. We're waiting on Shopify to approve our access to that data — it isn't something you can turn on.`}
      </p>
      {reconnect && canManage(workspace.role) && (
        <Link className="btn-primary mt-2 inline-block" href="/onboarding">Reconnect</Link>
      )}
      {requestable && canManage(workspace.role) && (
        <button className="btn-primary mt-2" onClick={() => onRequest(c)} disabled={pending}>
          {pending ? "Opening Shopify…" : "Enable"}
        </button>
      )}
    </li>
  );
}

/**
 * The dashboard re-checks the backend this often and only redraws when something changed.
 * (Each check also lets the server re-pull recent data from Shopify on its own schedule.)
 */
const LIVE_EVERY_SEC = 15;

/**
 * While the store is still importing, though, 15s is most of what a small import *costs*: the
 * data was there seconds after connecting and the page simply hadn't looked yet. Check every
 * couple of seconds until the store goes active, then drop back to the relaxed cadence.
 */
const IMPORTING_EVERY_SEC = 2;
const IMPORTING = new Set(["syncing", "pending"]);
/** Just after an ad account is connected, its first 90 days arrive within a minute or two: look more often until they do. */
const ADS_FETCHING_EVERY_SEC = 5;

const AD_PLATFORM_NAME: Record<string, string> = { meta: "Meta Ads", google: "Google Ads", adsense: "Google AdSense" };

/**
 * Coming back from connecting an ad platform (the API sends the browser to
 * /dashboard?adsConnected=meta&accounts=2&store=…): say so once, show that store, and tidy the
 * address without touching the dates the page keeps there.
 */
function useAdsConnectedNotice(): string | null {
  const { stores, storesStatus, setStoreId } = useApp();
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (storesStatus !== "ready") return;
    const url = new URL(window.location.href);
    const provider = url.searchParams.get("adsConnected");
    if (!provider) return;
    const target = url.searchParams.get("store");
    if (target && stores.some((s) => s.id === target)) setStoreId(target);
    const n = Number(url.searchParams.get("accounts") ?? 0);
    const what = provider === "adsense" ? "AdSense account" : "ad account";
    setNotice(`${AD_PLATFORM_NAME[provider] ?? "Ad platform"} connected: ${n} ${what}${n === 1 ? "" : "s"}. We're fetching the last 90 days; the Advertising numbers below fill in within a few minutes.`);
    for (const k of ["adsConnected", "accounts", "store"]) url.searchParams.delete(k);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    // Once, when the store list is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storesStatus]);
  return notice;
}

/** One headline number. Tapping it opens the full details behind it. */
function Metric({
  title,
  value,
  help,
  delta,
  invert,
  icon,
  spark,
  i = 0,
  onClick,
}: {
  title: string;
  value: ReactNode;
  help: string;
  delta?: number | null;
  invert?: boolean;
  icon: IconName;
  /** Daily values for a small trend line under the figure. */
  spark?: number[];
  i?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="card lift animate-rise group relative flex flex-col overflow-hidden text-left"
      style={{ ["--i" as string]: i }}
      data-testid={`metric-${title}`}
    >
      <span className="flex w-full items-start justify-between gap-2">
        <span className="text-sm text-muted">{title}</span>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
          <Icon name={icon} className="h-4 w-4" />
        </span>
      </span>
      <span className="mt-1 block text-xl font-semibold sm:text-2xl">{value}</span>
      {/* "vs before": the tiles sit two to a row on a phone, where the long label wrapped three times. */}
      {delta !== undefined && <Delta value={delta} invert={invert} label="vs before" />}
      {spark && spark.length > 1 && <Sparkline values={spark} className="mt-3 h-9 w-full" />}
      <span className="mt-auto flex w-full items-end gap-1 pt-2 text-xs text-muted">
        <span className="min-w-0 flex-1">{help}</span>
        <Icon name="chevronRight" className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
      </span>
      {/* No aria-label: it would replace the figure; screen readers read the tile, then this. */}
      <span className="sr-only"> – open details</span>
    </button>
  );
}

/** Placeholder shapes while the first numbers load, instead of a blank page. */
function DashboardSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => <div key={i} className="skeleton h-20" />)}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-36" />)}
      </div>
      <div className="skeleton h-64" />
    </div>
  );
}

export default function DashboardPage() {
  const { workspace, stores, storesStatus, store } = useApp();
  const adsNotice = useAdsConnectedNotice();
  const dates = useDateRange(store?.timezone ?? "UTC");
  const detail = useDetailView();
  const asking = dates.asking;
  // Driven by the answer the poll itself brings back, so the page speeds up the moment it sees
  // an import running and relaxes again as soon as that import reports it is done.
  const [everySec, setEverySec] = useState(LIVE_EVERY_SEC);
  const path = store && asking ? `/workspaces/${workspace.id}/stores/${store.id}/overview?${asking.qs}` : null;
  const { data, dataPath, error, loading, checkedAt, failing } = useLiveApi<Overview>(path, everySec * 1000);
  const syncState = data?.store?.status;
  const adsFetching = !!data && [...(data.modules.ads?.accounts ?? []), ...(data.modules.adsense?.accounts ?? [])].some((a) => a.status === "active" && !a.lastSyncedAt);
  useEffect(() => {
    setEverySec(syncState && IMPORTING.has(syncState) ? IMPORTING_EVERY_SEC : adsFetching ? ADS_FETCHING_EVERY_SEC : LIVE_EVERY_SEC);
  }, [syncState, adsFetching]);
  // "Live" while the last successful check is recent (a missed check or two is fine: the odd
  // request fails even when all is well, e.g. a Worker CPU-limit 1102); "checking" until the first
  // answer for this question arrives, or "Reconnecting…" straight away if that check failed
  // (otherwise an outage on arrival, or on picking new dates, reads "Checking…" for good).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), LIVE_EVERY_SEC * 1000);
    return () => window.clearInterval(t);
  }, []);
  const live: LiveState =
    checkedAt === null ? (failing ? "stale" : "checking") : now - checkedAt < LIVE_EVERY_SEC * 3 * 1000 ? "live" : "stale";

  // ---- optional scope grants ----
  const [pendingScope, setPendingScope] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [justGranted, setJustGranted] = useState<string[]>([]);

  /**
   * Ask Shopify what the merchant granted, once, on coming back from the grant screen. The
   * overview poll would eventually show it (the `app/scopes_update` webhook updates the same
   * field), but "eventually" is the wrong answer to someone who just approved and is looking at
   * the page: this closes the loop immediately and doesn't depend on webhook timing.
   */
  useEffect(() => {
    if (!store) return;
    let awaiting: string | null = null;
    try {
      awaiting = window.sessionStorage.getItem(AWAITING_GRANT_KEY);
      if (awaiting) window.sessionStorage.removeItem(AWAITING_GRANT_KEY);
    } catch {
      // Private mode or blocked storage: the webhook is still the backstop.
    }
    if (awaiting !== store.id) return;
    void (async () => {
      try {
        const r = await api<{ granted: string[] }>(`/workspaces/${workspace.id}/stores/${store.id}/scopes/refresh`, { method: "POST" });
        if (r.granted.length) setJustGranted(r.granted);
      } catch {
        // Nothing to tell the merchant: the webhook still updates the scopes, and the poll below
        // will show the modules unlocking. Surfacing an error here would be noise about a
        // reconciliation they never asked for.
      }
    })();
    // Runs once per store per return; the overview poll keeps the page current after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store?.id, workspace.id]);

  const requestScopes = async (c: Capability) => {
    if (!store) return;
    setPendingScope(c.id);
    setScopeError(null);
    try {
      const r = await api<{ url: string | null }>(`/workspaces/${workspace.id}/stores/${store.id}/scopes/request`, {
        method: "POST",
        body: { module: c.id },
      });
      if (!r.url) {
        // Already granted — the poll will unlock the module on its next check.
        setPendingScope(null);
        return;
      }
      try {
        window.sessionStorage.setItem(AWAITING_GRANT_KEY, store.id);
      } catch {
        // See above: the webhook is the backstop.
      }
      window.location.assign(r.url);
    } catch (e) {
      setScopeError(e instanceof ApiError ? e.message : "We couldn't open Shopify. Please try again.");
      setPendingScope(null);
    }
  };

  // Never show one store's numbers under another store's name while switching.
  const ov = data && store && data.store.id === store.id ? data : null;
  // The same store's numbers for the previous dates stay up while new dates load. If that load
  // fails they would sit under the new dates' button as if they answered it, so say what they are.
  const olderAnswer = ov !== null && dataPath !== path;

  // "No stores" only once the list has actually loaded: until then it means "not known yet".
  if (storesStatus !== "ready") return <StoresPending />;
  if (!stores.length) {
    return (
      <EmptyState
        title="Connect your first store"
        body="Once your Shopify store is connected we'll pull in your orders, products and stock levels and keep everything up to date automatically."
        action={canManage(workspace.role) ? <Link className="btn-primary" href="/onboarding">Continue with Shopify</Link> : <p className="text-sm text-muted">Ask a workspace admin to connect a store.</p>}
      />
    );
  }

  const cur = ov?.store.currency ?? store?.currency ?? "USD";
  const m = ov?.modules;
  const disabled = ov?.capabilities.filter((c) => !c.enabled) ?? [];
  const headerStore = ov?.store ?? store;
  const contactsOn = ov?.capabilities.some((c) => c.id === "contacts" && c.enabled) ?? false;
  const topics = ov ? availableTopics(ov, contactsOn) : [];
  const s = m?.sales_overview;
  const f = m?.funnel;

  return (
    <div className="space-y-6">
      {headerStore && (
        <StoreHeader key={headerStore.id} store={headerStore} data={ov?.data} live={live} everySec={everySec} />
      )}

      <DateRangeBar r={dates} shown={ov && { range: ov.range, previous: ov.previous, timezone: ov.store.timezone }} />

      {adsNotice && <Alert kind="success">{adsNotice}</Alert>}

      {error && !ov && <Alert kind={isTransient(error) ? "info" : "error"}>{friendlyError(error)}</Alert>}
      {error && ov && olderAnswer && (
        <Alert kind={isTransient(error) ? "info" : "error"}>
          Couldn&apos;t load {asking?.label}, so the numbers below are still for {fmtRange(ov.range.from, ov.range.to)}. {friendlyError(error)}
        </Alert>
      )}
      {loading && !ov && (
        <>
          <p className="sr-only" role="status">Loading your numbers…</p>
          <DashboardSkeleton />
        </>
      )}
      {ov && ov.store.status === "syncing" && <Alert kind="info">We&apos;re still importing your history. Numbers will fill in over the next few minutes; this page updates by itself.</Alert>}
      {ov && ov.store.status === "error" && (
        <Alert>
          {/* What `autoRefresh` actually does: the failed *job* is given up on, but the store is
              re-seeded once every 30 minutes — from this page's own poll, for the store being
              looked at. Saying "it will not clear on its own" was true of neither half, and sent
              people to reconnect when waiting would have done. Shopify's own answer says which
              (ov.syncProblem): a frozen, missing or locked store isn't fixed by reconnecting. */}
          {ov.syncProblem === "shop_unavailable" ? (
            <>
              <p>
                Shopify says {ov.store.name ?? ov.store.shopDomain} is unavailable: the store is frozen, paused or closed. That usually means an unpaid Shopify
                bill or a trial that has ended.
              </p>
              <p className="mt-1 text-xs">
                Reactivate it in your Shopify admin (Settings → Plan). Syncing starts again by itself within about half an hour; reconnecting won&apos;t help until then.
                Your numbers below are from the last sync{ov.store.lastSyncedAt ? ` (${fmtRelative(ov.store.lastSyncedAt)})` : ""}.
              </p>
              <a className="btn-primary mt-2 inline-block" href={`https://${ov.store.shopDomain}/admin/settings/plan`} target="_blank" rel="noreferrer">Open Shopify admin</a>
            </>
          ) : ov.syncProblem === "shop_locked" ? (
            <>
              <p>Shopify has locked {ov.store.name ?? ov.store.shopDomain}, so it can&apos;t be read right now.</p>
              <p className="mt-1 text-xs">Check your Shopify admin for a notice. Syncing starts again by itself once Shopify unlocks the store.</p>
            </>
          ) : (
            <>
              <p>
                {ov.syncProblem === "shop_gone"
                  ? `Shopify can't find ${ov.store.shopDomain} any more: the store may have been closed, or its address changed.`
                  : "Syncing this store has stopped. We try it again about every half hour while this page is open on this store, so it may well fix itself."}
              </p>
              <p className="mt-1 text-xs">
                {ov.syncProblem === "access"
                  ? "Shopify stopped accepting Insights' access. Reconnecting grants it again and restarts the import straight away."
                  : "If it keeps coming back, Shopify has most likely stopped accepting our access. Reconnecting grants it again and restarts the import straight away."}
              </p>
              {canManage(workspace.role) && (
                <Link className="btn-primary mt-2 inline-block" href="/onboarding">Reconnect</Link>
              )}
            </>
          )}
        </Alert>
      )}

      {ov && !ov.hasData && ov.store.status !== "syncing" && s && (
        <EmptyState title="No orders in this period" body="Try a longer date range. New orders show up here within a minute of being placed." />
      )}

      {/* The main page says each thing once: one sentence, four numbers, and one list of every
          area of the store (worst first). Every number and row opens the full details
          (components/dashboard/TopicDetail.tsx), so nothing is lost by keeping this page short. */}
      {s && (
        <section aria-labelledby="numbers-h">
          <h2 id="numbers-h" className="mb-1 flex items-center gap-2 font-semibold"><Icon name="chart" className="h-5 w-5 text-accent" />How your store is doing</h2>
          <div className="mb-3">
            {ov && <StoreSummary ov={ov} currency={cur} />}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <Metric i={0} icon="bag" title="Net sales" value={<AnimatedNumber value={s.current.netSales} format={(n) => fmtMoney(n, cur)} />} delta={s.deltas.netSales} spark={s.series.map((x) => x.netSales)} help="What you kept, after discounts and refunds." onClick={() => detail.open("sales")} />
            <Metric i={1} icon="receipt" title="Orders" value={<AnimatedNumber value={s.current.orders} format={fmtNum} />} delta={s.deltas.orders} spark={s.series.map((x) => x.orders)} help="Orders placed, not counting cancelled ones." onClick={() => detail.open("sales")} />
            <Metric i={2} icon="cart" title="Average order value" value={<AnimatedNumber value={s.current.averageOrderValue} format={(n) => fmtMoney(n, cur)} />} delta={s.deltas.averageOrderValue} help="Typical spend per order." onClick={() => detail.open("sales")} />
            {f && f.visits > 0 ? (
              <Metric i={3} icon="eye" title="Visitors who bought" value={<AnimatedNumber value={f.conversionRate} format={fmtPct} />} delta={f.deltas.conversionRate} help={`Of ${fmtNum(f.visits)} visits to your store.`} onClick={() => detail.open("shoppers")} />
            ) : (
              <Metric i={3} icon="trendUp" title="Gross sales" value={<AnimatedNumber value={s.current.grossSales} format={(n) => fmtMoney(n, cur)} />} delta={s.deltas.grossSales} help="Full price of items sold." onClick={() => detail.open("sales")} />
            )}
          </div>
        </section>
      )}

      {/* Ad platforms report about themselves, so they get their own section rather than a row in
          the store's list: results when connected, one way in when not (components/dashboard/Advertising.tsx). */}
      {ov && <AdvertisingSection ov={ov} manage={canManage(workspace.role)} onOpen={detail.open} />}

      {ov && <AreaList ov={ov} currency={cur} topics={topics} onOpen={detail.open} />}

      {disabled.length > 0 && (
        <section aria-labelledby="more-h">
          <h2 id="more-h" className="mb-2 text-sm font-semibold text-muted">More insights you can unlock</h2>
          {scopeError && <div className="mb-2"><Alert>{scopeError}</Alert></div>}
          {justGranted.length > 0 && (
            <div className="mb-2">
              <Alert kind="success">
                Thanks — Shopify granted {justGranted.join(" and ")}. We&apos;re importing the data behind it now; this page will fill in by itself.
              </Alert>
            </div>
          )}
          <ul className="grid gap-3 sm:grid-cols-2">
            {disabled.map((c) => (
              <LockedModule key={c.id} c={c} onRequest={requestScopes} pending={pendingScope === c.id} />
            ))}
          </ul>
        </section>
      )}

      {ov && detail.view && <TopicDetail topic={detail.view} ov={ov} currency={cur} contactsOn={contactsOn} onClose={detail.close} onOpen={detail.open} />}
    </div>
  );
}
