"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { canManage, StoresPending, useApp } from "@/components/AppContext";
import { LoadError } from "@/components/LoadError";
import { BackFromFacebook } from "@/components/MetaAdsAccess";
import { Alert } from "@/components/ui";
import { GoogleAdsDemoDialog } from "@/components/integrations/GoogleAdsDemoDialog";
import { DisconnectDialog, NoteAlert, StateAnnouncer } from "@/components/integrations/AdUi";
import { AD_PLATFORM_ORDER, AD_PLATFORMS } from "@/components/integrations/adPlatforms";
import { useAdConnections } from "@/components/integrations/useAdConnections";
import { AdPlatformPanel } from "@/components/settings/ads/AdPlatformPanel";
import { AdsenseSites } from "@/components/settings/ads/AdsenseSites";
import { AdvertisingHero } from "@/components/settings/ads/AdvertisingHero";
import { ChooseAccounts } from "@/components/settings/ads/ChooseAccounts";
import { callbackErrorMessage, isAdProvider, WRONG_LOGIN } from "@/components/settings/ads/callbackErrors";
import { AD_STATE, type AdProvider } from "@/lib/adConnections";
import { signInFinished } from "@/lib/adSignIn";

// ---------------------------------------------------------------------------
// Advertising integrations: connect and manage. The numbers themselves live on the dashboard's
// Advertising section; this page is where accounts are connected, chosen, refreshed, reconnected,
// shown or hidden, narrowed to sites (AdSense) and disconnected. Drawn after the owner's design
// (components/settings/ads); the cards follow the same rules as Settings → Integrations' rows
// (components/integrations/adPlatformParts.tsx).
// ---------------------------------------------------------------------------

export default function AdAccountsPage() {
  const { workspace, stores, storesStatus, store, setStoreId, allowed } = useApp();
  // Connecting ad accounts: owners, admins and members given "Manage integrations".
  const manage = allowed("integrations.manage");
  const base = store ? `/workspaces/${workspace.id}/stores/${store.id}` : null;
  const ads = useAdConnections(base);
  const { setChoosing } = ads;
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  // A sign-in came back with a login that reaches nothing: offer the platform's screen again.
  const [retry, setRetry] = useState<AdProvider | null>(null);

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
    if (code) setError(callbackErrorMessage(code, provider));
    if (code && WRONG_LOGIN.has(code) && isAdProvider(provider)) setRetry(provider);
    // It becomes part of an API path: only ever the nonce the callback put there.
    if (choose && /^[A-Za-z0-9_-]{16,64}$/.test(choose)) setPick(choose);
    if (code || choose) signInFinished();
    if (code || choose || target) window.history.replaceState(window.history.state, "", "/settings/ads");
    // Once the store list is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storesStatus]);

  const closePick = useCallback(
    (e?: string) => {
      setPick(null);
      setChoosing(null);
      if (e) setError(e);
    },
    [setChoosing],
  );

  if (storesStatus !== "ready") return <StoresPending />;
  if (!store || !base) {
    return (
      <AdvertisingHero>
        <p className="text-muted">Connect a Shopify store first; ad accounts are connected to a store.</p>
        {canManage(workspace.role) && (
          <Link href="/onboarding" className="btn-primary inline-flex">
            Connect a store
          </Link>
        )}
      </AdvertisingHero>
    );
  }

  const data = ads.answer;
  const storeName = store.name ?? store.shopDomain;
  const connect = (p: AdProvider) => {
    setError(null);
    setRetry(null);
    void ads.connect(p);
  };
  const views = Object.fromEntries(AD_PLATFORM_ORDER.map((p) => [p, ads.view(p)])) as Record<AdProvider, ReturnType<typeof ads.view>>;

  return (
    <div className="space-y-5">
      <AdvertisingHero>
        <p>
          For <strong>{storeName}</strong>
          {stores.length > 1 ? <span className="text-muted"> (switch store at the top of the page)</span> : null}
        </p>
        {!manage && <p className="text-muted">You can see how each account stands. Connecting, refreshing or disconnecting needs the Manage integrations permission: ask an owner or admin.</p>}
      </AdvertisingHero>

      <StateAnnouncer items={AD_PLATFORM_ORDER.map((p) => [AD_PLATFORMS[p].name, AD_STATE[views[p].state].label])} />
      {ads.note && <NoteAlert note={ads.note} onDismiss={() => ads.setNote(null)} />}
      {ads.backFromMeta && (
        <Alert kind="info">
          <BackFromFacebook restricted={data?.restricted.meta ?? false} />
        </Alert>
      )}
      {error && (
        <Alert onDismiss={() => setError(null)}>
          {error}
          {/* They just came back from this platform's sign-in, so it is set up: the button stays even while the list below can't load. */}
          {retry && manage && data?.configured[retry] !== false && (
            <span className="mt-2 flex flex-wrap items-center gap-2" data-testid="ads-retry">
              <button type="button" className="btn-secondary h-9" onClick={() => connect(retry)} disabled={!!ads.busy}>
                {ads.busy === `connect-${retry}` ? "Opening…" : AD_PLATFORMS[retry].retry}
              </button>
              {AD_PLATFORMS[retry].home.map((h) => (
                <a key={h.url} className="text-accent underline-offset-2 hover:underline" href={h.url} target="_blank" rel="noopener noreferrer">
                  {h.label}
                </a>
              ))}
            </span>
          )}
        </Alert>
      )}
      {/* A load that hit an outage retries by itself (useApi), so this says so instead of asking for a retry. */}
      {ads.loadError && <LoadError what="your ad accounts" error={ads.loadError} onRetry={() => void ads.retry()} busy={ads.loading} />}

      {pick && manage && <ChooseAccounts pick={pick} base={base} storeId={store.id} storeName={storeName} onLoaded={setChoosing} onDone={closePick} />}

      {AD_PLATFORM_ORDER.map((p) => (
        <AdPlatformPanel
          key={p}
          provider={p}
          answer={data}
          loadError={ads.loadError}
          connections={ads.connections.filter((c) => c.provider === p)}
          view={views[p]}
          store={store}
          manage={manage}
          busy={ads.busy}
          leaving={ads.leaving === p}
          showMetaNote={!ads.backFromMeta}
          onConnect={() => connect(p)}
          base={base}
          onRefresh={() => void ads.refresh(p)}
          onToggle={(c) => void ads.toggle(c)}
          onDisconnect={ads.askDisconnect}
          onTryDemo={ads.openDemo}
          onDemoSync={() => void ads.syncDemo()}
          onDemoReset={() => void ads.resetDemo()}
          rowExtra={(c) => (c.provider === "adsense" ? <AdsenseSites c={c} base={base} manage={manage} onSaved={ads.reload} /> : null)}
        />
      ))}

      {manage && ads.connections.some((c) => data?.configured[c.provider]) && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn-secondary" onClick={() => void ads.refresh()} disabled={!!ads.busy}>
            {ads.busy === "sync-all" ? "Starting…" : "Sync all now"}
          </button>
          <p className="text-xs text-muted">Numbers refresh by themselves through the day, and recent weeks are checked again daily for late conversions.</p>
        </div>
      )}

      <div className="card text-sm text-muted">
        <h2 className="font-semibold text-text">What bizinsights reads</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>For each ad campaign and day: what was spent, impressions, clicks, and the conversions and their value the platform counts.</li>
          <li>From AdSense, for each site and day: estimated earnings, page views, impressions and clicks.</li>
          <li>Account names, currencies, time zones and status, so days and money line up and a closed or paused account is shown as such.</li>
          <li>Nothing about the people who saw your ads, and nothing is ever changed in your accounts.</li>
          <li>Access is stored encrypted on the server and never sent to your browser. Disconnecting deletes it and every number fetched with it.</li>
        </ul>
      </div>

      <GoogleAdsDemoDialog open={ads.demoOpen} store={store} onClose={ads.closeDemo} onConnect={ads.connectDemo} onDisconnect={ads.disconnectDemo} />
      <DisconnectDialog c={ads.confirming} busy={!!ads.busy} onConfirm={() => void ads.disconnect()} onCancel={ads.cancelDisconnect} />
    </div>
  );
}
