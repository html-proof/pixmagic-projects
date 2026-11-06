"use client";
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { canManage, StoresPending, useApp, type StoreSummary } from "@/components/AppContext";
import { ShopifyConnect } from "@/components/ShopifyConnect";
import { ShopifyIcon } from "@/components/ShopifyIcon";
import { OAUTH_ERRORS } from "@/lib/shopifyErrors";
import { Alert, EmptyState } from "@/components/ui";
import { actionError, api, ApiError } from "@/lib/api";
import { fmtDateTime, fmtRelative } from "@/components/dashboard/format";
import { revokeWords } from "@/components/settings/scopeRevoke";
import { CAPABILITIES, SCOPE_LABELS, expandScopes, scopeLabel, scopeList } from "@app/shared/capabilities";

// ---------------------------------------------------------------------------
// Settings → Shopify: each connected store in the look of the Stitch design's Connections screen
// (prototype v2, screen 30), which this page's card on Settings → Integrations opens with Manage. A
// white card per store: its name and status, what bizinsights can read from it (each permission,
// and which are optional), what that gives the dashboard, its last update and its buttons.
// ---------------------------------------------------------------------------

/** Plain words for a status a merchant has no reason to know the internal name of. */
function statusLabel(status: string, problem?: StoreSummary["syncProblem"]): { text: string; tone: string; dot: string } {
  const good = { tone: "text-good", dot: "bg-good" };
  const quiet = { tone: "text-muted", dot: "bg-muted" };
  const bad = { tone: "text-danger", dot: "bg-danger" };
  switch (status) {
    case "active":
      return { text: "Connected", ...good };
    case "syncing":
      return { text: "Importing your data…", ...quiet };
    case "pending":
      return { text: "Finishing setup…", ...quiet };
    case "uninstalled":
      return { text: "Removed in Shopify", ...quiet };
    case "error":
      // Reconnecting fixes lost access (and is the best guess when Shopify didn't say), not these.
      if (problem === "not_approved") return { text: "Waiting for Shopify to approve bizinsights to read orders", ...quiet };
      if (problem === "shop_unavailable" || problem === "shop_locked") return { text: "Shopify has paused this store — syncing resumes once it's back", ...bad };
      if (problem === "shop_gone") return { text: "Shopify can't find this store any more", ...bad };
      return { text: "Something went wrong — reconnect to fix it", ...bad };
    default:
      return { text: status, ...quiet };
  }
}

/**
 * Why a store isn't disconnected (409 from DELETE …/stores/:id): it carries the plan's charges,
 * which Shopify goes on billing while the app stays installed there, and which nothing here could
 * cancel once the store's access is gone.
 */
const billedRefusals = (domain: string): Record<string, string> => ({
  store_billed: `${domain} pays for this workspace's plan through its Shopify bill. Switch to Free in Settings → Billing first, or uninstall bizinsights from ${domain} in your Shopify admin (Settings → Apps and sales channels), which ends the charge.`,
  store_billed_pending: `A plan change waiting for approval in Shopify is billed through ${domain}. Approve or decline it in Shopify first (Settings → Billing reopens it), then disconnect the store.`,
  plan_billed: "This workspace's plan is billed through one of its stores in Shopify. Switch to Free in Settings → Billing before disconnecting a store.",
});

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
      setError(actionError(e, `disconnect ${domain}`, billedRefusals(domain)));
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
    const words = revokeWords(scope, domain);
    if (!confirm(`${words.question}\n\n${words.consequence}`)) return;
    setRevoking(`${id}:${scope}`);
    setError(null);
    try {
      await api(`/workspaces/${workspace.id}/stores/${id}/scopes/revoke`, { method: "POST", body: { scopes: [scope] } });
      await reloadStores();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : revokeWords(scope, domain).failed);
    } finally {
      setRevoking(null);
    }
  }

  return (
    <section className="space-y-4">
      <header>
        <h1 className="page-title">Shopify stores</h1>
        <p className="mt-1 text-sm text-muted sm:text-base">Each store connected to this workspace, what bizinsights can read from it, and when it was last brought up to date.</p>
      </header>
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
          <section key={s.id} aria-labelledby={`store-${s.id}-h`} className="home-card animate-rise min-w-0 space-y-5 p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div className="flex min-w-0 items-center gap-2.5">
                <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded bg-home-soft">
                  <ShopifyIcon size={26} />
                </span>
                <div className="min-w-0">
                  {/* A paragraph, as before: the e2e suite finds the store's card by this line. */}
                  <p id={`store-${s.id}-h`} className="home-h2 break-words">{s.name ?? s.shopDomain}</p>
                  <p className="text-xs break-words text-muted">{s.shopDomain} · {s.currency} · {s.timezone}</p>
                </div>
              </div>
              <span className={`inline-flex items-center gap-1.5 pt-1 text-xs font-medium ${status.tone}`}>
                <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${status.dot}`} />
                {status.text}
              </span>
            </div>

            {empty && (
              <p className="rounded bg-home-soft p-3 text-sm" data-testid="store-empty">
                Connected, but there was nothing to import: this store has no orders or products in Shopify yet. Add a product, or create
                an order in Shopify (Orders → Create order, then mark it as paid), and press Sync now. Test orders aren&apos;t counted, as in
                Shopify&apos;s reports.
              </p>
            )}

            {/* What the app can read. Lead with what the data *is*, because the scope string is
                the one part of this page a merchant has no way to interpret. */}
            <div className="space-y-2">
              <h2 className="text-sm font-semibold">What bizinsights can read from this store</h2>
              {s.grantedScopes.length === 0 ? (
                <p className="text-sm text-muted">Nothing yet — reconnect the store to grant access.</p>
              ) : (
                <ul className="divide-y divide-home-line rounded border border-home-line">
                  {s.grantedScopes.map((scope) => {
                    // Optional is a fact about the permission, not about who is looking: viewers and
                    // analysts saw every optional permission labelled "Required".
                    const optional = s.revocableScopes.includes(scope);
                    const canRevoke = manage && optional;
                    const busy = revoking === `${s.id}:${scope}`;
                    return (
                      <li key={scope} className="flex items-start justify-between gap-4 px-3 py-2.5" title={scope}>
                        <div className="min-w-0">
                          <p className="text-sm">
                            {scopeLabel(scope)}
                            <span className="ml-2 rounded bg-home-soft px-1.5 py-0.5 text-[11px] font-medium text-muted">{optional ? "Optional" : "Required"}</span>
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
                            aria-label={revokeWords(scope, s.shopDomain).button}
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
              <h2 className="text-sm font-semibold">
                What you get on the dashboard{" "}
                <span className="font-normal text-muted">
                  ({working.length} of {modules.length} reports{empty ? ", waiting for data" : ""})
                </span>
              </h2>
              {working.length > 0 && (
                <ul className="flex flex-wrap gap-1.5 text-xs">
                  {working.map((c) => (
                    <li key={c.id} className="inline-flex items-center gap-1 rounded bg-home-soft px-2 py-0.5 font-medium" title={c.description}>
                      <Check aria-hidden size={11} strokeWidth={3} className="shrink-0 text-accent" />
                      {c.title}
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

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-home-line pt-4">
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
          </section>
        );
      })}
    </section>
  );
}
