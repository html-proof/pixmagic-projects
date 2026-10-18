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

/** Anything else the platform rejected (a bad request, an account we can't read). */
export class AdsApiError extends Error {
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
