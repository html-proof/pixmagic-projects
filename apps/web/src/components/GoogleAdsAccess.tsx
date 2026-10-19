/**
 * Google's "Google hasn't verified this app" screen, explained on bizinsights' side. Google shows it
 * before its consent screen while it hasn't verified bizinsights' use of the Google Ads permission
 * (adwords, a sensitive scope); the API says so as `restricted.google` (GOOGLE_ADS_OAUTH_VERIFIED
 * unset). A merchant who meets it unwarned takes it for phishing. Google AdSense asks only for
 * adsense.readonly, which Google doesn't count as sensitive, so it never shows this screen.
 * https://support.google.com/cloud/answer/7454865
 */

/** On the Google Ads card, before anyone is sent to Google. `brief`: one line, for a card with accounts already connected. */
export function GoogleUnverified({ brief = false }: { brief?: boolean }) {
  if (brief) {
    return (
      <p className="text-xs text-muted" data-testid="google-unverified">
        Google first shows &ldquo;Google hasn&apos;t verified this app&rdquo; while it checks bizinsights: choose <strong>Advanced</strong>, then <strong>Go to bizinsights</strong>.
      </p>
    );
  }
  return (
    <p className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted" data-testid="google-unverified">
      <strong className="text-text">Google is still verifying bizinsights.</strong> Until it&apos;s done, Google shows a &ldquo;Google hasn&apos;t verified this app&rdquo; screen
      before asking you to allow access. To go on, choose <strong>Advanced</strong>, then <strong>Go to bizinsights</strong>, and allow access on the next screen. bizinsights
      only reads your reports: it can&apos;t create, change or pause ads, or spend money. Google AdSense doesn&apos;t show this screen.
    </p>
  );
}
