"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { canManage, StoresPending, useApp, type StoreSummary } from "@/components/AppContext";
import { BackFromFacebook } from "@/components/MetaAdsAccess";
import { ShopifyIcon } from "@/components/ShopifyIcon";
import { fmtRelative } from "@/components/dashboard/format";
import { Alert } from "@/components/ui";
import { AdRow, rowState } from "@/components/integrations/AdRow";
import { NoteAlert, StateAnnouncer } from "@/components/integrations/AdUi";
import { AD_PLATFORMS } from "@/components/integrations/adPlatforms";
import { GoogleAdsDemoDialog } from "@/components/integrations/GoogleAdsDemoDialog";
import { ConnectButton, IntegrationRow, ManageLink, OneClickSetup, RowPill } from "@/components/integrations/IntegrationRow";
import { useAdConnections } from "@/components/integrations/useAdConnections";
import { EmbeddedSignup } from "@/components/whatsapp/EmbeddedSignup";
import { WhatsappIcon } from "@/components/whatsapp/WhatsappUi";
import { quality, tier, type Overview as WaOverview } from "@/components/whatsapp/types";
import { stateInfo, type AdProvider, type StateTone } from "@/lib/adConnections";
import { actionError, api, friendlyError, useApi } from "@/lib/api";

// ---------------------------------------------------------------------------
// Settings → Integrations (the owner's design, 2026-10-23): the "One Click Setup" banner, then a card
// per platform, Google Ads, Shopify, WhatsApp, Meta Ads and Google AdSense, each with where it stands,
// one button that opens the platform's own sign-in (Manage once connected) and what it brings
// (components/integrations/IntegrationRow.tsx, AdRow.tsx). Nothing here asks for an app id, a key or a
// token: bizinsights' own Shopify, Google and Meta apps do that part. Accounts are managed in depth on
// Settings → Shopify, Settings → Advertising and WhatsApp's own pages; signing in with Google is on
// Settings → Security.
// ---------------------------------------------------------------------------

/** Shopify's and WhatsApp's states. The ad rows' are in lib/adConnections.ts (AD_STATE). */
type State = "checking" | "unknown" | "not_connected" | "connecting" | "connected" | "action_required" | "permission_expired" | "failed" | "unavailable";

const STATE: Record<State, { label: string; tone: StateTone; busy?: boolean }> = {
  checking: { label: "Checking…", tone: "neutral", busy: true },
  unknown: { label: "Status unavailable", tone: "neutral" },
  not_connected: { label: "Not connected", tone: "neutral" },
  connecting: { label: "Connecting", tone: "neutral", busy: true },
  connected: { label: "Connected", tone: "good" },
  action_required: { label: "Action required", tone: "warn" },
  permission_expired: { label: "Reconnect required", tone: "danger" },
  failed: { label: "Connection failed", tone: "danger" },
  unavailable: { label: "Coming soon", tone: "neutral" },
};

const pill = (s: State) => <RowPill {...STATE[s]} state={s} />;

function shopifyState(s: StoreSummary | null): State {
  if (!s || s.status === "uninstalled") return "not_connected";
  if (s.status === "error") return "failed";
  if (s.status === "pending" || s.status === "syncing") return "connecting";
  return "connected";
}

/** Only from an answer: while it loads, or when it couldn't be had, the card doesn't claim "Not connected". */
function whatsappState(o: WaOverview | null, failed: boolean): State {
  if (!o) return failed ? "unknown" : "checking";
  const c = o.connection;
  if (!c) return o.platform.embeddedSignup ? "not_connected" : "unavailable";
  if (c.status === "reconnect") return "permission_expired";
  if (c.status === "error") return "failed";
  if (!c.registered) return "action_required";
  if (!c.webhookVerifiedAt) return "connecting";
  return "connected";
}

const AD_ROWS: AdProvider[] = ["google", "meta", "adsense"];

export default function IntegrationsPage() {
  const { workspace, store, storesStatus, offers, allowed } = useApp();
  // Connecting a Shopify store needs owner or admin rights; WhatsApp and ad accounts, "Manage integrations".
  const manageStores = canManage(workspace.role);
  const manage = allowed("integrations.manage");
  const storeBase = store ? `/workspaces/${workspace.id}/stores/${store.id}` : null;
  // An App Store workspace leaves WhatsApp and advertising out (lib/features.ts): no card, no request.
  const showWa = offers("whatsapp");
  const showAds = offers("ads");
  const wa = useApi<WaOverview>(storeBase && showWa ? `${storeBase}/whatsapp` : null);
  const ads = useAdConnections(storeBase && showAds ? storeBase : null);
  const [note, setNote] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Another store chosen at the top: a WhatsApp note was about the last one (the ad notes reset in useAdConnections).
  const [noteFor, setNoteFor] = useState(storeBase);
  if (noteFor !== storeBase) {
    setNoteFor(storeBase);
    setNote(null);
  }
  const { reload: reloadWa } = wa;

  const waState = whatsappState(wa.data, !!wa.error);

  // While WhatsApp is still being set up, look again until it settles (the ad rows do the same for a sync).
  useEffect(() => {
    if (waState !== "connecting") return;
    const t = window.setInterval(() => void reloadWa(), 10_000);
    return () => window.clearInterval(t);
  }, [waState, reloadWa]);

  if (storesStatus !== "ready") return <StoresPending />;

  /** Disconnect WhatsApp: bizinsights deletes its access. The number itself carries on. */
  const disconnectWa = async () => {
    if (!storeBase) return;
    const ok = window.confirm(
      "Disconnect WhatsApp? bizinsights deletes its access to your number and stops sending; messages waiting to go out are cancelled. Your number keeps working in WhatsApp.",
    );
    if (!ok) return;
    setBusy(true);
    setNote(null);
    try {
      await api(`${storeBase}/whatsapp`, { method: "DELETE" });
      await reloadWa();
      setNote({ kind: "success", text: "WhatsApp is disconnected." });
    } catch (e) {
      setNote({ kind: "error", text: actionError(e, "disconnect") });
    } finally {
      setBusy(false);
    }
  };

  const waConn = wa.data?.connection ?? null;
  const shopState = shopifyState(store);
  const shownWa: State = store ? waState : "not_connected";
  const announced: Array<[string, string]> = [
    ["Shopify", STATE[shopState].label],
    ...(showWa && store ? [["WhatsApp", STATE[waState].label] as [string, string]] : []),
    ...(showAds
      ? AD_ROWS.map((p): [string, string] => {
          const r = rowState(ads, store, p);
          return [AD_PLATFORMS[p].name, stateInfo(r.state, r.demo).label];
        })
      : []),
  ];
  const adRow = (p: AdProvider) => showAds && <AdRow provider={p} ads={ads} store={store} manage={manage} />;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Integrations</h1>
        <p className="mt-2 max-w-2xl leading-relaxed text-muted">
          {showAds
            ? "Connect your business accounts and get your data from Shopify, Google Ads, Meta Ads and AdSense, all in one place. Track performance, optimize campaigns and grow your business effortlessly."
            : "Connect your Shopify store and get its orders, products, customers and sales in one place. Track performance and grow your business effortlessly."}
        </p>
        {!manage && (
          <p className="mt-2 text-sm text-muted">
            You can see how each connection stands. Connecting or disconnecting WhatsApp and ad accounts needs the Manage integrations permission: ask an owner or admin.
          </p>
        )}
      </header>

      <OneClickSetup adPlatforms={showAds} />

      <StateAnnouncer items={announced} />
      {note && <Alert kind={note.kind}>{note.text}</Alert>}
      {ads.note && <NoteAlert note={ads.note} onDismiss={() => ads.setNote(null)} />}
      {ads.backFromMeta && (
        <Alert kind="info">
          <BackFromFacebook restricted={ads.answer?.restricted.meta ?? false} />
        </Alert>
      )}

      <div className="space-y-5">
        {adRow("google")}

        <IntegrationRow
          testid="int-shopify"
          state={shopState}
          logo={<ShopifyIcon size={44} />}
          name="Shopify"
          sub="Track your orders, products, customers and sales."
          pill={pill(shopState)}
          action={
            !store ? (
              manageStores && <ConnectButton name="Shopify" href={`/onboarding?ws=${encodeURIComponent(workspace.id)}`} testid="int-shopify-connect" />
            ) : (
              <ManageLink name="Shopify" href="/settings/stores" attention={shopState === "failed"} />
            )
          }
          brings={["Orders", "Products", "Customers", "Sales"]}
        >
          {store ? (
            <p>
              <span className="text-muted">Store:</span> {store.name ?? store.shopDomain}
              <span className="text-muted">
                {" · "}
                {shopState === "failed"
                  ? "Couldn't sync: see Fix it"
                  : shopState === "connecting"
                    ? "Importing your data"
                    : `Last synchronized ${store.lastSyncedAt ? fmtRelative(store.lastSyncedAt) : "not yet"}`}
              </span>
            </p>
          ) : (
            !manageStores && <p className="text-muted">Only a workspace owner or admin can connect a Shopify store.</p>
          )}
        </IntegrationRow>

        {showWa && (
          <IntegrationRow
            testid="int-whatsapp"
            state={shownWa}
            logo={<WhatsappIcon size={46} />}
            name="WhatsApp"
            sub="Send order updates, cart reminders and campaigns to your customers from your own business number."
            pill={pill(shownWa)}
            action={
              !store || !wa.data || !storeBase ? null : waConn ? (
                <ManageLink name="WhatsApp" href="/whatsapp/connect" attention={waState === "action_required" || waState === "permission_expired" || waState === "failed"} />
              ) : !manage ? null : wa.data.platform.embeddedSignup ? (
                <EmbeddedSignup base={`${storeBase}/whatsapp`} platform={wa.data.platform} label="Connect" look="row" onConnected={() => void wa.reload()} notify={(kind, text) => setNote({ kind, text })} />
              ) : (
                // One-click sign-up isn't switched on here: WhatsApp's own page connects with the business's own Meta app.
                <ConnectButton name="WhatsApp" href="/whatsapp/connect" />
              )
            }
            brings={["Messages", "Templates", "Campaigns"]}
          >
            {!store ? (
              <p className="text-muted">Connect your Shopify store first: WhatsApp messages are about its orders.</p>
            ) : !wa.data ? (
              wa.error ? <p className="text-muted">We couldn&apos;t check WhatsApp just now. {friendlyError(wa.error)}</p> : null
            ) : waConn ? (
              <>
                <p>
                  <span className="text-muted">Number:</span> {waConn.displayPhoneNumber ?? "—"}
                  {waConn.verifiedName ? ` · ${waConn.verifiedName}` : ""}
                  <span className="text-muted"> · {waConn.wabaName ?? "WhatsApp Business Account"}</span>
                </p>
                <p className="text-muted">
                  {waState === "action_required"
                    ? "Register the number to start sending: see Fix it."
                    : waState === "connecting"
                      ? "Waiting for Meta's first message."
                      : waState === "permission_expired"
                        ? "Meta access ended: reconnect from Fix it."
                        : waState === "failed"
                          ? "Meta reported a problem with this number: see Fix it."
                          : `Working · quality ${quality(waConn.qualityRating).toLowerCase()} · ${tier(waConn.messagingLimitTier)} · last synchronized ${waConn.lastSyncedAt ? fmtRelative(waConn.lastSyncedAt) : "not yet"}`}
                  {manage && (
                    <>
                      {" · "}
                      <button type="button" className="text-danger underline-offset-2 hover:underline" onClick={() => void disconnectWa()} disabled={busy}>
                        {busy ? "Disconnecting…" : "Disconnect"}
                      </button>
                    </>
                  )}
                </p>
              </>
            ) : !manage ? null : !wa.data.platform.embeddedSignup ? (
              <p className="text-muted">One-click WhatsApp sign-up is being switched on. Meanwhile, Connect sets it up with your own Meta app.</p>
            ) : (
              <p className="text-muted">
                Meta opens a window: log in, choose your business and number (or add one) and confirm the code Meta texts you. About 3 minutes.{" "}
                <Link className="text-accent underline-offset-2 hover:underline" href="/whatsapp/connect">
                  Other ways to connect
                </Link>
              </p>
            )}
          </IntegrationRow>
        )}

        {adRow("meta")}
        {adRow("adsense")}
      </div>

      <GoogleAdsDemoDialog open={ads.demoOpen} store={store} onClose={ads.closeDemo} onConnect={ads.connectDemo} onDisconnect={ads.disconnectDemo} />
    </div>
  );
}
