/**
 * Ad connections as the UI sees them: what GET /workspaces/:ws/stores/:storeId/ads answers
 * (apps/api/src/routes/ads.ts, publicConnection), and where each connection and each platform
 * stands. Settings → Connect your business and Settings → Advertising both word a connection
 * through this module, so a state has one name and one badge on both pages.
 */
import { AD_CONNECTION_STATUSES, AD_ERROR_STATUS, adErrorMessage, isAdAccountStatus, isAdErrorCode } from "@app/shared/ads";
import type { AdAccountStatus, AdConnectionStatus, AdErrorCode, AdProvider } from "@app/shared/ads";

export type { AdProvider };

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
   * first, until it verifies bizinsights' Google Ads access. AdSense: never.
   */
  restricted: Record<AdProvider, boolean>;
  connections: ConnectionAnswer[];
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

/** The error code, only when it belongs to the status (a row written half-way through a change can disagree). */
const codeOf = (c: Pick<AdConnection, "status" | "errorCode">): AdErrorCode | null => (c.errorCode && AD_ERROR_STATUS[c.errorCode] === c.status ? c.errorCode : null);

/** The headline for a status, worded as the API words it (`message`), for an API that doesn't send it. */
function statusWording(c: Pick<AdConnection, "status" | "errorCode" | "provider">): string | null {
  if (c.status === "active") return null;
  return adErrorMessage(codeOf(c) ?? STATUS_CODE[c.status], c.provider);
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
    };
  });
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/**
 * Where a connection, or a platform's card, stands. Every state is reachable:
 *
 * | State                  | Badge                  | When                                                                                                      |
 * | ---------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
 * | checking               | Checking…              | the card's first answer hasn't arrived                                                                    |
 * | unknown                | Status unavailable     | the first answer failed (an outage): never shown as "Not connected"                                        |
 * | coming_soon            | Coming soon            | the platform isn't set up on this server (configured false) and nothing is connected                      |
 * | not_connected          | Not connected          | nothing connected, and the platform lets anyone connect                                                   |
 * | connecting             | Connecting             | leaving for the platform's sign-in, or back from it with accounts to choose                               |
 * | synchronizing          | Synchronizing          | a requested sync hasn't finished (syncRequestedAt after lastSyncedAt), or active and never synced yet      |
 * | connected              | Connected              | active, and a sync has worked                                                                             |
 * | authorization_required | Authorization required | reconnect + connector_left: the person whose login powered it left; someone with access must authorize again |
 * | permission_missing     | Permission missing     | reconnect + scope_missing (the read permission was taken back), or status permission (this login lost the account) |
 * | verification_pending   | Verification pending   | an unconnected card whose platform is restricted; error + not_approved; unavailable + account_not_ready;    |
 * |                        |                        | an active account the platform has under review, not finished setting up, or needing attention           |
 * | sync_failed            | Sync failed            | error (other than not_approved); unavailable + account_disabled; an active account the platform disabled  |
 * | reconnect_required     | Reconnect required     | reconnect + auth_expired (or no code): the sign-in expired or was revoked                                  |
 * | disconnected           | Disconnected           | unavailable + account_closed, or the platform says the account is closed; and, for a moment, a card whose  |
 * |                        |                        | last account the person just disconnected                                                                 |
 *
 * A requested sync shows "Synchronizing" for every status but reconnect (nothing is queued for those).
 */
export type AdState =
  | "checking"
  | "unknown"
  | "coming_soon"
  | "not_connected"
  | "connecting"
  | "synchronizing"
  | "connected"
  | "authorization_required"
  | "permission_missing"
  | "verification_pending"
  | "sync_failed"
  | "reconnect_required"
  | "disconnected";

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

/** States that signing in again (Reconnect) fixes. */
export const RECONNECT_STATES: ReadonlySet<AdState> = new Set(["reconnect_required", "authorization_required", "permission_missing"]);

/** The account statuses that mean "not ready at the platform yet". */
const NOT_READY: ReadonlySet<AdAccountStatus> = new Set(["under_review", "setup_unfinished", "needs_attention"]);

/** A requested sync older than this is taken as lost (the API's ADS_REQUEST_STALE_MS): the card stops saying "Synchronizing". */
const SYNC_REQUEST_STALE_MS = 30 * 60_000;

/** A sync someone asked for is still running. */
export function syncRunning(c: Pick<AdConnection, "syncRequestedAt" | "lastSyncedAt">, now = Date.now()): boolean {
  if (!c.syncRequestedAt) return false;
  const asked = Date.parse(c.syncRequestedAt);
  if (Number.isNaN(asked) || now - asked > SYNC_REQUEST_STALE_MS) return false;
  return !c.lastSyncedAt || asked > Date.parse(c.lastSyncedAt);
}

/** Where one connection stands. */
export function connectionState(c: AdConnection, now = Date.now()): AdState {
  const code = codeOf(c);
  if (c.status === "reconnect") return code === "connector_left" ? "authorization_required" : code === "scope_missing" ? "permission_missing" : "reconnect_required";
  if (syncRunning(c, now)) return "synchronizing";
  if (c.status === "permission") return "permission_missing";
  if (c.status === "unavailable") return code === "account_closed" ? "disconnected" : code === "account_disabled" ? "sync_failed" : "verification_pending";
  if (c.status === "error") return code === "not_approved" ? "verification_pending" : "sync_failed";
  if (!c.lastSyncedAt) return "synchronizing";
  if (c.accountStatus === "closed") return "disconnected";
  if (c.accountStatus === "disabled") return "sync_failed";
  if (c.accountStatus && NOT_READY.has(c.accountStatus)) return "verification_pending";
  return "connected";
}

/** Most pressing first: a platform's card shows the worst of its accounts' states. */
const PRECEDENCE: AdState[] = ["reconnect_required", "authorization_required", "permission_missing", "sync_failed", "verification_pending", "synchronizing", "connected", "disconnected"];

export interface PlatformInput {
  /** The answer, once one arrived (null while loading or after a first load failed). */
  answer: AdsState | null;
  /** The first load failed. */
  failed: boolean;
  /** This platform's connections (adConnectionsOf). */
  connections: AdConnection[];
  /** Leaving for its sign-in, or choosing its accounts after coming back. */
  connecting?: boolean;
  /** Its last account was just disconnected on this page. */
  justDisconnected?: boolean;
}

/**
 * Where a platform's card stands, and whether every one of its accounts is hidden from the
 * dashboard (the card then says so beside the badge).
 */
export function platformState(provider: AdProvider, input: PlatformInput, now = Date.now()): { state: AdState; hidden: boolean } {
  if (input.connecting) return { state: "connecting", hidden: false };
  if (!input.answer) return { state: input.failed ? "unknown" : "checking", hidden: false };
  const mine = input.connections.filter((c) => c.provider === provider);
  if (!mine.length) {
    if (input.justDisconnected) return { state: "disconnected", hidden: false };
    if (!input.answer.configured[provider]) return { state: "coming_soon", hidden: false };
    return { state: input.answer.restricted[provider] ? "verification_pending" : "not_connected", hidden: false };
  }
  const shown = mine.filter((c) => c.enabled);
  const states = new Set((shown.length ? shown : mine).map((c) => connectionState(c, now)));
  return { state: PRECEDENCE.find((s) => states.has(s)) ?? "connected", hidden: !shown.length };
}

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
export function grantedPermissions(c: Pick<AdConnection, "grantedScopes" | "permission">): string[] {
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
