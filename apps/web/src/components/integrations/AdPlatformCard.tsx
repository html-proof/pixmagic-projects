"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { GoogleUnverified } from "@/components/GoogleAdsAccess";
import { MetaTestersOnly } from "@/components/MetaAdsAccess";
import type { StoreSummary } from "@/components/AppContext";
import { friendlyError } from "@/lib/api";
import { RECONNECT_STATES, type AdConnection, type AdProvider, type AdsState, type AdState } from "@/lib/adConnections";
import { AdAccountRow, StateBadge } from "./AdUi";
import { AD_PLATFORMS } from "./adPlatforms";
import { IntegrationCard } from "./IntegrationCard";

/**
 * One ad platform's card, the same on Settings → Connect your business (`hub`: with what it turns
 * on and a link to manage it) and Settings → Advertising (`settings`: with the AdSense sites):
 * its state, each connected account, the notes to read before going to the platform, and the
 * actions this member may take.
 */
export function AdPlatformCard({
  provider,
  variant,
  answer,
  loadError,
  connections,
  view,
  store,
  manage,
  busy,
  leaving,
  showMetaNote,
  onConnect,
  onRefresh,
  onToggle,
  onDisconnect,
  rowExtra,
}: {
  provider: AdProvider;
  variant: "hub" | "settings";
  answer: AdsState | null;
  loadError: unknown;
  /** This platform's connections. */
  connections: AdConnection[];
  view: { state: AdState; hidden: boolean };
  store: StoreSummary | null;
  manage: boolean;
  /** The action running on the page, if any (every button waits for it). */
  busy: string | null;
  /** This platform's sign-in is being opened. */
  leaving: boolean;
  /** Meta's testers-only note (not again right after coming back from Facebook, which explains it). */
  showMetaNote: boolean;
  onConnect: () => void;
  onRefresh: () => void;
  onToggle: (c: AdConnection) => void;
  onDisconnect: (c: AdConnection) => void;
  rowExtra?: (c: AdConnection) => ReactNode;
}) {
  const P = AD_PLATFORMS[provider];
  const hub = variant === "hub";
  const testid = hub ? `int-${provider}-ads` : `ads-provider-${provider}`;
  const configured = answer?.configured[provider] ?? false;
  const restricted = answer?.restricted[provider] ?? false;
  const reconnect = RECONNECT_STATES.has(view.state) || connections.some((c) => c.status === "reconnect");
  const readable = connections.some((c) => c.enabled && c.status !== "reconnect");
  const canAct = manage && !!store && !!answer;

  const connectLabel = leaving ? P.opening : !connections.length ? P.button : reconnect ? "Reconnect" : "Change accounts";
  const actions = (
    <>
      {canAct && configured && (
        <button
          type="button"
          className={connections.length && !reconnect ? "btn-secondary" : "btn-primary"}
          onClick={onConnect}
          disabled={!!busy}
          aria-label={connections.length && !leaving ? `${connectLabel}: ${P.name}` : undefined}
          data-testid={hub ? `int-${provider}-connect` : `connect-${provider}`}
        >
          {!connections.length && <P.Icon size={16} />} {connectLabel}
        </button>
      )}
      {canAct && configured && readable && (
        <button type="button" className="btn-secondary" onClick={onRefresh} disabled={!!busy} aria-label={`Refresh ${P.name}`} data-testid={hub ? `int-${provider}-refresh` : `refresh-${provider}`}>
          {busy === `sync-${provider}` ? "Starting…" : "Refresh"}
        </button>
      )}
      {hub && connections.length > 0 && (
        <Link className="btn-secondary" href="/settings/ads" aria-label={`Manage ${P.name}`}>
          Manage
        </Link>
      )}
    </>
  );

  let body: ReactNode;
  if (!store) body = <p className="text-muted">Connect your Shopify store first: ad accounts are connected to a store.</p>;
  else if (!answer && loadError) body = <p className="text-muted">We couldn&apos;t check {P.name} just now. {friendlyError(loadError)}</p>;
  else if (!answer) body = <div className="skeleton h-10" aria-hidden />;
  else if (connections.length) {
    body = (
      <ul className="divide-y divide-border rounded-lg border border-border">
        {connections.map((c) => (
          <AdAccountRow
            key={c.id}
            c={c}
            storeTimezone={store.timezone}
            manage={manage}
            busy={!!busy}
            onToggle={() => onToggle(c)}
            onDisconnect={() => onDisconnect(c)}
          >
            {rowExtra?.(c)}
          </AdAccountRow>
        ))}
      </ul>
    );
  } else if (!configured) {
    body = (
      <p className="rounded-lg border border-dashed border-border px-3 py-2 text-muted">
        {P.name} sign-in is being switched on for bizinsights. Once it&apos;s on, this card shows a &ldquo;{P.button}&rdquo; button: there are no keys or codes to copy.
      </p>
    );
  } else body = <p className="text-muted">{P.how}</p>;

  // Read before going to the platform: who it lets in, and what it shows first.
  const notes = canAct && configured && restricted && (
    <>
      {provider === "meta" && !connections.length && showMetaNote && <MetaTestersOnly />}
      {provider === "google" && <GoogleUnverified brief={connections.length > 0} />}
    </>
  );

  return (
    <IntegrationCard
      testid={testid}
      state={view.state}
      icon={<P.Icon size={22} />}
      name={P.name}
      sub={P.sub}
      badge={
        <>
          <StateBadge state={view.state} testid="platform-state" />
          {view.hidden && (
            <span className="text-xs text-muted" data-testid="platform-hidden">
              Hidden from the dashboard
            </span>
          )}
        </>
      }
      actions={actions}
    >
      {body}
      {notes}
      {hub && store && answer && <p className="text-xs text-muted">Turns on: {P.features.join(" · ")}</p>}
    </IntegrationCard>
  );
}
