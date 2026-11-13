"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { shopifyIntegrationStatus, whatsappIntegrationStatus, type IntegrationStatus } from "@app/shared/integrations";
import { canManage, StoresPending, useApp, type StoreSummary } from "@/components/AppContext";
import { ShopifyIcon } from "@/components/ShopifyIcon";
import { fmtRelative } from "@/components/dashboard/format";
import { Alert } from "@/components/ui";
import { AdRow, rowState } from "@/components/integrations/AdRow";
import { NoteAlert, StateAnnouncer } from "@/components/integrations/AdUi";
import { AD_PLATFORMS } from "@/components/integrations/adPlatforms";
import { GoogleAdsDemoDialog } from "@/components/integrations/GoogleAdsDemoDialog";
import { ConnectButton, IntegrationRow, ManageLink, OneClickSetup, RowPill } from "@/components/integrations/IntegrationRow";
import { useAdConnections } from "@/components/integrations/useAdConnections";
import { ZapierCard } from "@/components/integrations/ZapierCard";
import { ZAPIER_CARD } from "@/lib/features";
import { waHref, WA_PAGE, WhatsappIcon } from "@/components/whatsapp/WaUi";
import type { WaOverview } from "@/components/whatsapp/types";
import { stateInfo, type AdProvider, type StateTone } from "@/lib/adConnections";
import { friendlyError, useApi } from "@/lib/api";

// ---------------------------------------------------------------------------
// Settings → Integrations, as the owner's approved Stitch design draws its Connections screen
// (prototype v2, screen 30): the "One Click Setup" line, then one card per connection, two to a row,
// in the design's order (Shopify, Meta Ads, Google Ads, AdSense, WhatsApp, Zapier). Each
// says where it stands (its own state, and the same on the one scale of six every page shares,
// @app/shared/integrations), what it does and brings, and has one button that opens the platform's
// own sign-in (Manage once connected): components/integrations/IntegrationRow.tsx, AdRow.tsx,
// ZapierCard.tsx. Nothing here asks for an app id, a key or a token: bizinsights'
// own Shopify, Google and Meta apps do that part. Accounts are managed in depth on Settings → Shopify,
// Settings → Advertising and WhatsApp Automation (/dashboard/whatsapp-automation); signing in with
// Google is on Settings → Security.
// ---------------------------------------------------------------------------

/** Shopify's and WhatsApp's states. The ad cards' are in lib/adConnections.ts (AD_STATE). */
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

/**
 * The store on the one scale. The store list doesn't say whether its token is still held: a store
 * that lost it stops syncing and comes back in error with its reason (`access`), which the scale
 * reads as signing in again.
 */
const shopifyStatus = (s: StoreSummary | null): IntegrationStatus => (s ? shopifyIntegrationStatus({ status: s.status, hasToken: true, problem: s.syncProblem ?? null }) : "disconnected");

/** Only from an answer: while it loads, or when it couldn't be had, the card doesn't claim "Not connected". */
function whatsappState(o: WaOverview | null, failed: boolean): State {
  if (!o) return failed ? "unknown" : "checking";
  const c = o.connection;
  if (!c || c.status === "disconnected") return o.platform.evolution ? "not_connected" : "unavailable";
  if (c.status === "pairing" || c.status === "reconnecting") return "connecting";
  if (c.status === "logged_out") return "permission_expired";
  if (c.status === "failed") return "failed";
  return "connected";
}

/** The design's order of the ad cards, after Shopify's. */
const AD_ROWS: AdProvider[] = ["meta", "google", "adsense"];

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

  const waConn = wa.data?.connection && wa.data.connection.status !== "disconnected" ? wa.data.connection : null;
  const shopState = shopifyState(store);
  const shownWa: State = store ? waState : "not_connected";
  const announced: Array<[string, string]> = [
    ["Shopify", STATE[shopState].label],
    ...(showAds
      ? AD_ROWS.map((p): [string, string] => {
          const r = rowState(ads, store, p);
          return [AD_PLATFORMS[p].name, stateInfo(r.state, r.demo).label];
        })
      : []),
    ...(showWa && store ? [["WhatsApp", STATE[waState].label] as [string, string]] : []),
  ];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">Integrations</h1>
        <p className="mt-1 text-sm text-muted sm:text-base">
          Every service bizinsights works with{store ? `, for ${store.name ?? store.shopDomain}` : ""}: where each one stands, and what it brings.
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

      {/* Two to a row once beside the settings menu there is room for two, as the design draws them; one under the other before that. */}
      <div className="grid gap-4 xl:grid-cols-2">
        <IntegrationRow
          testid="int-shopify"
          state={shopState}
          status={shopifyStatus(store)}
          logo={<ShopifyIcon size={26} />}
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

        {showAds && AD_ROWS.map((p) => <AdRow key={p} provider={p} ads={ads} store={store} manage={manage} />)}

        {showWa && (
          <IntegrationRow
            testid="int-whatsapp"
            state={shownWa}
            status={store && wa.data ? whatsappIntegrationStatus(wa.data.connection?.status) : store ? undefined : "disconnected"}
            logo={<WhatsappIcon size={22} />}
            name="WhatsApp"
            sub="Send order updates, reminders and campaigns to your customers from your own business number."
            pill={pill(shownWa)}
            action={
              !store || !wa.data || !storeBase ? null : waConn ? (
                <ManageLink name="WhatsApp" href={WA_PAGE} attention={waState === "permission_expired" || waState === "failed"} />
              ) : !manage || !wa.data.platform.evolution ? null : (
                <ConnectButton name="WhatsApp" href={waHref("setup")} testid="int-whatsapp-connect">
                  Connect
                </ConnectButton>
              )
            }
            brings={["Messages", "Automations", "Campaigns"]}
          >
            {!store ? (
              <p className="text-muted">Connect your Shopify store first: WhatsApp messages are about its orders.</p>
            ) : !wa.data ? (
              wa.error ? <p className="text-muted">We couldn&apos;t check WhatsApp just now. {friendlyError(wa.error)}</p> : null
            ) : waConn ? (
              <>
                <p>
                  <span className="text-muted">Number:</span> {waConn.phone ?? "—"}
                  {waConn.profileName ? ` · ${waConn.profileName}` : ""}
                  <span className="text-muted"> · {waConn.provider === "qr" ? "linked phone" : "Cloud API"}</span>
                </p>
                <p className="text-muted">
                  {waState === "connecting"
                    ? waConn.status === "pairing"
                      ? "Waiting for the phone to scan the code."
                      : "WhatsApp is reconnecting by itself."
                    : waState === "permission_expired"
                      ? "The phone logged this link out: link it again from Fix it."
                      : waState === "failed"
                        ? (waConn.reason ?? "Not connected: see Fix it.")
                        : `Working${waConn.lastCheckedAt ? ` · last checked ${fmtRelative(waConn.lastCheckedAt)}` : ""}`}
                </p>
              </>
            ) : !wa.data.platform.evolution ? (
              <p className="text-muted">Connecting WhatsApp is being switched on.</p>
            ) : !manage ? null : (
              <p className="text-muted">
                Link your WhatsApp with a QR code in a minute, or connect Meta&apos;s official Cloud API.{" "}
                <Link className="text-accent underline-offset-2 hover:underline" href={WA_PAGE}>
                  What WhatsApp Automation does
                </Link>
              </p>
            )}
          </IntegrationRow>
        )}

        {ZAPIER_CARD && offers("zapier") && allowed("integrations.status") && <ZapierCard workspaceId={workspace.id} store={store} manage={manage} full={manageStores} />}
      </div>

      <p className="text-center text-xs text-muted">Manage opens the page where that connection is looked after in full.</p>

      <GoogleAdsDemoDialog open={ads.demoOpen} store={store} onClose={ads.closeDemo} onConnect={ads.connectDemo} onDisconnect={ads.disconnectDemo} />
    </div>
  );
}
