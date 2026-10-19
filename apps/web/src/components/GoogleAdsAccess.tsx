/**
 * Google's "Google hasn't verified this app" screen, explained on bizinsights' side. Google shows it
 * before its consent screen while it hasn't verified bizinsights' use of the Google Ads permission
 * (adwords, a sensitive scope); the API says so as `restricted.google` (GOOGLE_ADS_OAUTH_VERIFIED
 * unset). A merchant who meets it unwarned takes it for phishing. Google AdSense asks only for
 * adsense.readonly, which Google doesn't count as sensitive, so it never shows this screen.
 * https://support.google.com/cloud/answer/7454865
 *
 * The way on is "Advanced", then a link that reads "Go to <name> (unsafe)". Google's help pages don't
 * spell that link out; "(unsafe)" is how it appears for unverified apps, and <name> is the app name or
 * bizinsights.io until Google has verified the branding (docs/ads-review-packs.md). The note names the
 * word "unsafe" up front: told only "Go to bizinsights", a merchant who then sees it stops there.
 */

/** On the Google Ads card, before anyone is sent to Google. `brief`: one line, for a card with accounts already connected. */
export function GoogleUnverified({ brief = false }: { brief?: boolean }) {
  if (brief) {
    return (
      <p className="text-xs text-muted" data-testid="google-unverified">
        Google first shows &ldquo;Google hasn&apos;t verified this app&rdquo; while it checks bizinsights: choose <strong>Advanced</strong>, then{" "}
        <strong>Go to bizinsights.io (unsafe)</strong>. That&apos;s Google&apos;s usual label for an app it hasn&apos;t finished checking.
      </p>
    );
  }
  return (
    <p className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted" data-testid="google-unverified">
      <strong className="text-text">Google is still verifying bizinsights.</strong> Until it&apos;s done, Google shows a &ldquo;Google hasn&apos;t verified this app&rdquo; screen
      before asking you to allow access. To go on, choose <strong>Advanced</strong>, then <strong>Go to bizinsights.io (unsafe)</strong> (it may say bizinsights instead of
      the address), and allow access on the next screen. &ldquo;Unsafe&rdquo; is Google&apos;s usual label there for an app it hasn&apos;t finished checking. bizinsights only
      reads your reports: it can&apos;t create, change or pause ads, or spend money. Google AdSense doesn&apos;t show this screen.
    </p>
  );
}
