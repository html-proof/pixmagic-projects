/**
 * Where every connection stands, worked out once for the API and the UI. Two parts:
 *
 * - The ad connections' states (AdState): one connection's (connectionState) and a platform card's
 *   (platformState), which Settings → Integrations and Settings → Advertising word and badge
 *   (apps/web lib/adConnections.ts re-exports them, with the badges).
 * - One scale of six statuses for every provider (IntegrationStatus), which
 *   GET /workspaces/:ws/stores/:storeId/integrations answers with (core's integrations/status.ts),
 *   and each provider's own states mapped onto it.
 *
 * Imported by the UI through `@app/shared/integrations`: no I/O, no node: imports.
 */
// Without the ".js" the rest of the package uses: the web app imports this file directly, and its
// bundler doesn't map "./ads.js" to ads.ts.
import { AD_ERROR_STATUS, adsenseTotals, googleReportMetrics, metaReportMetrics, type AdAccountStatus, type AdConnectionStatus, type AdErrorCode, type AdProvider } from "./ads";
import { CAPABILITIES } from "./capabilities";
import type { AccountStatus } from "./email/constants";
import type { WaConnectionStatus } from "./whatsapp";

// ---------------------------------------------------------------------------
// Ad connections' states
// ---------------------------------------------------------------------------

/**
 * Where a connection, or a platform's card, stands. Every state is reachable:
 *
 * | State                  | Badge                  | When                                                                                                      |
 * | ---------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
 * | checking               | Checking…              | the card's first answer hasn't arrived                                                                    |
 * | unknown                | Status unavailable     | the first answer failed (an outage): never shown as "Not connected"                                        |
 * | coming_soon            | Coming soon            | the platform isn't set up on this server (configured false) and nothing is connected                      |
 * | not_connected          | Not connected          | nothing connected, and the platform is set up on this server (or offers its demo)                         |
 * | connecting             | Connecting             | leaving for the platform's sign-in, or back from it with accounts to choose                               |
 * | synchronizing          | Synchronizing          | shown on the dashboard, and a sync someone asked for is on its way (syncRequestedAt, for up to 30 minutes), |
 * |                        |                        | or active and never synced, in the first 30 minutes after connecting                                      |
 * | connected              | Connected              | active, and a sync has worked; or hidden from the dashboard before its first sync (nothing is fetched for a |
 * |                        |                        | hidden account, so nothing is under way: its row says so); or no account yet, but a sign-in connected     |
 * |                        |                        | that waits for its ad accounts (AdLogin)                                                                  |
 * | authorization_required | Authorization required | reconnect + connector_left: the person whose login powered it left; someone with access must authorize again |
 * | permission_missing     | Permission missing     | reconnect + scope_missing (the read permission was taken back), or status permission (this login lost the account) |
 * | verification_pending   | Verification pending   | error + not_approved; unavailable + account_not_ready;                                                    |
 * |                        |                        | an active account the platform has under review, not finished setting up, or needing attention           |
 * | sync_failed            | Sync failed            | error (other than not_approved); unavailable + account_disabled; an active account the platform disabled; |
 * |                        |                        | shown on the dashboard and still never synced 30 minutes after connecting (the first sync went missing)   |
 * | reconnect_required     | Reconnect required     | reconnect + auth_expired (or no code): the sign-in expired or was revoked                                  |
 * | disconnected           | Disconnected           | unavailable + account_closed, or the platform says the account is closed; and, for a moment, a card whose  |
 * |                        |                        | last account the person just disconnected                                                                 |
 *
 * A requested sync shows "Synchronizing" for every status but reconnect (nothing is queued for those).
 * Only accounts shown on the dashboard can be synchronizing: the worker skips a hidden one, so a page
 * never waits (or keeps looking again) for it.
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

/**
 * What a connection's state is worked out from: GET .../ads answers each connection with these
 * (the UI's AdConnection), and core reads them off the row (dates as ISO strings).
 */
export interface AdStateFacts {
  status: AdConnectionStatus;
  /** Why it isn't active (AD_ERROR_CODES); null when active. */
  errorCode: AdErrorCode | null;
  /** Shown on the dashboard (and synced). */
  enabled: boolean;
  /** The ad account's own health at the platform. */
  accountStatus: AdAccountStatus | null;
  /** The last sync that worked. */
  lastSyncedAt: string | null;
  /** A sync was asked for (connect, Refresh, re-enable) and hasn't finished yet. */
  syncRequestedAt: string | null;
  connectedAt: string;
}

/** The error code, only when it belongs to the status (a row written half-way through a change can disagree). */
export const ownErrorCode = (c: Pick<AdStateFacts, "status" | "errorCode">): AdErrorCode | null => (c.errorCode && AD_ERROR_STATUS[c.errorCode] === c.status ? c.errorCode : null);

/** The account statuses that mean "not ready at the platform yet". */
const NOT_READY: ReadonlySet<AdAccountStatus> = new Set(["under_review", "setup_unfinished", "needs_attention"]);

/**
 * A requested sync older than this is taken as lost (the API's ADS_REQUEST_STALE_MS): the card stops
 * saying "Synchronizing". So is a first sync that hasn't landed this long after connecting (its retries
 * take a few minutes; after an hour the worker's schedule tries the account again by itself).
 */
const SYNC_REQUEST_STALE_MS = 30 * 60_000;

/**
 * A sync someone asked for is still on its way. The worker clears syncRequestedAt when the last window
 * asked for has landed, or failed, or a health check ended; lastSyncedAt moves on after every window,
 * so it says nothing about the request (a long catch-up lands in several). A hidden account's sync is
 * skipped, so it never counts there.
 */
export function syncRunning(c: Pick<AdStateFacts, "enabled" | "syncRequestedAt">, now = Date.now()): boolean {
  if (!c.enabled || !c.syncRequestedAt) return false;
  const asked = Date.parse(c.syncRequestedAt);
  return !Number.isNaN(asked) && now - asked <= SYNC_REQUEST_STALE_MS;
}

/** Shown on the dashboard, connected over 30 minutes ago, and its first sync still hasn't landed. */
export function firstSyncOverdue(c: Pick<AdStateFacts, "enabled" | "status" | "lastSyncedAt" | "connectedAt">, now = Date.now()): boolean {
  if (!c.enabled || c.status !== "active" || c.lastSyncedAt) return false;
  const at = Date.parse(c.connectedAt);
  return !Number.isNaN(at) && now - at > SYNC_REQUEST_STALE_MS;
}

/** Where one connection stands. */
export function connectionState(c: AdStateFacts, now = Date.now()): AdState {
  const code = ownErrorCode(c);
  if (c.status === "reconnect") return code === "connector_left" ? "authorization_required" : code === "scope_missing" ? "permission_missing" : "reconnect_required";
  if (syncRunning(c, now)) return "synchronizing";
  if (c.status === "permission") return "permission_missing";
  if (c.status === "unavailable") return code === "account_closed" ? "disconnected" : code === "account_disabled" ? "sync_failed" : "verification_pending";
  if (c.status === "error") return code === "not_approved" ? "verification_pending" : "sync_failed";
  // Just connected: its first sync is on its way (an older API doesn't send syncRequestedAt for it).
  if (!c.lastSyncedAt && c.enabled && !firstSyncOverdue(c, now)) return "synchronizing";
  if (c.accountStatus === "closed") return "disconnected";
  if (c.accountStatus === "disabled") return "sync_failed";
  if (c.accountStatus && NOT_READY.has(c.accountStatus)) return "verification_pending";
  if (firstSyncOverdue(c, now)) return "sync_failed";
  // Synced, or hidden before its first sync: nothing is fetched for a hidden account, so nothing is under way.
  return "connected";
}

/** Most pressing first: a platform's card shows the worst of its accounts' states. */
const PRECEDENCE: AdState[] = ["reconnect_required", "authorization_required", "permission_missing", "sync_failed", "verification_pending", "synchronizing", "connected", "disconnected"];

/** What GET .../ads says about the platforms that platformState reads: which this server can connect, which offer a demo, and the sign-ins waiting for their ad accounts. */
export interface PlatformAnswer {
  configured: Record<AdProvider, boolean>;
  /** Which platforms offer a simulated account ("Try demo"); absent from older answers. */
  demo?: Partial<Record<AdProvider, boolean>>;
  /** Sign-ins connected with no ad account yet (absent from an API before 2026-10-26). */
  logins?: ReadonlyArray<{ provider: AdProvider }>;
}

/** The store's sign-in for this platform that waits for its ad accounts, if there is one. */
export const adLoginOf = <L extends { provider: AdProvider }>(state: { logins?: readonly L[] } | null, provider: AdProvider): L | null => state?.logins?.find((l) => l.provider === provider) ?? null;

export interface PlatformInput {
  /** The answer, once one arrived (null while loading or after a first load failed). */
  answer: PlatformAnswer | null;
  /** The first load failed. */
  failed: boolean;
  /** This platform's connections (the UI's adConnectionsOf). */
  connections: ReadonlyArray<AdStateFacts & { provider: AdProvider; demo: boolean }>;
  /** Leaving for its sign-in, or choosing its accounts after coming back. */
  connecting?: boolean;
  /** Its last account was just disconnected on this page. */
  justDisconnected?: boolean;
  /** The connection under way, or the one just disconnected, is the demo. */
  connectingDemo?: boolean;
  justDisconnectedDemo?: boolean;
}

/**
 * Where a platform's card stands, and whether every one of its accounts is hidden from the
 * dashboard (the card then says so beside the badge).
 */
export function platformState(provider: AdProvider, input: PlatformInput, now = Date.now()): { state: AdState; hidden: boolean; demo: boolean } {
  if (input.connecting) return { state: "connecting", hidden: false, demo: !!input.connectingDemo };
  if (!input.answer) return { state: input.failed ? "unknown" : "checking", hidden: false, demo: false };
  const mine = input.connections.filter((c) => c.provider === provider);
  if (!mine.length) {
    if (input.justDisconnected) return { state: "disconnected", hidden: false, demo: !!input.justDisconnectedDemo };
    // Signed in and authorized, its ad accounts not listed yet: connected, and they follow by themselves.
    if (adLoginOf(input.answer, provider)) return { state: "connected", hidden: false, demo: false };
    // A platform not set up on this server offers its demo where it has one: never "Coming soon" with a button under it.
    if (!input.answer.configured[provider]) return { state: input.answer.demo?.[provider] ? "not_connected" : "coming_soon", hidden: false, demo: false };
    return { state: "not_connected", hidden: false, demo: false };
  }
  const shown = mine.filter((c) => c.enabled);
  const counted = shown.length ? shown : mine;
  const states = new Set(counted.map((c) => connectionState(c, now)));
  // The card reads as a demo only when every account it shows is one.
  return { state: PRECEDENCE.find((s) => states.has(s)) ?? "connected", hidden: !shown.length, demo: counted.every((c) => c.demo) };
}

// ---------------------------------------------------------------------------
// One scale for every connection (GET .../integrations)
// ---------------------------------------------------------------------------

/**
 * Where any connection stands, whatever the provider:
 *
 * - connected: it works: the numbers come in, or messages can go.
 * - pending: set up, and waiting for a step: the platform's approval or review, a first check, the
 *   phone's pairing, the store's first import, the rest of a channel's setup.
 * - reauthorization_required: someone must sign in again: the access ended, a permission was taken
 *   back, or the person whose login powered it left.
 * - syncing: bizinsights is bringing it up to date, or checking it, now; it settles by itself.
 * - error: connected, and not working: the last attempt failed, or the platform stopped the account.
 * - disconnected: nothing is connected (or it was disconnected or closed), or the provider isn't set
 *   up on this server.
 */
export const INTEGRATION_STATUSES = ["connected", "pending", "reauthorization_required", "syncing", "error", "disconnected"] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

/** Most pressing first: a module shows the worst of its accounts' statuses, as a platform's card does (PRECEDENCE above). */
const STATUS_PRECEDENCE: readonly IntegrationStatus[] = ["reauthorization_required", "error", "pending", "syncing", "connected", "disconnected"];

/** The most pressing of these statuses; none at all is "disconnected". */
export function worstStatus(statuses: Iterable<IntegrationStatus>): IntegrationStatus {
  const seen = new Set(statuses);
  return STATUS_PRECEDENCE.find((s) => seen.has(s)) ?? "disconnected";
}

/**
 * An ad connection's or platform's state on the scale. The page's own states (checking, unknown,
 * connecting) never come from the server; they map for completeness.
 */
const AD_STATUS: Record<AdState, IntegrationStatus> = {
  checking: "pending",
  unknown: "error",
  coming_soon: "disconnected",
  not_connected: "disconnected",
  connecting: "pending",
  synchronizing: "syncing",
  connected: "connected",
  authorization_required: "reauthorization_required",
  permission_missing: "reauthorization_required",
  verification_pending: "pending",
  sync_failed: "error",
  reconnect_required: "reauthorization_required",
  disconnected: "disconnected",
};

export const adIntegrationStatus = (state: AdState): IntegrationStatus => AD_STATUS[state];

/**
 * A Shopify store on the scale, from stores.status, whether it still holds a token, and, for a store
 * whose import stopped, why (core's syncProblem: "access" is lost access, which reconnecting fixes;
 * "not_approved" waits for Shopify's approval of protected customer data; the rest only Shopify or
 * the merchant's Shopify account fix).
 */
export function shopifyIntegrationStatus(s: { status: string; hasToken: boolean; problem: string | null }): IntegrationStatus {
  switch (s.status) {
    case "pending":
      return "pending";
    case "syncing":
      return "syncing";
    case "active":
      return s.hasToken ? "connected" : "reauthorization_required";
    case "error":
      if (!s.hasToken || s.problem === "access") return "reauthorization_required";
      return s.problem === "not_approved" ? "pending" : "error";
    default:
      // uninstalled
      return "disconnected";
  }
}

/** WhatsApp's connection (wapp_connections.status, as waConnectionView shows it) on the scale. */
const WA_STATUS: Record<WaConnectionStatus, IntegrationStatus> = {
  pairing: "pending",
  connected: "connected",
  // The provider is connecting again by itself.
  reconnecting: "syncing",
  logged_out: "reauthorization_required",
  failed: "error",
  disconnected: "disconnected",
};

export function whatsappIntegrationStatus(status: string | null | undefined): IntegrationStatus {
  if (!status) return "disconnected";
  return WA_STATUS[status as WaConnectionStatus] ?? "error";
}

/** The Automations hub's card for a channel (core's ChannelConnection): its state and the problems behind it. */
export interface HubCard {
  /** connected | needs_attention | not_connected | unavailable | elsewhere */
  state: string;
  problems: ReadonlyArray<{ code: string }>;
}

/**
 * SMS on the scale, from the hub's card: needs_attention is a failed connection check at AWS
 * ("connection_failed"), or the store's setup still standing between automations and phones (no
 * sender yet, sender not verified, no budget...), which is a step left. Not connected, and SMS not
 * offered on this server (unavailable), are both nothing connected.
 */
export function smsIntegrationStatus(card: HubCard): IntegrationStatus {
  if (card.state === "connected") return "connected";
  if (card.state === "needs_attention") return card.problems.some((p) => p.code === "connection_failed") ? "error" : "pending";
  return "disconnected";
}

/** An email account (email_accounts.status) on the scale. */
const EMAIL_STATUS: Record<AccountStatus, IntegrationStatus> = {
  // Not tested yet.
  pending: "pending",
  connected: "connected",
  testing: "syncing",
  // Temporarily failing.
  degraded: "error",
  reauthorization_required: "reauthorization_required",
  // Switched off by the workspace: it sends nothing.
  disabled: "disconnected",
  revoked: "disconnected",
  failed: "error",
};

export function emailAccountIntegrationStatus(status: string): IntegrationStatus {
  return EMAIL_STATUS[status as AccountStatus] ?? "error";
}

/**
 * The workspace's own email problems on the scale (the hub card's codes): no verified sender yet, or
 * sending paused, is a step left; bizinsights suspending its sending stops every mailbox.
 */
const EMAIL_SETUP_STATUS = { no_verified_sender: "pending", sending_paused: "pending", suspended: "error" } as const satisfies Record<string, IntegrationStatus>;

/** One of the hub card's email problems on the scale, when it is the workspace's own (EMAIL_SETUP_STATUS); null for a mailbox's. */
export const emailSetupStatus = (code: string): IntegrationStatus | null => (Object.hasOwn(EMAIL_SETUP_STATUS, code) ? EMAIL_SETUP_STATUS[code as keyof typeof EMAIL_SETUP_STATUS] : null);

/**
 * Email as a whole, from the hub's card and its accounts' statuses: the worst of the accounts still
 * in use and of the workspace's own problems (EMAIL_SETUP_STATUS), so a suspension is an error
 * whatever the mailboxes say. A card that needs attention for none of these reasons is pending, never
 * connected.
 */
export function emailIntegrationStatus(card: HubCard, accounts: readonly IntegrationStatus[]): IntegrationStatus {
  if (card.state === "connected") return "connected";
  if (card.state !== "needs_attention") return "disconnected";
  const inUse = accounts.filter((s) => s !== "disconnected");
  if (!inUse.length) return "disconnected";
  const setup = card.problems.map((p) => emailSetupStatus(p.code)).filter((s): s is IntegrationStatus => s !== null);
  const worst = worstStatus([...inUse, ...setup]);
  return worst === "connected" ? "pending" : worst;
}

// ---------------------------------------------------------------------------
// The modules: what each is called, where it's managed, what it can show, and what can be done
// ---------------------------------------------------------------------------

export const INTEGRATION_MODULES = ["shopify", "meta_ads", "google_ads", "adsense", "whatsapp", "sms", "email"] as const;
export type IntegrationModuleId = (typeof INTEGRATION_MODULES)[number];

/** Each ad platform's module. */
export const AD_MODULE: Record<AdProvider, IntegrationModuleId> = { meta: "meta_ads", google: "google_ads", adsense: "adsense" };

/** What a caller may do with a module (by their permissions and its state), in this order. */
export const INTEGRATION_ACTIONS = ["connect", "reconnect", "refresh", "disconnect"] as const;
export type IntegrationAction = (typeof INTEGRATION_ACTIONS)[number];

/** These actions in the scale's order, each once. */
export const orderedActions = (actions: Iterable<IntegrationAction>): IntegrationAction[] => {
  const set = new Set(actions);
  return INTEGRATION_ACTIONS.filter((a) => set.has(a));
};

/** The hub's connection actions (connect, test, reconnect, disconnect) on this scale: a test asks the provider now, which is a refresh. */
export function hubCardActions(actions: readonly string[]): IntegrationAction[] {
  return orderedActions(actions.map((a) => (a === "test" ? "refresh" : a)).filter((a): a is IntegrationAction => (INTEGRATION_ACTIONS as readonly string[]).includes(a)));
}

/** The counts a messaging channel's figures are made of (the hub's message statuses). */
const MESSAGE_COUNTS = ["sent", "delivered", "undelivered", "failed"] as const;

export interface IntegrationModuleInfo {
  title: string;
  /** The app page where it is connected and managed. */
  href: string;
  /** The figures it brings (metric keys): the store's data modules, an ad platform's report figures, a channel's message counts. */
  capabilities: readonly string[];
}

/** The messaging channels' pages are their homes in the hub's CHANNEL_INFO (@app/shared/automations, left out of this module's imports: the settings pages don't need its weight). */
export const INTEGRATION_MODULE_INFO: Record<IntegrationModuleId, IntegrationModuleInfo> = {
  shopify: { title: "Shopify", href: "/settings/stores", capabilities: CAPABILITIES.map((c) => c.id) },
  meta_ads: { title: "Meta Ads", href: "/settings/ads", capabilities: Object.keys(metaReportMetrics({})) },
  google_ads: { title: "Google Ads", href: "/settings/ads", capabilities: Object.keys(googleReportMetrics({})) },
  adsense: { title: "Google AdSense", href: "/settings/ads", capabilities: Object.keys(adsenseTotals([])) },
  whatsapp: { title: "WhatsApp", href: "/dashboard/whatsapp-automation", capabilities: ["sent", "delivered", "read", "failed"] },
  sms: { title: "SMS", href: "/messaging", capabilities: MESSAGE_COUNTS },
  email: { title: "Email", href: "/settings/email", capabilities: MESSAGE_COUNTS },
};

/** One account of a module (an ad account, a waiting sign-in, the store, the WhatsApp number, the SMS sender, a mailbox). `D`: how dates travel (Date in core, a string in JSON). */
export interface IntegrationAccount<D = string> {
  id: string;
  /** The name its page shows: never a token, a full phone number or a password. */
  name: string | null;
  status: IntegrationStatus;
  /** The last sync that worked (Shopify, ad accounts); null for the messaging channels, which send rather than sync. */
  lastSyncedAt: D | null;
  /** The last sync or check that started, whatever came of it. */
  lastAttemptAt: D | null;
  /** Why it stands where it does, as its provider's code (an ad error code, a waiting sign-in's reason, a sync problem...); null when nothing needs saying. */
  code: string | null;
  /** The Google Ads demo: simulated figures, nothing verified by Google. */
  demo: boolean;
}

export interface IntegrationModule<D = string> {
  id: IntegrationModuleId;
  title: string;
  status: IntegrationStatus;
  /** Why the module stands where it does (the deciding account's code, or the module's own: "not_configured"...); null when nothing needs saying. */
  code: string | null;
  /** Every account it counts is the Google Ads demo. */
  demo: boolean;
  /** Empty, with no `code` either, for a caller who may not open the channel's own page (SMS without View campaigns; SMS and email for an API key). */
  accounts: IntegrationAccount<D>[];
  /** The latest of its accounts' last working syncs (an ad platform's: of the accounts shown on the dashboard, as its status). */
  lastSyncedAt: D | null;
  capabilities: string[];
  actions: IntegrationAction[];
  href: string;
}
