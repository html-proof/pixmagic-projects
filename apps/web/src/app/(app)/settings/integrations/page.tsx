"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { canManage, StoresPending, useApp, type StoreSummary } from "@/components/AppContext";
import { BackFromFacebook } from "@/components/MetaAdsAccess";
import { ShopifyIcon } from "@/components/ShopifyIcon";
import { fmtRelative } from "@/components/dashboard/format";
import type { Tone } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { AdPlatformCard } from "@/components/integrations/AdPlatformCard";
import { DisconnectDialog, NoteAlert, StateAnnouncer } from "@/components/integrations/AdUi";
import { AD_PLATFORM_ORDER, AD_PLATFORMS } from "@/components/integrations/adPlatforms";
import { GoogleAccountCard } from "@/components/integrations/GoogleAccountCard";
import { Facts, IntegrationCard, StatusBadge } from "@/components/integrations/IntegrationCard";
import { useAdConnections } from "@/components/integrations/useAdConnections";
import { EmbeddedSignup } from "@/components/whatsapp/EmbeddedSignup";
import { WhatsappIcon } from "@/components/whatsapp/WhatsappUi";
import { quality, tier, type Overview as WaOverview } from "@/components/whatsapp/types";
import { AD_STATE } from "@/lib/adConnections";
import { actionError, api, friendlyError, useApi } from "@/lib/api";

// ---------------------------------------------------------------------------
// "Connect your business": the Google Account sign-in, Shopify, WhatsApp, Google Ads, Meta Ads and
// Google AdSense on one page, each with one button that opens the platform's own sign-in, and a
// plain status. Nothing here asks for an app id, a key or a token: bizinsights' own Shopify, Google
// and Meta apps do that part. The detailed pages (Shopify, WhatsApp, Advertising) stay where things
// are managed in depth. The ad cards are the ones Settings → Advertising shows (components/integrations).
// ---------------------------------------------------------------------------

/** Shopify's and WhatsApp's states. The ad cards' are in lib/adConnections.ts (AD_STATE). */
type State = "checking" | "unknown" | "not_connected" | "connecting" | "connected" | "action_required" | "permission_expired" | "failed" | "unavailable";

const STATE: Record<State, { label: string; tone: Tone; busy?: boolean }> = {
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

const badge = (s: State) => <StatusBadge {...STATE[s]} state={s} />;

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

export default function IntegrationsPage() {
  const { workspace, store, storesStatus, offers, allowed, me } = useApp();
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

  // While WhatsApp is still being set up, look again until it settles (the ad cards do the same for a sync).
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
  const views = Object.fromEntries(AD_PLATFORM_ORDER.map((p) => [p, ads.view(p)])) as Record<(typeof AD_PLATFORM_ORDER)[number], ReturnType<typeof ads.view>>;
  const announced: Array<[string, string]> = [
    ["Shopify", STATE[shopState].label],
    ...(showWa && store ? [["WhatsApp", STATE[waState].label] as [string, string]] : []),
    ...(showAds && store ? AD_PLATFORM_ORDER.map((p): [string, string] => [AD_PLATFORMS[p].name, AD_STATE[views[p].state].label]) : []),
  ];

  return (
    <div className="space-y-4">
      <div className="card">
        <h1 className="text-lg font-semibold">Connect your business</h1>
        <p className="mt-1 text-sm text-muted">
          Press a button, sign in on the platform&apos;s own page and choose what to share. bizinsights finds your accounts and fills in the dashboard by itself: there are no keys or
          codes to copy.
        </p>
        {!manage && (
          <p className="mt-2 text-sm text-muted">
            You can see how each connection stands. Connecting or disconnecting WhatsApp and ad accounts needs the Manage integrations permission: ask an owner or admin.
          </p>
        )}
      </div>

      <StateAnnouncer items={announced} />
      {note && <Alert kind={note.kind}>{note.text}</Alert>}
      {ads.note && <NoteAlert note={ads.note} onDismiss={() => ads.setNote(null)} />}
      {ads.backFromMeta && (
        <Alert kind="info">
          <BackFromFacebook restricted={ads.answer?.restricted.meta ?? false} />
        </Alert>
      )}

      <div className="grid gap-4">
        {/* The account's own sign-in: not for a dashboard opened from a shared link, which isn't signed in to an account. */}
        {!me.shared && <GoogleAccountCard />}

        <IntegrationCard
          testid="int-shopify"
          state={shopState}
          icon={<ShopifyIcon size={22} />}
          name="Shopify"
          sub="Your store's orders, products, customers and sales"
          badge={badge(shopState)}
          actions={
            !store ? (
              manageStores && (
                <Link className="btn-primary" href={`/onboarding?ws=${encodeURIComponent(workspace.id)}`}>
                  Continue with Shopify
                </Link>
              )
            ) : (
              <Link className="btn-secondary" href="/settings/stores">
                Manage
              </Link>
            )
          }
        >
          {store ? (
            <>
              <Facts
                rows={[
                  ["Store", store.name ?? store.shopDomain],
                  ["Address", store.shopDomain],
                  ["Last synchronized", store.lastSyncedAt ? fmtRelative(store.lastSyncedAt) : "Not yet"],
                  ["Health", shopState === "connected" ? "Working" : shopState === "failed" ? "Couldn't sync: see Manage" : "Importing your data"],
                ]}
              />
              <p className="text-xs text-muted">Turns on: Sales dashboard · Products and stock · Customers to follow up</p>
            </>
          ) : (
            !manageStores && <p className="text-muted">Only a workspace owner or admin can connect a Shopify store.</p>
          )}
        </IntegrationCard>

        {showWa && (
          <IntegrationCard
            testid="int-whatsapp"
            state={store ? waState : "not_connected"}
            icon={<WhatsappIcon size={22} />}
            name="WhatsApp"
            sub="Order and delivery updates, cart reminders and reviews from your own business number"
            badge={badge(store ? waState : "not_connected")}
            actions={
              store && wa.data && storeBase ? (
                <>
                  {manage && wa.data.platform.embeddedSignup && (
                    <EmbeddedSignup
                      base={`${storeBase}/whatsapp`}
                      platform={wa.data.platform}
                      label={waConn ? "Reconnect with WhatsApp" : "Continue with WhatsApp"}
                      onConnected={() => void wa.reload()}
                      notify={(kind, text) => setNote({ kind, text })}
                    />
                  )}
                  <Link className="btn-secondary" href="/whatsapp/connect">
                    {waConn ? "Manage" : wa.data.platform.embeddedSignup ? "Other ways to connect" : "Set up WhatsApp"}
                  </Link>
                  {manage && waConn && (
                    <button type="button" className="text-sm text-danger underline-offset-2 hover:underline" onClick={() => void disconnectWa()} disabled={busy}>
                      {busy ? "Disconnecting…" : "Disconnect"}
                    </button>
                  )}
                </>
              ) : null
            }
          >
            {!store ? (
              <p className="text-muted">Connect your Shopify store first: WhatsApp messages are about its orders.</p>
            ) : !wa.data ? (
              wa.error ? <p className="text-muted">We couldn&apos;t check WhatsApp just now. {friendlyError(wa.error)}</p> : <div className="skeleton h-10" aria-hidden />
            ) : waConn ? (
              <>
                <Facts
                  rows={[
                    ["Business account", waConn.wabaName ?? "WhatsApp Business Account"],
                    ["Number", `${waConn.displayPhoneNumber ?? "—"}${waConn.verifiedName ? ` · ${waConn.verifiedName}` : ""}`],
                    ["Last synchronized", waConn.lastSyncedAt ? fmtRelative(waConn.lastSyncedAt) : "Not yet"],
                    [
                      "Health",
                      waState === "action_required"
                        ? "Register the number to start sending (Manage)"
                        : waState === "connecting"
                          ? "Waiting for Meta's first message"
                          : waState === "permission_expired"
                            ? "Meta access ended: reconnect"
                            : waState === "failed"
                              ? "Meta reported a problem with this number: see Manage"
                              : `Working · quality ${quality(waConn.qualityRating).toLowerCase()} · ${tier(waConn.messagingLimitTier)}`,
                    ],
                  ]}
                />
                <p className="text-xs text-muted">Turns on: Messages and delivery status · Message templates · Order updates · Cart reminders · Reviews</p>
              </>
            ) : !wa.data.platform.embeddedSignup ? (
              <p className="text-muted">One-click WhatsApp sign-up is being switched on. You can already connect with your own Meta app from Set up WhatsApp.</p>
            ) : (
              <p className="text-muted">Meta opens a window: log in, choose your business and number (or add one) and confirm the code Meta texts you. About 3 minutes.</p>
            )}
          </IntegrationCard>
        )}

        {showAds &&
          AD_PLATFORM_ORDER.map((p) => (
            <AdPlatformCard
              key={p}
              provider={p}
              variant="hub"
              answer={ads.answer}
              loadError={ads.loadError}
              connections={ads.connections.filter((c) => c.provider === p)}
              view={store ? views[p] : { state: "not_connected", hidden: false }}
              store={store}
              manage={manage}
              busy={ads.busy}
              leaving={ads.leaving === p}
              showMetaNote={!ads.backFromMeta}
              onConnect={() => void ads.connect(p)}
              onRefresh={() => void ads.refresh(p)}
              onToggle={(c) => void ads.toggle(c)}
              onDisconnect={ads.askDisconnect}
            />
          ))}
      </div>

      <DisconnectDialog c={ads.confirming} busy={!!ads.busy} onConfirm={() => void ads.disconnect()} onCancel={ads.cancelDisconnect} />
    </div>
  );
}
