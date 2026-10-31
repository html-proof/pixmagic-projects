"use client";
import { useState } from "react";
import { META_ACTION_LABEL, META_STATE_INFO, type MetaConnectionState, type MetaDiscoveryAction, type MetaShopifyMarker } from "@app/shared/metaDiscovery";
import { useApp } from "@/components/AppContext";
import { ShopifyIcon } from "@/components/ShopifyIcon";
import { plural } from "@/components/dashboard/format";
import { leavingForSignIn } from "@/lib/adSignIn";
import { actionError, api, ApiError, useApi } from "@/lib/api";

// ---------------------------------------------------------------------------
// Meta, found through the store's Shopify connection (GET .../meta/discovery; the states in
// @app/shared/metaDiscovery, docs/meta-discovery.md): what the store's Shopify orders show of Facebook
// and Instagram, and the one step left, if there is one. Shopify never shares its own Meta access with
// bizinsights, so Meta seen there is said to be seen there, never "connected": Meta's figures need a
// Meta sign-in given to bizinsights, and someone who gave one for another store uses it here without
// Meta's screen ("Use my Meta sign-in").
// ---------------------------------------------------------------------------

/** The API's answer (core's MetaDiscovery, dates as strings). */
export interface MetaDiscoveryAnswer {
  state: MetaConnectionState;
  marker: MetaShopifyMarker | null;
  authorizedForOurApp: boolean;
  shopifySharesMetaAccess: boolean;
  shopify: { ordersRead: boolean; days: number; orders: number | null; facebook: number | null; instagram: number | null; paidOrders: number | null; lastOrderAt: string | null };
  assets: {
    adAccounts: Array<{ id: string; accountId: string; name: string | null; currency: string | null; state: MetaConnectionState; enabled: boolean; lastSyncedAt: string | null }>;
    campaigns: number;
    waitingLogin: { name: string | null } | null;
  };
  reuse: { storeName: string | null } | null;
  action: MetaDiscoveryAction | null;
  configured: boolean;
}

/** The store's answer; none without a store, or for someone who may not see integration status. */
export function useMetaDiscovery(storeBase: string | null) {
  return useApi<MetaDiscoveryAnswer>(storeBase ? `${storeBase}/meta/discovery` : null);
}

/**
 * The note for the store picked at the top, on pages that already say Meta isn't connected (the
 * Advertising pages, the dashboard's advertising card): shown only when it adds something, which is
 * Meta seen in Shopify, a sign-in to reuse, or one to fix. Nothing for someone who may not see
 * integration status.
 */
export function StoreMetaDiscovery({ compact = false, boxed = false }: { compact?: boolean; /** In a card of its own. */ boxed?: boolean }) {
  const { workspace, store, allowed } = useApp();
  const storeBase = store && allowed("integrations.status") ? `/workspaces/${workspace.id}/stores/${store.id}` : null;
  const { data } = useMetaDiscovery(storeBase);
  if (!data || !storeBase || !store) return null;
  if (data.state === "AUTHORIZED_FOR_OUR_APP" || (data.state === "NOT_CONNECTED" && data.action !== "reuse")) return null;
  const note = <MetaDiscoveryNote d={data} storeBase={storeBase} storeId={store.id} compact={compact} />;
  return boxed ? <div className="card">{note}</div> : note;
}

/** What Shopify's orders show, in one sentence; null when they show nothing. */
export function shopifyEvidenceLine(d: MetaDiscoveryAnswer): string | null {
  const s = d.shopify;
  if (s.orders === null) return d.state === "CONNECTED_IN_SHOPIFY" ? "Your Shopify orders show Facebook and Instagram bringing this store customers." : null;
  if (!s.orders) return null;
  const sites = [s.facebook ? `Facebook ${s.facebook}` : null, s.instagram ? `Instagram ${s.instagram}` : null].filter(Boolean).join(", ");
  const paid = s.paidOrders ? `, ${plural(s.paidOrders, "order")} through an ad link` : "";
  return `Shopify recorded ${plural(s.orders, "order")} from Facebook and Instagram in the last ${s.days} days (${sites}${paid}).`;
}

/**
 * The note: the state, what Shopify shows, and its button. Nothing once bizinsights' authorization
 * works (the page shows Meta's figures then). `connectHere` false: the page has its own button to
 * Meta's sign-in (Settings → Integrations' row), so the note offers only the sign-in to reuse.
 */
export function MetaDiscoveryNote({
  d,
  storeBase,
  storeId,
  connectHere = true,
  compact = false,
}: {
  d: MetaDiscoveryAnswer;
  storeBase: string;
  storeId: string;
  connectHere?: boolean;
  /** One short block, for the dashboard's cards. */
  compact?: boolean;
}) {
  const [working, setWorking] = useState<MetaDiscoveryAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The reused sign-in stopped working: Meta's own sign-in is the way left.
  const [reuseGone, setReuseGone] = useState(false);
  if (d.state === "AUTHORIZED_FOR_OUR_APP") return null;
  const info = META_STATE_INFO[d.state];
  const action: MetaDiscoveryAction | null = d.action === "reuse" && reuseGone ? (d.state === "NOT_CONNECTED" || d.state === "CONNECTED_IN_SHOPIFY" ? "connect" : "reconnect") : d.action;
  const evidence = shopifyEvidenceLine(d);

  const signIn = async (a: MetaDiscoveryAction) => {
    setError(null);
    setWorking(a);
    try {
      const { url } = await api<{ url: string }>(`${storeBase}/ads/meta/connect`, { method: "POST", body: {} });
      leavingForSignIn("meta");
      window.location.assign(url);
    } catch (e) {
      setWorking(null);
      setError(actionError(e, "start connecting Meta"));
    }
  };

  const reuse = async () => {
    setError(null);
    setWorking("reuse");
    try {
      const r = await api<{ connected?: number; choose?: string }>(`${storeBase}/ads/meta/reuse`, { method: "POST", body: {} });
      // As after Meta's sign-in: connected goes to the numbers, several accounts to the choice.
      window.location.assign(
        r.choose
          ? `/settings/ads?${new URLSearchParams({ choose: r.choose, provider: "meta", store: storeId })}`
          : `/dashboard?${new URLSearchParams({ adsConnected: "meta", accounts: String(r.connected ?? 0), store: storeId })}`,
      );
    } catch (e) {
      setWorking(null);
      if (e instanceof ApiError && (e.code === "reuse_ended" || e.code === "reuse_unavailable" || e.code === "no_accounts")) setReuseGone(true);
      setError(e instanceof ApiError && e.message ? e.message : actionError(e, "use your Meta sign-in"));
    }
  };

  const title =
    d.state === "CONNECTED_IN_SHOPIFY"
      ? "Meta found through your Shopify store"
      : d.state === "NOT_CONNECTED"
        ? d.shopify.ordersRead
          ? "Meta isn't connected to this store"
          : "Checking your Shopify orders for Facebook and Instagram"
        : `Meta: ${info.label.toLowerCase()}`;
  const body = [
    evidence,
    d.state === "CONNECTED_IN_SHOPIFY" ? "Shopify doesn't share its own Meta access with other apps, so Meta's spend, impressions, reach, clicks and conversions need your OK for bizinsights, once." : null,
    d.state === "NOT_CONNECTED" ? (d.shopify.ordersRead ? info.line : "Once your Shopify import finishes, bizinsights looks for orders from Facebook and Instagram by itself.") : null,
    d.state !== "CONNECTED_IN_SHOPIFY" && d.state !== "NOT_CONNECTED" ? info.line : null,
    action === "reuse" ? `You already gave bizinsights a Meta sign-in for ${d.reuse?.storeName ?? "another of your stores"}: use it here, with no Meta screen.` : null,
  ].filter(Boolean);

  const buttonBusy = !!working;
  const label = (a: MetaDiscoveryAction) => (working === a ? (a === "reuse" ? "Connecting…" : "Opening Meta…") : META_ACTION_LABEL[a]);
  // The page's own button goes to Meta's sign-in: only the sign-in to reuse is the note's.
  const shown = action && (connectHere || action === "reuse") ? action : null;

  return (
    <div className={compact ? "space-y-2" : "space-y-2 rounded-xl border border-border bg-bg/40 p-3"} data-testid="meta-discovery" data-state={d.state} data-marker={d.marker ?? undefined}>
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        {d.state === "CONNECTED_IN_SHOPIFY" && <ShopifyIcon size={14} />}
        {title}
        {d.marker && (
          <span className="rounded-full bg-border/60 px-2 py-0.5 text-[11px] font-medium text-muted" data-testid="meta-discovery-marker">
            Not authorized for bizinsights yet
          </span>
        )}
      </p>
      {body.map((t) => (
        <p key={t} className="text-xs text-muted">
          {t}
        </p>
      ))}
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
      {shown && (
        <div className="flex flex-wrap items-center gap-3 pt-1">
          {shown === "reuse" ? (
            <>
              <button type="button" className="btn-primary h-9 text-xs" onClick={() => void reuse()} disabled={buttonBusy} data-testid="meta-discovery-reuse">
                {label("reuse")}
              </button>
              {connectHere && (
                <button type="button" className="text-xs text-accent underline-offset-2 hover:underline" onClick={() => void signIn("connect")} disabled={buttonBusy} data-testid="meta-discovery-connect">
                  Use another Facebook login
                </button>
              )}
            </>
          ) : (
            <button type="button" className="btn-primary h-9 text-xs" onClick={() => void signIn(shown)} disabled={buttonBusy} data-testid="meta-discovery-connect">
              {label(shown)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
