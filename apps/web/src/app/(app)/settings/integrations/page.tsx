"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { canManage, StoresPending, useApp, type StoreSummary } from "@/components/AppContext";
import { MetaIcon } from "@/components/BrandIcons";
import { ShopifyIcon } from "@/components/ShopifyIcon";
import { fmtRelative } from "@/components/dashboard/format";
import { Badge, type Tone } from "@/components/dashboard/primitives";
import { Alert } from "@/components/ui";
import { EmbeddedSignup } from "@/components/whatsapp/EmbeddedSignup";
import { WhatsappIcon } from "@/components/whatsapp/common";
import { quality, tier, type Overview as WaOverview } from "@/components/whatsapp/types";
import { actionError, api, useApi } from "@/lib/api";

// ---------------------------------------------------------------------------
// "Connect your business": Shopify, WhatsApp and Meta Ads on one page, each with one button that
// opens the platform's own sign-in, and a plain status. Nothing here asks for an app id, a key or
// a token: Insights' own Shopify and Meta apps do that part. The detailed pages (Shopify,
// WhatsApp, Advertising) stay where things are managed in depth.
// ---------------------------------------------------------------------------

type State = "not_connected" | "connecting" | "connected" | "action_required" | "permission_expired" | "failed" | "unavailable";

const STATE: Record<State, { label: string; tone: Tone }> = {
  not_connected: { label: "Not connected", tone: "neutral" },
  connecting: { label: "Connecting", tone: "neutral" },
  connected: { label: "Connected", tone: "good" },
  action_required: { label: "Action required", tone: "warn" },
  permission_expired: { label: "Permission expired", tone: "danger" },
  failed: { label: "Connection failed", tone: "danger" },
  unavailable: { label: "Coming soon", tone: "neutral" },
};

interface AdConnection {
  id: string;
  provider: "meta" | "google" | "adsense";
  accountId: string;
  accountName: string | null;
  enabled: boolean;
  status: "active" | "reconnect" | "error";
  lastError: string | null;
  lastSyncedAt: string | null;
  accessExpiresAt: string | null;
}
interface AdsState {
  configured: { meta: boolean; google: boolean; adsense: boolean };
  connections: AdConnection[];
}

function shopifyState(s: StoreSummary | null): State {
  if (!s || s.status === "uninstalled") return "not_connected";
  if (s.status === "error") return "failed";
  if (s.status === "pending" || s.status === "syncing") return "connecting";
  return "connected";
}

function whatsappState(o: WaOverview | null): State {
  const c = o?.connection;
  if (!c) return o && !o.platform.embeddedSignup ? "unavailable" : "not_connected";
  if (c.status === "reconnect") return "permission_expired";
  if (c.status === "error") return "failed";
  if (!c.registered) return "action_required";
  if (!c.webhookVerifiedAt) return "connecting";
  return "connected";
}

function metaState(a: AdsState | null): State {
  const mine = (a?.connections ?? []).filter((c) => c.provider === "meta");
  if (!mine.length) return a && !a.configured.meta ? "unavailable" : "not_connected";
  const shown = mine.filter((c) => c.enabled);
  if (shown.some((c) => c.status === "reconnect")) return "permission_expired";
  if (shown.some((c) => c.status === "error")) return "failed";
  if (shown.some((c) => !c.lastSyncedAt)) return "connecting";
  return "connected";
}

/** "act_1234567890" → "Ad account ••••7890": enough to tell accounts apart without the full id. */
const adAccountLabel = (id: string) => `Ad account ••••${id.replace(/^act_/, "").slice(-4)}`;

function Card({
  icon,
  name,
  sub,
  state,
  children,
  actions,
  testid,
}: {
  icon: ReactNode;
  name: string;
  sub: string;
  state: State;
  children?: ReactNode;
  actions?: ReactNode;
  testid: string;
}) {
  const s = STATE[state];
  return (
    <section className="card animate-rise flex min-w-0 flex-col gap-3" aria-labelledby={`${testid}-h`} data-testid={testid} data-state={state}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-white">{icon}</span>
          <div className="min-w-0">
            <h2 id={`${testid}-h`} className="font-semibold">
              {name}
            </h2>
            <p className="text-sm text-muted">{sub}</p>
          </div>
        </div>
        <Badge tone={s.tone}>{s.label}</Badge>
      </div>
      {children && <div className="text-sm">{children}</div>}
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </section>
  );
}

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs text-muted">{k}</dt>
          <dd className="truncate">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const Features = ({ items }: { items: string[] }) => <p className="mt-2 text-xs text-muted">Turns on: {items.join(" · ")}</p>;

export default function IntegrationsPage() {
  const { workspace, store, storesStatus } = useApp();
  const manage = canManage(workspace.role);
  const storeBase = store ? `/workspaces/${workspace.id}/stores/${store.id}` : null;
  const wa = useApi<WaOverview>(storeBase ? `${storeBase}/whatsapp` : null);
  const ads = useApi<AdsState>(storeBase ? `${storeBase}/ads` : null);
  const [note, setNote] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState<null | "wa-off" | "meta-off">(null);
  const { reload: reloadWa } = wa;
  const { reload: reloadAds } = ads;

  const waState = whatsappState(wa.data);
  const adState = metaState(ads.data);

  // While something is still being set up, look again until it settles: the page updates by itself.
  useEffect(() => {
    if (waState !== "connecting" && adState !== "connecting") return;
    const t = window.setInterval(() => {
      void reloadWa();
      void reloadAds();
    }, 10_000);
    return () => window.clearInterval(t);
  }, [waState, adState, reloadWa, reloadAds]);

  if (storesStatus !== "ready") return <StoresPending />;

  const connectMeta = async () => {
    if (!storeBase) return;
    setLeaving(true);
    setNote(null);
    try {
      const { url } = await api<{ url: string }>(`${storeBase}/ads/meta/connect`, { method: "POST" });
      window.location.assign(url);
    } catch (e) {
      setLeaving(false);
      setNote({ kind: "error", text: actionError(e, "start connecting Meta Ads") });
    }
  };

  /** Disconnect: Insights deletes its access (and, for ads, the numbers it fetched). The accounts themselves carry on. */
  const disconnect = async (what: "wa-off" | "meta-off") => {
    if (!storeBase) return;
    const ok = window.confirm(
      what === "wa-off"
        ? "Disconnect WhatsApp? Insights deletes its access to your number and stops sending; messages waiting to go out are cancelled. Your number keeps working in WhatsApp."
        : "Disconnect Meta Ads? Insights deletes its access and every number it fetched for your ad accounts. Your ads keep running.",
    );
    if (!ok) return;
    setBusy(what);
    setNote(null);
    try {
      if (what === "wa-off") {
        await api(`${storeBase}/whatsapp`, { method: "DELETE" });
        await reloadWa();
      } else {
        for (const c of metaConns) await api(`${storeBase}/ads/connections/${c.id}`, { method: "DELETE" });
        await reloadAds();
      }
      setNote({ kind: "success", text: what === "wa-off" ? "WhatsApp is disconnected." : "Meta Ads is disconnected." });
    } catch (e) {
      setNote({ kind: "error", text: actionError(e, "disconnect") });
    } finally {
      setBusy(null);
    }
  };

  const metaConns = (ads.data?.connections ?? []).filter((c) => c.provider === "meta");
  const waConn = wa.data?.connection ?? null;
  const shopState = shopifyState(store);
  const soonest = metaConns.map((c) => (c.accessExpiresAt ? Math.ceil((Date.parse(c.accessExpiresAt) - Date.now()) / 86_400_000) : null)).filter((d): d is number => d !== null).sort((a, b) => a - b)[0];

  return (
    <div className="space-y-4">
      <div className="card">
        <h1 className="text-lg font-semibold">Connect your business</h1>
        <p className="mt-1 text-sm text-muted">
          Press a button, sign in on the platform&apos;s own page and choose what to share. Insights finds your accounts and fills in the dashboard by itself: there are no keys or
          codes to copy.
        </p>
        {!manage && <p className="mt-2 text-sm text-muted">Only a workspace owner or admin can connect or disconnect accounts.</p>}
      </div>

      {note && <Alert kind={note.kind}>{note.text}</Alert>}

      <div className="grid gap-4">
        <Card
          testid="int-shopify"
          icon={<ShopifyIcon size={22} />}
          name="Shopify"
          sub="Your store's orders, products, customers and sales"
          state={shopState}
          actions={
            !store ? (
              manage && (
                <Link className="btn-primary" href="/onboarding">
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
          {store && (
            <Facts
              rows={[
                ["Store", store.name ?? store.shopDomain],
                ["Address", store.shopDomain],
                ["Last synchronized", store.lastSyncedAt ? fmtRelative(store.lastSyncedAt) : "Not yet"],
                ["Health", shopState === "connected" ? "Working" : shopState === "failed" ? "Couldn't sync: see Manage" : "Importing your data"],
              ]}
            />
          )}
          {store && <Features items={["Sales dashboard", "Products and stock", "Customers to follow up"]} />}
        </Card>

        <Card
          testid="int-whatsapp"
          icon={<WhatsappIcon size={22} />}
          name="WhatsApp"
          sub="Order and delivery updates, cart reminders and reviews from your own business number"
          state={store ? waState : "not_connected"}
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
                  <button type="button" className="text-sm text-danger underline-offset-2 hover:underline" onClick={() => void disconnect("wa-off")} disabled={!!busy}>
                    {busy === "wa-off" ? "Disconnecting…" : "Disconnect"}
                  </button>
                )}
              </>
            ) : null
          }
        >
          {!store ? (
            <p className="text-muted">Connect your Shopify store first: WhatsApp messages are about its orders.</p>
          ) : wa.error ? (
            <p className="text-muted">{actionError(wa.error, "check WhatsApp")}</p>
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
                            ? (waConn.lastError ?? "Meta reported a problem")
                            : `Working · quality ${quality(waConn.qualityRating).toLowerCase()} · ${tier(waConn.messagingLimitTier)}`,
                  ],
                ]}
              />
              <Features items={["Messages and delivery status", "Message templates", "Order updates", "Cart reminders", "Reviews"]} />
            </>
          ) : wa.data && !wa.data.platform.embeddedSignup ? (
            <p className="text-muted">One-click WhatsApp sign-up is being switched on. You can already connect with your own Meta app from Set up WhatsApp.</p>
          ) : (
            <p className="text-muted">Meta opens a window: log in, choose your business and number (or add one) and confirm the code Meta texts you. About 3 minutes.</p>
          )}
        </Card>

        <Card
          testid="int-meta-ads"
          icon={<MetaIcon size={22} />}
          name="Meta Ads"
          sub="Facebook and Instagram ads: spend, reach, clicks and the purchases Meta reports"
          state={!store ? "not_connected" : leaving && metaConns.length ? "connecting" : adState}
          actions={
            store && ads.data ? (
              <>
                {manage && ads.data.configured.meta && (
                  <button type="button" className={metaConns.length ? "btn-secondary" : "btn-primary"} onClick={() => void connectMeta()} disabled={leaving} data-testid="int-meta-connect">
                    <MetaIcon size={16} /> {leaving ? (metaConns.length ? "Reconnecting…" : "Opening Meta…") : metaConns.length ? "Reconnect or add accounts" : "Continue with Meta Ads"}
                  </button>
                )}
                {metaConns.length > 0 && (
                  <Link className="btn-secondary" href="/settings/ads">
                    Manage
                  </Link>
                )}
                {manage && metaConns.length > 0 && (
                  <button type="button" className="text-sm text-danger underline-offset-2 hover:underline" onClick={() => void disconnect("meta-off")} disabled={!!busy}>
                    {busy === "meta-off" ? "Disconnecting…" : "Disconnect"}
                  </button>
                )}
              </>
            ) : null
          }
        >
          {!store ? (
            <p className="text-muted">Connect your Shopify store first: ad accounts are connected to a store.</p>
          ) : ads.error ? (
            <p className="text-muted">{actionError(ads.error, "check Meta Ads")}</p>
          ) : metaConns.length ? (
            <>
              <Facts
                rows={[
                  ["Ad accounts", metaConns.map((c) => c.accountName ?? adAccountLabel(c.accountId)).join(", ")],
                  ["Identifiers", metaConns.map((c) => adAccountLabel(c.accountId)).join(", ")],
                  ["Last synchronized", (() => {
                    const last = metaConns.map((c) => c.lastSyncedAt).filter((d): d is string => !!d).sort().pop();
                    return last ? fmtRelative(last) : "Fetching the last 90 days…";
                  })()],
                  [
                    "Health",
                    adState === "permission_expired"
                      ? "Meta access ended: reconnect"
                      : adState === "failed"
                        ? (metaConns.find((c) => c.status === "error")?.lastError ?? "The last update didn't work")
                        : soonest !== undefined && soonest <= 14
                          ? `Access ends in ${soonest} day${soonest === 1 ? "" : "s"}: reconnect to keep it`
                          : "Working · read-only (ads_read)",
                  ],
                ]}
              />
              <Features items={["Ad spend next to your sales", "Campaigns, ad sets and ads", "Reach, clicks, purchases and ROAS"]} />
            </>
          ) : ads.data && !ads.data.configured.meta ? (
            <p className="text-muted">Meta Ads sign-in is being switched on for Insights. It will appear here as one button.</p>
          ) : (
            <p className="text-muted">
              Meta asks you to log in and choose the ad accounts to share. Access is read-only: Insights can&apos;t create, change or pause ads, or spend money.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
