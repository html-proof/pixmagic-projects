"use client";
import type { ReactNode } from "react";
import { Unlink } from "lucide-react";
import { Dot } from "@/components/dashboard/Primitives";
import { AccountMessages, AccountProblems, DemoActions, DemoBadge, RecentSyncs, ShowOnDashboard, accountFacts, dataAge, present, refreshCadence } from "@/components/integrations/AdUi";
import { Facts } from "@/components/integrations/IntegrationCard";
import { accountLabel, connectionState, stateInfo, type AdConnection } from "@/lib/adConnections";
import { PanelTitle, Rows, StatePill } from "./ui";

/** "America/Los_Angeles", allowed to wrap after its slashes rather than inside a word. */
const zone = (tz: string) => tz.split("/").flatMap((part, i, all) => (i < all.length - 1 ? [`${part}/`, <wbr key={i} />] : [part]));

/**
 * One connected account on Settings → Advertising: what it is (Account details) and how its figures
 * stand (Data status) side by side, what it is doing or what went wrong, and, behind the card's "View
 * data details", the rest of what is known about it (permissions, who connected it, recent syncs).
 * Its Disconnect sits in the card's header when it is the platform's only account (`single`).
 * `children`: more for this account (the AdSense sites).
 */
export function AccountPanel({
  c,
  storeTimezone,
  manage,
  busy,
  single,
  more,
  moreId,
  onToggle,
  onDisconnect,
  demoActions,
  syncsPath,
  children,
}: {
  c: AdConnection;
  storeTimezone: string | null;
  manage: boolean;
  busy: boolean;
  single: boolean;
  /** "View data details" is open. */
  more: boolean;
  moreId: string;
  onToggle: () => void;
  onDisconnect: () => void;
  /** The Google Ads demo's own actions (for those who manage integrations). */
  demoActions?: { onSync: () => void; onReset: () => void };
  /** Where its recent syncs are read from; none, no list. */
  syncsPath?: string | null;
  children?: ReactNode;
}) {
  const state = connectionState(c);
  const name = accountLabel(c);
  const f = accountFacts(c);
  const [, lastSynced] = f.lastSynced;

  return (
    <li className="min-w-0 overflow-hidden rounded-xl border border-border bg-bg/40" data-testid="ad-account" data-state={state} data-account={c.accountId}>
      <div className="space-y-2 px-4 pt-3 empty:hidden">
        {c.demo && <DemoBadge />}
        <AccountMessages c={c} storeTimezone={storeTimezone} />
      </div>

      <div className="grid sm:grid-cols-2">
        <section className="min-w-0 p-4" aria-labelledby={`${moreId}-account`}>
          <PanelTitle id={`${moreId}-account`}>Account details</PanelTitle>
          <Rows
            rows={present([
              ["Account name", name],
              ["Account ID", c.accountId],
              ["Time zone", c.timezone ? <span>{zone(c.timezone)}</span> : "Not given"],
              ["Currency", c.currency ?? "Not given"],
              f.accountStatus,
              f.reachedThrough,
            ])}
          />
        </section>
        <section className="min-w-0 border-t border-border p-4 sm:border-l sm:border-t-0" aria-labelledby={`${moreId}-data`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <PanelTitle id={`${moreId}-data`}>Data status</PanelTitle>
            <StatePill state={state} demo={c.demo} testid="account-state" />
          </div>
          <Rows
            rows={[
              [
                "Last synced",
                <span className="inline-flex items-center gap-2">
                  <Dot tone={c.lastSyncedAt ? stateInfo(state, c.demo).tone : "neutral"} />
                  {lastSynced}
                </span>,
              ],
              f.dataThrough,
              ["Freshness", dataAge(c)],
              ["Sync frequency", `Refreshes ${refreshCadence(c)}`],
            ]}
          />
          {!c.enabled && <p className="mt-3 text-xs text-muted">Hidden from the dashboard</p>}
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 empty:hidden">
        {manage && <ShowOnDashboard c={c} busy={busy} onToggle={onToggle} />}
        {manage && !single && (
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={onDisconnect} disabled={busy} aria-label={`Disconnect ${name}`} data-testid="account-disconnect">
            <Unlink size={13} aria-hidden />
            {c.demo ? "Disconnect demo" : "Disconnect"}
          </button>
        )}
      </div>

      <div className="space-y-2 px-4 pb-3 empty:hidden">
        <AccountProblems c={c} />
        {c.demo && <DemoActions manage={manage} busy={busy} actions={demoActions} />}
        {children}
      </div>

      <div id={moreId} hidden={!more} className="space-y-3 border-t border-border px-4 py-3 text-sm">
        <Facts rows={present([...f.demo, f.readThrough, f.lastAttempt, f.connectedBy, f.connected, f.accessEnds, f.permissions])} />
        {syncsPath && !c.demo && <RecentSyncs path={syncsPath} name={name} />}
      </div>
    </li>
  );
}
