import Link from "next/link";

/** Each ad platform, the one permission bizinsights asks it for, and what that permission is used for. */
const PLATFORMS = [
  {
    name: "Google Ads",
    scope: "adwords",
    text: (
      <>
        Google asks you to allow bizinsights to &ldquo;See, edit, create, and delete your Google Ads accounts and data&rdquo;. Google
        offers no read-only permission for the Google Ads API, and bizinsights uses this one only to read reports: account names and
        IDs, currency and time zone; campaign and ad group names, status, type and budget; and daily spend, impressions, clicks,
        conversions and conversion value by device and country.
      </>
    ),
  },
  {
    name: "Google AdSense",
    scope: "adsense.readonly",
    text: <>Read-only access (&ldquo;View your AdSense data&rdquo;), to show your site&rsquo;s estimated earnings, page views, ads shown and clicks.</>,
  },
  {
    name: "Meta Ads",
    scope: "ads_read",
    text: <>Read-only access to the ad accounts you choose, to show their spend, impressions, reach, clicks and the purchases Meta attributes to your ads.</>,
  },
] as const;

const LINK = "lp-focus rounded text-lp-text underline decoration-lp-line-strong underline-offset-4 transition-colors hover:decoration-lp-violet-bright";

/**
 * What bizinsights does with the ad accounts a merchant may connect, in plain words on the homepage
 * itself: Google's OAuth verification checks that the homepage explains why the app asks for Google
 * Ads (`adwords`) and AdSense access, and links the privacy policy. Static text, no motion and no
 * deferral, so it is in the page's HTML as served; the `google-data` id is what the verification
 * form links to (docs/ads-review-packs.md). It says the same as "Advertising accounts" and "Google
 * user data" on /privacy, and names each permission the ads clients ask for
 * (packages/core/test/appConfig.test.ts checks that).
 */
export function AdPlatforms() {
  return (
    <section id="google-data" aria-labelledby="google-data-title" className="scroll-mt-24 bg-lp-bg">
      <div className="mx-auto grid max-w-[1380px] gap-10 px-4 py-24 md:px-8 md:py-32 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16 xl:px-12">
        <div>
          <p className="lp-eyebrow mb-5">Optional · Your ad accounts</p>
          <h2 id="google-data-title" className="lp-title text-balance text-lp-text">
            Google Ads, Google AdSense and Meta Ads
          </h2>
          <p className="mt-6 text-pretty text-[16px] leading-relaxed text-lp-text-2 md:text-[17px]">
            If you choose to, bizinsights shows your advertising next to your Shopify sales. It connects to an ad account only when you
            press that platform&rsquo;s Continue button in Settings, and it only reads: it never creates, changes or pauses an ad, never
            changes a budget or billing, and never spends money.
          </p>
          <p className="mt-4 text-pretty text-[15px] leading-relaxed text-lp-text-2">
            You can disconnect an account at any time in Settings: bizinsights deletes its access token and every figure it fetched.
          </p>
          <p className="mt-4 text-pretty text-[15px] leading-relaxed text-lp-text-2">
            bizinsights&rsquo; use and transfer to any other app of information received from Google APIs will adhere to the{" "}
            <a href="https://developers.google.com/terms/api-services-user-data-policy" className={LINK}>
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements. More in our{" "}
            <Link href="/privacy#google-user-data" className={LINK}>
              Privacy Policy
            </Link>{" "}
            and{" "}
            <Link href="/terms" className={LINK}>
              Terms of Service
            </Link>
            .
          </p>
        </div>

        <ul className="grid gap-4 self-start">
          {PLATFORMS.map((p) => (
            <li key={p.name} className="rounded-[22px] border border-lp-line bg-gradient-to-b from-lp-surface/80 to-lp-elevated/80 p-5 md:p-6">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
                <h3 className="text-[16.5px] font-medium tracking-[-0.01em] text-lp-text">{p.name}</h3>
                <p className="text-[13px] text-lp-muted">
                  Permission <code className="font-lp-mono rounded-md border border-lp-line-strong bg-lp-bg-2 px-1.5 py-0.5 text-[12.5px] text-lp-text-2">{p.scope}</code>
                </p>
              </div>
              <p className="mt-3 text-[15px] leading-relaxed text-lp-text-2">{p.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
