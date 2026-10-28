/**
 * Ad connections as the UI sees them: what GET /workspaces/:ws/stores/:storeId/ads answers
 * (apps/api/src/routes/ads.ts, publicConnection), and where each connection and each platform
 * stands (worked out in @app/shared/integrations, which the API's integrations status uses too, and
 * re-exported here). Settings → Integrations and Settings → Advertising both word a connection
 * through this module, so a state has one name and one badge on both pages.
 */
import { AD_CONNECTION_STATUSES, adErrorMessage, isAdAccountStatus, isAdErrorCode } from "@app/shared/ads";
import type { AdAccountStatus, AdConnectionStatus, AdErrorCode, AdLoginReason, AdProvider } from "@app/shared/ads";
import type { GoogleAdsConnectionStatus } from "@app/shared/adsDemo";
import { ownErrorCode, type AdState } from "@app/shared/integrations";

export type { AdProvider };
export { adLoginOf, connectionState, firstSyncOverdue, platformState, syncRunning, type AdState, type PlatformInput } from "@app/shared/integrations";

export interface AdConnection {
  id: string;
  provider: AdProvider;
  accountId: string;
  accountName: string | null;
  currency: string | null;
  timezone: string | null;
  enabled: boolean;
  status: AdConnectionStatus;
  /** Why it isn't active (AD_ERROR_CODES); null when active. */
  errorCode: AdErrorCode | null;
  /** Plain wording for the current status (the card's headline); null when active. */
  message: string | null;
  /** The platform's own reason, already cleaned by the API: only ever behind "Details", never the headline. */
  lastError: string | null;
  /** The ad account's own health at the platform. */
  accountStatus: AdAccountStatus | null;
  accountStatusDetail: string | null;
  /** The last sync that worked. */
  lastSyncedAt: string | null;
  /** When the last sync started, whatever came of it. */
  lastSyncAttemptAt: string | null;
  /**
   * How the account is read: bizinsights' own sign-in with the platform ("direct"), or ("nango") one made
   * through Nango that bizinsights is still moving off it (a few minutes). bizinsights reads the
   * platform's API itself either way.
   */
  source: "direct" | "nango";
  /** The account's own last day (YYYY-MM-DD) stored without a gap, and the first. */
  syncedThrough: string | null;
  historyFrom: string | null;
  /** A sync was asked for (connect, Refresh, re-enable) and hasn't finished yet. */
  syncRequestedAt: string | null;
  consecutiveFailures: number;
  /** Meta only: when its access ends unless someone reconnects. */
  accessExpiresAt: string | null;
  connectedAt: string;
  /** The one read permission this connection needs. */
  permission: string | null;
  /** Every permission the person who connected it granted, when the platform said. */
  grantedScopes: string[];
  /** "123-456-7890" when a Google Ads account is reached through a manager account. */
  loginCustomerId: string | null;
  /** The member whose login powers it; null when unknown or gone. */
  connectedBy: { name: string | null; email: string | null; you: boolean } | null;
  /** AdSense: the sites (DOMAIN_CODE) counted for this store, empty = every site. */
  sites: string[];
  /** AdSense: the sites seen for this account plus the chosen ones. */
  availableSites: string[];
  /**
   * The Google Ads demo (docs/ads-demo.md): simulated figures and no Google grant, nothing verified by
   * Google. Said by the API from the row alone; never true of a real account.
   */
  demo: boolean;
  connectionType: "demo" | "production";
  /** "simulated" for the demo; "authorized" when the person authorized the account at the platform. */
  verificationStatus: "simulated" | "authorized";
  /** Google Ads: where it stands in the status endpoint's words; null for other platforms. */
  connectionStatus: GoogleAdsConnectionStatus | null;
  /** The demo's seed, so its figures can be reproduced; null for a real account. */
  demoSeed: number | null;
}

/** One connection as the API sends it. An API from before 2026-10-19 leaves out the fields marked optional; adConnectionsOf fills them in. */
type ConnectionAnswer = Pick<AdConnection, "id" | "provider" | "accountId" | "accountName" | "currency" | "timezone" | "enabled" | "connectedAt"> &
  Partial<Omit<AdConnection, "id" | "provider" | "accountId" | "accountName" | "currency" | "timezone" | "enabled" | "connectedAt" | "status">> & { status: string };

export interface AdsState {
  configured: Record<AdProvider, boolean>;
  /**
   * Who may connect is limited on the platform's side. Meta: only the people with a role on
   * bizinsights' Meta app, until Meta gives it Advanced Access (anyone else is turned away on
   * Facebook's page and never comes back). Google: Google shows "Google hasn't verified this app"
   * first, until it verifies bizinsights' Google Ads access. AdSense: never. The cards say nothing
   * about it: Connect goes straight to the platform (the owner's choice, 2026-10-24).
   */
  restricted: Record<AdProvider, boolean>;
  connections: ConnectionAnswer[];
  /** Sign-ins connected with no ad account yet (absent from an API before 2026-10-26). */
  logins?: AdLogin[];
  /** Which platforms offer a simulated account ("Try demo"); absent from older answers. */
  demo?: Partial<Record<AdProvider, boolean>>;
  /** The settings each platform's real sign-in still lacks on this server, by name (never a value). */
  missing?: Partial<Record<AdProvider, string[]>>;
}

/**
 * A sign-in connected with no ad account yet (GET .../ads `logins`; the API's ad_logins): the person
 * authorized bizinsights, and the platform lists no ad account for that login so far (or didn't answer
 * in time). bizinsights asks again every hour and connects its ad accounts by itself once they appear,
 * so the card says "Connected", never an error.
 */
export interface AdLogin {
  id: string;
  provider: AdProvider;
  /** The name the platform's sign-in went by ("Connected as …"), when the platform said. */
  name: string | null;
  reason: AdLoginReason;
  connectedAt: string;
  /** When the platform was last asked for the login's ad accounts. */
  checkedAt: string;
  connectedBy: { name: string | null; email: string | null; you: boolean } | null;
}

/** One sync of a connection as it ended (GET .../ads/connections/:id/syncs). */
export interface AdSyncRun {
  trigger: "request" | "schedule" | "history" | string;
  since: string | null;
  until: string | null;
  outcome: "synced" | "skipped" | "failed" | string;
  rows: number;
  reason: string | null;
  source: string;
  startedAt: string;
  finishedAt: string;
  /** A failure, worded from its code; null otherwise. */
  message: string | null;
}

/** The account list after a sign-in that sees several accounts (GET .../ads/pending/:nonce). */
export interface PendingAccounts {
  provider: AdProvider;
  expiresAt: string;
  /** The platform's list was cut short: some accounts the login sees aren't in it. */
  truncated?: boolean;
  accounts: Array<{
    accountId: string;
    name: string | null;
    currency: string | null;
    timezone: string | null;
    /** Already connected to this store. */
    connected: boolean;
    /** Shown on the dashboard; null when not connected yet. */
    enabled?: boolean | null;
    status?: AdAccountStatus | null;
    statusDetail?: string | null;
  }>;
}

/** What DELETE .../ads/connections/:id did about bizinsights' access at the platform. */
export type RevokeOutcome = "revoked" | "still_used" | "unknown_person" | "not_configured" | "failed";

/** The status a code stands for when the API doesn't send one that matches (the rule adAlertsFor follows too). */
const STATUS_CODE: Record<Exclude<AdConnectionStatus, "active">, AdErrorCode> = { reconnect: "auth_expired", permission: "no_access", unavailable: "account_not_ready", error: "provider_error" };

/** The headline for a status, worded as the API words it (`message`), for an API that doesn't send it. */
function statusWording(c: Pick<AdConnection, "status" | "errorCode" | "provider">): string | null {
  if (c.status === "active") return null;
  return adErrorMessage(ownErrorCode(c) ?? STATUS_CODE[c.status], c.provider);
}

/** The store's connections, with every field the UI reads (an older API's answer gets the defaults). */
export function adConnectionsOf(state: AdsState | null): AdConnection[] {
  return (state?.connections ?? []).map((raw) => {
    const status: AdConnectionStatus = (AD_CONNECTION_STATUSES as readonly string[]).includes(raw.status) ? (raw.status as AdConnectionStatus) : "error";
    const errorCode = isAdErrorCode(raw.errorCode) ? raw.errorCode : null;
    const base = { status, errorCode, provider: raw.provider };
    return {
      ...raw,
      status,
      errorCode,
      message: raw.message !== undefined ? raw.message : statusWording(base),
      lastError: raw.lastError ?? null,
      accountStatus: isAdAccountStatus(raw.accountStatus) ? raw.accountStatus : null,
      accountStatusDetail: raw.accountStatusDetail ?? null,
      lastSyncedAt: raw.lastSyncedAt ?? null,
      lastSyncAttemptAt: raw.lastSyncAttemptAt ?? null,
      source: raw.source === "nango" ? "nango" : "direct",
      syncedThrough: raw.syncedThrough ?? null,
      historyFrom: raw.historyFrom ?? null,
      syncRequestedAt: raw.syncRequestedAt ?? null,
      consecutiveFailures: raw.consecutiveFailures ?? 0,
      accessExpiresAt: raw.accessExpiresAt ?? null,
      permission: raw.permission ?? null,
      grantedScopes: raw.grantedScopes ?? [],
      loginCustomerId: raw.loginCustomerId ?? null,
      connectedBy: raw.connectedBy ?? null,
      sites: raw.sites ?? [],
      availableSites: raw.availableSites ?? [],
      demo: raw.demo ?? false,
      connectionType: raw.connectionType ?? "production",
      verificationStatus: raw.verificationStatus ?? "authorized",
      connectionStatus: raw.connectionStatus ?? null,
      demoSeed: raw.demoSeed ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

// AdState (every state and when it is reached), connectionState and platformState: @app/shared/integrations.

/** The badge colours (components/dashboard/Primitives Tone): the label always says it, the colour only backs it up. */
export type StateTone = "good" | "warn" | "danger" | "neutral";

export const AD_STATE: Record<AdState, { label: string; tone: StateTone; /** Something is under way: the badge's dot pulses. */ busy?: boolean }> = {
  checking: { label: "Checking…", tone: "neutral", busy: true },
  unknown: { label: "Status unavailable", tone: "neutral" },
  coming_soon: { label: "Coming soon", tone: "neutral" },
  not_connected: { label: "Not connected", tone: "neutral" },
  connecting: { label: "Connecting", tone: "neutral", busy: true },
  synchronizing: { label: "Synchronizing", tone: "neutral", busy: true },
  connected: { label: "Connected", tone: "good" },
  authorization_required: { label: "Authorization required", tone: "warn" },
  permission_missing: { label: "Permission missing", tone: "warn" },
  verification_pending: { label: "Verification pending", tone: "warn" },
  sync_failed: { label: "Sync failed", tone: "danger" },
  reconnect_required: { label: "Reconnect required", tone: "danger" },
  disconnected: { label: "Disconnected", tone: "neutral" },
};

/**
 * The same states for the Google Ads demo, named as such wherever the demo shows: a demo is never shown
 * as plainly "Connected", so nobody takes a simulated account for a real one. Orange, as a demo badge.
 */
const DEMO_STATE: Partial<Record<AdState, { label: string; tone: StateTone; busy?: boolean }>> = {
  connecting: { label: "Connecting demo", tone: "warn", busy: true },
  synchronizing: { label: "Demo synchronizing", tone: "warn", busy: true },
  connected: { label: "Demo connected", tone: "warn" },
  sync_failed: { label: "Demo sync failed", tone: "danger" },
  disconnected: { label: "Demo disconnected", tone: "neutral" },
};

/** A state's badge wording: the demo's when it is a demo. */
export const stateInfo = (state: AdState, demo = false) => (demo ? (DEMO_STATE[state] ?? AD_STATE[state]) : AD_STATE[state]);

/** States that signing in again (Reconnect) fixes. */
export const RECONNECT_STATES: ReadonlySet<AdState> = new Set(["reconnect_required", "authorization_required", "permission_missing"]);

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** Each permission a platform can grant bizinsights, in words. Anything else is shown by its own name. */
const SCOPE_WORDS: Record<string, string> = {
  "https://www.googleapis.com/auth/adwords": "Read Google Ads reports",
  "https://www.googleapis.com/auth/adsense.readonly": "Read AdSense reports (read-only)",
  ads_read: "Read Meta ads reports (read-only)",
  openid: "Know which Google account signed in",
  email: "See the account's email address",
  "https://www.googleapis.com/auth/userinfo.email": "See the account's email address",
  profile: "See the account's name and picture",
  "https://www.googleapis.com/auth/userinfo.profile": "See the account's name and picture",
  public_profile: "See the Facebook profile's name and picture",
};

/** The permissions this connection was granted, in words (the needed one when the platform didn't list them). */
export function grantedPermissions(c: Pick<AdConnection, "grantedScopes" | "permission" | "demo">): string[] {
  // A demo holds no Google permission at all: its row names its own, fictional ones instead.
  if (c.demo) return [];
  const scopes = c.grantedScopes.length ? c.grantedScopes : c.permission ? [c.permission] : [];
  return [...new Set(scopes.map((s) => SCOPE_WORDS[s] ?? s))];
}

/** A connection's name for headings and for its controls' accessible names. */
export const accountLabel = (c: Pick<AdConnection, "accountName" | "accountId">) => c.accountName ?? `Account ${c.accountId}`;

/** Where a person removes bizinsights' access themselves, when bizinsights couldn't give it back. */
export const REMOVE_ACCESS: Record<AdProvider, { url: string; label: string }> = {
  google: { url: "https://myaccount.google.com/permissions", label: "your Google Account's third-party connections" },
  adsense: { url: "https://myaccount.google.com/permissions", label: "your Google Account's third-party connections" },
  meta: { url: "https://www.facebook.com/settings?tab=business_tools", label: "Facebook's Business integrations settings" },
};

/** What to tell the person after a disconnect about bizinsights' access at the platform (null: nothing to add). */
export function revokeNote(provider: AdProvider, outcome: RevokeOutcome | undefined): { kind: "success" | "info"; text: string; link?: { url: string; label: string } } | null {
  const google = provider !== "meta";
  switch (outcome) {
    case "revoked":
      return { kind: "success", text: google ? "bizinsights also handed its access back to Google." : "bizinsights also gave up its permission to read your Meta ads." };
    case "still_used":
      return {
        kind: "info",
        text: google
          ? "bizinsights keeps its access at Google for now: another account here was connected with the same Google login (Google Ads and AdSense share it). It's handed back with the last of them."
          : "bizinsights keeps its permission at Meta for now: another ad account here was connected with the same Facebook login. It's given up with the last of them.",
      };
    case "failed":
    case "unknown_person":
    case "not_configured":
      return {
        kind: "info",
        text: `bizinsights couldn't hand its access back to ${google ? "Google" : "Meta"} by itself. Nothing is read any more; to remove the access too, open`,
        link: REMOVE_ACCESS[provider],
      };
    default:
      return null;
  }
}
