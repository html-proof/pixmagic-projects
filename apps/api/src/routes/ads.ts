import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { dbReachable, systemDb, withTenant, type AdConnection, type AdLogin } from "@app/db";
import {
  AD_PROVIDER_NAME,
  AdConsentNeededError,
  AdLoginWaitingError,
  AdNoRefreshTokenError,
  AdPermissionMissingError,
  adsConfigured,
  adsRestricted,
  adsenseReportForConnection,
  AdsApiError,
  AdsAuthError,
  AdsNoAccountsError,
  AdsNotApprovedError,
  AdsPermissionError,
  AdsRateLimitedError,
  AdsReportPendingError,
  AdsRetryableError,
  AdsUnavailableError,
  adToday,
  AD_REPORT_BUDGET_MS,
  audit,
  checkAdLogin,
  dropUnusedGrant,
  enqueueAdCatchUp,
  enqueueAdSync,
  env,
  googleReportForConnection,
  disconnectGoogleAdsDemo,
  dropAdLoginOf,
  googleAdsBudget,
  googleAdsBudgetAllows,
  googleAdsConnectionStatus,
  googleAdsDemoEnabled,
  googleAdsPaused,
  googleProductionMissing,
  holdAdLogin,
  holdPendingAdConnect,
  isDemoConnection,
  logger,
  providerDetail,
  META_REPORT_JOB,
  metaReportForConnection,
  peekPendingAdConnect,
  pendingTokens,
  readAdSignIn,
  releaseAdLogin,
  REQUIRED_AD_SCOPE,
  revokeAdAccessIfUnused,
  saveAdConnections,
  startAdSignIn,
  takeAdSignInState,
  takePendingAdConnect,
  AD_SIGN_IN_TTL_S,
  type AdSignInProgress,
  type AdAccountList,
  type AdsenseLiveReport,
  type GoogleReport,
  type MetaReport,
  type NoAdAccountsReason,
  type TokenSet,
} from "@app/core";
import {
  AD_CONNECTION_STATUSES,
  AD_LOGIN_REASONS,
  AD_PROVIDERS,
  ADSENSE_REPORT_LEVELS,
  adErrorMessage,
  adStatusCode,
  allows,
  daysBetweenInclusive,
  GOOGLE_REPORT_LEVELS,
  googleParentFits,
  googleReportMetrics,
  isAdAccountStatus,
  isAdErrorCode,
  isDay,
  isDemoObjectId,
  isGoogleDetailLevel,
  isGoogleObjectId,
  isMetaObjectId,
  MAX_CUSTOM_DAYS,
  META_REPORT_VIEWS,
  metaParentFits,
  metaReportMetrics,
  randomToken,
  safeEqual,
  sha256Hex,
  type AdConnectionStatus,
  type AdProvider,
} from "@app/shared";
import { body, clientIp, HttpError, loadUser, memberAllows, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";

/**
 * A store's ad accounts, read-only, so the dashboard can show what's spent on ads next to what the
 * store sells (Meta Ads, Google Ads), and what the store's site earns from ads shown on it (Google
 * AdSense): the connections and their sync history, the account choice, showing or hiding an account,
 * Sync now, disconnecting, and the live reports.
 *
 * "Continue with Meta Ads" / "Google Ads" / "Google AdSense": bizinsights' own sign-in with the
 * platform (core's adConnections/signIn.ts), read-only. The OAuth round trip mirrors the Shopify
 * connect: single-use state in the coordinator, bound to this browser by a cookie, and the callback
 * only accepted for the person who started it. When the sign-in can see several accounts (and some are
 * new), the person chooses which to connect here; the sign-in's tokens wait, encrypted, in the
 * coordinator. A finished connection lands on the dashboard, where the numbers are. A sign-in that ends
 * without a connection gives its grant back to the platform, unless something else relies on it.
 */

const STATE_COOKIE = "ads_oauth_state";
/**
 * The sign-ins this browser started that haven't come back yet, newest first. A second press of the
 * button (or a second tab) mustn't void the first: the platform may still send the person back with
 * the first one's state. Each is still single-use and bound to this browser.
 */
const MAX_PENDING_STATES = 5;
const pendingStates = (cookie: string | undefined) => (cookie ?? "").split(".").filter((n) => /^[A-Za-z0-9_-]{16,64}$/.test(n));

const cookieOpts = () => ({ path: "/", httpOnly: true, sameSite: "Lax" as const, secure: env().NODE_ENV === "production", maxAge: AD_SIGN_IN_TTL_S });

/**
 * How long a callback waits for the database before giving up on it. A database failover takes 10-20
 * seconds, and the person has just been through the platform's sign-in, which is not theirs to repeat
 * because of us.
 */
const CALLBACK_DB_WAIT_MS = 20_000;
const DB_POLL_MS = 1_000;

/** The database didn't answer before the callback's deadline. `cause` is the step's own error. */
class DbUnavailable extends Error {}

/**
 * Run one database step of the callback, waiting out an outage: when the step fails and the database
 * doesn't answer, wait for it to answer again (until `deadline`) and run the step again. A failure while
 * the database answers is the step's own, and is thrown as it is.
 */
async function waitingOutDb<T>(deps: Deps, deadline: number, step: () => Promise<T>): Promise<T> {
  const answers = deps.dbHealthy ?? (() => dbReachable());
  for (;;) {
    try {
      return await step();
    } catch (err) {
      if (await answers()) throw err;
      do {
        if (Date.now() + DB_POLL_MS > deadline) throw new DbUnavailable("database unreachable", { cause: err });
        await new Promise((r) => setTimeout(r, DB_POLL_MS));
      } while (!(await answers()));
    }
  }
}

const providerSchema = z.enum(AD_PROVIDERS);

/** The ?error= (or finish code) for each way a login can have nothing to connect (the settings page words each one, per platform). */
const NO_ACCOUNTS_ERROR: Record<NoAdAccountsReason, string> = {
  no_ads_account: "no_accounts",
  manager_only: "manager_only",
  not_ready: "account_not_ready",
  none_shared: "none_shared",
};

/** "1234567890" → "123-456-7890", as Google Ads writes a customer id. */
const customerId = (id: string | null) => (id && /^\d{10}$/.test(id) ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id);

interface ConnectionContext {
  /** The viewer, to tell them which connections their own login powers. */
  viewerId: string | null;
  /** Whether the viewer may see who connected an account by email (they manage integrations). */
  seesEmail: boolean;
  /** Members of this workspace by user id: a person who left it is never named. */
  connectors: Map<string, { name: string | null; email: string }>;
  /** AdSense: the sites (DOMAIN_CODE) stored for each connection. */
  seenSites: Map<string, string[]>;
}

/** What the browser may see of a connection: never a token, and the platform's own words only cleaned, under "Details". */
function publicConnection(c: AdConnection, ctx: ConnectionContext) {
  const provider = c.provider as AdProvider;
  const status: AdConnectionStatus = (AD_CONNECTION_STATUSES as readonly string[]).includes(c.status) ? (c.status as AdConnectionStatus) : "error";
  // Worded by its code only when the code is the status's own (a writer may have changed the status alone).
  const wording = adStatusCode(status, c.errorCode);
  const connector = c.connectedByUserId ? ctx.connectors.get(c.connectedByUserId) : undefined;
  const adsense = provider === "adsense";
  // The Google Ads demo: simulated figures and no Google grant. Decided by the row alone, never by anything a browser sends.
  const demo = isDemoConnection(c);
  return {
    id: c.id,
    provider: c.provider,
    accountId: c.accountId,
    accountName: c.accountName,
    currency: c.currency,
    timezone: c.timezone,
    enabled: c.enabled,
    status,
    errorCode: isAdErrorCode(c.errorCode) ? c.errorCode : null,
    message: wording ? adErrorMessage(wording, provider) : null,
    lastError: c.lastError ? providerDetail(c.lastError) || null : null,
    accountStatus: isAdAccountStatus(c.accountStatus) ? c.accountStatus : null,
    accountStatusDetail: c.accountStatusDetail,
    lastSyncedAt: c.lastSyncedAt,
    /** When the last sync started, whatever came of it ("Last attempted"). */
    lastSyncAttemptAt: c.lastSyncAttemptAt,
    /** The last day (the account's own) stored without a gap from historyFrom on. */
    syncedThrough: c.syncedThrough,
    historyFrom: c.historyFrom,
    /** Someone asked for a sync that hasn't finished: the card says "Synchronizing". */
    syncRequestedAt: c.syncRequestedAt,
    consecutiveFailures: c.consecutiveFailures,
    // Meta access lasts about 60 days; Settings warns before it runs out. Google's renews itself.
    accessExpiresAt: provider === "meta" ? c.accessTokenExpiresAt : null,
    connectedAt: c.createdAt,
    /** The one read-only permission this connection was granted (checked when connecting); none for a demo, which holds no Google permission. */
    permission: demo ? null : (REQUIRED_AD_SCOPE[provider] ?? null),
    /** Every permission that was granted, when the platform said. */
    grantedScopes: c.grantedScopes ?? [],
    /** Google Ads: the manager account the account is reached through. */
    loginCustomerId: customerId(c.loginCustomerId),
    connectedBy: connector ? { name: connector.name, email: ctx.seesEmail ? connector.email : null, you: c.connectedByUserId === ctx.viewerId } : null,
    sites: adsense ? c.sites : [],
    availableSites: adsense ? [...new Set([...(ctx.seenSites.get(c.id) ?? []), ...c.sites])].sort() : [],
    /** The Google Ads demo (docs/ads-demo.md): simulated figures, no Google grant, nothing verified by Google. Never true of a real account. */
    demo,
    connectionType: demo ? "demo" : "production",
    /** "simulated": bizinsights' own demo; "authorized": the person authorized the account at the platform (which says nothing about the platform verifying bizinsights). */
    verificationStatus: demo ? "simulated" : "authorized",
    /** Google Ads: where it stands in the status endpoint's words (connected_demo, demo_syncing, connected_production...). */
    connectionStatus: provider === "google" ? googleAdsConnectionStatus(c) : null,
    /** A demo's seed, so its figures can be reproduced or reset; null for a real account. */
    demoSeed: demo ? c.demoSeed : null,
  };
}

/** Connections as the browser sees them, with who connected each (of this workspace's members) and the sites AdSense reported. */
export async function publicConnections(ws: string, rows: AdConnection[], viewer: { id: string | null; seesEmail: boolean }) {
  const userIds = [...new Set(rows.map((r) => r.connectedByUserId).filter((id): id is string => !!id))];
  const adsenseIds = rows.filter((r) => r.provider === "adsense").map((r) => r.id);
  const [members, sites] = await withTenant(ws, async (tx) => [
    userIds.length ? await tx.membership.findMany({ where: { workspaceId: ws, userId: { in: userIds } }, select: { userId: true, user: { select: { displayName: true, email: true } } } }) : [],
    adsenseIds.length ? await tx.adsenseDaily.groupBy({ by: ["connectionId", "site"], where: { workspaceId: ws, connectionId: { in: adsenseIds }, site: { not: "" } } }) : [],
  ] as const);
  const ctx: ConnectionContext = {
    viewerId: viewer.id,
    seesEmail: viewer.seesEmail,
    connectors: new Map(members.map((m) => [m.userId, { name: m.user.displayName, email: m.user.email }])),
    seenSites: new Map(),
  };
  for (const s of sites) ctx.seenSites.set(s.connectionId, [...(ctx.seenSites.get(s.connectionId) ?? []), s.site]);
  return rows.map((r) => publicConnection(r, ctx));
}

/**
 * A sign-in kept connected while it reaches no ad account (core's logins.ts), as the browser may see it:
 * who it signed in as and why nothing is connected yet. Never a token or the platform's ids.
 */
async function publicLogins(ws: string, rows: AdLogin[], viewer: { id: string | null; seesEmail: boolean }) {
  const userIds = [...new Set(rows.map((r) => r.connectedByUserId).filter((id): id is string => !!id))];
  const members = userIds.length
    ? await withTenant(ws, (tx) => tx.membership.findMany({ where: { workspaceId: ws, userId: { in: userIds } }, select: { userId: true, user: { select: { displayName: true, email: true } } } }))
    : [];
  const connectors = new Map(members.map((m) => [m.userId, { name: m.user.displayName, email: m.user.email }]));
  return rows.map((r) => {
    const connector = r.connectedByUserId ? connectors.get(r.connectedByUserId) : undefined;
    return {
      id: r.id,
      provider: r.provider,
      /** The name the platform's sign-in went by ("Connected as …"), when the platform said. */
      name: r.loginName,
      reason: (AD_LOGIN_REASONS as readonly string[]).includes(r.reason) ? r.reason : "no_ads_account",
      connectedAt: r.createdAt,
      checkedAt: r.checkedAt,
      connectedBy: connector ? { name: connector.name, email: viewer.seesEmail ? connector.email : null, you: r.connectedByUserId === viewer.id } : null,
    };
  });
}

export async function storeInWorkspace(ws: string, storeId: string) {
  const store = await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: storeId, workspaceId: ws }, select: { id: true, status: true } }));
  if (!store || store.status === "uninstalled") throw new HttpError(404, "Not found", "not_found");
  return store;
}

/**
 * Whether this person may still connect ad accounts to this store: checked when the platform sends
 * them back, not only when they pressed the button. The sign-in can take minutes, and someone
 * removed or demoted in between (or a store disconnected or moved) must not get accounts attached.
 */
export async function mayStillConnect(ws: string, storeId: string, userId: string): Promise<boolean> {
  const m = await systemDb.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ws, userId } } });
  if (!memberAllows(m, "integrations.manage")) return false;
  return !!(await systemDb.store.findFirst({ where: { id: storeId, workspaceId: ws, status: { not: "uninstalled" } }, select: { id: true } }));
}

/**
 * Save the chosen accounts, bring each up to date, and record who connected them. A new account's
 * catch-up is its first 90 days, after which its history is walked back; one connected before
 * fetches what it missed. Each card says "Synchronizing" until its catch-up lands.
 */
export async function connectAccounts(
  deps: Deps,
  ip: string | undefined,
  input: {
    workspaceId: string;
    storeId: string;
    provider: AdProvider;
    accounts: AdAccountList;
    tokens: TokenSet;
    userId: string;
    externalUserId?: string | null;
  },
) {
  const saved = await saveAdConnections(input);
  for (const conn of saved) {
    if (conn.enabled) await enqueueAdCatchUp(deps.queues, conn, { interactive: true });
  }
  // The store has accounts of this platform now: a login that was waiting for some isn't needed any more.
  if (saved.length) await dropAdLoginOf(input.storeId, input.provider, deps.fetchImpl);
  await audit({
    workspaceId: input.workspaceId,
    actorUserId: input.userId,
    action: "ads.connected",
    targetType: "store",
    targetId: input.storeId,
    metadata: { provider: input.provider, accounts: saved.length },
    ip,
  }).catch((err: unknown) => logger.warn({ err }, "audit failed"));
  return saved;
}

/**
 * Ask for one shown connection to be brought up to date, someone waiting ("Synchronizing"): a catch-up,
 * or for an account this login can't read now, or that the platform won't report on, a check whether
 * it is back (which catches up if so). Nothing for one waiting for a reconnect, or without a token
 * (its person left): only connecting again helps those, and a job would only be skipped. Returns
 * whether a job was sent (one already on its way isn't sent again).
 */
async function queueRefresh(deps: Deps, conn: AdConnection): Promise<boolean> {
  if (!conn.enabled || conn.status === "reconnect" || (!conn.accessTokenEnc && !isDemoConnection(conn))) return false;
  if (conn.status === "permission" || conn.status === "unavailable") {
    await enqueueAdSync(deps.queues, conn, 1, { healthOnly: true, interactive: true });
    return true;
  }
  return !!(await enqueueAdCatchUp(deps.queues, conn, { interactive: true }));
}

/** A pending choice that belongs to this person, workspace and store, or a 404 that says it's gone. */
async function ownPending(deps: Deps, nonce: string, userId: string | undefined, ws: string, storeId: string) {
  const p = await peekPendingAdConnect(deps.coord, nonce);
  if (!p || !userId || p.userId !== userId || p.workspaceId !== ws || p.storeId !== storeId) {
    throw new HttpError(404, "That choice has expired. Press the button to connect again.", "pending_expired");
  }
  return p;
}

/** The finish's error code for a platform failure during the sign-in (after the person said yes), logged as it deserves. */
export function connectFailure(err: unknown, provider: AdProvider, storeId: string): string {
  // bizinsights' Google Cloud project isn't approved for real Google Ads accounts yet: say so, don't blame the account.
  if (err instanceof AdsNotApprovedError) {
    logger.warn({ err, provider, storeId }, "google ads: project not approved for production accounts");
    return "not_approved";
  }
  // The login reaches nothing that can be connected. Which case it is decides what the person should do.
  if (err instanceof AdsNoAccountsError) {
    // Meta's diagnosis says who signed in and what the grant holds (docs/ads-setup.md reads it); the login's name stays out.
    logger.info({ reason: err.reason, detail: err.message, provider, storeId, ...(err.diagnosis ? { diagnosis: err.diagnosis } : {}) }, "ads: nothing to connect for this login");
    return NO_ACCOUNTS_ERROR[err.reason];
  }
  // A Google login with no AdSense account: AdSense answers 403 rather than an empty list.
  if (provider === "adsense" && err instanceof AdsApiError && err.status === 403 && /adsense account/i.test(err.message)) return "no_accounts";
  // The platform's API isn't switched on for bizinsights, or its client (Meta: our appsecret_proof) was refused: ours to fix.
  if (err instanceof AdsApiError && err.errorCode === "not_configured") {
    logger.error({ err, provider, storeId }, "ad platform connect failed on our set-up");
    return "not_configured";
  }
  // The platform asked to wait, or didn't answer (Google too slow to list a big login's accounts): try again shortly.
  if (err instanceof AdsRateLimitedError) {
    logger.warn({ err, provider, storeId }, "ad platform connect rate limited");
    return "rate_limited";
  }
  if (err instanceof AdsRetryableError) {
    logger.warn({ err, provider, storeId }, "ad platform connect: the platform didn't answer");
    return "temporarily_unavailable";
  }
  logger.error({ err, provider, storeId }, "ad platform connect failed");
  return "exchange_failed";
}

/** Each platform's own "access ended" wording for a report. */
const ACCESS_ENDED: Record<AdProvider, string> = {
  meta: "Meta access for this ad account has ended. Reconnect it in Settings → Advertising.",
  google: "Google Ads access for this account has ended. Reconnect it in Settings → Advertising.",
  adsense: "Google AdSense access for this account has ended. Reconnect it in Settings → Advertising.",
};
const REPORT_CODE_PREFIX: Record<AdProvider, string> = { meta: "meta", google: "google", adsense: "adsense" };

/** A live report's failure as the HTTP answer the Marketing page words. Never the platform's raw text (providerDetail only). */
function reportFailure(err: unknown, provider: AdProvider, connectionId: string): unknown {
  const name = AD_PROVIDER_NAME[provider];
  const prefix = REPORT_CODE_PREFIX[provider];
  if (err instanceof AdsAuthError) return new HttpError(409, ACCESS_ENDED[provider], "reconnect");
  if (err instanceof AdsNotApprovedError) {
    if (provider === "google") return new HttpError(503, "Google is still approving bizinsights for live Google Ads accounts. The report will work once that's done.", "google_not_approved");
    return new HttpError(503, adErrorMessage("not_approved", provider)!, "not_approved");
  }
  if (err instanceof AdsPermissionError) return new HttpError(409, adErrorMessage("no_access", provider)!, "permission");
  if (err instanceof AdsUnavailableError) return new HttpError(409, adErrorMessage(err.errorCode, provider)!, "unavailable");
  if (err instanceof AdsApiError && err.errorCode === "not_configured") {
    logger.error({ err, connectionId, provider }, "ad report failed on our set-up");
    return new HttpError(503, `${name} isn't set up on this server yet.`, "not_configured");
  }
  // Meta's report job didn't finish within this request: it is still being prepared.
  if (err instanceof AdsReportPendingError) return new HttpError(503, "Meta is still preparing this report. Try again in a minute.", "meta_report_pending", 60);
  // bizinsights' own daily allowance (Google Ads API operations), not the account's.
  if (err instanceof AdsRateLimitedError && err.errorCode === "quota_exhausted") return new HttpError(503, adErrorMessage("quota_exhausted", provider)!, "quota_exhausted");
  if (err instanceof AdsRetryableError) return new HttpError(503, `${name} is busy right now. Try again in a minute.`, `${prefix}_busy`, 60);
  if (err instanceof AdsApiError) {
    logger.warn({ err, connectionId, provider }, "ad report failed");
    return new HttpError(502, `${name} didn't return the report: ${providerDetail(err.message)}`, `${prefix}_error`);
  }
  return err;
}

const day = z.string().refine(isDay, "must be a YYYY-MM-DD day");

/** A report's dates, and the optional comparison's (cfrom, cto): each a real range of up to a year. */
const reportDates = z
  .object({ connection: z.string().min(1).max(64), from: day, to: day, cfrom: day.optional(), cto: day.optional() })
  .refine((v) => v.from <= v.to, "from is after to")
  .refine((v) => daysBetweenInclusive(v.from, v.to) <= MAX_CUSTOM_DAYS, "Pick up to a year at a time")
  .refine((v) => (v.cfrom === undefined) === (v.cto === undefined), "cfrom and cto go together")
  .refine((v) => !v.cfrom || !v.cto || v.cfrom <= v.cto, "cfrom is after cto")
  .refine((v) => !v.cfrom || !v.cto || daysBetweenInclusive(v.cfrom, v.cto) <= MAX_CUSTOM_DAYS, "Compare up to a year at a time");

/**
 * A drill-down's ids in a report's query: Meta's campaign and ad set ids (digits); Google Ads' campaign
 * and ad group ids (digits, or the demo's own "demo-…", which only a demo connection takes: checked once
 * the connection is known).
 */
const metaObjectId = z.string().refine(isMetaObjectId, "must be one of Meta's ids (digits)");
const googleObjectId = z.string().refine((v) => isGoogleObjectId(v) || isDemoObjectId(v), "must be one of Google Ads' ids");

/** The part of a report's cache key that says what it was under: "-" for the whole account. */
const parentKey = (...ids: Array<string | undefined>) => ids.map((id) => id ?? "-").join(":");

interface ReportRange {
  from: string;
  to: string;
  /** The comparison's: read for its figures only (Meta: no delivery statuses), so cached apart from a report of the same dates. */
  compare?: boolean;
}

/** The ranges a report request asks for: its own, then the comparison's when there is one. */
const rangesOf = (q: { from: string; to: string; cfrom?: string; cto?: string }): ReportRange[] => [
  { from: q.from, to: q.to },
  ...(q.cfrom && q.cto ? [{ from: q.cfrom, to: q.cto, compare: true }] : []),
];

/**
 * Read a report's ranges, each from the cache or the platform (all at once, so a comparison takes no
 * longer than one range), and cache what was read: days that are over change little, today's keep
 * coming in. The first failure is thrown once every read has ended, the ranges that worked cached.
 * `opts.ttl`: how long a range is kept, when not the usual 10 minutes with today and an hour without;
 * `opts.onMiss`: run once before anything is read, only when some range must be (a guard that throws).
 */
async function readRanges<T>(
  deps: Deps,
  ranges: ReportRange[],
  today: string,
  key: (r: ReportRange) => string,
  read: (r: ReportRange) => Promise<T>,
  rateKey: string,
  opts: { ttl?: (r: ReportRange) => number; onMiss?: () => Promise<void> } = {},
) {
  const cached = await Promise.all(ranges.map((r) => deps.coord.peek(key(r))));
  if (cached.some((c) => !c)) {
    await limit(deps.coord, rateKey, LIMITS.adsReport);
    await opts.onMiss?.();
  }
  const results = await Promise.allSettled(
    ranges.map(async (r, i) => {
      if (cached[i]) return JSON.parse(cached[i]!) as T;
      const report = await read(r);
      await deps.coord.put(key(r), JSON.stringify(report), opts.ttl?.(r) ?? (r.to >= today ? 600 : 3600));
      return report;
    }),
  );
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  return { reports: results.map((r) => (r as PromiseFulfilledResult<T>).value), cached: cached.every(Boolean) };
}

/**
 * Before Google is asked for keywords or search terms (never for a cached answer or the demo's):
 * bizinsights' daily Google Ads operations aren't past the share these reports may use
 * (GOOGLE_ADS_DETAIL_SHARE: the syncs keep the rest), and this ad account hasn't had its
 * LIMITS.adsGoogleDetail for the day. While Google says the allowance is used up, the report itself
 * answers that (quota_exhausted).
 */
async function googleDetailAllowed(deps: Deps, connectionId: string): Promise<void> {
  const budget = await googleAdsBudget(deps.coord);
  if (!budget.paused && !googleAdsBudgetAllows(budget, "detail")) {
    throw new HttpError(503, "Keyword and search-term reports are paused for a few hours so your Google Ads figures keep syncing: bizinsights has used most of today's Google Ads allowance. Reports already read stay available.", "google_detail_paused", 3600);
  }
  await limit(
    deps.coord,
    `rl:ads-gdetail:${connectionId}`,
    LIMITS.adsGoogleDetail,
    "This ad account's keywords and search terms have been read from Google as often as they can be today. Reports already read stay available; other dates can be read tomorrow.",
    "google_detail_limit",
  );
}

/** The figures of each platform's report (its totals and every row carry them). */
const META_METRICS = Object.keys(metaReportMetrics({}));
const GOOGLE_METRICS = Object.keys(googleReportMetrics({}));

/** A comparison's figures beside a report: its dates, totals, and each row's figures by id (names and statuses are the report's own). */
function comparisonOf(report: { since: string; until: string; totals: object; rows: Array<{ id: string }> }, metrics: string[]) {
  const pick = (o: object) => Object.fromEntries(metrics.map((k) => [k, (o as Record<string, unknown>)[k] ?? null]));
  return { since: report.since, until: report.until, totals: pick(report.totals), rows: report.rows.map((r) => ({ id: r.id, ...pick(r) })) };
}

/** A site's host name, as AdSense's DOMAIN_CODE spells it ("shop.example.com"). */
const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((s) => s.replace(/\.$/, ""))
  .pipe(z.string().max(253).regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/, "must be a site's host name, like shop.example.com"));

export function adsRoutes(app: App, deps: Deps) {
  /** Connected ad accounts for a store, which platforms this server can connect at all, and which only for the people added to its app. */
  app.get("/workspaces/:ws/stores/:storeId/ads", async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, ["marketing.ads", "integrations.status"]);
    await storeInWorkspace(ws, storeId);
    const [rows, waiting] = await withTenant(ws, async (tx) => [
      await tx.adConnection.findMany({ where: { workspaceId: ws, storeId }, orderBy: [{ provider: "asc" }, { createdAt: "asc" }] }),
      await tx.adLogin.findMany({ where: { workspaceId: ws, storeId }, orderBy: { provider: "asc" } }),
    ] as const);
    const viewer = { id: access.user?.id ?? null, seesEmail: allows(access.access, "integrations.manage") };
    const connections = await publicConnections(ws, rows, viewer);
    return c.json({
      configured: adsConfigured(),
      restricted: adsRestricted(),
      connections,
      /** Sign-ins connected with no ad account yet (Meta): the card says who, and their accounts follow by themselves. */
      logins: await publicLogins(ws, waiting, viewer),
      /** Which platforms offer a simulated account ("Try demo"): Google Ads, when this server switches it on. */
      demo: { google: googleAdsDemoEnabled() },
      /** The settings each platform's real sign-in still lacks on this server, by name (empty once set up). */
      missing: { google: googleProductionMissing() },
    });
  });

  /** The last syncs of one connection, newest first (ad_sync_runs): when, what was asked, and what came of it. */
  app.get("/workspaces/:ws/stores/:storeId/ads/connections/:id/syncs", async (c) => {
    const { ws, storeId, id } = c.req.param();
    await requireWorkspace(c, deps, ws, ["marketing.ads", "integrations.status"]);
    const found = await withTenant(ws, async (tx) => {
      const conn = await tx.adConnection.findFirst({ where: { id, workspaceId: ws, storeId }, select: { id: true, provider: true } });
      if (!conn) return null;
      const runs = await tx.adSyncRun.findMany({
        where: { workspaceId: ws, connectionId: id },
        orderBy: { startedAt: "desc" },
        take: 20,
        select: { trigger: true, since: true, until: true, outcome: true, rows: true, reason: true, source: true, startedAt: true, finishedAt: true },
      });
      return { provider: conn.provider as AdProvider, runs };
    });
    if (!found) throw new HttpError(404, "Not found", "not_found");
    return c.json({
      runs: found.runs.map((r) => ({
        ...r,
        // A failure worded from its code, as the card words the connection's own (never a platform's raw text).
        message: r.outcome === "failed" && isAdErrorCode(r.reason) ? adErrorMessage(r.reason, found.provider) : null,
      })),
    });
  });

  /** Step 1: where to send the browser to approve read access to ads. */
  app.post("/workspaces/:ws/stores/:storeId/ads/:provider/connect", async (c) => {
    const { ws, storeId } = c.req.param();
    const provider = providerSchema.parse(c.req.param("provider"));
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    const user = access.user!;
    if (!user.emailVerified) throw new HttpError(403, "Verify your email first", "email_unverified");
    await storeInWorkspace(ws, storeId);
    if (!adsConfigured()[provider]) throw new HttpError(503, `${AD_PROVIDER_NAME[provider]} isn't set up on this server yet.`, "not_configured");
    // Listing a login's Google Ads accounts spends bizinsights' daily operations: none while they're used up.
    if (provider === "google" && (await googleAdsPaused(deps.coord))) throw new HttpError(503, adErrorMessage("quota_exhausted", "google")!, "rate_limited", 3600);
    // Each sign-in writes a coordinator item and its callback lists accounts against the platform's quota.
    await limit(deps.coord, `rl:ads-connect:${user.id}`, LIMITS.adsConnect, "That's a lot of sign-ins in a short time. Wait a few minutes and try again.");
    const nonce = randomToken(24);
    const url = await startAdSignIn(deps.coord, nonce, { userId: user.id, workspaceId: ws, storeId, provider });
    if (!url) throw new HttpError(503, `${AD_PROVIDER_NAME[provider]} isn't set up on this server yet.`, "not_configured");
    setCookie(c, STATE_COOKIE, [nonce, ...pendingStates(getCookie(c, STATE_COOKIE))].slice(0, MAX_PENDING_STATES).join("."), cookieOpts());
    return c.json({ url });
  });

  /** Step 2: the platform sends the browser back here with a code (or with the person's "no"). */
  app.get("/ads/:provider/callback", async (c) => {
    const appUrl = env().APP_URL;
    const parsed = providerSchema.safeParse(c.req.param("provider"));
    // Problems, the account choice and a login still waiting for its accounts stay on the integrations page; success goes to the numbers.
    const back = (params: Record<string, string>, storeId?: string) =>
      c.redirect(`${appUrl}/settings/ads?${new URLSearchParams({ ...params, ...(storeId ? { store: storeId } : {}) })}`);
    const toDashboard = (provider: AdProvider, accounts: number, storeId: string) =>
      c.redirect(`${appUrl}/dashboard?${new URLSearchParams({ adsConnected: provider, accounts: String(accounts), store: storeId })}`);
    if (!parsed.success) return back({ error: "unknown_provider" });
    const provider = parsed.data;
    const q = c.req.query();
    const deadline = Date.now() + CALLBACK_DB_WAIT_MS;
    const db = <T>(step: () => Promise<T>) => waitingOutDb(deps, deadline, step);

    try {
      const pending = pendingStates(getCookie(c, STATE_COOKIE));
      const ours = !!q.state && pending.some((n) => safeEqual(n, q.state!));
      // This one is used up either way; the others this browser started stay usable.
      const rest = pending.filter((n) => n !== q.state);
      if (rest.length) setCookie(c, STATE_COOKIE, rest.join("."), cookieOpts());
      else deleteCookie(c, STATE_COOKIE, { path: "/" });
      if (!ours) return back({ error: "state_mismatch", provider });
      const state = await takeAdSignInState(deps.coord, q.state!);
      if (!state) return back({ error: "state_expired", provider });
      if (state.provider !== provider) return back({ error: "state_mismatch", provider }, state.storeId);
      // They pressed Cancel / "Not now" on the platform's screen.
      if (q.error || !q.code) return back({ error: q.error === "access_denied" || q.error_reason === "user_denied" ? "denied" : "missing_params", provider }, state.storeId);
      // Listing a login's Google Ads accounts spends bizinsights' daily operations: none while they're used up.
      if (provider === "google" && (await googleAdsPaused(deps.coord))) return back({ error: "rate_limited", provider }, state.storeId);

      // Still no database at the deadline: go on with the sign-in and hold it for the person (below).
      // Then the check that they are who started it happens when they finish (ownPending).
      const user = await db(() => loadUser(c, deps)).catch((err: unknown) => {
        if (err instanceof DbUnavailable) return undefined;
        throw err;
      });
      if (user === null || (user && user.id !== state.userId)) return back({ error: "session_mismatch", provider }, state.storeId);

      const progress: AdSignInProgress = { externalUserId: null, reusedRefreshToken: false };
      /**
       * End without a connection: the grant this sign-in made goes back to the platform first, unless
       * it can't be told whose it is or something else relies on it (dropUnusedGrant). Best effort.
       */
      const fail = async (error: string) => {
        if (progress.tokens) await dropUnusedGrant(provider, progress.tokens, progress.externalUserId, deps.fetchImpl, { coord: deps.coord, reusedRefreshToken: progress.reusedRefreshToken });
        return back({ error, provider }, state.storeId);
      };
      let accounts: AdAccountList;
      try {
        accounts = await readAdSignIn(state, q.code, progress, { coord: deps.coord, fetchImpl: deps.fetchImpl });
      } catch (err) {
        if (err instanceof AdConsentNeededError) {
          // The consent screen was skipped, and this login is one bizinsights holds no refresh token for:
          // ask again, with it this time (Google always sends one then).
          const again = randomToken(24);
          const url = await startAdSignIn(deps.coord, again, { userId: state.userId, workspaceId: state.workspaceId, storeId: state.storeId, provider }, { consent: true });
          if (!url) return back({ error: "not_configured", provider }, state.storeId);
          setCookie(c, STATE_COOKIE, [again, ...rest].slice(0, MAX_PENDING_STATES).join("."), cookieOpts());
          return c.redirect(url);
        }
        if (err instanceof AdPermissionMissingError) return await fail("permission_missing");
        if (err instanceof AdNoRefreshTokenError) return await fail("no_refresh_token");
        if (err instanceof AdLoginWaitingError && user && progress.tokens) {
          // Signed in and granted, with no ad account to list yet (or the platform slow to list them): connected
          // all the same, never refused. The card says who is connected, and the accounts follow by themselves.
          // Logged as a refusal used to be, with Meta's diagnosis of the empty list (docs/ads-setup.md reads it).
          connectFailure(err.cause, provider, state.storeId);
          if (!(await db(() => mayStillConnect(state.workspaceId, state.storeId, user.id)))) return await fail("not_allowed");
          await db(() =>
            holdAdLogin(
              { workspaceId: state.workspaceId, storeId: state.storeId, provider, tokens: progress.tokens!, externalUserId: progress.externalUserId, loginName: err.loginName, userId: user.id, reason: err.reason },
              deps.fetchImpl,
            ),
          );
          await audit({ workspaceId: state.workspaceId, actorUserId: user.id, action: "ads.login_connected", targetType: "store", targetId: state.storeId, metadata: { provider, reason: err.reason }, ip: clientIp(c) }).catch(
            (e: unknown) => logger.warn({ err: e }, "audit failed"),
          );
          return back({ waiting: err.reason, provider }, state.storeId);
        }
        // Ours, not the platform's.
        if (err instanceof DbUnavailable) throw err;
        return await fail(connectFailure(err instanceof AdLoginWaitingError ? err.cause : err, provider, state.storeId));
      }
      if (!accounts.length) return await fail("no_accounts");
      const tokens = progress.tokens!;

      // One account, or a reconnect that sees nothing new: there's nothing to choose. A list the platform
      // cut short always goes to the choice, which says so.
      // With the database still out of reach, the sign-in waits for the person in the coordinator
      // (which doesn't need it), and they finish on the integrations page once it answers.
      let dbDown = !user;
      if (user) {
        try {
          if (!(await db(() => mayStillConnect(state.workspaceId, state.storeId, user.id)))) return await fail("not_allowed");
          const known = await db(() => systemDb.adConnection.findMany({ where: { storeId: state.storeId, provider }, select: { accountId: true } }));
          const knownIds = new Set(known.map((k) => k.accountId));
          if (!accounts.truncated && (accounts.length === 1 || accounts.every((a) => knownIds.has(a.accountId)))) {
            const saved = await db(() =>
              connectAccounts(deps, clientIp(c), { workspaceId: state.workspaceId, storeId: state.storeId, provider, accounts, tokens, userId: user.id, externalUserId: progress.externalUserId }),
            );
            return toDashboard(provider, saved.length, state.storeId);
          }
        } catch (err) {
          if (!(err instanceof DbUnavailable)) throw err;
          dbDown = true;
        }
      }
      if (dbDown) logger.warn({ provider, storeId: state.storeId }, "database unreachable after an ad platform sign-in; holding it for the person to finish");
      const pick = randomToken(24);
      await holdPendingAdConnect(deps.coord, pick, {
        userId: state.userId,
        workspaceId: state.workspaceId,
        storeId: state.storeId,
        provider,
        accounts,
        tokens,
        externalUserId: progress.externalUserId,
        reusedRefreshToken: progress.reusedRefreshToken,
      });
      return back({ choose: pick, provider }, state.storeId);
    } catch (err) {
      // A browser navigation: land on a page that says what happened, never on raw JSON.
      logger.error({ err, provider }, "ads callback failed");
      return back({ error: "temporarily_unavailable", provider });
    }
  });

  /** The accounts a sign-in can see, while the person chooses which to connect. No tokens. */
  app.get("/workspaces/:ws/stores/:storeId/ads/pending/:nonce", async (c) => {
    const { ws, storeId, nonce } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    await storeInWorkspace(ws, storeId);
    const p = await ownPending(deps, nonce, access.user?.id, ws, storeId);
    const known = await withTenant(ws, (tx) => tx.adConnection.findMany({ where: { workspaceId: ws, storeId, provider: p.provider }, select: { accountId: true, enabled: true } }));
    // Whether each is connected already, and shown: the picker ticks only the ones on the dashboard now,
    // so a reconnect doesn't bring back an account someone hid.
    const enabled = new Map(known.map((k) => [k.accountId, k.enabled]));
    return c.json({
      provider: p.provider,
      expiresAt: new Date(p.expiresAt).toISOString(),
      truncated: !!p.truncated,
      accounts: p.accounts.map((a) => ({
        accountId: a.accountId,
        name: a.name,
        currency: a.currency,
        timezone: a.timezone,
        connected: enabled.has(a.accountId),
        enabled: enabled.get(a.accountId) ?? null,
        status: isAdAccountStatus(a.status) ? a.status : null,
        statusDetail: a.statusDetail ?? null,
      })),
    });
  });

  /** Connect the accounts the person ticked. A choice can be used once. */
  app.post("/workspaces/:ws/stores/:storeId/ads/pending/:nonce", async (c) => {
    const { ws, storeId, nonce } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    await storeInWorkspace(ws, storeId);
    // Bounded by the accounts the sign-in listed (checked below), not by a small number: agency logins see thousands.
    const { accountIds } = z.object({ accountIds: z.array(z.string().min(1).max(64)).min(1).max(10_000) }).parse(await body(c));
    const p = await ownPending(deps, nonce, access.user?.id, ws, storeId);
    const wanted = new Set(accountIds);
    const chosen = p.accounts.filter((a) => wanted.has(a.accountId));
    if (chosen.length !== wanted.size) throw new HttpError(400, "Choose from the accounts listed.", "invalid_accounts");
    // Used up only now, so a bad request doesn't cost the person their sign-in.
    const taken = await takePendingAdConnect(deps.coord, nonce);
    if (!taken) throw new HttpError(404, "That choice has expired. Press the button to connect again.", "pending_expired");
    // The choice is about what shows on this store's dashboard: a ticked account that was hidden
    // comes back, and an already-connected one left unticked is hidden (not deleted).
    const scope = { workspaceId: ws, storeId, provider: taken.provider };
    const unticked = taken.accounts.map((a) => a.accountId).filter((id) => !wanted.has(id));
    await systemDb.adConnection.updateMany({ where: { ...scope, accountId: { in: [...wanted] }, enabled: false }, data: { enabled: true } });
    if (unticked.length) await systemDb.adConnection.updateMany({ where: { ...scope, accountId: { in: unticked } }, data: { enabled: false } });
    const saved = await connectAccounts(deps, clientIp(c), {
      workspaceId: ws,
      storeId,
      provider: taken.provider,
      accounts: chosen,
      tokens: pendingTokens(taken),
      userId: access.user!.id,
      externalUserId: taken.externalUserId ?? null,
    });
    return c.json({ provider: taken.provider, connected: saved.length });
  });

  /** "Cancel" on the choice: nothing is connected, and the sign-in's grant goes back to the platform unless something relies on it. */
  app.delete("/workspaces/:ws/stores/:storeId/ads/pending/:nonce", async (c) => {
    const { ws, storeId, nonce } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    await ownPending(deps, nonce, access.user?.id, ws, storeId);
    const taken = await takePendingAdConnect(deps.coord, nonce);
    if (taken) {
      await dropUnusedGrant(taken.provider, pendingTokens(taken), taken.externalUserId, deps.fetchImpl, { coord: deps.coord, exceptPending: nonce, reusedRefreshToken: !!taken.reusedRefreshToken });
    }
    return c.json({ ok: true });
  });

  /**
   * Show an account on the dashboard (and keep syncing it), or not; for AdSense, which of the
   * account's sites are the store's (empty: every site). Showing an account again, or changing its
   * sites, brings it up to date.
   */
  app.patch("/workspaces/:ws/stores/:storeId/ads/connections/:id", async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    const input = z
      .object({ enabled: z.boolean().optional(), sites: z.array(hostSchema).max(200).optional() })
      .refine((v) => v.enabled !== undefined || v.sites !== undefined, "Nothing to change")
      .parse(await body(c));
    const conn = await withTenant(ws, (tx) => tx.adConnection.findFirst({ where: { id, workspaceId: ws, storeId } }));
    if (!conn) throw new HttpError(404, "Not found", "not_found");
    if (input.sites !== undefined && conn.provider !== "adsense") throw new HttpError(400, "sites: only an AdSense account has sites to choose.", "validation");
    const sites = input.sites ? [...new Set(input.sites)].sort() : undefined;
    const before = [...conn.sites].sort();
    const sitesChanged = !!sites && (sites.length !== before.length || sites.some((s, i) => s !== before[i]));
    const shown = input.enabled === true && !conn.enabled;
    const hidden = input.enabled === false && conn.enabled;
    let updated = await systemDb.adConnection.update({
      where: { id: conn.id },
      // A hidden account isn't synced: nothing it asked for is on its way any more.
      data: { ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), ...(sites ? { sites } : {}), ...(hidden ? { syncRequestedAt: null } : {}) },
    });
    if ((shown || sitesChanged) && (await queueRefresh(deps, updated))) {
      // The answer's card says "Synchronizing" (syncRequestedAt) from now.
      updated = await systemDb.adConnection.findUniqueOrThrow({ where: { id: conn.id } });
    }
    const auditOf = (action: string, metadata?: Record<string, unknown>) =>
      audit({ workspaceId: ws, actorUserId: access.user?.id ?? null, action, targetType: "ad_connection", targetId: conn.id, metadata, ip: clientIp(c) }).catch((err: unknown) => logger.warn({ err }, "audit failed"));
    if (input.enabled !== undefined && input.enabled !== conn.enabled) await auditOf(input.enabled ? "ads.account_shown" : "ads.account_hidden");
    if (sitesChanged) await auditOf("ads.sites_changed", { sites: sites!.length });
    const [connection] = await publicConnections(ws, [updated], { id: access.user?.id ?? null, seesEmail: true });
    return c.json({ connection });
  });

  /** Disconnect one ad account: its token and every number fetched for it are deleted. */
  app.delete("/workspaces/:ws/stores/:storeId/ads/connections/:id", async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    const conn = await withTenant(ws, (tx) => tx.adConnection.findFirst({ where: { id, workspaceId: ws, storeId } }));
    if (!conn) throw new HttpError(404, "Not found", "not_found");
    // The demo: its figures and row go. There is no grant to hand back, and no other connection is touched.
    if (isDemoConnection(conn)) {
      await disconnectGoogleAdsDemo(conn);
      await audit({ workspaceId: ws, actorUserId: access.user?.id ?? null, action: "ads.demo_disconnected", targetType: "store", targetId: storeId, metadata: { accountId: conn.accountId }, ip: clientIp(c) }).catch((err: unknown) => logger.warn({ err }, "audit failed"));
      return c.json({ ok: true });
    }
    await systemDb.$transaction([
      systemDb.adCampaignDaily.deleteMany({ where: { connectionId: conn.id } }),
      systemDb.adsenseDaily.deleteMany({ where: { connectionId: conn.id } }),
      systemDb.adConnection.delete({ where: { id: conn.id } }),
    ]);
    // bizinsights' copy is gone; now the platform access too, unless another connection relies on it.
    const revoked = await revokeAdAccessIfUnused(conn, deps.fetchImpl);
    await audit({
      workspaceId: ws,
      actorUserId: access.user?.id ?? null,
      action: "ads.disconnected",
      targetType: "store",
      targetId: storeId,
      metadata: { provider: conn.provider, accountId: conn.accountId, revoked },
      ip: clientIp(c),
    }).catch((err: unknown) => logger.warn({ err }, "audit failed"));
    return c.json({ ok: true, revoked });
  });

  /**
   * "Check for ad accounts" on a connected sign-in that has none yet: Meta is asked now (as the cron tick
   * does every hour), and the accounts it lists are connected. `connected`: how many; `waiting`: still
   * none (or more than are connected without asking: `reason` "choose"); `ended`: the access is gone.
   */
  app.post("/workspaces/:ws/stores/:storeId/ads/logins/:id/check", async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    await limit(deps.coord, `rl:ads-sync:${storeId}:${access.user?.id ?? clientIp(c)}`, LIMITS.adsSync);
    await storeInWorkspace(ws, storeId);
    const row = await withTenant(ws, (tx) => tx.adLogin.findFirst({ where: { id, workspaceId: ws, storeId } }));
    if (!row) throw new HttpError(404, "Not found", "not_found");
    const r = await checkAdLogin(row, deps, { interactive: true });
    if (r.outcome === "connected") return c.json({ connected: r.connected });
    if (r.outcome === "ended") return c.json({ ended: true });
    return c.json({ waiting: true, reason: r.outcome === "waiting" ? r.reason : row.reason });
  });

  /** Disconnect a sign-in that has no ad account yet: it goes, and its grant goes back to the platform unless something else relies on it. */
  app.delete("/workspaces/:ws/stores/:storeId/ads/logins/:id", async (c) => {
    const { ws, storeId, id } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    const row = await withTenant(ws, (tx) => tx.adLogin.findFirst({ where: { id, workspaceId: ws, storeId } }));
    if (!row) throw new HttpError(404, "Not found", "not_found");
    const revoked = await releaseAdLogin(row, deps.fetchImpl);
    await audit({ workspaceId: ws, actorUserId: access.user?.id ?? null, action: "ads.login_disconnected", targetType: "store", targetId: storeId, metadata: { provider: row.provider, revoked }, ip: clientIp(c) }).catch(
      (err: unknown) => logger.warn({ err }, "audit failed"),
    );
    return c.json({ ok: true, revoked });
  });

  /**
   * The Meta Ads report for one connected account and range: campaigns, ad sets or ads with reach,
   * frequency, link clicks, purchases and their value, asked of Meta for exactly those dates; with
   * cfrom/cto, the same for the comparison's dates. Read-only, and cached briefly so the dashboard's
   * polling doesn't spend Meta's rate limit. Both ranges are read at once, within one deadline that
   * fits the request's time. A drill-down: `campaign` (its ad sets or ads) and `adset` (its ads), each
   * Meta's own id; the totals are then the campaign's or ad set's own (metaReport).
   */
  app.get("/workspaces/:ws/stores/:storeId/ads/meta/report", async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "marketing.campaigns");
    await storeInWorkspace(ws, storeId);
    // Meta keeps 37 months of insights; a year at a time is what the dashboard asks for.
    const q = z
      .object({ level: z.enum(META_REPORT_VIEWS).default("campaign"), campaign: metaObjectId.optional(), adset: metaObjectId.optional() })
      .refine((v) => metaParentFits(v.level, v), "Only a campaign's ad sets or ads, or an ad set's ads, are read under it")
      .and(reportDates)
      .parse(c.req.query());
    const parent = { ...(q.campaign !== undefined ? { campaign: q.campaign } : {}), ...(q.adset !== undefined ? { adset: q.adset } : {}) };
    const conn = await withTenant(ws, (tx) => tx.adConnection.findFirst({ where: { id: q.connection, workspaceId: ws, storeId, provider: "meta" } }));
    if (!conn) throw new HttpError(404, "Not found", "not_found");
    if (conn.status === "reconnect") throw new HttpError(409, ACCESS_ENDED.meta, "reconnect");
    const account = { id: conn.id, accountId: conn.accountId, name: conn.accountName, currency: conn.currency, timezone: conn.timezone };
    const today = adToday(conn);
    const deadline = Date.now() + META_REPORT_JOB.budgetMs;
    // Days that are over change little (Meta still revises purchases for a while); today's keep coming in.
    // The key's version moves whenever a report gains figures (v3: the rows' campaign and ad set ids), so
    // none cached without them is read back; a drill-down's parent is part of what was asked.
    const { reports, cached } = await readRanges<MetaReport>(
      deps,
      rangesOf(q),
      today,
      (r) => `ads-report:v3:${conn.id}:${q.level}:${parentKey(q.campaign, q.adset)}:${r.from}:${r.to}${r.compare ? ":figures" : ""}`,
      (r) => metaReportForConnection(conn, q.level, r.from, r.to, deps.fetchImpl, { coord: deps.coord, deadline, parent, ...(r.compare ? { statuses: false } : {}) }),
      `rl:ads-report:${storeId}:${access.user?.id ?? clientIp(c)}`,
    ).catch((err: unknown) => {
      throw reportFailure(err, "meta", conn.id);
    });
    const [report, compared] = reports;
    return c.json({ account, today, cached, report: { ...report!, ...(compared ? { comparison: comparisonOf(compared, META_METRICS) } : {}) } });
  });

  /**
   * The Google Ads report for one connected account and range: campaigns (with status, type and
   * daily budget), ad groups, devices or countries, asked of Google for exactly those dates; with
   * cfrom/cto, the comparison's too. Read-only, cached briefly, and counted against bizinsights' daily
   * allowance of Google Ads API operations like the syncs. A drill-down: `campaign` (its ad groups, or a
   * Performance Max campaign's asset groups) and `adGroup` (its ads); one operation a range, with the
   * rows added up as the totals (googleReport).
   *
   * Keywords and search terms (`level=keyword|search_term`, for the account, one campaign or (keywords)
   * one ad group): only when someone opens them, two operations a range, held to their own share of the
   * day's allowance and to LIMITS.adsGoogleDetail reads per ad account a day (googleDetailAllowed), and
   * cached longer (30 minutes with today, 6 hours without). The demo's are generated, with neither guard.
   */
  app.get("/workspaces/:ws/stores/:storeId/ads/google/report", async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "marketing.campaigns");
    await storeInWorkspace(ws, storeId);
    const q = z
      .object({ level: z.enum(GOOGLE_REPORT_LEVELS).default("campaign"), campaign: googleObjectId.optional(), adGroup: googleObjectId.optional() })
      .refine(
        (v) => googleParentFits(v.level, v),
        "Asset groups are read under a campaign, ads under an ad group, search terms for the account or a campaign, keywords for the account, a campaign or an ad group, and campaigns, devices and countries for the whole account",
      )
      .and(reportDates)
      .parse(c.req.query());
    const parent = { ...(q.campaign !== undefined ? { campaign: q.campaign } : {}), ...(q.adGroup !== undefined ? { adGroup: q.adGroup } : {}) };
    const conn = await withTenant(ws, (tx) => tx.adConnection.findFirst({ where: { id: q.connection, workspaceId: ws, storeId, provider: "google" } }));
    if (!conn) throw new HttpError(404, "Not found", "not_found");
    // Google's own ids for a real account (they go into its query), the demo's for the demo.
    if (!Object.values(parent).every(isDemoConnection(conn) ? isDemoObjectId : isGoogleObjectId)) throw new HttpError(400, "That campaign or ad group isn't one this account has.", "validation");
    if (conn.status === "reconnect") throw new HttpError(409, ACCESS_ENDED.google, "reconnect");
    const account = { id: conn.id, accountId: conn.accountId, name: conn.accountName, currency: conn.currency, timezone: conn.timezone };
    const today = adToday(conn);
    // Both ranges' calls end within one deadline, so the answer comes within the request's time.
    const deadline = Date.now() + AD_REPORT_BUDGET_MS;
    // Google finishes most of a day's numbers within about three hours, and still revises conversions after.
    // The key's version moves whenever a report gains figures (v4: the rows' match type and Quality Score;
    // v3 their campaign and ad group ids), so none cached without them is read back; a drill-down's parent
    // is part of what was asked.
    const detail = isGoogleDetailLevel(q.level);
    const { reports, cached } = await readRanges<GoogleReport>(
      deps,
      rangesOf(q),
      today,
      (r) => `ads-greport:v4:${conn.id}:${q.level}:${parentKey(q.campaign, q.adGroup)}:${r.from}:${r.to}`,
      (r) => googleReportForConnection(conn, q.level, r.from, r.to, deps.fetchImpl, { coord: deps.coord, deadline, parent }),
      `rl:ads-report:${storeId}:${access.user?.id ?? clientIp(c)}`,
      // Keywords and search terms cost the most to read and are opened again and again on the same dates.
      detail ? { ttl: (r) => (r.to >= today ? 1800 : 21_600), ...(isDemoConnection(conn) ? {} : { onMiss: () => googleDetailAllowed(deps, conn.id) }) } : {},
    ).catch((err: unknown) => {
      throw reportFailure(err, "google", conn.id);
    });
    const [report, compared] = reports;
    return c.json({ account, today, cached, report: { ...report!, ...(compared ? { comparison: comparisonOf(compared, GOOGLE_METRICS) } : {}) } });
  });

  /**
   * The AdSense report for one connected account and range, by site, country or device type, limited
   * to the store's own sites (the connection's `sites`, echoed in the answer; empty: every site). An
   * account AdSense won't filter by site answers an error, never every site's earnings. Cached briefly.
   */
  app.get("/workspaces/:ws/stores/:storeId/ads/adsense/report", async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "marketing.campaigns");
    await storeInWorkspace(ws, storeId);
    const q = z
      .object({ connection: z.string().min(1).max(64), level: z.enum(ADSENSE_REPORT_LEVELS).default("site"), from: day, to: day })
      .refine((v) => v.from <= v.to, "from is after to")
      .refine((v) => daysBetweenInclusive(v.from, v.to) <= MAX_CUSTOM_DAYS, "Pick up to a year at a time")
      .parse(c.req.query());
    const conn = await withTenant(ws, (tx) => tx.adConnection.findFirst({ where: { id: q.connection, workspaceId: ws, storeId, provider: "adsense" } }));
    if (!conn) throw new HttpError(404, "Not found", "not_found");
    if (conn.status === "reconnect") throw new HttpError(409, ACCESS_ENDED.adsense, "reconnect");
    const account = { id: conn.id, accountId: conn.accountId, name: conn.accountName };
    const today = adToday(conn);
    // The sites are part of what was asked: a change of sites is a different report.
    const sitesKey = sha256Hex([...conn.sites].sort().join(",")).slice(0, 16);
    // AdSense finalizes a month's estimated earnings after it ends; today's keep coming in.
    const { reports, cached } = await readRanges<AdsenseLiveReport>(
      deps,
      [{ from: q.from, to: q.to }],
      today,
      (r) => `ads-sreport:${conn.id}:${q.level}:${r.from}:${r.to}:${sitesKey}`,
      (r) => adsenseReportForConnection(conn, q.level, r.from, r.to, deps.fetchImpl, { deadline: Date.now() + AD_REPORT_BUDGET_MS }),
      `rl:ads-report:${storeId}:${access.user?.id ?? clientIp(c)}`,
    ).catch((err: unknown) => {
      throw reportFailure(err, "adsense", conn.id);
    });
    return c.json({ account, today, cached, report: reports[0]! });
  });

  /**
   * "Sync now" / "Refresh": bring every shown account up to date (or one platform's). An account this
   * login can't read now, or that the platform won't report on, is asked whether it is back (and
   * catches up if so). One waiting for a reconnect is left alone: only connecting again helps it.
   * `queued`: the accounts sent off; one already on its way isn't sent again. While a platform is paused
   * for bizinsights' own limit there (Google's daily allowance, Meta's hourly app limit), its accounts
   * are sent all the same: the job reads nothing and marks the card with why (quota_exhausted,
   * rate_limited), so the answer and its "Synchronizing" mean what they always do.
   */
  app.post("/workspaces/:ws/stores/:storeId/ads/sync", async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    const { provider } = z.object({ provider: providerSchema.optional() }).parse(await body(c));
    await limit(deps.coord, `rl:ads-sync:${storeId}:${access.user?.id ?? clientIp(c)}`, LIMITS.adsSync);
    await storeInWorkspace(ws, storeId);
    const conns = await withTenant(ws, (tx) =>
      // Accounts with a working grant, and the demo, which needs none.
      tx.adConnection.findMany({ where: { workspaceId: ws, storeId, enabled: true, status: { not: "reconnect" }, OR: [{ accessTokenEnc: { not: "" } }, { isDemo: true }], ...(provider ? { provider } : {}) } }),
    );
    let queued = 0;
    for (const conn of conns) if (await queueRefresh(deps, conn)) queued++;
    return c.json({ queued });
  });
}
