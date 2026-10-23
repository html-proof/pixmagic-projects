"use client";
import { useEffect, useState } from "react";
import { canManage, StoresPending, useApp, type StoreSummary } from "@/components/AppContext";
import { ShopifyConnect } from "@/components/ShopifyConnect";
import { OAUTH_ERRORS } from "@/lib/shopifyErrors";
import { Alert, EmptyState } from "@/components/ui";
import { actionError, api, ApiError } from "@/lib/api";
import { fmtDateTime, fmtDay, fmtRelative } from "@/components/dashboard/format";
import { localDay } from "@app/shared/dates";
import { CAPABILITIES, SCOPE_LABELS, expandScopes, scopeLabel, scopeList } from "@app/shared/capabilities";

/** The modules that stop working without `scope`, so a confirm can name them. */
function modulesNeeding(scope: string): string[] {
  return CAPABILITIES.filter((c) => c.requiredScopes.includes(scope)).map((c) => c.title);
}

/** Plain words for a status a merchant has no reason to know the internal name of. */
function statusLabel(status: string, problem?: StoreSummary["syncProblem"]): { text: string; tone: string } {
  switch (status) {
    case "active":
      return { text: "Connected", tone: "text-good" };
    case "syncing":
      return { text: "Importing your data…", tone: "text-muted" };
    case "pending":
      return { text: "Finishing setup…", tone: "text-muted" };
    case "uninstalled":
      return { text: "Removed in Shopify", tone: "text-muted" };
    case "error":
      // Reconnecting fixes lost access (and is the best guess when Shopify didn't say), not these.
      if (problem === "not_approved") return { text: "Waiting for Shopify to approve bizinsights to read orders", tone: "text-muted" };
      if (problem === "shop_unavailable" || problem === "shop_locked") return { text: "Shopify has paused this store — syncing resumes once it's back", tone: "text-danger" };
      if (problem === "shop_gone") return { text: "Shopify can't find this store any more", tone: "text-danger" };
      return { text: "Something went wrong — reconnect to fix it", tone: "text-danger" };
    default:
      return { text: status, tone: "text-muted" };
  }
}

/** The day a store-local instant falls on, or null in a zone this browser doesn't know. */
function storeDay(iso: string, timeZone: string): string | null {
  try {
    return localDay(new Date(iso), timeZone);
  } catch {
    return null;
  }
}

/**
 * When Shopify created the store (where the dashboard's dates begin, All time) and how far back its
 * orders can be read: Shopify shares 60 days of orders unless the store granted access to all of
 * them (read_all_orders).
 */
function StoreDates({ s }: { s: StoreSummary }) {
  const created = s.shopCreatedAt ? storeDay(s.shopCreatedAt, s.timezone) : null;
  const allOrders = expandScopes(s.grantedScopes).has("read_all_orders");
  return (
    <p className="text-xs text-muted" data-testid="store-dates">
      {created ? (
        <>
          Created on Shopify <span className="text-text">{fmtDay(created)}</span>
        </>
      ) : (
        "Creation date not read from Shopify yet"
      )}
      {" · "}
      {allOrders ? "Orders readable back to the store's first" : "Orders readable for the last 60 days (Shopify shares older ones only with access to all orders)"}
    </p>
  );
}

export default function StoresPage() {
  const { workspace, stores, storesStatus, reloadStores, setStoreId } = useApp();
  const manage = canManage(workspace.role);
  /** `${storeId}:${scope}` while that one revoke is in flight, so only its button is busy. */
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The store whose "Sync now" is in flight, and the last one that was started. */
  const [syncing, setSyncing] = useState<string | null>(null);
  const [synced, setSynced] = useState<string | null>(null);
  /** Just back from Shopify with a store connected (`?connected=<store id>`). */
  const [connected, setConnected] = useState<string | null>(null);

  // Shopify's answer to a connect started here comes back to this page: ?connected= or ?error=.
  // Read once, then dropped from the address so a refresh doesn't announce it again.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const id = q.get("connected");
    const code = q.get("error");
    if (!id && !code) return;
    if (id) {
      setConnected(id);
      setStoreId(id);
      void reloadStores().catch(() => {});
    }
    if (code) setError(OAUTH_ERRORS[code] ?? "Shopify didn't complete the connection. Please try again.");
    window.history.replaceState(window.history.state, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const justConnected = connected ? stores.find((s) => s.id === connected) : undefined;

  async function disconnect(id: string, domain: string) {
    // Disconnecting is ours alone: the app stays installed in the merchant's Shopify admin until
    // they uninstall it there, so say so rather than imply Shopify access ends here.
    if (!confirm(`Disconnect ${domain}? Its synced data will be deleted from bizinsights. You can reconnect later.

To stop bizinsights' access in Shopify too, uninstall the app from your Shopify admin.`)) return;
    setError(null);
    try {
      await api(`/workspaces/${workspace.id}/stores/${id}`, { method: "DELETE" });
    } catch (e) {
      setError(actionError(e, `disconnect ${domain}`));
    }
    // Either way: a failure can come after the store was already marked disconnected (the data
    // purge runs last), so the card should show what is true now. Disconnecting again is safe.
    await reloadStores().catch(() => {});
  }

  /** Re-read the store from Shopify now: orders of the whole import window, products and stock. */
  async function syncNow(id: string, domain: string) {
    setSyncing(id);
    setError(null);
    setSynced(null);
    try {
      await api(`/workspaces/${workspace.id}/stores/${id}/resync`, { method: "POST" });
      setSynced(domain);
      await reloadStores().catch(() => {});
    } catch (e) {
      setError(actionError(e, `sync ${domain}`));
    } finally {
      setSyncing(null);
    }
  }

  /**
   * Hand one optional permission back to Shopify. The merchant can grant it again from the
   * locked module on the dashboard, so this is reversible — but the modules it feeds go dark
   * until they do, and the confirm says which ones rather than naming the scope alone.
   */
  async function revoke(id: string, domain: string, scope: string) {
    const affected = modulesNeeding(scope);
    const consequence = affected.length
      ? `${affected.join(", ")} will stop working until you grant it again.`
      : "Nothing on your dashboard uses it today.";
    if (!confirm(`Stop letting bizinsights read ${scopeLabel(scope).toLowerCase()} for ${domain}?\n\n${consequence}`)) return;
    setRevoking(`${id}:${scope}`);
    setError(null);
    try {
      await api(`/workspaces/${workspace.id}/stores/${id}/scopes/revoke`, { method: "POST", body: { scopes: [scope] } });
      await reloadStores();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `We couldn't remove ${scopeLabel(scope).toLowerCase()}. Please try again.`);
    } finally {
      setRevoking(null);
    }
  }

  return (
    <section className="space-y-4">
      <h1 className="text-lg font-semibold">Shopify stores</h1>
      {connected && (
        <Alert kind="success">
          {justConnected ? `${justConnected.name ?? justConnected.shopDomain} is connected.` : "Your store is connected."} We&apos;re importing its
          orders and products now; its card below shows how that&apos;s going, and the dashboard fills in as it lands.
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
      {synced && (
        <Alert kind="success">
          Syncing {synced} with Shopify: its orders, products and stock are being read again. The dashboard fills in as they land.
        </Alert>
      )}
      {manage && <ShopifyConnect workspaceId={workspace.id} />}
      <StoresPending />
      {storesStatus === "ready" && stores.length === 0 && (
        <EmptyState title="No stores yet" body={manage ? "Connect a Shopify store above to start seeing metrics." : "Ask a workspace admin to connect a Shopify store."} />
      )}
      {stores.map((s) => {
        const status = statusLabel(s.status, s.syncProblem);
        // write_X implies read_X, so a store granted write_pixels satisfies a read_pixels need.
        const granted = expandScopes(s.grantedScopes);
        const modules = CAPABILITIES.map((c) => ({
          ...c,
          missingScopes: c.requiredScopes.filter((r) => !granted.has(r)),
        }));
        const working = modules.filter((c) => c.missingScopes.length === 0);
        const blocked = modules.filter((c) => c.missingScopes.length > 0);
        const removable = s.grantedScopes.filter((scope) => s.revocableScopes.includes(scope));
        // Connected, synced, and holding nothing. Without this the card reads exactly like a
        // working store — green ticks, a sync time — while every report has nothing to show.
        const empty = s.status === "active" && s.imported && s.imported.orders === 0 && s.imported.products === 0;

        return (
          <div key={s.id} className="card space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{s.name ?? s.shopDomain}</p>
                <p className="text-xs text-muted">{s.shopDomain} · {s.currency} · {s.timezone}</p>
                <StoreDates s={s} />
              </div>
              <span className={`text-xs ${status.tone}`}>● {status.text}</span>
            </div>

            {empty && (
              <p className="rounded-lg border border-border bg-bg p-3 text-sm" data-testid="store-empty">
                Connected, but there was nothing to import: this store has no orders or products in Shopify yet. Add a product, or create
                an order in Shopify (Orders → Create order, then mark it as paid), and press Sync now. Test orders aren&apos;t counted, as in
                Shopify&apos;s reports.
              </p>
            )}

            {/* What the app can read. Lead with what the data *is*, because the scope string is
                the one part of this page a merchant has no way to interpret. */}
            <div className="space-y-2">
              <h2 className="text-sm font-medium">What bizinsights can read from this store</h2>
              {s.grantedScopes.length === 0 ? (
                <p className="text-sm text-muted">Nothing yet — reconnect the store to grant access.</p>
              ) : (
                <ul className="divide-y divide-border border-y border-border">
                  {s.grantedScopes.map((scope) => {
                    // Optional is a fact about the permission, not about who is looking: viewers and
                    // analysts saw every optional permission labelled "Required".
                    const optional = s.revocableScopes.includes(scope);
                    const canRevoke = manage && optional;
                    const busy = revoking === `${s.id}:${scope}`;
                    return (
                      <li key={scope} className="flex items-start justify-between gap-4 py-2" title={scope}>
                        <div>
                          <p className="text-sm">
                            {scopeLabel(scope)}
                            <span className="ml-2 text-xs text-muted">{optional ? "Optional" : "Required"}</span>
                          </p>
                          <p className="text-xs text-muted">{SCOPE_LABELS[scope]?.description ?? scope}</p>
                        </div>
                        {/* A word, not a ×: this gives up access, and the page's other controls
                            are worded too. */}
                        {canRevoke && (
                          <button
                            type="button"
                            className="shrink-0 text-xs text-muted underline hover:text-danger disabled:opacity-50"
                            data-testid={`revoke-${scope}`}
                            aria-label={`Remove ${scopeLabel(scope).toLowerCase()} permission for ${s.shopDomain}`}
                            disabled={busy}
                            onClick={() => revoke(s.id, s.shopDomain, scope)}
                          >
                            {busy ? "Removing…" : "Remove"}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {manage && removable.length > 0 && (
                <p className="text-xs text-muted">
                  Remove an optional permission and the reports using it go quiet until you grant it again from the
                  dashboard. The required ones only go when you disconnect the store.
                </p>
              )}
            </div>

            {/* The same list as before, but split: a row of identical pills made "working" and
                "not working" look like one undifferentiated set. */}
            <div className="space-y-2">
              <h2 className="text-sm font-medium">
                What you get on the dashboard{" "}
                <span className="font-normal text-muted">
                  ({working.length} of {modules.length} reports{empty ? ", waiting for data" : ""})
                </span>
              </h2>
              {working.length > 0 && (
                <ul className="flex flex-wrap gap-2 text-xs">
                  {working.map((c) => (
                    <li key={c.id} className="rounded-full border border-good px-2 py-0.5 text-good" title={c.description}>
                      ✓ {c.title}
                    </li>
                  ))}
                </ul>
              )}
              {blocked.length > 0 && (
                <>
                  <p className="text-xs text-muted">Not available yet:</p>
                  <ul className="space-y-1 text-xs text-muted">
                    {blocked.map((c) => (
                      <li key={c.id}>
                        <span className="text-text">{c.title}</span> — needs access to{" "}
                        {scopeList(c.missingScopes)}.
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              {s.lastSyncedAt ? (
                // Relative, the way the dashboard header already says it, with the exact time on
                // hover — in the *store's* zone, not the viewer's: the line above this card states
                // the store's time zone, so a timestamp in another one reads as a contradiction.
                <p className="text-xs text-muted" title={`${fmtDateTime(s.lastSyncedAt, s.timezone)} (${s.timezone})`}>
                  Last updated {fmtRelative(s.lastSyncedAt) ?? "just now"} · bizinsights keeps this current on its own
                </p>
              ) : (
                <span />
              )}
              {manage && (
                <div className="flex flex-wrap gap-2">
                  {(s.status === "active" || s.status === "error") && (
                    <button
                      type="button"
                      className="btn-secondary"
                      aria-label={`Sync ${s.shopDomain} with Shopify now`}
                      disabled={syncing === s.id}
                      onClick={() => syncNow(s.id, s.shopDomain)}
                    >
                      {syncing === s.id ? "Starting…" : "Sync now"}
                    </button>
                  )}
                  <button className="btn-danger" aria-label={`Disconnect ${s.shopDomain}`} onClick={() => disconnect(s.id, s.shopDomain)}>Disconnect</button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
