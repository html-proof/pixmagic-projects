"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { canManage, StoresPending, useApp } from "@/components/AppContext";
import { GoogleIcon, MetaIcon } from "@/components/BrandIcons";
import { LoadError } from "@/components/LoadError";
import { BackFromFacebook, MetaTestersOnly } from "@/components/MetaAdsAccess";
import { Alert } from "@/components/ui";
import type { AdConnection, AdProvider, AdsState } from "@/lib/adConnections";
import { leavingForSignIn, signInFinished, useBackFromSignIn } from "@/lib/adSignIn";
import { actionError, api, useApi } from "@/lib/api";
import { fmtRelative } from "@/components/dashboard/format";
import { Badge, type Tone } from "@/components/dashboard/Primitives";

// ---------------------------------------------------------------------------
// Advertising integrations: connect and manage. The numbers themselves live on the dashboard's
// Advertising section; this page is where accounts are connected, chosen, refreshed, reconnected
// and disconnected.
// ---------------------------------------------------------------------------

type Provider = AdProvider;
type Connection = AdConnection;

interface Pending {
  provider: Provider;
  expiresAt: string;
  accounts: Array<{ accountId: string; name: string | null; currency: string | null; timezone: string | null; connected: boolean }>;
}

const PROVIDERS: Array<{ id: Provider; name: string; sub: string; button: string; access: string; Icon: (p: { size?: number }) => ReactNode }> = [
  {
    id: "google",
    name: "Google Ads",
    sub: "Search, Shopping, YouTube and Performance Max: spend, clicks, conversions",
    button: "Continue with Google Ads",
    access: "Google Ads reporting (Google has no read-only scope; bizinsights only reads)",
    Icon: GoogleIcon,
  },
  {
    id: "meta",
    name: "Meta Ads",
    sub: "Facebook and Instagram ads: spend, impressions, clicks, conversions",
    button: "Continue with Meta Ads",
    access: "Read-only access to ads reporting (ads_read)",
    Icon: MetaIcon,
  },
  {
    id: "adsense",
    name: "Google AdSense",
    sub: "What your site earns from ads shown on it: earnings, page views, impressions, clicks",
    button: "Continue with Google AdSense",
    access: "Read-only access to AdSense reports (adsense.readonly)",
    Icon: GoogleIcon,
  },
];

const INFO = Object.fromEntries(PROVIDERS.map((p) => [p.id, p])) as Record<Provider, (typeof PROVIDERS)[number]>;

/** Every platform has its card. One the server can't connect yet says so instead of offering a button. */
const OFFERED: Provider[] = ["google", "meta", "adsense"];

/** What the callback's ?error= means, in words. A provider-specific message wins. */
const ERRORS: Record<string, string> = {
  denied: "You chose not to give bizinsights access, so nothing was connected.",
  state_mismatch: "That sign-in started in another browser or tab. Please press the button again here.",
  state_expired: "That took a little too long. Please press the button again.",
  session_mismatch: "You were signed in as someone else when you came back. Sign in as yourself and try again.",
  not_allowed: "You no longer have permission to connect ad accounts to this store. Ask an owner or admin.",
  exchange_failed: "The platform didn't accept the sign-in. Please try again in a moment.",
  no_accounts: "That login can't see any ad accounts. Ask the account's owner to give you access, then connect again.",
  no_accounts_meta:
    "That Facebook login can't reach any ad account, so nothing was connected. If your ads run in a business portfolio, assign this login to the ad account in Meta Business settings → Ad accounts (admins have to assign themselves too). If your ads are on another Facebook login, log out of Facebook in this browser first. No ad account yet? Create one in Meta Ads Manager. Then press Connect again.",
  none_shared_meta:
    "No ad account was shared with bizinsights on Facebook's screen, so nothing was connected. Press Connect again, choose to edit what bizinsights can access, and tick the ad accounts this store's ads run from.",
  no_accounts_adsense: "That Google login has no AdSense account. Choose the Google account that owns your AdSense, or ask its owner to add this login as a user.",
  not_approved_google: "Google is still approving bizinsights for live Google Ads accounts, so nothing was connected. This is on our side, not yours; please try again in a day or two.",
  no_accounts_google:
    "That Google login has no Google Ads account, so nothing was connected. Choose the Google account you use at ads.google.com, or ask the Google Ads account's owner to add this login as a user. No Google Ads account yet? Create one at ads.google.com first.",
  manager_only_google:
    "That Google login only reaches a Google Ads manager account with no active ad account under it. Choose the Google account that runs your ads, or create or link an ad account in the manager account, then connect again.",
  account_not_ready_google:
    "Google Ads won't report on the account that login reaches yet: its setup at ads.google.com isn't finished, or it's cancelled or suspended. Finish setting it up there, or choose another Google account.",
  no_refresh_token: "Google didn't grant lasting access. Please try again and allow access on Google's screen.",
  permission_missing: "The permission to read reports wasn't granted, so nothing could be connected. Press the button again and leave it ticked.",
  permission_missing_meta: "Meta's ads_read permission wasn't granted, so bizinsights can't read your ad reports. Press Continue with Meta Ads again and allow it.",
  missing_params: "The platform didn't send everything back. Please try again.",
  temporarily_unavailable: "Something went wrong on our side. Please try again in a minute.",
};

/**
 * Errors that mean "that login reaches nothing yet": fixed on the platform's side or with another login,
 * then a retry. Google shows its account chooser again; Facebook shows its screen again.
 */
const WRONG_LOGIN = new Set(["no_accounts", "manager_only", "account_not_ready", "none_shared"]);

/** What the retry button says. */
const RETRY_LABEL: Record<Provider, string> = { google: "Choose another Google account", adsense: "Choose another Google account", meta: "Connect again" };

/** Where a login without an account can create one, or be given access to one. */
const PLATFORM_HOME: Record<Provider, Array<{ url: string; label: string }>> = {
  google: [{ url: "https://ads.google.com/", label: "Open ads.google.com" }],
  adsense: [{ url: "https://adsense.google.com/", label: "Open AdSense" }],
  meta: [
    { url: "https://adsmanager.facebook.com/", label: "Open Ads Manager" },
    { url: "https://business.facebook.com/settings/ad-accounts", label: "Open Business settings" },
  ],
};

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
}

/** One word for where a platform stands, with its colour (never colour alone: the word says it). */
function platformStatus(configured: boolean, mine: Connection[]): { tone: Tone; label: string } {
  if (!configured && !mine.length) return { tone: "neutral", label: "Coming soon" };
  if (!mine.length) return { tone: "neutral", label: "Not connected" };
  if (mine.some((c) => c.enabled && c.status === "reconnect")) return { tone: "danger", label: "Needs reconnecting" };
  if (mine.some((c) => c.enabled && c.status === "error")) return { tone: "warn", label: "Sync problem" };
  if (mine.some((c) => c.enabled && c.status === "active" && !c.lastSyncedAt)) return { tone: "neutral", label: "Syncing" };
  if (!mine.some((c) => c.enabled)) return { tone: "neutral", label: "Connected · hidden" };
  return { tone: "good", label: "Connected" };
}

function StatusLine({ c }: { c: Connection }) {
  if (!c.enabled) return <span className="text-muted">Hidden from the dashboard</span>;
  if (c.status === "reconnect") return <span className="text-danger">Access has ended. Press Reconnect to keep the numbers coming.</span>;
  if (c.status === "error") return <span className="text-warn">The last update didn&apos;t work{c.lastError ? `: ${c.lastError}` : ""}. We&apos;ll keep trying.</span>;
  if (!c.lastSyncedAt) return <span className="text-muted">Syncing: fetching the last 90 days…</span>;
  const left = c.provider === "meta" ? daysUntil(c.accessExpiresAt) : null;
  return (
    <span className="text-muted">
      Last synced {fmtRelative(c.lastSyncedAt)}
      {left !== null && left <= 14 ? <span className="text-warn"> · Meta access ends in {left} day{left === 1 ? "" : "s"}: reconnect to keep it going</span> : null}
    </span>
  );
}

/** After a sign-in that sees several accounts: tick the ones that belong to this store. */
function ChooseAccounts({ pick, ws, storeId, storeName, onDone }: { pick: string; ws: string; storeId: string; storeName: string; onDone: (error?: string) => void }) {
  const path = `/workspaces/${ws}/stores/${storeId}/ads/pending/${encodeURIComponent(pick)}`;
  const { data, error } = useApi<Pending>(path);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!data || chosen) return;
    // Reconnecting keeps what was chosen before; a first connection starts with every account
    // ticked, unless there are so many (an agency login) that ticking each wanted one is easier.
    const before = data.accounts.filter((a) => a.connected).map((a) => a.accountId);
    setChosen(new Set(before.length ? before : data.accounts.length > 20 ? [] : data.accounts.map((a) => a.accountId)));
  }, [data, chosen]);

  if (error) {
    return <Alert>{actionError(error, "load the accounts to choose from")} <button type="button" className="underline" onClick={() => onDone()}>Close</button></Alert>;
  }
  if (!data || !chosen) return <div className="card skeleton h-40" aria-busy="true" />;
  const P = INFO[data.provider];
  const toggle = (id: string) => setChosen((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const confirm = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const r = await api<{ provider: Provider; connected: number }>(path, { method: "POST", body: { accountIds: [...chosen] } });
      // The numbers live on the dashboard: go and watch them arrive.
      window.location.assign(`/dashboard?${new URLSearchParams({ adsConnected: r.provider, accounts: String(r.connected), store: storeId })}`);
    } catch (e) {
      setFailed(actionError(e, "connect those accounts"));
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    await api(path, { method: "DELETE" }).catch(() => undefined);
    onDone();
  };

  return (
    <section className="card border-accent/40" aria-labelledby="choose-h" data-testid="ads-choose">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-white"><P.Icon size={22} /></span>
        <div>
          <h2 id="choose-h" className="font-semibold">Choose {P.name} accounts for {storeName}</h2>
          <p className="text-xs text-muted">
            Your login can see {data.accounts.length} account{data.accounts.length === 1 ? "" : "s"}. Tick the ones whose numbers belong on this store&apos;s
            dashboard; an account you untick is hidden from it. You can change this later.
          </p>
        </div>
      </div>
      {failed && <div className="mt-3"><Alert>{failed}</Alert></div>}
      {data.accounts.length > 3 && (
        <div className="mt-3 flex gap-3 text-xs">
          <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => setChosen(new Set(data.accounts.map((a) => a.accountId)))} disabled={busy}>
            Select all
          </button>
          <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => setChosen(new Set())} disabled={busy}>
            Select none
          </button>
        </div>
      )}
      <fieldset className="mt-4">
        <legend className="sr-only">Accounts to connect</legend>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {data.accounts.map((a) => (
            <li key={a.accountId}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-3">
                <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={chosen.has(a.accountId)} onChange={() => toggle(a.accountId)} disabled={busy} />
                <span className="min-w-0">
                  <span className="block font-medium">{a.name ?? "Unnamed account"}</span>
                  <span className="block text-xs text-muted">
                    {a.accountId}
                    {a.currency ? ` · ${a.currency}` : ""}
                    {a.timezone ? ` · ${a.timezone}` : ""}
                    {a.connected ? " · already connected" : ""}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" onClick={() => void confirm()} disabled={busy || chosen.size === 0} data-testid="ads-choose-confirm">
          {busy ? "Connecting…" : `Connect ${chosen.size} account${chosen.size === 1 ? "" : "s"}`}
        </button>
        <button type="button" className="btn-secondary" onClick={() => void cancel()} disabled={busy}>Cancel</button>
        {chosen.size === 0 && <span className="text-xs text-muted">Tick at least one account.</span>}
      </div>
    </section>
  );
}

export default function AdAccountsPage() {
  const { workspace, stores, storesStatus, store, setStoreId } = useApp();
  const manage = canManage(workspace.role);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  // A sign-in came back with a login that reaches nothing: offer the platform's screen again.
  const [retry, setRetry] = useState<Provider | null>(null);
  // Back from Facebook's own page without connecting: Facebook never says why to bizinsights, so this does.
  const [backFromMeta, setBackFromMeta] = useState(false);

  // Coming back from Meta or Google: a problem to explain, or accounts to choose, for the store that was connected.
  useEffect(() => {
    // Not before the store list is known: ?store= has to pick the store the sign-in was for.
    if (storesStatus !== "ready") return;
    const q = new URLSearchParams(window.location.search);
    const target = q.get("store");
    if (target && stores.some((s) => s.id === target)) setStoreId(target);
    const code = q.get("error");
    const choose = q.get("choose");
    const provider = q.get("provider");
    if (code) setError(ERRORS[`${code}_${provider}`] ?? ERRORS[code] ?? "Connecting didn't work. Please try again.");
    if (code && WRONG_LOGIN.has(code) && provider && Object.hasOwn(RETRY_LABEL, provider)) setRetry(provider as Provider);
    // It becomes part of an API path: only ever the nonce the callback put there.
    if (choose && /^[A-Za-z0-9_-]{16,64}$/.test(choose)) setPick(choose);
    if (code || choose) signInFinished();
    if (code || choose || target) window.history.replaceState(window.history.state, "", "/settings/ads");
    // Once the store list is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storesStatus]);

  useBackFromSignIn((provider) => {
    setBusy(null);
    if (provider === "meta") setBackFromMeta(true);
  });

  const path = store ? `/workspaces/${workspace.id}/stores/${store.id}/ads` : null;
  const { data, error: loadError, reload } = useApi<AdsState>(path);

  // A first sync is running: look again until every account has numbers.
  useEffect(() => {
    if (!data?.connections.some((c) => c.enabled && c.status === "active" && !c.lastSyncedAt)) return;
    const t = window.setInterval(() => void reload(), 5000);
    return () => window.clearInterval(t);
  }, [data, reload]);

  if (storesStatus !== "ready") return <StoresPending />;
  if (!store) {
    return (
      <div className="card">
        <h1 className="text-lg font-semibold">Advertising integrations</h1>
        <p className="mt-1 text-sm text-muted">Connect a Shopify store first; ad accounts are connected to a store.</p>
        {manage && <Link href="/onboarding" className="btn-primary mt-3 inline-flex">Connect a store</Link>}
      </div>
    );
  }

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setRetry(null);
    setBackFromMeta(false);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(actionError(e, key.startsWith("connect") ? "start connecting" : key.startsWith("sync") ? "start a refresh" : "save that change"));
      setBusy(null);
      return;
    }
    setBusy(null);
  };

  const connect = (p: Provider) =>
    run(`connect-${p}`, async () => {
      const { url } = await api<{ url: string }>(`/workspaces/${workspace.id}/stores/${store.id}/ads/${p}/connect`, { method: "POST" });
      leavingForSignIn(p);
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
      if (
        !window.confirm(
          `Disconnect ${c.accountName ?? c.accountId}? Its access and every number fetched for it are deleted from bizinsights, and bizinsights gives up its access at ${INFO[c.provider].name} once no other connected account uses it. Your ads keep running.`,
        )
      )
        return;
      await api(`/workspaces/${workspace.id}/stores/${store.id}/ads/connections/${c.id}`, { method: "DELETE" });
      await reload();
    });

  const refresh = (p?: Provider) =>
    run(`sync-${p ?? "all"}`, async () => {
      const { queued } = await api<{ queued: number }>(`/workspaces/${workspace.id}/stores/${store.id}/ads/sync`, { method: "POST", body: p ? { provider: p } : {} });
      setNotice(queued ? `Refreshing the last 30 days for ${queued} account${queued === 1 ? "" : "s"}. This takes a minute or two; the dashboard updates by itself.` : "Nothing to refresh: no account here is shown on the dashboard.");
      await reload();
    });

  const connections = data?.connections ?? [];
  const storeName = store.name ?? store.shopDomain;
  const home = retry ? PLATFORM_HOME[retry] : [];

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">Advertising integrations</h1>
            <p className="mt-1 text-sm text-muted">
              Connect Google Ads and Meta Ads to see what you spend on ads and what it brings, and Google AdSense to see what your site earns from ads.
              Once connected, the numbers appear on your <Link className="text-accent underline" href="/dashboard">dashboard</Link> and refresh every hour. bizinsights
              only reads: it can&apos;t create, change or pause your ads, or spend money.
            </p>
            <p className="mt-2 text-sm">
              For <strong>{storeName}</strong>
              {stores.length > 1 ? <span className="text-muted"> (switch store at the top of the page)</span> : null}
            </p>
          </div>
          {connections.length > 0 && <Link className="btn-secondary shrink-0" href="/dashboard">View results</Link>}
        </div>
      </div>

      {notice && <Alert kind="success">{notice}</Alert>}
      {backFromMeta && (
        <Alert kind="info">
          <BackFromFacebook restricted={data?.restricted.meta ?? false} />
        </Alert>
      )}
      {error && (
        <Alert>
          {error}
          {/* They just came back from this platform's sign-in, so it is set up: the button stays even while the list below can't load. */}
          {retry && manage && data?.configured[retry] !== false && (
            <span className="mt-2 flex flex-wrap items-center gap-2" data-testid="ads-retry">
              <button type="button" className="btn-secondary h-9" onClick={() => void connect(retry)} disabled={!!busy}>
                {busy === `connect-${retry}` ? "Opening…" : RETRY_LABEL[retry]}
              </button>
              {home.map((h) => (
                <a key={h.url} className="text-accent underline-offset-2 hover:underline" href={h.url} target="_blank" rel="noopener noreferrer">
                  {h.label}
                </a>
              ))}
            </span>
          )}
        </Alert>
      )}
      {/* A load that hit an outage retries by itself (useApi), so this says so instead of asking for a retry. */}
      {loadError && <LoadError what="your ad accounts" error={loadError} onRetry={() => void reload()} />}

      {pick && manage && (
        <ChooseAccounts
          pick={pick}
          ws={workspace.id}
          storeId={store.id}
          storeName={storeName}
          onDone={(e) => {
            setPick(null);
            if (e) setError(e);
          }}
        />
      )}

      {PROVIDERS.filter((p) => OFFERED.includes(p.id) || connections.some((c) => c.provider === p.id)).map((p) => {
        const mine = connections.filter((c) => c.provider === p.id);
        const configured = data?.configured[p.id] ?? false;
        const status = platformStatus(configured, mine);
        const shown = mine.filter((c) => c.enabled && c.status !== "reconnect");
        return (
          <section key={p.id} className="card" aria-labelledby={`ads-${p.id}`} data-testid={`ads-provider-${p.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-white">
                  <p.Icon size={22} />
                </span>
                <div className="min-w-0">
                  <h2 id={`ads-${p.id}`} className="flex flex-wrap items-center gap-2 font-semibold">
                    {p.name} {data && <Badge tone={status.tone}>{status.label}</Badge>}
                  </h2>
                  <p className="text-xs text-muted">{p.sub}</p>
                </div>
              </div>
              {manage && configured && (
                <div className="flex flex-wrap items-center gap-2">
                  {shown.length > 0 && (
                    <button type="button" className="btn-secondary h-10" onClick={() => void refresh(p.id)} disabled={!!busy} data-testid={`refresh-${p.id}`}>
                      {busy === `sync-${p.id}` ? "Starting…" : "Refresh"}
                    </button>
                  )}
                  <button
                    type="button"
                    className={
                      mine.length
                        ? "btn-secondary h-10"
                        : "inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-white px-4 text-sm font-medium text-[#1b1b18] shadow-sm transition hover:shadow disabled:opacity-60"
                    }
                    onClick={() => void connect(p.id)}
                    disabled={!!busy}
                    data-testid={`connect-${p.id}`}
                  >
                    {!mine.length && <p.Icon size={18} />}
                    {busy === `connect-${p.id}` ? "Opening…" : mine.length ? "Reconnect or add accounts" : p.button}
                  </button>
                </div>
              )}
            </div>

            {/* Facebook turns away anyone not added to bizinsights' Meta app on its own page: say so before sending them there (once). */}
            {manage && configured && !mine.length && p.id === "meta" && data?.restricted.meta && !backFromMeta && (
              <div className="mt-3">
                <MetaTestersOnly />
              </div>
            )}

            {!configured && data && (
              <p className="mt-3 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted">
                {p.name} sign-in is being switched on for bizinsights. Once it&apos;s on, this card shows a &ldquo;{p.button}&rdquo; button: there are no keys or codes
                to copy.
              </p>
            )}

            {mine.length > 0 && (
              <>
                <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
                  {mine.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3" data-testid="ad-account">
                      <div className="min-w-0">
                        <p className="font-medium">
                          {c.accountName ?? "Ad account"}{" "}
                          <span className="text-xs font-normal text-muted">
                            · {c.accountId}
                            {c.currency ? ` · ${c.currency}` : ""}
                            {c.timezone ? ` · ${c.timezone}` : ""}
                          </span>
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
                <p className="mt-2 text-xs text-muted">{p.access}. Connected {fmtRelative(mine[0]!.connectedAt)}.</p>
              </>
            )}
          </section>
        );
      })}

      {connections.length > 0 && manage && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn-secondary" onClick={() => void refresh()} disabled={!!busy}>
            {busy === "sync-all" ? "Starting…" : "Refresh all"}
          </button>
          <p className="text-xs text-muted">Numbers refresh by themselves every hour, and the last 30 days are checked again each day.</p>
        </div>
      )}

      <div className="card text-sm text-muted">
        <h2 className="font-semibold text-text">What bizinsights reads</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>For each ad campaign and day: what was spent, impressions, clicks, and the conversions and their value the platform counts.</li>
          <li>From AdSense, for each site and day: estimated earnings, page views, impressions and clicks.</li>
          <li>Account names, currencies and time zones, so days and money line up.</li>
          <li>Nothing about the people who saw your ads, and nothing is ever changed in your accounts.</li>
          <li>Access is stored encrypted on the server and never sent to your browser. Disconnecting deletes it and every number fetched with it.</li>
        </ul>
      </div>
    </div>
  );
}
