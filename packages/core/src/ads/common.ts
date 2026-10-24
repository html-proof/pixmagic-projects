/**
 * What the three ad platform clients share: the errors every caller sorts failures by, an ad
 * account as a person picks it, a token set, and the one permission each platform is asked for.
 *
 * Every error carries an `errorCode` (AD_ERROR_CODES in @app/shared/ads): what the connection's
 * error_code becomes, and so what the merchant reads. classifyAdError() turns any failure into the
 * status, code and cleaned detail a connection stores.
 */
import { AD_ERROR_STATUS, type AdAccountStatus, type AdConnectionStatus, type AdErrorCode } from "@app/shared";
import { providerDetail } from "../errors.js";

/** The person's access was refused or has expired: they have to connect again. */
export class AdsAuthError extends Error {
  /** The platform's own name for the error, for the logs (Google's "authenticationError.OAUTH_TOKEN_REVOKED"). */
  declare providerCode?: string;
  constructor(
    message: string,
    /** "auth_expired" (expired, revoked) or "scope_missing" (the reporting permission was taken back). */
    public errorCode: Extract<AdErrorCode, "auth_expired" | "scope_missing"> = "auth_expired",
  ) {
    super(message);
  }
}

/** The platform said no for a reason that a retry may fix (rate limits, outages). */
export class AdsRetryableError extends Error {
  /** The platform's own name for the error, for the logs (Google's "quotaError.RESOURCE_EXHAUSTED"). */
  declare providerCode?: string;
  constructor(
    message: string,
    /** The platform's own error code, when it gives one (Meta's `error.code`). */
    public code?: number,
    public errorCode: Extract<AdErrorCode, "temporary" | "rate_limited" | "quota_exhausted"> = "temporary",
  ) {
    super(message);
  }
}

/**
 * The platform asked bizinsights to wait (Meta's throttling, Google's RESOURCE_EXHAUSTED). `retryAfterS`
 * is how long the platform said to wait, when it said; the queue waits that long without spending a
 * retry. "quota_exhausted": bizinsights' daily allowance is used up (Google Ads API operations).
 */
export class AdsRateLimitedError extends AdsRetryableError {
  constructor(
    message: string,
    public retryAfterS: number | null = null,
    errorCode: Extract<AdErrorCode, "rate_limited" | "quota_exhausted"> = "rate_limited",
    code?: number,
  ) {
    super(message, code, errorCode);
  }
}

/**
 * A live report too big to answer within one request: the platform is still preparing it (Meta's
 * asynchronous report job). Asking again in a minute or two may find it done; nothing is wrong.
 */
export class AdsReportPendingError extends AdsRetryableError {
  constructor(message: string) {
    super(message, undefined, "temporary");
  }
}

/** Anything else the platform rejected (a bad request, an account we can't read). */
export class AdsApiError extends Error {
  /** The platform's own name for the error, for the logs (Google's "authorizationError.USER_PERMISSION_DENIED"). */
  declare providerCode?: string;
  constructor(
    message: string,
    public status: number,
    /** The platform's own error code, when it gives one (Meta's `error.code`). */
    public code?: number,
    public errorCode: AdErrorCode = "provider_error",
  ) {
    super(message);
  }
}

/**
 * Google hasn't approved bizinsights' Cloud project for real (production) Google Ads accounts yet: it has
 * Test access only. Nothing the merchant does fixes it, so it's never mistaken for "no accounts".
 */
export class AdsNotApprovedError extends AdsApiError {
  constructor(message: string) {
    super(message, 403, undefined, "not_approved");
  }
}

/**
 * This login can no longer read this one account (Google USER_PERMISSION_DENIED, a Meta permission
 * error while ads_read is still granted, AdSense PERMISSION_DENIED on the account). Reconnecting with
 * the same login doesn't help; a login that has access does.
 */
export class AdsPermissionError extends AdsApiError {
  constructor(message: string, code?: number) {
    super(message, 403, code, "no_access");
  }
}

/** The platform won't report on this account: closed or cancelled, disabled or suspended, or its set-up isn't finished. */
export class AdsUnavailableError extends AdsApiError {
  constructor(
    message: string,
    errorCode: Extract<AdErrorCode, "account_closed" | "account_disabled" | "account_not_ready">,
    code?: number,
  ) {
    super(message, 403, code, errorCode);
  }
}

/**
 * Why a login gives nothing to connect: it reaches no ad account at all (Google's NOT_ADS_USER, or an
 * empty list), Google only: it reaches only manager accounts with no active ad account under them, or
 * the accounts it reaches can't be reported on (sign-up not finished, cancelled, suspended); Meta only:
 * the person picked which ad accounts to share on Facebook's screen and none of them came through.
 */
export type NoAdAccountsReason = "no_ads_account" | "manager_only" | "not_ready" | "none_shared";

/** The login has no ad account bizinsights can report on; `reason` says which case it is. */
export class AdsNoAccountsError extends AdsApiError {
  constructor(
    message: string,
    public reason: NoAdAccountsReason = "no_ads_account",
    /** What the platform said about the login, for the log: ids, counts, permission names and its error codes only. */
    public diagnosis?: Record<string, unknown>,
    /** The name the login goes by at the platform, for the person who just signed in with it: never logged. */
    public loginName?: string | null,
  ) {
    super(message, 403);
  }
}

/** Meta's "permission" errors: 10 and 200-299. Either the app lost ads_read, or this login lost the account. */
export const isMetaPermissionError = (err: unknown) => err instanceof AdsApiError && err.code !== undefined && (err.code === 10 || (err.code >= 200 && err.code <= 299));

export interface AdAccount {
  accountId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  /** Google: the manager account the client is reached through (sent as login-customer-id). */
  loginCustomerId?: string | null;
  /** The account's own health at the platform, when the listing says (Meta account_status, AdSense state). */
  status?: AdAccountStatus | null;
  /** What the platform says about that status (Meta's disable reason, AdSense's pending tasks). */
  statusDetail?: string | null;
}

/**
 * The ad accounts a sign-in can see. `truncated`: the login reaches more than could be listed (an
 * agency login with thousands), so the picker can say the list was cut rather than look complete.
 */
export type AdAccountList = AdAccount[] & { truncated?: boolean };

export const adAccountList = (accounts: AdAccount[], truncated: boolean): AdAccountList => Object.assign(accounts, truncated ? { truncated: true } : {});

/**
 * How much of an account list one sign-in carries. The list is read inside the OAuth callback, then
 * waits in the coordinator while the person picks: one DynamoDB item, which holds 400 KB with the
 * tokens and everything else, so the accounts get 300 KB of it.
 */
export const AD_ACCOUNT_LIST_MAX_BYTES = 300_000;

/**
 * How long a sign-in spends listing accounts beyond the first answer: the callback runs in the API,
 * which has 55 seconds for the whole request and other calls to make.
 */
export const AD_DISCOVERY_BUDGET_MS = 20_000;

const utf8 = new TextEncoder();

/** The accounts, in order, that fit in `maxBytes` as JSON; marked `truncated` when some didn't (or `truncated` already). */
export function adAccountListWithin(accounts: AdAccount[], truncated: boolean, maxBytes = AD_ACCOUNT_LIST_MAX_BYTES): AdAccountList {
  // "[" and "]", then each account and its comma.
  let bytes = 2;
  let fit = 0;
  for (const a of accounts) {
    bytes += utf8.encode(JSON.stringify(a)).length + 1;
    if (bytes > maxBytes) break;
    fit++;
  }
  return adAccountList(fit < accounts.length ? accounts.slice(0, fit) : accounts, truncated || fit < accounts.length);
}

/** An ad account's health as the platform reports it now (metaAccountHealth, adsenseAccountHealth). */
export interface AdAccountHealth {
  status: AdAccountStatus | null;
  detail: string | null;
  name: string | null;
  currency: string | null;
  timezone: string | null;
}

/** What a failed sync or report leaves on its connection. */
export interface AdFailure {
  status: AdConnectionStatus;
  code: AdErrorCode;
  /** The platform's own reason, cleaned (providerDetail): for the logs and support. Null for our own errors. */
  detail: string | null;
  /** A later attempt may work (the queue retries it). */
  retryable: boolean;
  /** How long the platform asked to wait, when it said. */
  retryAfterS: number | null;
}

/**
 * Sort any failure into what its connection stores. Errors that aren't the platform's (a TypeError, the
 * database) are "internal" and keep no detail: their text can carry internals.
 */
export function classifyAdError(err: unknown): AdFailure {
  const detail = (e: Error) => providerDetail(e.message) || null;
  if (err instanceof AdsAuthError) return { status: AD_ERROR_STATUS[err.errorCode], code: err.errorCode, detail: detail(err), retryable: false, retryAfterS: null };
  if (err instanceof AdsRateLimitedError) return { status: "error", code: err.errorCode, detail: detail(err), retryable: true, retryAfterS: err.retryAfterS };
  if (err instanceof AdsRetryableError) return { status: "error", code: err.errorCode, detail: detail(err), retryable: true, retryAfterS: null };
  if (err instanceof AdsApiError) {
    const code = err.errorCode;
    // Our own set-up (not approved, not configured) and the platform's other refusals are retried by the schedule, not at once.
    return { status: AD_ERROR_STATUS[code], code, detail: detail(err), retryable: false, retryAfterS: null };
  }
  return { status: "error", code: "internal", detail: null, retryable: true, retryAfterS: null };
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** When the access token stops working, if the platform says. */
  expiresAt: Date | null;
  /**
   * The permissions the person actually granted, when the platform says (Google lists them with
   * the token; Meta answers /me/permissions). People can untick a permission on the consent screen.
   */
  grantedScopes?: string[];
}

/** The one permission each platform needs. Nothing else is asked for. */
export const REQUIRED_AD_SCOPE = {
  meta: "ads_read",
  google: "https://www.googleapis.com/auth/adwords",
  adsense: "https://www.googleapis.com/auth/adsense.readonly",
} as const;

/** When a token stops working, from the `expires_in` seconds a token endpoint answers. */
export const tokenExpiry = (seconds: unknown) => (typeof seconds === "number" && seconds > 0 ? new Date(Date.now() + seconds * 1000) : null);

// ---------------------------------------------------------------------------
// Google's APIs (Google Ads, AdSense) answer errors the same way: google.rpc.Status as JSON, the
// real reason in error.details[] (https://cloud.google.com/apis/design/errors). The top-level
// message is often only the wrapper's ("The caller does not have permission").
// ---------------------------------------------------------------------------

/** One error of a Google Ads GoogleAdsFailure (error.details[].errors[]). */
export interface GoogleAdsFailureError {
  /** The errorCode oneof's field and value, e.g. "authorizationError.USER_PERMISSION_DENIED". */
  code: string | null;
  message: string | null;
  /** QuotaErrorDetails, on quota errors: ACCOUNT or DEVELOPER (the project's), the bucket's name, and how long to wait. */
  quota: { rateScope: string | null; rateName: string | null; retryDelayS: number | null } | null;
}

/** A Google API error, read for what sorts it. */
export interface GoogleApiError {
  httpStatus: number;
  /** The google.rpc.Code name: PERMISSION_DENIED, UNAUTHENTICATED, RESOURCE_EXHAUSTED... */
  status: string | null;
  message: string;
  /** google.rpc.ErrorInfo reasons: SERVICE_DISABLED, ACCESS_TOKEN_SCOPE_INSUFFICIENT... */
  reasons: string[];
  /** google.rpc.RetryInfo's retryDelay, in whole seconds. */
  retryAfterS: number | null;
  /** Google Ads only: the GoogleAdsFailure's errors, most specific first as Google lists them. */
  adsErrors: GoogleAdsFailureError[];
}

/** A protobuf Duration as JSON ("30s", "1.5s"; or {seconds, nanos}) → whole seconds, rounded up. */
export function durationSeconds(d: unknown): number | null {
  let s: number | null = null;
  if (typeof d === "string") {
    const m = /^(\d+(?:\.\d+)?)s$/.exec(d.trim());
    s = m ? Number(m[1]) : null;
  } else if (d && typeof d === "object") {
    const o = d as { seconds?: unknown; nanos?: unknown };
    s = Number(o.seconds ?? 0) + Number(o.nanos ?? 0) / 1e9;
  }
  return s !== null && Number.isFinite(s) && s > 0 ? Math.ceil(s) : null;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Read a Google API `error` object (whatever shape it came in) and its HTTP status. */
export function readGoogleError(error: unknown, httpStatus: number, fallback: string): GoogleApiError {
  const e = isObj(error) ? error : {};
  const details = Array.isArray(e.details) ? e.details.filter(isObj) : [];
  const adsErrors: GoogleAdsFailureError[] = [];
  const reasons: string[] = [];
  let retryAfterS: number | null = null;
  for (const d of details) {
    // GoogleAdsFailure: { "@type": "...errors.GoogleAdsFailure", errors: [{ errorCode: { authorizationError: "..." }, message, details }] }
    for (const g of Array.isArray(d.errors) ? d.errors.filter(isObj) : []) {
      const oneof = isObj(g.errorCode) ? Object.entries(g.errorCode).find(([, v]) => typeof v === "string") : undefined;
      const q = isObj(g.details) && isObj(g.details.quotaErrorDetails) ? g.details.quotaErrorDetails : null;
      adsErrors.push({
        code: oneof ? `${oneof[0]}.${String(oneof[1])}` : null,
        message: str(g.message),
        quota: q ? { rateScope: str(q.rateScope), rateName: str(q.rateName), retryDelayS: durationSeconds(q.retryDelay) } : null,
      });
    }
    // google.rpc.ErrorInfo { reason, domain, metadata } and google.rpc.RetryInfo { retryDelay }.
    const reason = str(d.reason);
    if (reason) reasons.push(reason);
    const delay = durationSeconds(d.retryDelay);
    if (delay !== null) retryAfterS = Math.max(retryAfterS ?? 0, delay);
  }
  return { httpStatus, status: str(e.status), message: str(e.message) ?? fallback, reasons, retryAfterS, adsErrors };
}

/** Google's own API isn't switched on for bizinsights' Cloud project: "<API> has not been used in project N before or it is disabled". */
const serviceDisabled = (g: GoogleApiError) =>
  g.reasons.includes("SERVICE_DISABLED") || g.reasons.includes("API_DISABLED") || (g.httpStatus === 403 && /has not been used in project|it is disabled/i.test(g.message));

/**
 * The two set-up failures every Google API names in an ErrorInfo: the API switched off on bizinsights'
 * Cloud project (ours to fix), and a token without the API's permission (the person unticked it, or it
 * was taken back: connecting again with it ticked fixes it). Null otherwise.
 */
export function googleSetupError(g: GoogleApiError, message: string): Error | null {
  if (serviceDisabled(g)) return new AdsApiError(message, g.httpStatus || 403, undefined, "not_configured");
  if (g.reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) return new AdsAuthError(message, "scope_missing");
  return null;
}

/**
 * The failures every Google API answers alike: the set-up ones above, ended access, throttling and
 * outages. Null for the rest, which each API sorts itself.
 */
export function googleCommonError(g: GoogleApiError, message: string): Error | null {
  const setup = googleSetupError(g, message);
  if (setup) return setup;
  if (g.httpStatus === 401 || g.status === "UNAUTHENTICATED") return new AdsAuthError(message);
  if (g.httpStatus === 429 || g.status === "RESOURCE_EXHAUSTED") return new AdsRateLimitedError(message, g.retryAfterS);
  if (g.httpStatus >= 500 || g.status === "UNAVAILABLE" || g.status === "INTERNAL" || g.status === "DEADLINE_EXCEEDED") return new AdsRetryableError(message);
  return null;
}
