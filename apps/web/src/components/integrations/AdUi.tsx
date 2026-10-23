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
import { StatusBadge } from "./IntegrationCard";

// ---------------------------------------------------------------------------
// The pieces both integrations pages build their ad cards from: the state badge, what is known
// about a connected account, the disconnect dialog and its outcome, and the live region that reads
// out a card's state when it changes.
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
export function refreshCadence(c: Pick<AdConnection, "provider">): string {
  return c.provider === "google" ? "about every 3 hours" : "about every hour";
}

/** How current the stored figures are: the last day stored, against the account's own today. */
export function dataAge(c: Pick<AdConnection, "syncedThrough" | "timezone">, now = new Date()): string {
  if (!c.syncedThrough) return "Nothing stored yet";
  let today: string;
  try {
    today = localDay(now, c.timezone || "UTC");
  } catch {
    today = localDay(now, "UTC");
  }
  const behind = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${c.syncedThrough}T00:00:00Z`)) / 86_400_000);
  return behind <= 0 ? "Includes today (still coming in)" : behind === 1 ? "Through yesterday" : `${behind} days behind`;
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
export function RecentSyncs({ path, name }: { path: string; name: string }) {
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

type Row = [string, ReactNode];

/**
 * Everything known about one connected account, each as a label and its value, for its panel on
 * Settings → Advertising (AccountPanel), which orders them its own way.
 */
export function accountFacts(c: AdConnection) {
  const P = AD_PLATFORMS[c.provider];
  const accessLeft = c.provider === "meta" ? daysUntil(c.accessExpiresAt) : null;
  const accountStatus = adAccountStatusLabel(c.accountStatus, c.provider) ?? (c.accountStatus === "active" ? "Active" : null);
  const permissions = grantedPermissions(c);
  const row = (label: string, value: ReactNode): Row => [label, value];
  return {
    // A demo says what it is where a real account says who it belongs to.
    demo: c.demo
      ? [
          row("Account type", "Demo advertising account (simulated)"),
          row("Data source", "Generated sample data"),
          row("Billing", "Not applicable: demo"),
          row("Verification", "Not verified by Google"),
          row("Demo seed", String(c.demoSeed ?? "—")),
        ]
      : [],
    readThrough: c.demo ? null : row("Read through", c.source === "nango" ? `Direct connection to ${P.name} (sign-in kept by Nango)` : `Direct connection to ${P.name}`),
    lastSynced: row("Last successful sync", c.lastSyncedAt ? <span title={exact(c.lastSyncedAt)}>{fmtRelative(c.lastSyncedAt)}</span> : "Not yet"),
    lastAttempt: row("Last attempted sync", c.lastSyncAttemptAt ? <span title={exact(c.lastSyncAttemptAt)}>{fmtRelative(c.lastSyncAttemptAt)}</span> : "Not yet"),
    dataThrough: row("Data through", c.syncedThrough ? `${fmtDay(c.syncedThrough)}${c.historyFrom ? ` (from ${fmtDay(c.historyFrom)})` : ""}` : "Nothing stored yet"),
    accountStatus: accountStatus ? row(`Account at ${P.name}`, accountStatus) : null,
    reachedThrough: c.loginCustomerId ? row("Reached through", `Manager account ${c.loginCustomerId}`) : null,
    connectedBy: c.connectedBy ? row("Connected by", c.connectedBy.you ? "You" : (c.connectedBy.name ?? c.connectedBy.email ?? "A member of this workspace")) : null,
    connected: row("Connected", <span title={exact(c.connectedAt)}>{fmtRelative(c.connectedAt)}</span>),
    accessEnds: accessLeft !== null ? row("Meta access ends", accessLeft <= 0 ? "Ended" : `In ${accessLeft} day${accessLeft === 1 ? "" : "s"}`) : null,
    permissions: row(
      "Permissions granted",
      c.demo ? (
        <>
          Demo data access (simulated): {DEMO_PERMISSIONS.join(" · ")}.
          <span className="block text-xs text-muted">Fictional application permissions, not Google OAuth scopes: no Google permission was requested or granted.</span>
        </>
      ) : (
        <>
          {permissions.length ? permissions.join(" · ") : "Not listed by the platform"}
          {c.provider === "google" && <span className="block text-xs text-muted">Google has no read-only permission for Google Ads; bizinsights only reads.</span>}
        </>
      ),
    ),
  };
}

/** The facts that apply, in the order given. */
export const present = (rows: Array<Row | null>): Row[] => rows.filter((r): r is Row => r !== null);

/**
 * What an account is doing, or what went wrong, in a sentence; that its Meta access ends soon; and that
 * its days are another time zone's than the store's.
 */
export function AccountMessages({ c, storeTimezone }: { c: AdConnection; storeTimezone: string | null }) {
  const state = connectionState(c);
  const tone = stateInfo(state, c.demo).tone;
  // A sync asked for is running: that's the news, even for an account whose last update failed.
  const headline = state === "synchronizing" ? activeLine(c, state) : (c.message ?? activeLine(c, state));
  const otherDays = !!c.timezone && !!storeTimezone && !sameDays(c.timezone, storeTimezone, new Date());
  const accessLeft = c.provider === "meta" ? daysUntil(c.accessExpiresAt) : null;
  return (
    <>
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
    </>
  );
}

/** The platform's own words about an account's last failure or its status, behind "Details". */
export function AccountProblems({ c }: { c: AdConnection }) {
  if (!c.lastError && !c.accountStatusDetail) return null;
  return (
    <details className="text-xs text-muted">
      <summary className="cursor-pointer select-none">
        Details<span className="sr-only"> for {accountLabel(c)}</span>
      </summary>
      <div className="mt-1 space-y-1 break-words">
        {c.lastError && <p>What {AD_PLATFORMS[c.provider].name} said: {c.lastError}</p>}
        {c.accountStatusDetail && <p>About the account: {c.accountStatusDetail}</p>}
        {c.consecutiveFailures > 1 && <p>Updates in a row that didn&apos;t work: {c.consecutiveFailures}</p>}
      </div>
    </details>
  );
}

export function DemoBadge() {
  return (
    <p className="inline-flex rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-xs font-medium text-warn" data-testid="demo-badge">
      {DEMO_BADGE}
    </p>
  );
}

/** The Google Ads demo's own buttons: its dashboard, and (for those who manage integrations) a sync or a reset of its figures. */
export function DemoActions({ manage, busy, actions }: { manage: boolean; busy: boolean; actions?: { onSync: () => void; onReset: () => void } }) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="demo-actions">
      <Link className="btn-primary h-8 px-3 text-xs" href="/advertising/google/analytics">
        Open demo dashboard
      </Link>
      {manage && actions && (
        <>
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={actions.onSync} disabled={busy} data-testid="demo-sync">
            Sync demo data
          </button>
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={actions.onReset} disabled={busy} data-testid="demo-reset">
            Reset demo data
          </button>
        </>
      )}
    </div>
  );
}

/** An account's "Show on dashboard" box, named for the account (the visible words first): every row has one. */
export function ShowOnDashboard({ c, busy, onToggle }: { c: AdConnection; busy: boolean; onToggle: () => void }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={c.enabled} onChange={onToggle} disabled={busy} aria-label={`Show on dashboard: ${accountLabel(c)}`} />
      Show on dashboard
    </label>
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
      {c && P && !c.demo && (
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
