"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { canManage, StoresPending, useApp } from "@/components/AppContext";
import { GoogleIcon, MetaIcon } from "@/components/BrandIcons";
import { Alert } from "@/components/ui";
import { actionError, api, useApi } from "@/lib/api";
import { fmtRelative } from "@/components/dashboard/format";

type Provider = "meta" | "google";

interface Connection {
  id: string;
  provider: Provider;
  accountId: string;
  accountName: string | null;
  currency: string | null;
  timezone: string | null;
  enabled: boolean;
  status: "active" | "reconnect" | "error";
  lastError: string | null;
  lastSyncedAt: string | null;
  accessExpiresAt: string | null;
  connectedAt: string;
}

interface AdsState {
  configured: Record<Provider, boolean>;
  connections: Connection[];
}

const PROVIDERS: Array<{ id: Provider; name: string; sub: string; button: string; Icon: (p: { size?: number }) => ReactNode }> = [
  { id: "meta", name: "Meta Ads", sub: "Facebook and Instagram ads", button: "Continue with Meta", Icon: MetaIcon },
  { id: "google", name: "Google Ads", sub: "Search, Shopping, YouTube and Performance Max", button: "Continue with Google", Icon: GoogleIcon },
];

/** What the callback's ?error= means, in words. */
const ERRORS: Record<string, string> = {
  denied: "You chose not to give Insights access, so nothing was connected.",
  state_mismatch: "That sign-in started in another browser or tab. Please press the button again here.",
  state_expired: "That took a little too long. Please press the button again.",
  session_mismatch: "You were signed in as someone else when you came back. Sign in as yourself and try again.",
  exchange_failed: "The platform didn't accept the sign-in. Please try again in a moment.",
  no_accounts: "That login can't see any ad accounts. Ask the account's owner to give you access, then connect again.",
  no_refresh_token: "Google didn't grant lasting access. Please try again and allow access on Google's screen.",
  missing_params: "The platform didn't send everything back. Please try again.",
  temporarily_unavailable: "Something went wrong on our side. Please try again in a minute.",
};

const PROVIDER_NAME: Record<Provider, string> = { meta: "Meta", google: "Google Ads" };

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
}

function StatusLine({ c }: { c: Connection }) {
  if (!c.enabled) return <span className="text-muted">Hidden from the dashboard</span>;
  if (c.status === "reconnect") return <span className="text-danger">Access has ended. Press {c.provider === "meta" ? "Continue with Meta" : "Continue with Google"} again to reconnect.</span>;
  if (c.status === "error") return <span className="text-warn">Last sync didn&apos;t work{c.lastError ? `: ${c.lastError}` : ""}. We&apos;ll keep trying.</span>;
  if (!c.lastSyncedAt) return <span className="text-muted">Fetching the last 90 days…</span>;
  const left = c.provider === "meta" ? daysUntil(c.accessExpiresAt) : null;
  return (
    <span className="text-muted">
      Up to date · synced {fmtRelative(c.lastSyncedAt)}
      {left !== null && left <= 14 ? <span className="text-warn"> · Meta access ends in {left} day{left === 1 ? "" : "s"}: reconnect to keep it going</span> : null}
    </span>
  );
}

export default function AdAccountsPage() {
  const { workspace, stores, storesStatus, store, setStoreId } = useApp();
  const manage = canManage(workspace.role);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Coming back from Meta or Google: show what happened, for the store that was connected.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const target = q.get("store");
    if (target && stores.some((s) => s.id === target)) setStoreId(target);
    const connected = q.get("connected") as Provider | null;
    const code = q.get("error");
    if (connected) {
      const n = Number(q.get("accounts") ?? 0);
      setNotice(`${PROVIDER_NAME[connected] ?? "Ad platform"} connected: ${n} ad account${n === 1 ? "" : "s"}. The last 90 days are being fetched; numbers appear on the dashboard within a few minutes.`);
    } else if (code) {
      setError(ERRORS[code] ?? "Connecting didn't work. Please try again.");
    }
    if (connected || code) window.history.replaceState(window.history.state, "", "/settings/ads");
    // Once the store list is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storesStatus]);

  const path = store ? `/workspaces/${workspace.id}/stores/${store.id}/ads` : null;
  const { data, error: loadError, reload } = useApi<AdsState>(path);

  // A sync is running in the background after connecting: look again until every account has numbers.
  useEffect(() => {
    if (!data?.connections.some((c) => c.enabled && c.status === "active" && !c.lastSyncedAt)) return;
    const t = window.setInterval(() => void reload(), 5000);
    return () => window.clearInterval(t);
  }, [data, reload]);

  if (storesStatus !== "ready") return <StoresPending />;
  if (!store) {
    return (
      <div className="card">
        <h1 className="text-lg font-semibold">Ad accounts</h1>
        <p className="mt-1 text-sm text-muted">Connect a Shopify store first; ad accounts are connected to a store.</p>
        {manage && <Link href="/onboarding" className="btn-primary mt-3 inline-flex">Connect a store</Link>}
      </div>
    );
  }

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(actionError(e, key.startsWith("connect") ? "start connecting" : "save that change"));
      setBusy(null);
      return;
    }
    setBusy(null);
  };

  const connect = (p: Provider) =>
    run(`connect-${p}`, async () => {
      const { url } = await api<{ url: string }>(`/workspaces/${workspace.id}/stores/${store.id}/ads/${p}/connect`, { method: "POST" });
      window.location.assign(url);
      // Keep the button busy while the browser leaves.
      await new Promise(() => undefined);
    });

  const toggle = (c: Connection) =>
    run(`toggle-${c.id}`, async () => {
      await api(`/workspaces/${workspace.id}/stores/${store.id}/ads/connections/${c.id}`, { method: "PATCH", body: { enabled: !c.enabled } });
      await reload();
    });

  const disconnect = (c: Connection) =>
    run(`delete-${c.id}`, async () => {
      if (!window.confirm(`Disconnect ${c.accountName ?? c.accountId}? Its numbers are removed from Insights. Your ads keep running.`)) return;
      await api(`/workspaces/${workspace.id}/stores/${store.id}/ads/connections/${c.id}`, { method: "DELETE" });
      await reload();
    });

  const syncNow = () =>
    run("sync", async () => {
      const { queued } = await api<{ queued: number }>(`/workspaces/${workspace.id}/stores/${store.id}/ads/sync`, { method: "POST" });
      setNotice(queued ? `Fetching the last 30 days for ${queued} account${queued === 1 ? "" : "s"}. This takes a minute or two.` : "Nothing to sync: no ad account is shown on the dashboard.");
      await reload();
    });

  const connections = data?.connections ?? [];

  return (
    <div className="space-y-4">
      <div className="card">
        <h1 className="text-lg font-semibold">Ad accounts</h1>
        <p className="mt-1 text-sm text-muted">
          Connect Meta and Google Ads to see what you spend on ads each day, the clicks and sales they bring, and how that compares with your store&apos;s own
          sales. Access is read-only: Insights can&apos;t create, change or pause your ads.
        </p>
        <p className="mt-2 text-sm">
          For <strong>{store.name ?? store.shopDomain}</strong>
          {stores.length > 1 ? <span className="text-muted"> (switch store at the top of the page)</span> : null}
        </p>
      </div>

      {notice && <Alert kind="success">{notice}</Alert>}
      {error && <Alert>{error}</Alert>}
      {loadError && <Alert>{actionError(loadError, "load your ad accounts")}</Alert>}

      {PROVIDERS.map((p) => {
        const mine = connections.filter((c) => c.provider === p.id);
        const configured = data?.configured[p.id] ?? false;
        return (
          <section key={p.id} className="card" aria-labelledby={`ads-${p.id}`} data-testid={`ads-provider-${p.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-white">
                  <p.Icon size={22} />
                </span>
                <div>
                  <h2 id={`ads-${p.id}`} className="font-semibold">{p.name}</h2>
                  <p className="text-xs text-muted">{p.sub}</p>
                </div>
              </div>
              {manage && configured && (
                <button
                  type="button"
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-white px-4 text-sm font-medium text-[#1b1b18] shadow-sm transition hover:shadow disabled:opacity-60"
                  onClick={() => void connect(p.id)}
                  disabled={!!busy}
                  data-testid={`connect-${p.id}`}
                >
                  <p.Icon size={18} />
                  {busy === `connect-${p.id}` ? "Opening…" : mine.length ? `${p.button} (add or reconnect)` : p.button}
                </button>
              )}
            </div>

            {!configured && data && (
              <p className="mt-3 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted">
                {p.name} isn&apos;t set up on this Insights server yet: it needs the app keys from {p.id === "meta" ? "Meta for Developers" : "Google Cloud and a Google Ads developer token"}.
                {manage ? " The steps are in docs/ads-setup.md." : " Ask a workspace owner or admin."}
              </p>
            )}

            {mine.length > 0 && (
              <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
                {mine.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3" data-testid="ad-account">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {c.accountName ?? "Ad account"} <span className="text-xs font-normal text-muted">· {c.accountId}{c.currency ? ` · ${c.currency}` : ""}</span>
                      </p>
                      <p className="text-xs"><StatusLine c={c} /></p>
                    </div>
                    {manage && (
                      <div className="flex items-center gap-2">
                        <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
                          <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={c.enabled} onChange={() => void toggle(c)} disabled={!!busy} />
                          Show on dashboard
                        </label>
                        <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => void disconnect(c)} disabled={!!busy}>
                          Disconnect
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      {connections.length > 0 && manage && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn-secondary" onClick={() => void syncNow()} disabled={!!busy}>
            {busy === "sync" ? "Starting…" : "Sync now"}
          </button>
          <p className="text-xs text-muted">Numbers refresh by themselves every hour, and the last 30 days are checked again each day.</p>
        </div>
      )}

      <div className="card text-sm text-muted">
        <h2 className="font-semibold text-text">What Insights reads</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>For each campaign and day: what was spent, impressions, clicks, and the purchases, leads and sales value the platform counts.</li>
          <li>Account names, currencies and time zones, so days and money line up.</li>
          <li>Nothing about the people who saw your ads, and nothing is ever changed in your ad accounts.</li>
          <li>Access is stored encrypted. Disconnecting deletes it and every number fetched with it.</li>
        </ul>
      </div>
    </div>
  );
}
