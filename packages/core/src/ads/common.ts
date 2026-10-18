/**
 * What the three ad platform clients share: the errors every caller sorts failures by, an ad
 * account as a person picks it, a token set, and the one permission each platform is asked for.
 */
/** The person's access was refused or has expired: they have to connect again. */
export class AdsAuthError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** The platform said no for a reason that a retry may fix (rate limits, outages). */
export class AdsRetryableError extends Error {
  constructor(
    message: string,
    /** The platform's own error code, when it gives one (Meta's `error.code`). */
    public code?: number,
  ) {
    super(message);
  }
}

/** Anything else the platform rejected (a bad request, an account we can't read). */
export class AdsApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** The platform's own error code, when it gives one (Meta's `error.code`). */
    public code?: number,
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
    super(message, 403);
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
