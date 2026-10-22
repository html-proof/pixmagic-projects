"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { adAccountStatusLabel, sameDays } from "@app/shared/ads";
import { DEMO_BADGE, DEMO_PERMISSIONS } from "@app/shared/adsDemo";
import { localDay } from "@app/shared/dates";
import { ConfirmDialog } from "@/components/AppUi";
import { fmtDay, fmtRelative } from "@/components/dashboard/format";
import { Alert } from "@/components/ui";
import { useApi } from "@/lib/api";
import { AD_STATE, accountLabel, connectionState, firstSyncOverdue, grantedPermissions, stateInfo, type AdConnection, type AdState, type AdSyncRun } from "@/lib/adConnections";
import { AD_PLATFORMS } from "./adPlatforms";
import { Facts, StatusBadge } from "./IntegrationCard";

// ---------------------------------------------------------------------------
// The pieces both integrations pages build their ad cards from: the state badge, one connected
// account with everything known about it, the disconnect dialog and its outcome, and the live
// region that reads out a card's state when it changes.
// ---------------------------------------------------------------------------

/** An ad connection's (or platform's) state as a badge; a demo's named as such ("Demo connected"). */
export function StateBadge({ state, testid, demo = false }: { state: AdState; testid?: string; demo?: boolean }) {
  const s = stateInfo(state, demo);
  return <StatusBadge label={s.label} tone={s.tone} busy={s.busy} testid={testid} state={state} />;
}

const TONE_TEXT = { good: "text-good", warn: "text-warn", danger: "text-danger", neutral: "text-muted" } as const;

const daysUntil = (iso: string | null) => (iso ? Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000) : null);

/** The full date and time, for a relative time's tooltip. */
const exact = (iso: string) => new Date(iso).toLocaleString();

/** What the account is doing, in one sentence, when its status has no message of its own. */
function activeLine(c: AdConnection, state: AdState): string | null {
  if (state === "synchronizing") {
    return c.lastSyncedAt ? "Updating now. The dashboard follows by itself." : "Fetching the last 90 days now, then earlier history a few months at a time.";
  }
  if (firstSyncOverdue(c)) return "The first update hasn't come through yet. bizinsights tries again by itself; Refresh asks for it now.";
  if (!c.enabled && !c.lastSyncedAt && c.status === "active") return "Nothing fetched yet: bizinsights fetches this account's figures once it's shown on the dashboard.";
  const status = adAccountStatusLabel(c.accountStatus, c.provider);
  if (status) return `${AD_PLATFORMS[c.provider].name} says: ${status}.`;
  return null;
}

/** How often an account's recent days are fetched again by itself, as the worker schedules it (apps/worker handlers/integrations.ts). */
function refreshCadence(c: Pick<AdConnection, "provider" | "source">): string {
  if (c.source === "supermetrics") return "about every 6 hours";
  return c.provider === "google" ? "about every 3 hours" : "about every hour";
}

/** How current the stored figures are: the last day stored, against the account's own today. */
function freshness(c: Pick<AdConnection, "syncedThrough" | "timezone" | "provider" | "source">, now = new Date()): string {
  if (!c.syncedThrough) return "Nothing stored yet";
  let today: string;
  try {
    today = localDay(now, c.timezone || "UTC");
  } catch {
    today = localDay(now, "UTC");
  }
  const behind = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${c.syncedThrough}T00:00:00Z`)) / 86_400_000);
  const when = behind <= 0 ? "Includes today (still coming in)" : behind === 1 ? "Through yesterday" : `${behind} days behind`;
  return `${when} · refreshes ${refreshCadence(c)}`;
}

const TRIGGER_WORDS: Record<string, string> = { request: "Asked for", schedule: "Scheduled", history: "History" };
const SKIP_WORDS: Record<string, string> = {
  nothing: "nothing new to fetch",
  gone: "the account was removed",
  hidden: "hidden from the dashboard",
  no_token: "no access held",
  budget: "held back to keep within the day's allowance",
  paused: "paused for the day's allowance",
  health_failed: "account check didn't answer",
};

/** The last syncs of one account (GET .../syncs), read only when someone opens the list. */
function RecentSyncs({ path, name }: { path: string; name: string }) {
  const [open, setOpen] = useState(false);
  const runs = useApi<{ runs: AdSyncRun[] }>(open ? path : null);
  return (
    <details className="text-xs text-muted" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} data-testid="recent-syncs">
      <summary className="cursor-pointer select-none">
        Recent syncs<span className="sr-only"> for {name}</span>
      </summary>
      <div className="mt-1">
        {runs.error && !runs.data ? (
          <p>The sync history couldn&apos;t be loaded just now.</p>
        ) : !runs.data ? (
          <p>Loading…</p>
        ) : !runs.data.runs.length ? (
          <p>No sync has run yet.</p>
        ) : (
          <ul className="space-y-1">
            {runs.data.runs.map((r) => (
              <li key={`${r.startedAt}-${r.trigger}`} className="break-words" data-outcome={r.outcome}>
                <span title={exact(r.startedAt)}>{fmtRelative(r.startedAt)}</span> · {TRIGGER_WORDS[r.trigger] ?? r.trigger} ·{" "}
                {r.outcome === "synced" ? (
                  <span className="text-good">
                    {r.rows} row{r.rows === 1 ? "" : "s"}
                    {r.since && r.until ? `, ${fmtDay(r.since)} – ${fmtDay(r.until)}` : ""}
                  </span>
                ) : r.outcome === "failed" ? (
                  <span className="text-danger">Didn&apos;t work{r.message ? `: ${r.message}` : ""}</span>
                ) : (
                  <span>Skipped{r.reason ? `: ${SKIP_WORDS[r.reason] ?? r.reason}` : ""}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

/**
 * One connected ad account: its name and id, currency and time zone, how it stands and why, when it
 * last synced and how far its figures go, the permissions granted, who connected it, and (for
 * those allowed) its "Show on dashboard" switch and Disconnect. `children`: more for this account
 * (the AdSense sites).
 */
export function AdAccountRow({
  c,
  storeTimezone,
  manage,
  busy,
  onToggle,
  onDisconnect,
  demoActions,
  onReconnectSupermetrics,
  syncsPath,
  children,
}: {
  c: AdConnection;
  storeTimezone: string | null;
  manage: boolean;
  busy: boolean;
  onToggle: () => void;
  onDisconnect: () => void;
  /** The Google Ads demo's own actions (for those who manage integrations). */
  demoActions?: { onSync: () => void; onReset: () => void };
  /** A connection read through Supermetrics: sign in again through Supermetrics (offered while it needs reconnecting). */
  onReconnectSupermetrics?: () => void;
  /** Where its recent syncs are read from; none, no list. */
  syncsPath?: string | null;
  children?: ReactNode;
}) {
  const state = connectionState(c);
  const tone = stateInfo(state, c.demo).tone;
  const name = accountLabel(c);
  const P = AD_PLATFORMS[c.provider];
  // A sync asked for is running: that's the news, even for an account whose last update failed.
  const headline = state === "synchronizing" ? activeLine(c, state) : (c.message ?? activeLine(c, state));
  const otherDays = !!c.timezone && !!storeTimezone && !sameDays(c.timezone, storeTimezone, new Date());
  const accessLeft = c.provider === "meta" ? daysUntil(c.accessExpiresAt) : null;
  const permissions = grantedPermissions(c);
  const accountStatus = adAccountStatusLabel(c.accountStatus, c.provider) ?? (c.accountStatus === "active" ? "Active" : null);
  const supermetrics = c.source === "supermetrics";

  const facts: Array<[string, ReactNode]> = [
    // A demo says what it is where a real account says who it belongs to.
    ...(c.demo
      ? ([
          ["Account type", "Demo advertising account (simulated)"],
          ["Data source", "Generated sample data"],
          ["Billing", "Not applicable: demo"],
          ["Verification", "Not verified by Google"],
          ["Demo seed", String(c.demoSeed ?? "—")],
        ] as Array<[string, ReactNode]>)
      : []),
    ...(c.demo ? [] : ([["Read through", supermetrics ? "Supermetrics" : `Direct connection to ${P.name}`]] as Array<[string, ReactNode]>)),
    ["Last successful sync", c.lastSyncedAt ? <span title={exact(c.lastSyncedAt)}>{fmtRelative(c.lastSyncedAt)}</span> : "Not yet"],
    ["Last attempted sync", c.lastSyncAttemptAt ? <span title={exact(c.lastSyncAttemptAt)}>{fmtRelative(c.lastSyncAttemptAt)}</span> : "Not yet"],
    ["Data through", c.syncedThrough ? `${fmtDay(c.syncedThrough)}${c.historyFrom ? ` (from ${fmtDay(c.historyFrom)})` : ""}` : "Nothing stored yet"],
    ["Data freshness", freshness(c)],
  ];
  if (accountStatus) facts.push([`Account at ${P.name}`, accountStatus]);
  if (c.loginCustomerId) facts.push(["Reached through", `Manager account ${c.loginCustomerId}`]);
  if (c.connectedBy) facts.push(["Connected by", c.connectedBy.you ? "You" : (c.connectedBy.name ?? c.connectedBy.email ?? "A member of this workspace")]);
  facts.push(["Connected", <span key="at" title={exact(c.connectedAt)}>{fmtRelative(c.connectedAt)}</span>]);
  if (accessLeft !== null) facts.push(["Meta access ends", accessLeft <= 0 ? "Ended" : `In ${accessLeft} day${accessLeft === 1 ? "" : "s"}`]);

  return (
    <li className="space-y-2 px-3 py-3" data-testid="ad-account" data-state={state} data-account={c.accountId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            <span className="break-words">{name}</span>
            <StateBadge state={state} demo={c.demo} testid="account-state" />
            {!c.enabled && <span className="text-xs font-normal text-muted">Hidden from the dashboard</span>}
          </p>
          <p className="text-xs text-muted">
            {c.accountId}
            {c.currency ? ` · ${c.currency}` : ""}
            {c.timezone ? ` · ${c.timezone}` : ""}
          </p>
          {c.demo && (
            <p className="mt-1 inline-flex rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-xs font-medium text-warn" data-testid="demo-badge">
              {DEMO_BADGE}
            </p>
          )}
        </div>
        {manage && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
              {/* Named for the account (the visible words first): every row has one. */}
              <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={c.enabled} onChange={onToggle} disabled={busy} aria-label={`Show on dashboard: ${name}`} />
              Show on dashboard
            </label>
            <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={onDisconnect} disabled={busy} aria-label={`Disconnect ${name}`} data-testid="account-disconnect">
              {c.demo ? "Disconnect demo" : "Disconnect"}
            </button>
          </div>
        )}
      </div>

      {headline && (
        <p className={`text-sm ${tone === "good" ? "text-muted" : TONE_TEXT[tone]}`} data-testid="account-message">
          {headline}
        </p>
      )}
      {accessLeft !== null && accessLeft > 0 && accessLeft <= 14 && c.status === "active" && (
        <p className="text-sm text-warn">Meta access ends in {accessLeft} day{accessLeft === 1 ? "" : "s"}: reconnect to keep the numbers coming.</p>
      )}
      {otherDays && (
        <p className="text-xs text-warn" data-testid="timezone-note">
          Note: this account&apos;s days follow {c.timezone}, the store&apos;s follow {storeTimezone}. Each day&apos;s ad figures cover different hours than the store&apos;s day.
        </p>
      )}

      <Facts
        rows={[
          ...facts,
          [
            "Permissions granted",
            c.demo ? (
              <>
                Demo data access (simulated): {DEMO_PERMISSIONS.join(" · ")}.
                <span className="block text-xs text-muted">Fictional application permissions, not Google OAuth scopes: no Google permission was requested or granted.</span>
              </>
            ) : supermetrics ? (
              <>
                Granted to Supermetrics on {c.provider === "meta" ? "Facebook's" : "Google's"} screen, not to bizinsights.
                <span className="block text-xs text-muted">bizinsights only reads reports through bizinsights&apos; Supermetrics team; disconnecting ends that Supermetrics login.</span>
              </>
            ) : (
              <>
                {permissions.length ? permissions.join(" · ") : "Not listed by the platform"}
                {c.provider === "google" && <span className="block text-xs text-muted">Google has no read-only permission for Google Ads; bizinsights only reads.</span>}
              </>
            ),
          ],
        ]}
      />

      {manage && onReconnectSupermetrics && c.status === "reconnect" && (
        <button type="button" className="btn-primary h-8 px-3 text-xs" onClick={onReconnectSupermetrics} disabled={busy} aria-label={`Reconnect ${name} through Supermetrics`} data-testid="account-reconnect-supermetrics">
          Reconnect through Supermetrics
        </button>
      )}
      {(c.lastError || c.accountStatusDetail) && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer select-none">
            Details<span className="sr-only"> for {name}</span>
          </summary>
          <div className="mt-1 space-y-1 break-words">
            {c.lastError && <p>What {supermetrics ? "Supermetrics" : P.name} said: {c.lastError}</p>}
            {c.accountStatusDetail && <p>About the account: {c.accountStatusDetail}</p>}
            {c.consecutiveFailures > 1 && <p>Updates in a row that didn&apos;t work: {c.consecutiveFailures}</p>}
          </div>
        </details>
      )}
      {syncsPath && !c.demo && <RecentSyncs path={syncsPath} name={name} />}
      {c.demo && (
        <div className="flex flex-wrap items-center gap-2" data-testid="demo-actions">
          <Link className="btn-primary h-8 px-3 text-xs" href="/ads/google">
            Open demo dashboard
          </Link>
          {manage && demoActions && (
            <>
              <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={demoActions.onSync} disabled={busy} data-testid="demo-sync">
                Sync demo data
              </button>
              <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={demoActions.onReset} disabled={busy} data-testid="demo-reset">
                Reset demo data
              </button>
            </>
          )}
        </div>
      )}
      {children}
    </li>
  );
}

/** What a page tells the person after an action: an Alert, with a link when there is somewhere to go. */
export interface Note {
  kind: "success" | "error" | "info";
  text: string;
  link?: { url: string; label: string };
  /** Take the keyboard focus: what had it is gone (the row of an account just disconnected). */
  focus?: boolean;
}

export function NoteAlert({ note, onDismiss }: { note: Note; onDismiss?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Runs after the closing dialog hands focus back to the button it came from, which is about to go.
  useEffect(() => {
    if (note.focus) ref.current?.focus();
  }, [note]);
  return (
    <div ref={ref} tabIndex={note.focus ? -1 : undefined} className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="action-note">
      <Alert kind={note.kind} onDismiss={onDismiss}>
        {note.text}
        {note.link && (
          <>
            {" "}
            <a className="underline" href={note.link.url} target="_blank" rel="noopener noreferrer">
              {note.link.label}
            </a>
            .
          </>
        )}
      </Alert>
    </div>
  );
}

/** Disconnecting one account: what it deletes and what it leaves alone, before it happens. */
export function DisconnectDialog({ c, busy, onConfirm, onCancel }: { c: AdConnection | null; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const P = c ? AD_PLATFORMS[c.provider] : null;
  return (
    <ConfirmDialog open={!!c} title={c ? `Disconnect ${accountLabel(c)}?` : ""} confirmLabel="Disconnect" danger busy={busy} onConfirm={onConfirm} onCancel={onCancel}>
      {c?.demo && (
        <p>
          The demo&apos;s simulated figures are deleted from bizinsights. No Google access was ever granted for it, so there is nothing to hand back, and your real ad accounts
          aren&apos;t touched. You can connect the demo again at any time.
        </p>
      )}
      {c && P && !c.demo && c.source === "supermetrics" && (
        <p>
          bizinsights deletes every figure it fetched for this {P.name} account and stops reading it. It then ends the Supermetrics login it was read through, once no other
          account here is read through the same login. Your {c.provider === "adsense" ? "site and its ads" : "ads"} keep running.
        </p>
      )}
      {c && P && !c.demo && c.source !== "supermetrics" && (
        <p>
          bizinsights deletes its access to this {P.name} account and every figure it fetched for it, and stops reading it. It then hands its access back to{" "}
          {c.provider === "meta" ? "Meta" : "Google"} once no other account here was connected with the same login. Your {c.provider === "adsense" ? "site and its ads" : "ads"} keep
          running.
        </p>
      )}
    </ConfirmDialog>
  );
}

/**
 * A live region that reads out a card's new state when it changes ("Google Ads: Synchronizing",
 * then "Google Ads: Connected"), not the states the page opens with.
 */
export function StateAnnouncer({ items }: { items: Array<[name: string, label: string]> }) {
  const before = useRef<Map<string, string> | null>(null);
  const [said, setSaid] = useState("");
  const key = items.map(([n, l]) => `${n}=${l}`).join("|");
  useEffect(() => {
    const now = new Map(items);
    const prev = before.current;
    before.current = now;
    if (!prev) return;
    const changed = items.filter(([n, l]) => prev.has(n) && prev.get(n) !== l && prev.get(n) !== AD_STATE.checking.label);
    if (changed.length) setSaid(changed.map(([n, l]) => `${n}: ${l}`).join(". "));
    // `key` stands for the items: a new array with the same states is no change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <p className="sr-only" role="status" aria-live="polite" data-testid="state-announcer">
      {said}
    </p>
  );
}
