"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useApp, canManage, StoresPending } from "@/components/AppContext";
import { EmptyState, Alert } from "@/components/ui";
import { TrendChart } from "@/components/TrendChart";
import { StoreHeader, type LiveState } from "@/components/dashboard/StoreHeader";
import {
  CatalogCard,
  ChannelsCard,
  DiscountCodesCard,
  FulfillmentCard,
  InventoryCard,
  OrderTimingCard,
  RecentOrdersCard,
  SalesExtras,
} from "@/components/dashboard/modules";
import { ContactsCard } from "@/components/dashboard/contacts";
import { FunnelCard, JourneyCard } from "@/components/dashboard/funnel";
import { fmtDay } from "@/components/dashboard/format";
import { Highlights } from "@/components/dashboard/highlights";
import { Icon, type IconName } from "@/components/dashboard/icons";
import { AnimatedNumber, Sparkline } from "@/components/dashboard/motion";
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

const PRESETS = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "mtd", label: "Month to date" },
  { id: "custom", label: "Custom" },
] as const;

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

function Metric({
  title,
  value,
  help,
  delta,
  invert,
  icon,
  spark,
  i = 0,
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
}) {
  return (
    <div className="card lift animate-rise relative flex flex-col overflow-hidden" style={{ ["--i" as string]: i }} data-testid={`metric-${title}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-muted">{title}</p>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/12 text-accent">
          <Icon name={icon} className="h-4 w-4" />
        </span>
      </div>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {delta !== undefined && <Delta value={delta} invert={invert} />}
      {spark && spark.length > 1 && <Sparkline values={spark} className="mt-3 h-9 w-full" />}
      <p className="mt-auto pt-2 text-xs text-muted">{help}</p>
    </div>
  );
}

/** Quick links to each part of the dashboard; sticks to the top while scrolling, and marks where you are. */
function SectionNav({ items }: { items: Array<{ id: string; label: string; icon: IconName }> }) {
  const [active, setActive] = useState<string | null>(null);
  const ids = items.map((i) => i.id).join(",");
  useEffect(() => {
    const els = ids.split(",").map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    if (!els.length || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const seen = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (seen) setActive(seen.target.id);
      },
      { rootMargin: "-120px 0px -60% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [ids]);
  if (items.length < 3) return null;
  return (
    <nav aria-label="Dashboard sections" className="sticky top-0 z-20 -mx-4 border-b border-border/60 bg-bg/80 px-4 py-2 backdrop-blur-md">
      <ul className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
        {items.map((it) => (
          <li key={it.id} className="shrink-0">
            <a
              href={`#${it.id}`}
              aria-current={active === it.id ? "true" : undefined}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition ${active === it.id ? "bg-accent text-accent-ink shadow-sm" : "text-muted hover:bg-surface hover:text-text"}`}
            >
              <Icon name={it.icon} className="h-4 w-4" />
              {it.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
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
  const [preset, setPreset] = useState<(typeof PRESETS)[number]["id"]>("30d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const qs = preset === "custom" ? (from && to ? `preset=custom&from=${from}&to=${to}` : null) : `preset=${preset}`;
  // Driven by the answer the poll itself brings back, so the page speeds up the moment it sees
  // an import running and relaxes again as soon as that import reports it is done.
  const [everySec, setEverySec] = useState(LIVE_EVERY_SEC);
  const path = store && qs ? `/workspaces/${workspace.id}/stores/${store.id}/overview?${qs}` : null;
  const { data, dataPath, error, loading, checkedAt, failing } = useLiveApi<Overview>(path, everySec * 1000);
  const syncState = data?.store?.status;
  useEffect(() => {
    setEverySec(syncState && IMPORTING.has(syncState) ? IMPORTING_EVERY_SEC : LIVE_EVERY_SEC);
  }, [syncState]);
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
  const asked = preset === "custom" ? `${fmtDay(from)} – ${fmtDay(to)}` : PRESETS.find((p) => p.id === preset)!.label;
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
  const tz = ov?.store.timezone ?? store?.timezone ?? "UTC";
  const m = ov?.modules;
  const disabled = ov?.capabilities.filter((c) => !c.enabled) ?? [];
  const headerStore = ov?.store ?? store;
  const contactsOn = ov?.capabilities.some((c) => c.id === "contacts" && c.enabled) ?? false;
  const sections: Array<{ id: string; label: string; icon: IconName }> = [
    { id: "highlights", label: "Highlights", icon: "sparkle" },
    ...(m?.sales_overview ? [{ id: "sales", label: "Sales", icon: "chart" as IconName }] : []),
    ...(m?.funnel ? [{ id: "shoppers", label: "Shoppers", icon: "eye" as IconName }] : []),
    ...(contactsOn ? [{ id: "contacts", label: "Follow up", icon: "mail" as IconName }] : []),
    ...(m?.channels ? [{ id: "channels", label: "Channels", icon: "store" as IconName }] : []),
    ...(m?.top_products ? [{ id: "top-products", label: "Products", icon: "trophy" as IconName }] : []),
    ...(m?.inventory ? [{ id: "inventory", label: "Stock", icon: "box" as IconName }] : []),
    ...(m?.recent_orders ? [{ id: "recent_orders", label: "Orders", icon: "receipt" as IconName }] : []),
  ];

  return (
    <div className="space-y-6">
      {headerStore && (
        <StoreHeader key={headerStore.id} store={headerStore} data={ov?.data} live={live} everySec={everySec} />
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Date range">
          {PRESETS.map((p) => (
            <button key={p.id} onClick={() => setPreset(p.id)} aria-pressed={preset === p.id} className={`rounded-full border px-3 py-1 text-sm transition ${preset === p.id ? "border-accent bg-accent text-accent-ink shadow-sm" : "border-border bg-surface hover:border-accent/60"}`}>
              {p.label}
            </button>
          ))}
          {preset === "custom" && (
            <span className="flex flex-wrap items-center gap-2 text-sm">
              <input aria-label="From" type="date" className="input w-auto" value={from} onChange={(e) => setFrom(e.target.value)} />
              to
              <input aria-label="To" type="date" className="input w-auto" value={to} onChange={(e) => setTo(e.target.value)} />
            </span>
          )}
        </div>
        {ov && (
          <p className="text-xs text-muted">
            Showing {fmtDay(ov.range.from)} – {fmtDay(ov.range.to)} in the store&apos;s time zone ({ov.store.timezone}), compared with {fmtDay(ov.previous.from)} – {fmtDay(ov.previous.to)}.
          </p>
        )}
      </div>

      {error && !ov && <Alert kind={isTransient(error) ? "info" : "error"}>{friendlyError(error)}</Alert>}
      {error && ov && olderAnswer && (
        <Alert kind={isTransient(error) ? "info" : "error"}>
          Couldn&apos;t load {asked}, so the numbers below are still for {fmtDay(ov.range.from)} – {fmtDay(ov.range.to)}. {friendlyError(error)}
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
              people to reconnect when waiting would have done. */}
          <p>Syncing this store has stopped. We try it again about every half hour while this page is open on this store, so it may well fix itself.</p>
          <p className="mt-1 text-xs">If it keeps coming back, Shopify has most likely stopped accepting our access. Reconnecting grants it again and restarts the import straight away.</p>
          {canManage(workspace.role) && (
            <Link className="btn-primary mt-2 inline-block" href="/onboarding">Reconnect</Link>
          )}
        </Alert>
      )}

      {ov && !ov.hasData && ov.store.status !== "syncing" && m?.sales_overview && (
        <EmptyState title="No orders in this period" body="Try a longer date range. New orders show up here within a minute of being placed." />
      )}

      {ov && <SectionNav items={sections} />}

      {ov && <Highlights ov={ov} currency={cur} period={`${fmtDay(ov.range.from)} – ${fmtDay(ov.range.to)}`} />}

      {m?.sales_overview && (
        <section id="sales" className="scroll-mt-28" aria-labelledby="sales-h">
          <h2 id="sales-h" className="mb-3 flex items-center gap-2 font-semibold"><Icon name="chart" className="h-5 w-5 text-accent" />Sales</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric i={0} icon="bag" title="Net sales" value={<AnimatedNumber value={m.sales_overview.current.netSales} format={(n) => fmtMoney(n, cur)} />} delta={m.sales_overview.deltas.netSales} spark={m.sales_overview.series.map((x) => x.netSales)} help="What you kept: sales after discounts and refunds, before tax and shipping." />
            <Metric i={1} icon="receipt" title="Orders" value={<AnimatedNumber value={m.sales_overview.current.orders} format={fmtNum} />} delta={m.sales_overview.deltas.orders} spark={m.sales_overview.series.map((x) => x.orders)} help="Orders placed, not counting cancelled ones." />
            <Metric i={2} icon="cart" title="Average order value" value={<AnimatedNumber value={m.sales_overview.current.averageOrderValue} format={(n) => fmtMoney(n, cur)} />} delta={m.sales_overview.deltas.averageOrderValue} help="Typical spend per order, after discounts." />
            <Metric i={3} icon="trendUp" title="Gross sales" value={<AnimatedNumber value={m.sales_overview.current.grossSales} format={(n) => fmtMoney(n, cur)} />} delta={m.sales_overview.deltas.grossSales} help={`Full price of items sold. Discounts given: ${fmtMoney(m.sales_overview.current.discounts, cur)}.`} />
          </div>
          <SalesExtras s={m.sales_overview.current} currency={cur} />
          {ov?.hasData && (
            <div className="card animate-rise mt-4" style={{ ["--i" as string]: 4 }}>
              <TrendChart label="Net sales per day" format={(n) => fmtMoney(n, cur)} series={m.sales_overview.series.map((s) => ({ day: s.day, value: s.netSales }))} />
            </div>
          )}
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {m?.refunds && (
          <section className="grid gap-4 sm:grid-cols-2" aria-label="Refunds">
            <Metric icon="refresh" title="Refunded" value={<AnimatedNumber value={m.refunds.current.refunds} format={(n) => fmtMoney(n, cur)} />} delta={m.refunds.deltas.refunds} invert help={`Money returned to customers in this period, across ${fmtNum(m.refunds.current.refundedOrders)} orders.`} />
            <Metric i={1} icon="receipt" title="Refund rate" value={<AnimatedNumber value={m.refunds.current.refundRate} format={fmtPct} />} help="Share of sales (after discounts) that was later refunded." />
          </section>
        )}
        {m?.customers && (
          <Metric i={2} icon="users" title="Returning customers" value={<AnimatedNumber value={m.customers.current.returningCustomerRate} format={fmtPct} />} help="Share of orders from people who had ordered before. Higher usually means loyal customers." />
        )}
      </div>

      {(m?.channels || m?.order_timing) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {m.channels && <ChannelsCard m={m.channels} currency={cur} />}
          {m.order_timing && <OrderTimingCard m={m.order_timing} timezone={tz} />}
        </div>
      )}

      {(m?.fulfillment || m?.discount_codes) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {m.fulfillment && <FulfillmentCard m={m.fulfillment} />}
          {m.discount_codes && <DiscountCodesCard m={m.discount_codes} currency={cur} />}
        </div>
      )}

      {(m?.top_products || m?.catalog) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {m.top_products && (
            <section id="top-products" className="card animate-rise min-w-0 scroll-mt-28" aria-labelledby="top-h">
              <h2 id="top-h" className="flex items-center gap-2 font-semibold"><Icon name="trophy" className="h-5 w-5 text-accent-2" />Top products</h2>
              <p className="mt-0.5 text-xs text-muted">Best sellers in these dates, by sales after discounts.</p>
              {m.top_products.items.length === 0 ? (
                <p className="mt-2 text-sm text-muted">No product sales in this period yet.</p>
              ) : (
                <table className="mt-3 w-full text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr><th className="pb-2 font-normal">Product</th><th className="pb-2 text-right font-normal">Units</th><th className="pb-2 text-right font-normal">Revenue</th></tr>
                  </thead>
                  <tbody>
                    {m.top_products.items.map((p, rank) => (
                      <tr key={p.productId ?? p.title} className="border-t border-border transition-colors hover:bg-bg">
                        <td className="py-2 pr-2">
                          <span className={`mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold ${rank === 0 ? "bg-accent-2 text-white" : "bg-border text-muted"}`}>{rank + 1}</span>
                          {p.title}
                        </td>
                        <td className="py-2 text-right tabular-nums">{fmtNum(p.units)}</td>
                        <td className="py-2 text-right tabular-nums">{fmtMoney(p.revenue, cur)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}
          {m.catalog && <CatalogCard m={m.catalog} currency={cur} />}
        </div>
      )}

      {m?.inventory && <InventoryCard m={m.inventory} currency={cur} />}

      {m?.recent_orders && ov && <RecentOrdersCard items={m.recent_orders.items} currency={cur} timezone={tz} shopDomain={ov.store.shopDomain} />}

      {m?.funnel && (
        <section id="shoppers" className="scroll-mt-28 space-y-4" aria-label="Storefront visits">
          <FunnelCard m={m.funnel} />
          {m.funnel.visits > 0 && <JourneyCard m={m.funnel} />}
        </section>
      )}

      {ov && contactsOn && <ContactsCard key={ov.store.id} storeId={ov.store.id} storeName={ov.store.name ?? ov.store.shopDomain} shopDomain={ov.store.shopDomain} />}

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
    </div>
  );
}
