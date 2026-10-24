"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { CircleDollarSign, Gem, Package, ShoppingCart } from "lucide-react";
import { useApp, canManage, StoresPending } from "@/components/AppContext";
import { EmptyState, Alert } from "@/components/ui";
import { AboutThisData, EmptyStoreNote, StoreStatus, type LiveState } from "@/components/dashboard/StoreHeader";
import { CompareDates, comparedWith, CompareSelect, CustomDates, DateRangeSelect, periodWords, useDateRange, versusWords, type Shown } from "@/components/dashboard/DateRange";
import { TopicDetail } from "@/components/dashboard/TopicDetail";
import { HistoryLine } from "@/components/dashboard/HistoryLine";
import { availableTopics, useDetailView } from "@/components/dashboard/topics";
import { AreaList, HealthOverview, StoreSummary } from "@/components/dashboard/Overview";
import { AdvertisingSection } from "@/components/dashboard/Advertising";
import { fmtRange, fmtRelative } from "@/components/dashboard/format";
import { KpiCard, SummaryCard } from "@/components/dashboard/HomeCards";
import { OverviewCharts } from "@/components/dashboard/OverviewCharts";
import { appliedCustom } from "@/components/dashboard/redacted";
import { AnimatedNumber } from "@/components/dashboard/Motion";
import type { Capability, Overview } from "@/components/dashboard/types";
import { api, ApiError, apiHref, fmtMoney, fmtNum, friendlyError, isTransient, useLiveApi } from "@/lib/api";
import { scopeList } from "@app/shared/capabilities";
import { ALL_HISTORY } from "@app/shared/dates";
import { hasFullAccess, ROLE_INFO } from "@app/shared/access";
import { NoAccessAssigned } from "@/components/team/AccessStates";
import { hasDashboardAccess, seesTopic, TOPIC_EXPORT, TOPIC_PAGE } from "@/lib/access";

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
  const { workspace, store } = useApp();
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
            ? `bizinsights needs access to ${scopeList(c.missingScopes)}. Reconnect the store to grant it.`
            : requestable
              ? `Needs your permission in Shopify to read ${scopeList(c.missingScopes)}. We'll take you there to approve it.`
              : `Needs access to ${scopeList(c.missingScopes)}. We're waiting on Shopify to approve our access to that data — it isn't something you can turn on.`}
      </p>
      {reconnect && canManage(workspace.role) && store && (
        <Link className="btn-primary mt-2 inline-block" href={reconnectHref(workspace.id, store.shopDomain)}>Reconnect</Link>
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
 * Reconnecting a store: onboarding authorizes it again by name, through the app it is connected
 * with (apps/api `connectApp`), so a merchant is never sent to an app their store may refuse.
 */
const reconnectHref = (ws: string, shop: string) => `/onboarding?${new URLSearchParams({ ws, shop })}`;

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

/** A store's Shopify address: the only thing `?taken=` may put on the page. */
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Coming back from connecting a store another account already has (the API's takenLanding sends
 * /dashboard?ws=…&taken=<shop>, or ?ws=…&store=… when that store is open to this person): say so
 * once, then tidy the address. AppContext has opened the workspace and store by then.
 */
function useStoreTakenNotice(): [string | null, () => void] {
  const { storesStatus } = useApp();
  const [taken, setTaken] = useState<string | null>(null);
  useEffect(() => {
    if (storesStatus !== "ready") return;
    const url = new URL(window.location.href);
    if (!["taken", "ws", "store"].some((k) => url.searchParams.has(k)) || url.searchParams.has("adsConnected")) return;
    const shop = url.searchParams.get("taken");
    if (shop && SHOP_DOMAIN.test(shop)) setTaken(shop);
    for (const k of ["taken", "ws", "store"]) url.searchParams.delete(k);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [storesStatus]);
  return [taken, () => setTaken(null)];
}

/** Placeholder shapes while the first numbers load, in the page's own layout, instead of a blank page. */
function DashboardSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-32" />)}
      </div>
      {[0, 1].map((i) => <div key={i} className="skeleton h-96 rounded-2xl" />)}
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="skeleton h-40 lg:col-span-3" />
        <div className="skeleton h-40 lg:col-span-2" />
      </div>
    </div>
  );
}

/** Ask again now rather than at the next check (every live answer on the page listens for it). */
function RetryButton() {
  return (
    <span className="mt-2 block">
      <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => window.dispatchEvent(new Event("insights:retry"))}>
        Try again
      </button>
    </span>
  );
}

/** "Sebastian" from "Sebastian Tran", for the greeting; nothing when the account has no name. */
const firstName = (name: string | null) => name?.trim().split(/\s+/)[0] || null;

export default function DashboardPage() {
  const { me, workspace, stores, storesStatus, store, access, allowed, offers } = useApp();
  // Team & Access: a member with nothing shared yet asks for no numbers at all.
  const sharesData = hasDashboardAccess(access);
  const adsNotice = useAdsConnectedNotice();
  const [taken, dismissTaken] = useStoreTakenNotice();
  // Where the store's dates begin, from the store list (the API checks the same limits).
  const dates = useDateRange(store?.timezone ?? "UTC", { day: store?.startDay ?? null, created: !!store?.shopCreatedAt });
  const detail = useDetailView();
  const asking = dates.asking;
  // Advertising has its own pages now: ?view=ads (an old link, a bookmark, the health check's row)
  // opens them, with the dates on screen.
  const router = useRouter();
  const page = detail.view ? TOPIC_PAGE[detail.view] : undefined;
  useEffect(() => {
    if (!page) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    router.replace(`${page}${url.search}`);
  }, [page, router]);
  // Driven by the answer the poll itself brings back, so the page speeds up the moment it sees
  // an import running and relaxes again as soon as that import reports it is done.
  const [everySec, setEverySec] = useState(LIVE_EVERY_SEC);
  const path = store && asking && sharesData ? `/workspaces/${workspace.id}/stores/${store.id}/overview?${asking.qs}` : null;
  const { data, dataPath, error, loading, checkedAt, failing } = useLiveApi<Overview>(path, everySec * 1000);
  const syncState = data?.store?.status;
  const adsFetching = !!data && [...(data.modules.ads?.accounts ?? []), ...(data.modules.adsense?.accounts ?? [])].some((a) => a.status === "active" && !a.lastSyncedAt);
  useEffect(() => {
    setEverySec(syncState && IMPORTING.has(syncState) ? IMPORTING_EVERY_SEC : adsFetching ? ADS_FETCHING_EVERY_SEC : LIVE_EVERY_SEC);
  }, [syncState, adsFetching]);
  // The page's own connection: "live" while the last successful check is recent (a missed check or two is fine: the odd
  // request fails even when all is well, e.g. a slow cold start); "checking" until the first
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

  /** Send the owner to Shopify to grant a module's scopes, or (`scopes`) the full order history's. */
  const askShopify = async (pending: string, ask: { module: string } | { scopes: string[] }) => {
    if (!store) return;
    setPendingScope(pending);
    setScopeError(null);
    try {
      const r = await api<{ url: string | null }>(`/workspaces/${workspace.id}/stores/${store.id}/scopes/request`, {
        method: "POST",
        body: ask,
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
  const requestScopes = (c: Capability) => askShopify(c.id, { module: c.id });

  // Never show one store's numbers under another store's name while switching.
  const ov = data && store && data.store.id === store.id ? data : null;
  // The same store's numbers for the previous dates stay up while new dates load. If that load
  // fails they would sit under the new dates' button as if they answered it, so say what they are.
  const olderAnswer = ov !== null && dataPath !== path;

  // The store asked for belongs to another account: what to do instead, the connect button below
  // (no stores yet) or the link here, which the store switcher offers too.
  const takenNotice = taken && (
    <Alert kind="info" onDismiss={dismissTaken}>
      <span className="font-medium">{taken}</span> is already connected to another bizinsights account, so it wasn&apos;t added here. To see it, ask that
      account&apos;s owner to invite you, or connect a different store.
      {stores.length > 0 && canManage(workspace.role) && (
        <>
          {" "}
          <Link className="font-medium underline" href="/settings/stores">Connect another store</Link>
        </>
      )}
    </Alert>
  );

  if (!sharesData) return <NoAccessAssigned workspace={workspace.name} role={ROLE_INFO[access.role].label} />;
  // "No stores" only once the list has actually loaded: until then it means "not known yet".
  if (storesStatus !== "ready") return <StoresPending />;
  if (!stores.length) {
    return (
      <div className="space-y-4">
        {takenNotice}
        <EmptyState
          title="Connect your first store"
          body="Once your Shopify store is connected we'll pull in your orders, products and stock levels and keep everything up to date automatically."
          action={canManage(workspace.role) ? <Link className="btn-primary" href={`/onboarding?ws=${encodeURIComponent(workspace.id)}`}>Continue with Shopify</Link> : <p className="text-sm text-muted">Ask a workspace admin to connect a store.</p>}
        />
      </div>
    );
  }

  const cur = ov?.store.currency ?? store?.currency ?? "USD";
  const m = ov?.modules;
  // Unlocking more data is the store's owners' and admins' business, not a shared member's.
  // The Inventory pages ask for their own access (stock levels, stock changes): not a dashboard card.
  const disabled = hasFullAccess(access.role) ? (ov?.capabilities.filter((c) => !c.enabled && c.area !== "inventory") ?? []) : [];
  const exportSection = detail.view && allowed("reports.export") && seesTopic(access, detail.view, offers) ? TOPIC_EXPORT[detail.view] : undefined;
  const exportHref = exportSection && store && asking ? apiHref(`/workspaces/${workspace.id}/stores/${store.id}/export?section=${exportSection}&${asking.qs}`) : null;
  const headerStore = ov?.store ?? store;
  const contactsOn = ov?.capabilities.some((c) => c.id === "contacts" && c.enabled) ?? false;
  const topics = ov ? availableTopics(ov, contactsOn) : [];
  const s = m?.sales_overview;
  const custom = appliedCustom(s);

  const shown: Shown = ov && { range: ov.range, previous: ov.previous, timezone: ov.store.timezone };
  // Every day of the dates lies before the orders Shopify shared: there are no figures for them,
  // which isn't the same as $0 (the line under the dates says why).
  const historyFrom = ov?.data?.historyFrom;
  const notImported = !!ov && !!historyFrom && historyFrom !== ALL_HISTORY && ov.range.to < historyFrom;
  const figure = (n: ReactNode) =>
    notImported ? (
      <span className="text-base font-semibold text-muted sm:text-lg" data-testid="figure-not-imported">
        Not imported
      </span>
    ) : (
      n
    );
  const compared = comparedWith(shown);
  const versus = versusWords(shown);
  const name = firstName(me.user.displayName);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight sm:text-[1.75rem]">
            Welcome back{name ? `, ${name}` : ""}! <span aria-hidden>👋</span>
          </h1>
          <p className="mt-1 text-sm text-muted sm:text-base">
            Here&apos;s what&apos;s happening with {hasFullAccess(access.role) ? "your store" : workspace.name} {periodWords(dates, shown)}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {headerStore && <StoreStatus key={headerStore.id} store={headerStore} live={live} freshness={ov?.freshness} check={ov?.store.id === headerStore.id ? ov?.check : undefined} now={now} />}
          <DateRangeSelect r={dates} shown={shown} id="date-range" label="Dates" />
          {/* What the ▲ ▼ changes are on, as Shopify Analytics' second date chip. */}
          <CompareSelect r={dates} shown={shown} current={!olderAnswer} id="compare-with" label="Compare with" />
        </div>
        {dates.preset === "custom" && (
          <div className="flex w-full justify-end">
            <CustomDates r={dates} />
          </div>
        )}
        {dates.compare === "custom" && (
          <div className="flex w-full justify-end">
            <CompareDates r={dates} />
          </div>
        )}
      </header>

      {adsNotice && <Alert kind="success">{adsNotice}</Alert>}
      {takenNotice}

      {ov && (
        <HistoryLine
          ov={ov}
          loading={olderAnswer && loading && !error ? (asking?.label ?? null) : null}
          canManage={canManage(workspace.role)}
          reconnectHref={reconnectHref(workspace.id, ov.store.shopDomain)}
          onImportHistory={() => void askShopify("order_history", { scopes: ["read_all_orders"] })}
          importing={pendingScope === "order_history"}
        />
      )}
      {scopeError && pendingScope === null && disabled.length === 0 && <Alert>{scopeError}</Alert>}

      {error && !ov && (
        <Alert kind={isTransient(error) ? "info" : "error"}>
          {friendlyError(error)}
          <RetryButton />
        </Alert>
      )}
      {error && ov && olderAnswer && (
        <Alert kind={isTransient(error) ? "info" : "error"}>
          Couldn&apos;t load {asking?.label}, so the numbers below are still for {fmtRange(ov.range.from, ov.range.to)}. {friendlyError(error)}
          <RetryButton />
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
          ) : ov.syncProblem === "not_approved" ? (
            <>
              <p>Shopify hasn&apos;t approved bizinsights to read {ov.store.name ?? ov.store.shopDomain}&apos;s orders yet.</p>
              <p className="mt-1 text-xs">
                Shopify has to approve an app before it can read orders, which hold customer details, on merchants&apos; stores, and bizinsights is still waiting on that
                approval. There&apos;s nothing to do on your side, and reconnecting won&apos;t change it. We try again about every half hour while this page is open, so
                your orders import by themselves once Shopify approves.
              </p>
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
                  ? "Shopify stopped accepting bizinsights' access. Reconnecting grants it again and restarts the import straight away."
                  : "If it keeps coming back, Shopify has most likely stopped accepting our access. Reconnecting grants it again and restarts the import straight away."}
              </p>
              {canManage(workspace.role) && (
                <Link className="btn-primary mt-2 inline-block" href={reconnectHref(workspace.id, ov.store.shopDomain)}>Reconnect</Link>
              )}
            </>
          )}
        </Alert>
      )}

      {ov && <EmptyStoreNote store={ov.store} data={ov.data} />}

      {/* The page says each thing once: four numbers, sales day by day and month by month against
          the years before (the owner's design, components/dashboard/OverviewCharts.tsx), one health
          check and one sentence, then one card per area of the store (worst first). Every number
          and card opens the full details (components/dashboard/TopicDetail.tsx), so nothing is
          lost by keeping this page short. */}
      {s && (
        <section aria-label="Headline numbers" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          {/* Total sales, as Shopify's home page headlines it: the same figure for the same dates. It
              holds tax and shipping, so a member who may not see those (Team & Access) gets net sales. */}
          {s.current.totalSales !== undefined ? (
            <KpiCard
              i={0}
              icon={CircleDollarSign}
              tint="green"
              title="Total sales"
              value={figure(<AnimatedNumber value={s.current.totalSales} format={(n) => fmtMoney(n, cur)} />)}
              delta={s.deltas.totalSales ?? null}
              compared={compared}
              versus={versus}
              // The store's own calculation, when it shows it: under Shopify's figure, named, never instead of it.
              extra={
                custom ? (
                  <span data-testid="tile-custom-sales" title={`Custom sales · ${custom.name}: ${fmtMoney(custom.current, cur)}`}>
                    Custom sales <span className="font-semibold text-text">{fmtMoney(custom.current, cur)}</span>
                    <span className="block truncate">{custom.name}</span>
                  </span>
                ) : undefined
              }
              onClick={() => detail.open("sales")}
            />
          ) : (
            <KpiCard i={0} icon={CircleDollarSign} tint="green" title="Net sales" value={figure(<AnimatedNumber value={s.current.netSales} format={(n) => fmtMoney(n, cur)} />)} delta={s.deltas.netSales} compared={compared} versus={versus} onClick={() => detail.open("sales")} />
          )}
          <KpiCard i={1} icon={ShoppingCart} tint="blue" title="Orders" value={figure(<AnimatedNumber value={s.current.orders} format={fmtNum} />)} delta={s.deltas.orders} compared={compared} versus={versus} onClick={() => detail.open("sales")} />
          <KpiCard i={2} icon={Gem} tint="violet" title="Average order value" value={figure(<AnimatedNumber value={s.current.averageOrderValue} format={(n) => fmtMoney(n, cur)} />)} delta={s.deltas.averageOrderValue} compared={compared} versus={versus} onClick={() => detail.open("sales")} />
          <KpiCard i={3} icon={Package} tint="amber" title="Total products sold" value={figure(<AnimatedNumber value={s.current.units} format={fmtNum} />)} delta={s.deltas.units} compared={compared} versus={versus} onClick={() => detail.open("products")} />
        </section>
      )}

      {ov && s && <OverviewCharts ov={ov} currency={cur} />}

      {ov && (
        <div className="grid gap-4 lg:grid-cols-5">
          <div className={s ? "lg:col-span-3" : "lg:col-span-5"}>
            <HealthOverview ov={ov} currency={cur} onOpen={detail.open} report={seesTopic(access, "overview")} />
          </div>
          {s && (
            <div className="lg:col-span-2">
              <SummaryCard aside={<DateRangeSelect r={dates} shown={shown} id="summary-range" label="Period" size="sm" />}>
                <StoreSummary ov={ov} currency={cur} />
              </SummaryCard>
            </div>
          )}
        </div>
      )}

      {ov && <AreaList ov={ov} currency={cur} topics={topics} onOpen={detail.open} />}

      {/* Ad platforms report about themselves, so they get their own section rather than a card in
          the store's list: results when connected, one way in when not (components/dashboard/Advertising.tsx).
          Not in a workspace that leaves advertising out (lib/features.ts). */}
      {ov && offers("ads") && <AdvertisingSection ov={ov} manage={allowed("integrations.manage")} />}

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

      {ov && (
        <AboutThisData
          store={ov.store}
          data={ov.data}
          freshness={ov.freshness}
          everySec={everySec}
          check={ov.check}
          ws={workspace.id}
          seesFigures={allowed("finance.breakdown")}
          canCheck={allowed("integrations.manage")}
        />
      )}

      {ov && detail.view && !page && (
        <TopicDetail topic={detail.view} ov={ov} currency={cur} contactsOn={contactsOn} onClose={detail.close} onOpen={detail.open} exportHref={exportHref} canPrint={hasFullAccess(access.role) || allowed("reports.export")} />
      )}
    </div>
  );
}
