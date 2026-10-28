"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ArrowRight, ChartLine, CircleAlert, CircleCheck, CircleDashed, EyeOff, FlaskConical, RefreshCw, Unlink, type LucideIcon } from "lucide-react";
import { useApp } from "@/components/AppContext";
import { refreshCadence } from "@/components/integrations/AdUi";
import { NotConfiguredNote, platformFacts, type AdPlatformProps } from "@/components/integrations/adPlatformParts";
import type { AdPlatformInfo } from "@/components/integrations/adPlatforms";
import { canOpenPage } from "@/lib/access";
import { accountLabel, adLoginOf, stateInfo, type AdConnection, type AdProvider, type AdState } from "@/lib/adConnections";
import { friendlyError } from "@/lib/api";
import { AccountPanel } from "./AccountPanel";
import { LoginPanel } from "./LoginPanel";
import { LogoTile, PanelTitle, ReadsFlow, STATE_COLOR, StatePill, Tick, tone } from "./ui";

/** What the status panel beside the accounts says for each state a connected platform can be in. */
function statusWords(state: AdState, P: AdPlatformInfo, provider: AdProvider, demo: boolean, hidden: boolean): { title: string; text: string; color: string; icon: LucideIcon } {
  const label = stateInfo(state, demo).label;
  const warn = { color: STATE_COLOR.warn, icon: CircleAlert };
  const danger = { color: STATE_COLOR.danger, icon: CircleAlert };
  switch (state) {
    case "reconnect_required":
      return { title: label, text: `The sign-in to ${P.name} has ended. Reconnect account brings the figures back.`, ...danger };
    case "authorization_required":
      return { title: label, text: "The person whose login powered it has left. Someone with access to the account needs to reconnect it.", ...warn };
    case "permission_missing":
      return { title: label, text: `${P.name} no longer lets bizinsights read this account. Reconnect, and allow access to its reports.`, ...warn };
    case "sync_failed":
      return { title: label, text: "The last update didn't work, and bizinsights tries again by itself. The account's own message says why.", ...danger };
    case "verification_pending":
      return { title: label, text: `${P.name} hasn't finished checking the account. The account's own message says what's left.`, ...warn };
    case "synchronizing":
      return { title: label, text: "Fetching the latest figures now. The dashboard follows by itself.", color: "var(--info)", icon: RefreshCw };
    case "connecting":
      return { title: label, text: `Finish on ${P.name}'s screen, then choose the accounts for this store.`, color: "var(--info)", icon: RefreshCw };
    case "disconnected":
      return { title: label, text: `${P.name} says the account is closed, so nothing new is fetched.`, color: STATE_COLOR.neutral, icon: CircleDashed };
    default:
      if (hidden) return { title: "Hidden from the dashboard", text: "Nothing is fetched while it's hidden. Tick Show on dashboard to bring its figures in.", color: STATE_COLOR.neutral, icon: EyeOff };
      if (demo) return { title: label, text: "Simulated figures to try bizinsights with, not verified by Google.", color: STATE_COLOR.warn, icon: FlaskConical };
      return { title: "Integration active", text: `Your ${P.name} account is connected, and its figures refresh by themselves ${refreshCadence({ provider })}.`, color: STATE_COLOR.good, icon: CircleCheck };
  }
}

/** Beside the accounts: how the integration stands in a sentence, and the way to its figures. */
function StatusPanel({ id, P, words, dashboard, compact }: { id: string; P: AdPlatformInfo; words: ReturnType<typeof statusWords>; dashboard: boolean; compact: boolean }) {
  const Glyph = words.icon;
  return (
    // Beside one account it is as tall as the account, its button at the foot; beside several, only as tall as it needs.
    <section aria-labelledby={id} className={`tone-card flex flex-col gap-4 rounded-xl border p-4 ${compact ? "self-start" : ""}`} style={tone(words.color)}>
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--tone)] text-[var(--surface)]" aria-hidden>
          <Glyph size={18} strokeWidth={2.2} />
        </span>
        <div className="min-w-0">
          <PanelTitle id={id}>{words.title}</PanelTitle>
          <p className="mt-1 text-sm text-muted">{words.text}</p>
        </div>
      </div>
      {dashboard && (
        <Link className="btn-primary mt-auto w-full" href={P.page}>
          View {P.name} dashboard
          <ArrowRight size={15} aria-hidden />
        </Link>
      )}
    </section>
  );
}

/** The platform's mark on a white disc, so it reads on any button colour. */
const ButtonMark = ({ P }: { P: AdPlatformInfo }) => (
  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-white" aria-hidden>
    <P.Icon size={12} />
  </span>
);

/**
 * One ad platform on Settings → Advertising, as the owner's design draws it: the mark, name and state
 * with its main button; what bizinsights reads from it; then, once connected, each account's details
 * and data status beside how the integration stands, with Sync data now, View data details and
 * Reconnect account under them. While nothing is connected: what connecting brings, what it needs,
 * and the button again. The rules (who may press what, which state, the demo) are the same as on
 * Settings → Integrations (components/integrations/adPlatformParts.tsx).
 */
export function AdPlatformPanel(props: AdPlatformProps & { rowExtra?: (c: AdConnection) => ReactNode }) {
  const { provider, answer, loadError, connections, view, store, manage, busy, leaving, onConnect, base, onRefresh, onToggle, onDisconnect, onTryDemo, onDemoSync, onDemoReset, onCheckLogin, onDisconnectLogin, rowExtra } = props;
  const { P, configured, reconnect, readable, canAct, real, demoOffered, demoConnected, missing } = platformFacts(props);
  const { access, workspace, me, offers } = useApp();
  const [more, setMore] = useState(false);
  const testid = `ads-provider-${provider}`;
  const single = connections.length === 1 ? connections[0]! : null;
  // Signed in with no ad account yet: connected, and its accounts follow by themselves (never an error).
  const login = connections.length ? null : adLoginOf(answer, provider);
  const moreIds = connections.map((c) => `${testid}-more-${c.id}`);
  // The Advertising area's page for this platform, when this member may open it (Team & Access).
  const dashboard = canOpenPage(P.page, access, workspace.staffRole ?? null, !!me.shared, offers);

  const connectButton = (label: string, className: string, id?: string) => (
    <button type="button" className={className} onClick={onConnect} disabled={!!busy} data-testid={id}>
      {leaving ? (
        P.opening
      ) : (
        <>
          <ButtonMark P={P} />
          {label}
        </>
      )}
    </button>
  );

  const headerActions = (
    <>
      {canAct && configured && !real.length && !login && connectButton(P.button, "btn-primary", `connect-${provider}`)}
      {/* Not beside a real account: the demo is for trying bizinsights before connecting one. */}
      {canAct && demoOffered && !demoConnected && !real.length && onTryDemo && (
        <button type="button" className={configured ? "btn-secondary" : "btn-primary"} onClick={onTryDemo} disabled={!!busy} data-testid="try-demo-google">
          Try demo
        </button>
      )}
      {manage && single && (
        <button type="button" className="btn-secondary" onClick={() => onDisconnect(single)} disabled={!!busy} aria-label={`Disconnect ${accountLabel(single)}`} data-testid="account-disconnect">
          <Unlink size={15} aria-hidden />
          {single.demo ? "Disconnect demo" : "Disconnect"}
        </button>
      )}
      {manage && login && onDisconnectLogin && (
        <button type="button" className="btn-secondary" onClick={() => onDisconnectLogin(login)} disabled={!!busy} aria-label={`Disconnect ${P.name}`} data-testid="login-disconnect">
          <Unlink size={15} aria-hidden />
          {busy === `login-delete-${login.id}` ? "Disconnecting…" : "Disconnect"}
        </button>
      )}
    </>
  );

  let body: ReactNode;
  if (!store) body = <p className="text-sm text-muted">Connect your Shopify store first: ad accounts are connected to a store.</p>;
  else if (!answer && loadError) body = <p className="text-sm text-muted">We couldn&apos;t check {P.name} just now. {friendlyError(loadError)}</p>;
  else if (!answer) body = <div className="skeleton h-40" aria-hidden />;
  else if (login) {
    body = (
      <LoginPanel
        login={login}
        P={P}
        testid={testid}
        canAct={canAct && configured}
        busy={!!busy}
        checking={busy === `login-check-${login.id}`}
        leaving={leaving}
        dashboard={dashboard}
        onCheck={() => onCheckLogin?.(login)}
        onChoose={onConnect}
      />
    );
  } else if (connections.length) {
    body = (
      <>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <ul className="min-w-0 space-y-3">
            {connections.map((c, i) => (
              <AccountPanel
                key={c.id}
                c={c}
                storeTimezone={store.timezone}
                manage={manage}
                busy={!!busy}
                single={!!single}
                more={more}
                moreId={moreIds[i]!}
                onToggle={() => onToggle(c)}
                onDisconnect={() => onDisconnect(c)}
                demoActions={c.demo && onDemoSync && onDemoReset ? { onSync: onDemoSync, onReset: onDemoReset } : undefined}
                syncsPath={base ? `${base}/ads/connections/${c.id}/syncs` : null}
              >
                {rowExtra?.(c)}
              </AccountPanel>
            ))}
          </ul>
          <StatusPanel id={`${testid}-status`} P={P} words={statusWords(view.state, P, provider, view.demo ?? false, view.hidden)} dashboard={dashboard} compact={!single} />
        </div>
        {demoConnected && real.length === 0 && configured && canAct && (
          <p className="text-xs text-muted" data-testid="demo-switch-production">
            Ready for the real thing? &ldquo;{P.button}&rdquo; above opens Google&apos;s own sign-in for a real account; the demo stays until you disconnect it.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {canAct && configured && readable && (
            <button type="button" className="tone-solid" style={tone("var(--good)")} onClick={onRefresh} disabled={!!busy} aria-label={`Sync data now: ${P.name}`} data-testid={`refresh-${provider}`}>
              <RefreshCw size={15} aria-hidden className={busy === `sync-${provider}` ? "motion-safe:animate-spin" : undefined} />
              {busy === `sync-${provider}` ? "Starting…" : "Sync data now"}
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={() => setMore((m) => !m)} aria-expanded={more} aria-controls={moreIds.join(" ")}>
            <ChartLine size={15} aria-hidden />
            {more ? "Hide data details" : "View data details"}
          </button>
          {canAct && configured && real.length > 0 && (
            <button
              type="button"
              className={reconnect ? "btn-primary" : "btn-secondary"}
              onClick={onConnect}
              disabled={!!busy}
              title="Sign in again: to reconnect, or to choose other accounts"
              data-testid={`connect-${provider}`}
            >
              <RefreshCw size={15} aria-hidden />
              {leaving ? P.opening : "Reconnect account"}
            </button>
          )}
        </div>
      </>
    );
  } else {
    body = (
      <>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="grid overflow-hidden rounded-xl border border-border bg-bg/40 sm:grid-cols-2">
            <section className="min-w-0 p-4 sm:p-5" aria-labelledby={`${testid}-gets`}>
              <PanelTitle id={`${testid}-gets`}>What you&apos;ll get</PanelTitle>
              <ul className="mt-3 space-y-2.5 text-sm">
                {P.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5">
                    <Tick />
                    {f}
                  </li>
                ))}
              </ul>
            </section>
            <section className="min-w-0 border-t border-border p-4 sm:border-l sm:border-t-0 sm:p-5" aria-labelledby={`${testid}-needs`}>
              <PanelTitle id={`${testid}-needs`}>Requirements</PanelTitle>
              <ul className="mt-3 space-y-2.5 text-sm">
                {P.needs.map(({ label, icon: Glyph }) => (
                  <li key={label} className="flex items-start gap-2.5">
                    <Glyph size={17} strokeWidth={1.9} aria-hidden className="mt-px shrink-0 text-muted" />
                    {label}
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <Promo P={P} provider={provider}>
            {canAct && configured ? (
              connectButton(P.promo.button, "btn-primary self-start")
            ) : !configured ? (
              <NotConfiguredNote P={P} manage={manage} missing={missing} demoOffered={demoOffered} testid={`${testid}-not-configured`} />
            ) : null}
          </Promo>
        </div>
        {configured && <p className="text-sm text-muted">{P.how}</p>}
      </>
    );
  }

  return (
    <section className="card animate-rise flex min-w-0 flex-col gap-5 p-5 sm:p-6" aria-labelledby={`${testid}-h`} data-testid={testid} data-state={view.state}>
      <div className="flex flex-wrap items-start gap-4">
        <LogoTile P={P} />
        <div className="min-w-0 flex-1 basis-56">
          <h2 id={`${testid}-h`} className="text-lg font-semibold">
            {P.name}
          </h2>
          <p className="mt-0.5 text-sm text-muted">{P.sub}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-col items-end gap-1">
            <StatePill state={view.state} demo={view.demo ?? false} testid="platform-state" />
            {view.hidden && (
              <span className="text-xs text-muted" data-testid="platform-hidden">
                Hidden from the dashboard
              </span>
            )}
          </div>
          {headerActions}
        </div>
      </div>
      <ReadsFlow P={P} />
      {body}
    </section>
  );
}

/** Beside "What you'll get" while nothing is connected: why to connect, and the button (or why there's none yet). */
function Promo({ P, provider, children }: { P: AdPlatformInfo; provider: AdProvider; children: ReactNode }) {
  const Glyph = P.promo.icon;
  return (
    <section aria-labelledby={`ads-provider-${provider}-promo`} className="tone-card flex flex-col gap-4 rounded-xl border p-4 sm:p-5" style={tone("var(--info)")}>
      <div className="flex items-start gap-4">
        {/* The platform's mark over a disc of what it brings. */}
        <span className="relative grid size-16 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklab,var(--tone)_16%,transparent)] text-[var(--tone)]" aria-hidden>
          <Glyph size={28} strokeWidth={1.8} />
          <span className="absolute -right-1 -top-1 grid size-7 place-items-center rounded-lg border border-border bg-white shadow-[var(--shadow)]">
            <P.Icon size={14} />
          </span>
        </span>
        <div className="min-w-0">
          <PanelTitle id={`ads-provider-${provider}-promo`}>{P.promo.title}</PanelTitle>
          <p className="mt-1 text-sm text-muted">{P.promo.text}</p>
        </div>
      </div>
      {children}
    </section>
  );
}
