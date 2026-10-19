import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { dbReachable, systemDb, withTenant, type AdConnection } from "@app/db";
import {
  AD_PROVIDER_NAME,
  adsConfigured,
  adsRestricted,
  adsenseAccounts,
  adsenseAuthorizeUrl,
  adsenseConfig,
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
  adsRedirectUri,
  audit,
  dropUnusedGrant,
  enqueueAdCatchUp,
  enqueueAdSync,
  env,
  googleAdAccounts,
  googleAuthorizeUrl,
  googleClient,
  googleConfig,
  googleExchangeCode,
  googleReportForConnection,
  googleUserId,
  holdPendingAdConnect,
  holdsReusableRefreshToken,
  logger,
  providerDetail,
  metaAdAccounts,
  metaAuthorizeUrl,
  metaConfig,
  metaExchangeCode,
  metaGrantedPermissions,
  META_REPORT_JOB,
  metaReportForConnection,
  metaUserId,
  peekPendingAdConnect,
  pendingTokens,
  REQUIRED_AD_SCOPE,
  reusableRefreshToken,
  revokeAdAccessIfUnused,
  saveAdConnections,
  takePendingAdConnect,
  type AdAccountList,
  type AdsenseLiveReport,
  type GoogleReport,
  type MetaReport,
  type NoAdAccountsReason,
  type TokenSet,
} from "@app/core";
import {
  AD_CONNECTION_STATUSES,
  AD_PROVIDERS,
  ADSENSE_REPORT_LEVELS,
  adErrorMessage,
  adStatusCode,
  allows,
  daysBetweenInclusive,
  GOOGLE_REPORT_LEVELS,
  googleReportMetrics,
  isAdAccountStatus,
  isAdErrorCode,
  isDay,
  MAX_CUSTOM_DAYS,
  META_REPORT_VIEWS,
  metaReportMetrics,
  pkcePair,
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
 * "Continue with Meta" / "Continue with Google Ads": connect a store's ad accounts, read-only, so
 * the dashboard can show what's spent on ads next to what the store sells. "Continue with Google
 * AdSense" connects the other direction: what the store's site earns from ads shown on it.
 *
 * The OAuth round trip mirrors the Shopify connect: single-use state in the coordinator, bound
 * to this browser by a cookie, and the callback only accepted for the person who started it.
 * When the sign-in can see several accounts (and some are new), the person chooses which to
 * connect on the integrations page; the sign-in's tokens wait, encrypted, in the coordinator.
 * A finished connection lands on the dashboard, where the numbers are. A sign-in that ends
 * without a connection gives its grant back to the platform, unless something else relies on it.
 */

const STATE_TTL_S = 600;
const STATE_COOKIE = "ads_oauth_state";
/**
 * The sign-ins this browser started that haven't come back yet, newest first. A second press of the
 * button (or a second tab) mustn't void the first: the platform may still send the person back with
 * the first one's state. Each is still single-use and bound to this browser.
 */
const MAX_PENDING_STATES = 5;
const pendingStates = (cookie: string | undefined) => (cookie ?? "").split(".").filter((n) => /^[A-Za-z0-9_-]{16,64}$/.test(n));

const cookieOpts = () => ({ path: "/", httpOnly: true, sameSite: "Lax" as const, secure: env().NODE_ENV === "production", maxAge: STATE_TTL_S });

interface AdsState {
  userId: string;
  workspaceId: string;
  storeId: string;
  provider: AdProvider;
  /** PKCE verifier (Google): kept here on the server; only its challenge went to the browser. */
  codeVerifier?: string;
  /**
   * Google: false when the consent screen was skipped (the person already gave bizinsights a working
   * refresh token, holdsReusableRefreshToken). A sign-in that then brings none asks again with it.
   */
  consent?: boolean;
}

const providerSchema = z.enum(AD_PROVIDERS);

/** The callback's ?error= for each way a login can have nothing to connect (the settings page words each one, per platform). */
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
    /** The last day (the account's own) stored without a gap from historyFrom on. */
    syncedThrough: c.syncedThrough,
    historyFrom: c.historyFrom,
    /** Someone asked for a sync that hasn't finished: the card says "Synchronizing". */
    syncRequestedAt: c.syncRequestedAt,
    consecutiveFailures: c.consecutiveFailures,
    // Meta access lasts about 60 days; Settings warns before it runs out. Google's renews itself.
    accessExpiresAt: provider === "meta" ? c.accessTokenExpiresAt : null,
    connectedAt: c.createdAt,
    /** The one read-only permission this connection was granted (checked when connecting). */
    permission: REQUIRED_AD_SCOPE[provider] ?? null,
    /** Every permission that was granted, when the platform said. */
    grantedScopes: c.grantedScopes ?? [],
    /** Google Ads: the manager account the account is reached through. */
    loginCustomerId: customerId(c.loginCustomerId),
    connectedBy: connector ? { name: connector.name, email: ctx.seesEmail ? connector.email : null, you: c.connectedByUserId === ctx.viewerId } : null,
    sites: adsense ? c.sites : [],
    availableSites: adsense ? [...new Set([...(ctx.seenSites.get(c.id) ?? []), ...c.sites])].sort() : [],
  };
}

/** Connections as the browser sees them, with who connected each (of this workspace's members) and the sites AdSense reported. */
async function publicConnections(ws: string, rows: AdConnection[], viewer: { id: string | null; seesEmail: boolean }) {
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

async function storeInWorkspace(ws: string, storeId: string) {
  const store = await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: storeId, workspaceId: ws }, select: { id: true, status: true } }));
  if (!store || store.status === "uninstalled") throw new HttpError(404, "Not found", "not_found");
  return store;
}

/**
 * Whether this person may still connect ad accounts to this store: checked when the platform sends
 * them back, not only when they pressed the button. The sign-in can take minutes, and someone
 * removed or demoted in between (or a store disconnected or moved) must not get accounts attached.
 */
async function mayStillConnect(ws: string, storeId: string, userId: string): Promise<boolean> {
  const m = await systemDb.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ws, userId } } });
  if (!memberAllows(m, "integrations.manage")) return false;
  return !!(await systemDb.store.findFirst({ where: { id: storeId, workspaceId: ws, status: { not: "uninstalled" } }, select: { id: true } }));
}

/**
 * Save the chosen accounts, bring each up to date, and record who connected them. A new account's
 * catch-up is its first 90 days, after which its history is walked back; one connected before
 * fetches what it missed. Each card says "Synchronizing" until its catch-up lands.
 */
async function connectAccounts(
  deps: Deps,
  ip: string | undefined,
  input: { workspaceId: string; storeId: string; provider: AdProvider; accounts: AdAccountList; tokens: TokenSet; userId: string; externalUserId?: string | null },
) {
  const saved = await saveAdConnections(input);
  for (const conn of saved) {
    if (conn.enabled) await enqueueAdCatchUp(deps.queues, conn, { interactive: true });
  }
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

/** A pending choice that belongs to this person, workspace and store, or a 404 that says it's gone. */
async function ownPending(deps: Deps, nonce: string, userId: string | undefined, ws: string, storeId: string) {
  const p = await peekPendingAdConnect(deps.coord, nonce);
  if (!p || !userId || p.userId !== userId || p.workspaceId !== ws || p.storeId !== storeId) {
    throw new HttpError(404, "That choice has expired. Press the button to connect again.", "pending_expired");
  }
  return p;
}

/**
 * How long a callback waits for the database before giving up on it. Production's Postgres is reached
 * through a tunnel that drops for 10-20 seconds at a time, and the person has just been through the
 * platform's sign-in, which is not theirs to repeat because of us.
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

/** The callback's ?error= for a platform failure during the sign-in (after the person said yes), logged as it deserves. */
function connectFailure(err: unknown, provider: AdProvider, storeId: string): string {
  // bizinsights' Google Cloud project isn't approved for real Google Ads accounts yet: say so, don't blame the account.
  if (err instanceof AdsNotApprovedError) {
    logger.warn({ err, provider, storeId }, "google ads: project not approved for production accounts");
    return "not_approved";
  }
  // The login reaches nothing that can be connected. Which case it is decides what the person should do.
  if (err instanceof AdsNoAccountsError) {
    logger.info({ reason: err.reason, detail: err.message, provider, storeId }, "ads: nothing to connect for this login");
    return NO_ACCOUNTS_ERROR[err.reason];
  }
  // A Google login with no AdSense account: AdSense answers 403 rather than an empty list.
  if (provider === "adsense" && err instanceof AdsApiError && err.status === 403 && /adsense account/i.test(err.message)) return "no_accounts";
  // The platform's API isn't switched on for bizinsights, or its client was refused: ours to fix.
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

/** The ranges a report request asks for: its own, then the comparison's when there is one. */
const rangesOf = (q: { from: string; to: string; cfrom?: string; cto?: string }) => [{ from: q.from, to: q.to }, ...(q.cfrom && q.cto ? [{ from: q.cfrom, to: q.cto }] : [])];

/**
 * Read a report's ranges, each from the cache or the platform (all at once, so a comparison takes no
 * longer than one range), and cache what was read: days that are over change little, today's keep
 * coming in. The first failure is thrown once every read has ended, the ranges that worked cached.
 */
async function readRanges<T>(deps: Deps, ranges: Array<{ from: string; to: string }>, today: string, key: (r: { from: string; to: string }) => string, read: (r: { from: string; to: string }) => Promise<T>, rateKey: string) {
  const cached = await Promise.all(ranges.map((r) => deps.coord.peek(key(r))));
  if (cached.some((c) => !c)) await limit(deps.coord, rateKey, LIMITS.adsReport);
  const results = await Promise.allSettled(
    ranges.map(async (r, i) => {
      if (cached[i]) return JSON.parse(cached[i]!) as T;
      const report = await read(r);
      await deps.coord.put(key(r), JSON.stringify(report), r.to >= today ? 600 : 3600);
      return report;
    }),
  );
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  return { reports: results.map((r) => (r as PromiseFulfilledResult<T>).value), cached: cached.every(Boolean) };
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
    const rows = await withTenant(ws, (tx) => tx.adConnection.findMany({ where: { workspaceId: ws, storeId }, orderBy: [{ provider: "asc" }, { createdAt: "asc" }] }));
    const connections = await publicConnections(ws, rows, { id: access.user?.id ?? null, seesEmail: allows(access.access, "integrations.manage") });
    return c.json({ configured: adsConfigured(), restricted: adsRestricted(), connections });
  });

  /** Step 1: where to send the browser to approve read access to ads. */
  app.post("/workspaces/:ws/stores/:storeId/ads/:provider/connect", async (c) => {
    const { ws, storeId } = c.req.param();
    const provider = providerSchema.parse(c.req.param("provider"));
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    const user = access.user!;
    if (!user.emailVerified) throw new HttpError(403, "Verify your email first", "email_unverified");
    await storeInWorkspace(ws, storeId);
    const meta = metaConfig();
    const google = googleConfig();
    const adsense = adsenseConfig();
    if ((provider === "meta" && !meta) || (provider === "google" && !google) || (provider === "adsense" && !adsense)) {
      throw new HttpError(503, `${AD_PROVIDER_NAME[provider]} isn't set up on this server yet.`, "not_configured");
    }
    // Each sign-in writes a coordinator item and its callback lists accounts against the platform's quota.
    await limit(deps.coord, `rl:ads-connect:${user.id}`, LIMITS.adsConnect, "That's a lot of sign-ins in a short time. Wait a few minutes and try again.");
    const nonce = randomToken(24);
    // Google takes PKCE on top of the client secret: a code intercepted on its way back is useless without the verifier.
    const pkce = provider === "meta" ? null : pkcePair();
    // Google's consent screen only for someone without a working refresh token from it yet: each consent
    // hands out another, and Google ends a login's oldest past 100 (see holdsReusableRefreshToken).
    const consent = provider === "meta" ? true : !(await holdsReusableRefreshToken(provider, user.id));
    const state: AdsState = { userId: user.id, workspaceId: ws, storeId, provider, ...(pkce ? { codeVerifier: pkce.verifier } : {}), ...(consent ? {} : { consent: false }) };
    await deps.coord.put(`oauth:ads:${nonce}`, JSON.stringify(state), STATE_TTL_S);
    setCookie(c, STATE_COOKIE, [nonce, ...pendingStates(getCookie(c, STATE_COOKIE))].slice(0, MAX_PENDING_STATES).join("."), cookieOpts());
    const redirectUri = adsRedirectUri(provider);
    const url =
      provider === "meta" ? metaAuthorizeUrl(meta!, redirectUri, nonce)
      : provider === "google" ? googleAuthorizeUrl(google!, redirectUri, nonce, pkce!.challenge, { forceConsent: consent })
      : adsenseAuthorizeUrl(adsense!, redirectUri, nonce, pkce!.challenge, { forceConsent: consent });
    return c.json({ url });
  });

  /** Step 2: the platform sends the browser back here with a code (or with the person's "no"). */
  app.get("/ads/:provider/callback", async (c) => {
    const appUrl = env().APP_URL;
    const parsed = providerSchema.safeParse(c.req.param("provider"));
    // Problems and the account choice stay on the integrations page; success goes to the numbers.
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
      const raw = await deps.coord.take(`oauth:ads:${q.state}`);
      if (!raw) return back({ error: "state_expired", provider });
      const state = JSON.parse(raw) as AdsState;
      if (state.provider !== provider) return back({ error: "state_mismatch", provider }, state.storeId);
      // They pressed Cancel / "Not now" on the platform's screen.
      if (q.error || !q.code) return back({ error: q.error === "access_denied" || q.error_reason === "user_denied" ? "denied" : "missing_params", provider }, state.storeId);

      // The platform's keys: Google Ads accounts already connected keep working with new connections
      // switched off (googleClient), so a sign-in started before the switch can still finish.
      const metaCfg = provider === "meta" ? metaConfig(deps.fetchImpl) : null;
      const googleCfg = provider === "google" ? googleClient(deps.fetchImpl) : null;
      const adsenseCfg = provider === "adsense" ? adsenseConfig(deps.fetchImpl) : null;
      if (!metaCfg && !googleCfg && !adsenseCfg) return back({ error: "not_configured", provider }, state.storeId);

      // Still no database at the deadline: go on with the sign-in and hold it for the person (below).
      // Then the check that they are who started it happens when they finish (ownPending).
      const user = await db(() => loadUser(c, deps)).catch((err: unknown) => {
        if (err instanceof DbUnavailable) return undefined;
        throw err;
      });
      if (user === null || (user && user.id !== state.userId)) return back({ error: "session_mismatch", provider }, state.storeId);

      const redirectUri = adsRedirectUri(provider);
      let tokens: TokenSet | undefined;
      let accounts: AdAccountList;
      let externalUserId: string | null = null;
      // The refresh token is one this person gave before (Google sent none): never revoked on their behalf here.
      let reused = false;
      /**
       * End without a connection: the grant this sign-in made goes back to the platform first, unless
       * it can't be told whose it is or something else relies on it (dropUnusedGrant). Best effort.
       */
      const fail = async (error: string) => {
        if (tokens) await dropUnusedGrant(provider, tokens, externalUserId, deps.fetchImpl, { coord: deps.coord, reusedRefreshToken: reused });
        return back({ error, provider }, state.storeId);
      };
      // The person can untick the one permission on the platform's screen: then nothing can be read.
      const granted = (t: TokenSet) => !t.grantedScopes || t.grantedScopes.includes(REQUIRED_AD_SCOPE[provider]);
      // Who signed in, so a later disconnect knows whether anything else still relies on their grant. Never blocks a connect.
      const whoIs = (p: Promise<string | null>) =>
        p.catch((err: unknown) => {
          logger.warn({ err, provider }, "ad platform user id lookup failed");
          return null;
        });
      try {
        if (metaCfg) {
          tokens = await metaExchangeCode(metaCfg, q.code, redirectUri);
          // A Login for Business system-user token may not answer /me/permissions; then the account list below is the test.
          tokens.grantedScopes = await metaGrantedPermissions(metaCfg, tokens.accessToken).catch((err: unknown) => {
            if (err instanceof AdsApiError) return undefined;
            throw err;
          });
          externalUserId = await whoIs(metaUserId(metaCfg, tokens.accessToken));
          if (!granted(tokens)) return await fail("permission_missing");
          accounts = await metaAdAccounts(metaCfg, tokens.accessToken);
        } else {
          const cfg = (googleCfg ?? adsenseCfg)!;
          tokens = await googleExchangeCode(cfg, q.code, redirectUri, state.codeVerifier);
          externalUserId = await whoIs(googleUserId(cfg, tokens.accessToken));
          if (!granted(tokens)) return await fail("permission_missing");
          // Google sends a refresh token on consent; a person who gave one before keeps using theirs.
          if (!tokens.refreshToken) {
            tokens.refreshToken = await db(() => reusableRefreshToken(provider, externalUserId));
            reused = !!tokens.refreshToken;
          }
          if (!tokens.refreshToken && state.consent === false) {
            // The consent screen was skipped, and this login is one bizinsights holds no refresh token for:
            // ask again, with it this time (Google always sends one then).
            const again = randomToken(24);
            const pkce = pkcePair();
            await deps.coord.put(`oauth:ads:${again}`, JSON.stringify({ ...state, codeVerifier: pkce.verifier, consent: true } satisfies AdsState), STATE_TTL_S);
            setCookie(c, STATE_COOKIE, [again, ...rest].slice(0, MAX_PENDING_STATES).join("."), cookieOpts());
            return c.redirect(
              googleCfg
                ? googleAuthorizeUrl(googleCfg, redirectUri, again, pkce.challenge, { forceConsent: true })
                : adsenseAuthorizeUrl(adsenseCfg!, redirectUri, again, pkce.challenge, { forceConsent: true }),
            );
          }
          if (!tokens.refreshToken) return await fail("no_refresh_token");
          accounts = googleCfg ? await googleAdAccounts(googleCfg, tokens.accessToken) : await adsenseAccounts(cfg, tokens.accessToken);
        }
      } catch (err) {
        // Ours, not the platform's.
        if (err instanceof DbUnavailable) throw err;
        return await fail(connectFailure(err, provider, state.storeId));
      }
      if (!accounts.length) return await fail("no_accounts");

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
            const saved = await db(() => connectAccounts(deps, clientIp(c), { workspaceId: state.workspaceId, storeId: state.storeId, provider, accounts, tokens: tokens!, userId: user.id, externalUserId }));
            return toDashboard(provider, saved.length, state.storeId);
          }
        } catch (err) {
          if (!(err instanceof DbUnavailable)) throw err;
          dbDown = true;
        }
      }
      if (dbDown) logger.warn({ provider, storeId: state.storeId }, "database unreachable after an ad platform sign-in; holding it for the person to finish");
      const pick = randomToken(24);
      await holdPendingAdConnect(deps.coord, pick, { userId: state.userId, workspaceId: state.workspaceId, storeId: state.storeId, provider, accounts, tokens, externalUserId, reusedRefreshToken: reused });
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
    let updated = await systemDb.adConnection.update({ where: { id: conn.id }, data: { ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), ...(sites ? { sites } : {}) } });
    if (updated.enabled && (shown || sitesChanged) && (await enqueueAdCatchUp(deps.queues, updated, { interactive: true }))) {
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
   * The Meta Ads report for one connected account and range: campaigns, ad sets or ads with reach,
   * frequency, link clicks, purchases and their value, asked of Meta for exactly those dates; with
   * cfrom/cto, the same for the comparison's dates. Read-only, and cached briefly so the dashboard's
   * polling doesn't spend Meta's rate limit. Both ranges are read at once, within one deadline that
   * fits the request's time.
   */
  app.get("/workspaces/:ws/stores/:storeId/ads/meta/report", async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "marketing.campaigns");
    await storeInWorkspace(ws, storeId);
    // Meta keeps 37 months of insights; a year at a time is what the dashboard asks for.
    const q = z.object({ level: z.enum(META_REPORT_VIEWS).default("campaign") }).and(reportDates).parse(c.req.query());
    const conn = await withTenant(ws, (tx) => tx.adConnection.findFirst({ where: { id: q.connection, workspaceId: ws, storeId, provider: "meta" } }));
    if (!conn) throw new HttpError(404, "Not found", "not_found");
    if (conn.status === "reconnect") throw new HttpError(409, ACCESS_ENDED.meta, "reconnect");
    const account = { id: conn.id, accountId: conn.accountId, name: conn.accountName, currency: conn.currency, timezone: conn.timezone };
    const today = adToday(conn);
    const deadline = Date.now() + META_REPORT_JOB.budgetMs;
    // Days that are over change little (Meta still revises purchases for a while); today's keep coming in.
    const { reports, cached } = await readRanges<MetaReport>(
      deps,
      rangesOf(q),
      today,
      (r) => `ads-report:${conn.id}:${q.level}:${r.from}:${r.to}`,
      (r) => metaReportForConnection(conn, q.level, r.from, r.to, deps.fetchImpl, { deadline }),
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
   * allowance of Google Ads API operations like the syncs.
   */
  app.get("/workspaces/:ws/stores/:storeId/ads/google/report", async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "marketing.campaigns");
    await storeInWorkspace(ws, storeId);
    const q = z.object({ level: z.enum(GOOGLE_REPORT_LEVELS).default("campaign") }).and(reportDates).parse(c.req.query());
    const conn = await withTenant(ws, (tx) => tx.adConnection.findFirst({ where: { id: q.connection, workspaceId: ws, storeId, provider: "google" } }));
    if (!conn) throw new HttpError(404, "Not found", "not_found");
    if (conn.status === "reconnect") throw new HttpError(409, ACCESS_ENDED.google, "reconnect");
    const account = { id: conn.id, accountId: conn.accountId, name: conn.accountName, currency: conn.currency, timezone: conn.timezone };
    const today = adToday(conn);
    // Google finishes most of a day's numbers within about three hours, and still revises conversions after.
    const { reports, cached } = await readRanges<GoogleReport>(
      deps,
      rangesOf(q),
      today,
      (r) => `ads-greport:${conn.id}:${q.level}:${r.from}:${r.to}`,
      (r) => googleReportForConnection(conn, q.level, r.from, r.to, deps.fetchImpl, { coord: deps.coord }),
      `rl:ads-report:${storeId}:${access.user?.id ?? clientIp(c)}`,
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
      (r) => adsenseReportForConnection(conn, q.level, r.from, r.to, deps.fetchImpl),
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
   * `queued`: the accounts sent off; one already on its way isn't sent again.
   */
  app.post("/workspaces/:ws/stores/:storeId/ads/sync", async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "integrations.manage");
    const { provider } = z.object({ provider: providerSchema.optional() }).parse(await body(c));
    await limit(deps.coord, `rl:ads-sync:${storeId}:${access.user?.id ?? clientIp(c)}`, LIMITS.adsSync);
    await storeInWorkspace(ws, storeId);
    const conns = await withTenant(ws, (tx) =>
      tx.adConnection.findMany({ where: { workspaceId: ws, storeId, enabled: true, status: { not: "reconnect" }, accessTokenEnc: { not: "" }, ...(provider ? { provider } : {}) } }),
    );
    let queued = 0;
    for (const conn of conns) {
      if (conn.status === "permission" || conn.status === "unavailable") {
        await enqueueAdSync(deps.queues, conn, 1, { healthOnly: true, interactive: true });
        queued++;
      } else if (await enqueueAdCatchUp(deps.queues, conn, { interactive: true })) {
        queued++;
      }
    }
    return c.json({ queued });
  });
}
