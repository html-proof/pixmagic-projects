import type { AdProvider } from "@/lib/adConnections";

/**
 * What the platforms' callback means when it sends the browser back to Settings → Advertising with
 * `?error=<code>&provider=` (apps/api/src/routes/ads.ts). `<code>_<provider>` wins over `<code>`.
 */
const ERRORS: Record<string, string> = {
  denied: "You chose not to give bizinsights access, so nothing was connected.",
  state_mismatch: "That sign-in started in another browser or tab. Please press the button again here.",
  state_expired: "That took a little too long. Please press the button again.",
  session_mismatch: "You were signed in as someone else when you came back. Sign in as yourself and try again.",
  not_allowed: "You no longer have permission to connect ad accounts to this store. Ask an owner or admin.",
  exchange_failed: "The platform didn't accept the sign-in. Please try again in a moment.",
  no_accounts: "That login can't see any ad accounts. Ask the account's owner to give you access, then connect again.",
  no_accounts_meta:
    "That Facebook login can't reach any ad account, so nothing was connected. If your ads run in a business portfolio, assign this login to the ad account in Meta Business settings → Ad accounts (admins have to assign themselves too). If your ads are on another Facebook login, log out of Facebook in this browser first. No ad account yet? Create one in Meta Ads Manager. Then press Continue with Meta Ads again.",
  no_accounts_adsense: "That Google login has no AdSense account. Choose the Google account that owns your AdSense, or ask its owner to add this login as a user.",
  no_accounts_google:
    "That Google login has no Google Ads account, so nothing was connected. Choose the Google account you use at ads.google.com, or ask the Google Ads account's owner to add this login as a user. No Google Ads account yet? Create one at ads.google.com first.",
  none_shared: "No account was shared with bizinsights on the platform's screen, so nothing was connected. Press the button again and choose the accounts to share.",
  none_shared_meta:
    "No ad account was shared with bizinsights on Facebook's screen, so nothing was connected. Press Continue with Meta Ads again, choose to edit what bizinsights can access, and tick the ad accounts this store's ads run from.",
  manager_only: "That login only reaches a manager account with no ad account under it. Choose the login that runs your ads, then connect again.",
  manager_only_google:
    "That Google login only reaches a Google Ads manager account with no active ad account under it. Choose the Google account that runs your ads, or create or link an ad account in the manager account, then connect again.",
  account_not_ready: "The platform won't report on the account that login reaches yet: its set-up isn't finished, or it's closed. Finish it there, or choose another login.",
  account_not_ready_google:
    "Google Ads won't report on the account that login reaches yet: its setup at ads.google.com isn't finished, or it's cancelled or suspended. Finish setting it up there, or choose another Google account.",
  account_not_ready_adsense: "AdSense won't report on that account yet: its sign-up isn't finished or Google is still reviewing it. Finish it at adsense.google.com, then connect again.",
  no_refresh_token: "Google didn't grant lasting access. Please try again and allow access on Google's screen.",
  permission_missing: "The permission to read reports wasn't granted, so nothing could be connected. Press the button again and leave it ticked.",
  permission_missing_meta: "Meta's permission to read your ad reports (ads_read) wasn't granted, so nothing was connected. Press Continue with Meta Ads again and allow it.",
  missing_params: "The platform didn't send everything back. Please try again.",
  temporarily_unavailable: "The platform was slow to answer, or something went wrong on our side. Nothing was connected; please try again in a minute.",
  not_approved: "The platform is still approving bizinsights for this, so nothing was connected. It's on our side, not yours: please try again in a day or two.",
  not_approved_google:
    "Google is still approving bizinsights for live Google Ads accounts, so nothing was connected. This is on our side, not yours; please try again in a day or two.",
  not_approved_meta: "Meta is still reviewing bizinsights for this, so nothing was connected. This is on our side, not yours; please try again later.",
  not_configured: "This platform isn't switched on for bizinsights yet, so nothing was connected. It's on our side: please try again later.",
  rate_limited: "You started connecting several times in the last few minutes. Wait a few minutes, then press the button again.",
};

/** Only the wording above: the code comes from the address bar ("constructor" is not a message). */
const said = (key: string) => (Object.hasOwn(ERRORS, key) ? ERRORS[key] : undefined);

export function callbackErrorMessage(code: string, provider: string | null): string {
  return (provider ? said(`${code}_${provider}`) : undefined) ?? said(code) ?? "Connecting didn't work. Please try again.";
}

/**
 * Errors that mean "that login reaches nothing yet": fixed on the platform's side or with another login,
 * then a retry. Google shows its account chooser again; Facebook shows its screen again.
 */
export const WRONG_LOGIN: ReadonlySet<string> = new Set(["no_accounts", "manager_only", "account_not_ready", "none_shared"]);

export const isAdProvider = (p: string | null): p is AdProvider => p === "google" || p === "meta" || p === "adsense";
