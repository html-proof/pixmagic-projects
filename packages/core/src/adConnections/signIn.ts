/**
 * bizinsights' own sign-in with the ad platforms: "Continue with Meta Ads" (Facebook Login for Business,
 * ads_read), "Continue with Google Ads" and "Continue with Google AdSense" (Google OAuth with PKCE, the
 * read-only reporting scope and openid). The routes are apps/api/src/routes/ads.ts; this is the part a
 * route shouldn't hold: the single-use state, the consent screen's address, the code exchange, and
 * reading what the sign-in can connect.
 *
 * The round trip mirrors the Shopify connect: the state (bound to the person, workspace, store and
 * platform, and for Google the PKCE verifier) lives in the coordinator for 10 minutes and is used up by
 * the callback, which also checks the browser holds it (a cookie) and that the person signed in is the
 * one who started it. Tokens never reach the browser: they are sealed on the connection rows
 * (credentials.ts), or in the coordinator while the person picks accounts (connect.ts).
 */
import { pkcePair, type AdLoginReason, type AdProvider } from "@app/shared";
import {
  adsenseAccounts,
  adsenseAuthorizeUrl,
  AdsApiError,
  AdsNoAccountsError,
  AdsRateLimitedError,
  AdsRetryableError,
  googleAdAccounts,
  googleAuthorizeUrl,
  googleExchangeCode,
  googleUserId,
  metaAdAccounts,
  metaAuthorizeUrl,
  metaExchangeCode,
  metaGrantedPermissions,
  metaUserId,
  REQUIRED_AD_SCOPE,
  type AdAccountList,
  type TokenSet,
} from "../ads.js";
import type { Coord } from "../coord.js";
import { logger } from "../logger.js";
import type { FetchLike } from "../shopify.js";
import { countGoogleAdsOperations, countingGoogleAdsFetch, pauseGoogleAds } from "./budget.js";
import { adsenseConfig, adsRedirectUri, googleClient, googleConfig, metaConfig } from "./config.js";
import { holdsReusableRefreshToken, reusableRefreshToken } from "./connect.js";
import { loginReasonOf } from "./logins.js";

/** How long a started sign-in waits for the platform to send the person back. */
export const AD_SIGN_IN_TTL_S = 600;

/** What a started sign-in remembers, server side, until its callback uses it up. */
export interface AdSignInState {
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

const stateKey = (nonce: string) => `oauth:ads:${nonce}`;

/**
 * Start a sign-in: the state under `nonce` (the browser keeps the nonce in a cookie and the platform
 * sends it back as `state`), and the consent screen to send the browser to. Null when the platform's
 * keys aren't set on this server. `consent`: Google's consent screen whatever the person gave before
 * (the second try of a sign-in that skipped it and came back without a refresh token).
 */
export async function startAdSignIn(
  coord: Coord,
  nonce: string,
  input: Pick<AdSignInState, "userId" | "workspaceId" | "storeId" | "provider">,
  opts: { consent?: boolean } = {},
): Promise<string | null> {
  const { provider } = input;
  const redirectUri = adsRedirectUri(provider);
  if (provider === "meta") {
    const meta = metaConfig();
    if (!meta) return null;
    await coord.put(stateKey(nonce), JSON.stringify({ ...input } satisfies AdSignInState), AD_SIGN_IN_TTL_S);
    return metaAuthorizeUrl(meta, redirectUri, nonce);
  }
  const cfg = provider === "google" ? googleConfig() : adsenseConfig();
  if (!cfg) return null;
  // Google takes PKCE on top of the client secret: a code intercepted on its way back is useless without the verifier.
  const pkce = pkcePair();
  // Google's consent screen only for someone without a working refresh token from it yet: each consent
  // hands out another, and Google ends a login's oldest past 100 (see holdsReusableRefreshToken).
  const consent = opts.consent ?? !(await holdsReusableRefreshToken(provider, input.userId));
  const state: AdSignInState = { ...input, codeVerifier: pkce.verifier, ...(consent ? {} : { consent: false }) };
  await coord.put(stateKey(nonce), JSON.stringify(state), AD_SIGN_IN_TTL_S);
  return provider === "google"
    ? googleAuthorizeUrl(googleConfig()!, redirectUri, nonce, pkce.challenge, { forceConsent: consent })
    : adsenseAuthorizeUrl(cfg, redirectUri, nonce, pkce.challenge, { forceConsent: consent });
}

/** Use a started sign-in up: its callback is answered once. */
export async function takeAdSignInState(coord: Coord, nonce: string): Promise<AdSignInState | null> {
  const raw = await coord.take(stateKey(nonce));
  return raw ? (JSON.parse(raw) as AdSignInState) : null;
}

/**
 * What a sign-in has given so far, filled in as it is read (readAdSignIn), so a caller whose sign-in
 * ends without a connection can still give its grant back (dropUnusedGrant).
 */
export interface AdSignInProgress {
  tokens?: TokenSet;
  /** Who signed in (Meta's app-scoped id, Google's `sub`), when the platform said. */
  externalUserId: string | null;
  /** The refresh token is one this person gave before (Google sent none): never revoked on their behalf. */
  reusedRefreshToken: boolean;
}

/** The person unticked the one permission on the platform's screen: nothing can be read. */
export class AdPermissionMissingError extends Error {}

/** Google sent no refresh token, and bizinsights holds none for that login: it has to ask again, with its consent screen. */
export class AdConsentNeededError extends Error {}

/** Google sent no refresh token even with its consent screen: nothing would keep working past the hour. */
export class AdNoRefreshTokenError extends Error {}

/**
 * The person signed in and granted the permission, but the login lists no ad account yet (Meta: none of
 * its own, none it is assigned to, none ticked on Facebook's screen), or the platform didn't list them in
 * time. Nothing is wrong with the sign-in: it can stay connected and wait for its accounts (logins.ts).
 */
export class AdLoginWaitingError extends Error {
  constructor(
    public reason: AdLoginReason,
    /** The name the platform's sign-in went by, when the platform said. */
    public loginName: string | null,
    cause: unknown,
  ) {
    super(`The login reaches no ad account yet (${reason})`, { cause });
  }
}

/** Who a fresh token belongs to, for knowing later whether anything else relies on the grant. Never blocks a connect. */
const whoIs = (provider: AdProvider, p: Promise<string | null>) =>
  p.catch((err: unknown) => {
    logger.warn({ err, provider }, "ad platform user id lookup failed");
    return null;
  });

/**
 * Read the sign-in the platform sent back: the code becomes the tokens (Meta's long-lived user token;
 * Google's access and refresh tokens), the permission must have been granted, who signed in is looked
 * up, and the accounts the login can see are listed. Google Ads' listing is counted against bizinsights'
 * daily operations, as a sync's is. `progress` is filled in along the way.
 *
 * Throws AdPermissionMissingError, AdConsentNeededError, AdNoRefreshTokenError, AdLoginWaitingError (Meta
 * only) or the platform's own errors (connectFailure in the route words them).
 */
export async function readAdSignIn(
  state: AdSignInState,
  code: string,
  progress: AdSignInProgress,
  deps: { coord: Coord; fetchImpl?: FetchLike },
): Promise<AdAccountList> {
  const { provider } = state;
  const redirectUri = adsRedirectUri(provider);
  if (provider === "meta") {
    const cfg = metaConfig(deps.fetchImpl);
    if (!cfg) throw new AdsApiError("Meta isn't set up on this server", 503, undefined, "not_configured");
    const tokens = await metaExchangeCode(cfg, code, redirectUri);
    progress.tokens = tokens;
    // A Login for Business system-user token may not answer /me/permissions; then the account list is the test.
    tokens.grantedScopes = await metaGrantedPermissions(cfg, tokens.accessToken).catch((err: unknown) => {
      if (err instanceof AdsApiError) return undefined;
      throw err;
    });
    progress.externalUserId = await whoIs(provider, metaUserId(cfg, tokens.accessToken));
    if (tokens.grantedScopes && !tokens.grantedScopes.includes(REQUIRED_AD_SCOPE.meta)) throw new AdPermissionMissingError("ads_read was not granted");
    try {
      return await metaAdAccounts(cfg, tokens.accessToken);
    } catch (err) {
      // Signed in and granted: nothing to list yet, or Meta didn't list in time. The login can still stay connected.
      if (err instanceof AdsNoAccountsError) throw new AdLoginWaitingError(loginReasonOf(err), err.loginName ?? null, err);
      if (err instanceof AdsRetryableError) throw new AdLoginWaitingError("unanswered", null, err);
      throw err;
    }
  }
  // Google Ads accounts already connected keep working with new connections switched off (googleClient),
  // so a sign-in started before the switch can still finish.
  const cfg = provider === "google" ? googleClient(deps.fetchImpl) : adsenseConfig(deps.fetchImpl);
  if (!cfg) throw new AdsApiError(`${provider === "adsense" ? "Google AdSense" : "Google Ads"} isn't set up on this server`, 503, undefined, "not_configured");
  const tokens = await googleExchangeCode(cfg, code, redirectUri, state.codeVerifier);
  progress.tokens = tokens;
  progress.externalUserId = await whoIs(provider, googleUserId(cfg, tokens.accessToken));
  // With granular consent the person can untick the one permission on Google's screen.
  if (tokens.grantedScopes && !tokens.grantedScopes.includes(REQUIRED_AD_SCOPE[provider])) throw new AdPermissionMissingError(`${REQUIRED_AD_SCOPE[provider]} was not granted`);
  // Google sends a refresh token on consent; a person who gave one before keeps using theirs.
  if (!tokens.refreshToken) {
    tokens.refreshToken = await reusableRefreshToken(provider, progress.externalUserId);
    progress.reusedRefreshToken = !!tokens.refreshToken;
  }
  if (!tokens.refreshToken) throw state.consent === false ? new AdConsentNeededError("Google sent no refresh token") : new AdNoRefreshTokenError("Google sent no refresh token");
  if (provider === "adsense") return adsenseAccounts(cfg, tokens.accessToken);
  const counter = countingGoogleAdsFetch(deps.fetchImpl);
  try {
    return await googleAdAccounts({ ...googleClient(deps.fetchImpl)!, fetchImpl: counter.fetchImpl }, tokens.accessToken);
  } catch (err) {
    if (err instanceof AdsRateLimitedError && err.errorCode === "quota_exhausted") await pauseGoogleAds(deps.coord, err.retryAfterS).catch(() => undefined);
    throw err;
  } finally {
    await countGoogleAdsOperations(deps.coord, counter.operations());
  }
}
