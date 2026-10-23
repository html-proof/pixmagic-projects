"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { friendlyError } from "@/lib/api";
import { AdAccountRow, StateBadge } from "./AdUi";
import { NotConfiguredNote, platformFacts, RestrictedNotes, type AdPlatformProps } from "./adPlatformParts";
import { IntegrationCard } from "./IntegrationCard";

/**
 * One ad platform's card on Settings → Connect your business: its state, each connected account,
 * the notes to read before going to the platform, what it turns on, a link to manage it on
 * Settings → Advertising, and the actions this member may take.
 */
export function AdPlatformCard(props: AdPlatformProps) {
  const { provider, answer, loadError, connections, view, store, manage, busy, leaving, showMetaNote, onConnect, base, onRefresh, onToggle, onDisconnect, onTryDemo, onDemoSync, onDemoReset } = props;
  const { P, configured, restricted, reconnect, readable, canAct, real, demoOffered, demoConnected, missing } = platformFacts(props);
  const testid = `int-${provider}-ads`;

  const connectLabel = leaving ? P.opening : !real.length ? P.button : reconnect ? "Reconnect" : "Change accounts";
  const actions = (
    <>
      {canAct && configured && (
        <button
          type="button"
          className={real.length && !reconnect ? "btn-secondary" : "btn-primary"}
          onClick={onConnect}
          disabled={!!busy}
          aria-label={real.length && !leaving ? `${connectLabel}: ${P.name}` : undefined}
          data-testid={`int-${provider}-connect`}
        >
          {!real.length && <P.Icon size={16} />} {connectLabel}
        </button>
      )}
      {canAct && demoOffered && !demoConnected && onTryDemo && (
        <button type="button" className={configured ? "btn-secondary" : "btn-primary"} onClick={onTryDemo} disabled={!!busy} data-testid="int-google-try-demo">
          Try demo
        </button>
      )}
      {canAct && configured && readable && (
        <button type="button" className="btn-secondary" onClick={onRefresh} disabled={!!busy} aria-label={`Refresh ${P.name}`} data-testid={`int-${provider}-refresh`}>
          {busy === `sync-${provider}` ? "Starting…" : "Refresh"}
        </button>
      )}
      {connections.length > 0 && (
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
            demoActions={c.demo && onDemoSync && onDemoReset ? { onSync: onDemoSync, onReset: onDemoReset } : undefined}
            syncsPath={base ? `${base}/ads/connections/${c.id}/syncs` : null}
          />
        ))}
      </ul>
    );
  } else if (!configured) {
    body = <NotConfiguredNote P={P} manage={manage} missing={missing} demoOffered={demoOffered} testid={`${testid}-not-configured`} />;
  } else body = <p className="text-muted">{P.how}</p>;

  return (
    <IntegrationCard
      testid={testid}
      state={view.state}
      icon={<P.Icon size={22} />}
      name={P.name}
      sub={P.sub}
      badge={
        <>
          <StateBadge state={view.state} demo={view.demo ?? false} testid="platform-state" />
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
      {demoConnected && real.length === 0 && configured && canAct && (
        <p className="text-xs text-muted" data-testid="demo-switch-production">
          Ready for the real thing? &ldquo;{P.button}&rdquo; above opens Google&apos;s own sign-in for a real account; the demo stays until you disconnect it.
        </p>
      )}
      {canAct && configured && restricted && <RestrictedNotes provider={provider} connected={connections.length > 0} showMetaNote={showMetaNote} />}
      {store && answer && <p className="text-xs text-muted">Turns on: {P.features.join(" · ")}</p>}
    </IntegrationCard>
  );
}
