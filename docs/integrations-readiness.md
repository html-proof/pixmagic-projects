# Integrations readiness: Google, Meta and AWS checklist

The owner's checklist for opening Google Ads, Google AdSense, Meta Ads and "Continue with Google" sign-in to every
merchant. Each line says where it stands, why, and what happens next and who does it.

Last updated 2026-10-19. Status words:

- **Completed**: done and confirmed.
- **Pending**: can be done now, or is waiting on a step that is under way.
- **Blocked**: can't start until another item is finished (named in the line).
- **Not applicable**: nothing to do.

"This branch" means `claude/google-meta-oauth-integrations-dec503` (the Google/Meta integrations work). Anything that
says "after this branch's deploy" can be done once that branch is merged to `main` and its **Deploy to AWS** run has
succeeded.

Steps marked **Owner** need your own Google, Meta, Cloudflare or AWS login. Claude must not sign in to those consoles,
submit forms there or upload business documents for you, and never automates developers.facebook.com.

The detail behind each line: [ads-setup.md](ads-setup.md) (how the integrations work and every setting),
[ads-review-packs.md](ads-review-packs.md) (paste-ready answers, video scripts, step lists),
[cognito-setup.md](cognito-setup.md) (sign-in), [aws-deployment.md](aws-deployment.md) (secrets and deploys).

## Google (Cloud project insights-511119, OAuth client "Insights web")

| Requirement | Status | Why | Next action (who) |
| --- | --- | --- | --- |
| Search Console **Domain** property for bizinsights.io | Completed | Verified 2026-10-19 with a DNS TXT record in Cloudflare. Google only accepts a Domain property as proof you own the domain. | Never delete that TXT record: Google keeps re-checking it. (Owner) |
| Authorized domain `bizinsights.io` on the consent screen | Completed (2026-10-19) | Saved on Branding next to the old `imeseban.workers.dev`, which stays while "Insights web" still lists the workers.dev redirect URIs. | Once the old Worker is retired: remove the workers.dev redirect URIs on the client, then the workers.dev domain on Branding, save. (Owner or Claude on your word) |
| Branding (app name, logo, homepage, privacy, terms, contacts) | Completed (2026-10-19) | Saved with a 120x120 logo, re-verified ("I have fixed the issues") and published the same day: "Your branding has been verified and is being shown to users." Name **bizinsights**, homepage https://bizinsights.io/, privacy /privacy, terms /terms. | None. Changing the name, logo or links later sends it back for verification. |
| Redirect URIs on "Insights web" | Completed (2026-10-19) | Both bizinsights.io callbacks added and saved (they were missing, so Connect from bizinsights.io failed with a redirect error). The two `insights.imeseban.workers.dev` callbacks are still listed; no JavaScript origins. | Remove the workers.dev pair when the old Worker is retired. (Owner or Claude on your word) |
| Scope list and justification | Completed | Checked 2026-10-19: Data Access lists exactly `adsense.readonly` (non-sensitive) and `adwords` (sensitive), with the justification. Audience: External, In production, 1 of 100 unverified-scope users used. | None until the demo video (next row). |
| `adwords` data-access verification | Pending | Branding is published (row above); still needs a demo video on YouTube (unlisted) and the justification in the Verification Center. Until it passes, Google Ads sign-ins show "Google hasn't verified this app" and new users count toward a lifetime cap of 100. | After branding is published: dry run, record the video (script in ads-review-packs.md), submit in Verification Center. (Owner, Claude can help with the dry run) |
| Google Ads API access level | Completed (Explorer) | Explorer granted to insights-511119 on 2026-10-11: real accounts, 2,880 operations a day, which the syncs budget for. Developer tokens were retired by Google on 2026-09-09, so there is no token to get. | None now. (Owner) |
| Google Ads API **Basic** access | Pending | Needs brand verification of the project (branding row above). Only needed past roughly 60 busy accounts. | After branding is verified: Google Ads API → Access levels → apply for Basic; then Claude sets `GOOGLE_ADS_DAILY_OPERATIONS` to the new figure. (Owner, then Claude) |
| AdSense Management API enabled | Completed | In use since 2026-10-10: AdSense connections sync in production. | None. |
| Publishing status "In production" | Completed | The consent screen is published (External), so anyone can sign in, not only test users. Re-check it shows "In production" before submitting. | Glance at Audience before submitting. (Owner) |
| Turn off the "unverified app" warning in bizinsights | Blocked | The Google Ads card warns merchants about Google's unverified-app screen while `GOOGLE_ADS_OAUTH_VERIFIED` is empty. | After Google approves `adwords`: Claude sets `GOOGLE_ADS_OAUTH_VERIFIED` to `"1"` in `apps/aws/src/settings.ts` and ships it through `main`. (Claude, on your word) |
| Homepage section on Google data (https://bizinsights.io/#google-data) | Pending | Written on this branch (`AdPlatforms.tsx`); it is live once this branch deploys. Documentation link 3 in the Google form points at it. | Approve the wording, merge, confirm the deploy; check the link opens the section. (Owner approves, Claude ships) |

### "Continue with Google" sign-in to bizinsights (separate from Google Ads)

| Requirement | Status | Why | Next action (who) |
| --- | --- | --- | --- |
| Sign in with Google in production | Completed (2026-10-19, release 75) | `/api/auth/config` answers `"google":true`; a real Continue with Google sign-in (sebanceo@gmail.com) reached the dashboard. The first deploy couldn't read the runtime settings, so api/jobs/cron were restarted by hand once (versions 76). | None. Google's screen names the amazoncognito.com domain; `auth.bizinsights.io` (row below) would show bizinsights.io instead. |
| A separate Cloud project for sign-in | Completed | Project `bizinsights-sign-in`: External, In production, scopes openid/email/profile only (no verification or user cap), authorized domains bizinsights.io and amazoncognito.com. | None. |
| Its OAuth client and redirect URI | Completed | Web client "bizinsights sign-in" `567753266621-ltq5j5kij5s3em8gr0err3tbrh5fqciq.apps.googleusercontent.com`, redirect `https://insights-605411278365.auth.ap-southeast-2.amazoncognito.com/oauth2/idpresponse`. | None. |
| Its secret in AWS | Completed | `GOOGLE_SIGNIN_CLIENT_SECRET` in `insights/production/app` (2026-10-19). | None. |
| GitHub variable | Completed | `GOOGLE_SIGNIN_CLIENT_ID` on the `production` environment. | None. |
| Own sign-in domain `auth.bizinsights.io` | Not applicable (optional) | Lets Google's screen show bizinsights.io instead of amazoncognito.com. Not required. | If wanted: cognito-setup.md section 7. (Owner, with Claude) |

## Meta (developer app "Insights", App ID 971575545351940)

| Requirement | Status | Why | Next action (who) |
| --- | --- | --- | --- |
| Developer app | Completed (Development mode) | Set up 2026-10-11: use case "Measure ad performance data with Marketing API", `ads_read` at Standard Access ("ready for testing"), Facebook Login for Business configuration 1521935306664882. In this state only people with a role on the app (admins, developers, testers) can connect; others see "Feature Unavailable". | Add anyone who must test under App roles → Testers. (Owner) |
| Business portfolio | Pending | Not created yet (checked in the app dashboard 2026-10-19: the use case's Settings say no verified portfolio is connected). Needed for Business Verification. You have the registered business name "bizinsights" and its documents. | Create a portfolio in Meta Business Settings with the registered name, address, phone and website https://bizinsights.io, make your Facebook account an Admin, then connect the app to it (App settings → Basic → Verification). (Owner) |
| Permissions and access levels | Completed (checked 2026-10-19) | Use case "Measure ad performance data with Marketing API": `ads_read` Standard Access ("Ready for testing"), `public_profile` the same; `ads_management`, `business_management`, `pages_show_list` and `pages_read_engagement` are listed at Standard Access but bizinsights never asks for them (the Login configuration asks for `ads_read` alone). **Marketing API Access Tier: Limited** (the app dashboard says the higher tier needs App Review). The app is **published (Live)**: its Publish page lists the one use case and offers Unpublish. With `ads_read` at Standard Access that changes nothing for merchants: only people with a role on the app can grant it until Advanced Access. | Request Advanced Access for `ads_read` and `public_profile` only (row below); leave the rest at Standard Access. (Owner) |
| Business Verification | Blocked | Needs the portfolio (row above). Meta checks the business against its registration documents. | Business Settings → Security Center → Start verification, upload the documents. bizinsights.io has no mailbox, so confirm by phone or by domain (DNS record in Cloudflare). Claude must not do this step. (Owner) |
| App settings on bizinsights.io | Completed (2026-10-19) | Done in the app dashboard with the owner's Chrome: app domain `bizinsights.io`, Terms of Service URL https://bizinsights.io/terms and site URL https://bizinsights.io/ (Website) saved and confirmed after a reload. Privacy policy https://bizinsights.io/privacy, data deletion instructions https://bizinsights.io/data-deletion, the app icon (app-icon-1200.png), category Business and pages and contact email sebanceo@gmail.com were set already. | None. (Changing any of these later may need a new review once submitted.) |
| Facebook Login for Business redirect URI | Completed (2026-10-19) | Valid OAuth Redirect URIs held only `https://insights.imeseban.workers.dev/api/ads/meta/callback`, so "Continue with Meta Ads" on bizinsights.io failed with Facebook's redirect error. `https://bizinsights.io/api/ads/meta/callback` is now listed too, confirmed after a reload and by the page's Redirect URI Validator. **Dashboard quirk:** typing the address and pressing Enter shows a chip and "Changes saved", but nothing is kept (three times); typing it and then **clicking the suggestion that appears under the field** makes the chip count, and Save Changes keeps it. The App domains field behaves the same way. | Remove the workers.dev entry once the old deployment no longer serves Meta connections. (Owner) |
| Deauthorize and data deletion callbacks | Blocked | Built on this branch; they exist only after its deploy. Deauthorize: `https://bizinsights.io/api/webhooks/meta/deauthorize`. Data deletion: `https://bizinsights.io/api/webhooks/meta/data-deletion`. Both need `META_APP_SECRET` in AWS. | After the deploy: Facebook Login for Business → Settings → Deauthorize callback URL; App settings → Basic → User data deletion → callback URL. Save. (Owner) |
| Require App Secret | Blocked | Every ads call sends `appsecret_proof` from this branch on, so Meta can then refuse calls without it. Turning it on before the deploy would break Meta syncs. | After the deploy: App settings → Advanced → Security → Require App Secret → on. (Owner) |
| App settings on bizinsights.io | Completed | Seen 2026-10-19 in App settings → Basic: app domain `bizinsights.io`, privacy https://bizinsights.io/privacy, terms https://bizinsights.io/terms, user data deletion = callback URL (row below), app icon uploaded; site URL https://bizinsights.io/ saved the same day. | None. (Owner, done) |
| Facebook Login for Business redirect URI | Completed | Valid OAuth Redirect URIs held `https://bizinsights.io/api/ads/meta/callback` on 2026-10-19, next to the old workers.dev one (harmless while it stays). | Optional: once the old Worker is gone, remove the workers.dev entry (its ×, then **Save Changes**). (Owner) |
| Deauthorize and data deletion callbacks | Completed | Registered 2026-10-19 in Facebook Login for Business → Settings (Deauthorize callback URL `https://bizinsights.io/api/webhooks/meta/deauthorize`, Data Deletion Request URL `https://bizinsights.io/api/webhooks/meta/data-deletion`), both still there after a reload. App settings → Basic → User data deletion switched to "Data deletion callback URL" with the same URL by itself. Before registering, an unsigned POST to each answered 401 in production (signature checked: code and `META_APP_SECRET` both in place). | None. If a URL ever changes, register it again the same way. (Claude on your word) |
| Require App Secret | Completed | On since 2026-10-19 (App settings → Advanced → Security), confirmed after a reload. Release 77 proves every call made with a person's token with `appsecret_proof` (`packages/core/src/metaGraph.ts`), so Meta syncs keep working. | Leave it on. A Meta sync failing with "requires an appsecret_proof" means the code regressed, not the switch. (Claude) |
| App Review: Advanced Access to `ads_read` (and `public_profile`) | Blocked | Needs Business Verification first. Texts, video script and reviewer instructions are in ads-review-packs.md (Meta pack). | After verification: record the screencast, request Advanced Access for `ads_read` and `public_profile` only, submit. Then Access Verification (Tech Provider). (Owner) |
| Let every merchant connect in bizinsights | Blocked | The Meta card says only testers can connect while `META_ADS_ADVANCED_ACCESS` is empty. | After Meta grants Advanced Access: Claude sets `META_ADS_ADVANCED_ACCESS` to `"1"` and ships it through `main`; then switch the app to Live after the Data Use Checkup. (Claude on your word, then Owner) |

## AWS

| Requirement | Status | Why | Next action (who) |
| --- | --- | --- | --- |
| Provider secrets in production (`META_APP_SECRET`, `GOOGLE_ADS_CLIENT_SECRET`) | Completed | `GOOGLE_ADS_CLIENT_SECRET` stored 2026-10-19 (a new secret on "Insights web"; until then AWS had none, so Google Ads/AdSense never worked on bizinsights.io). An AdSense connection then completed in production. `META_APP_SECRET` is there too since 2026-10-19 evening: `put-secrets.mjs --dry-run` lists the key and the Meta callbacks answer 401, not 503, so the running functions see it. | None. (Owner, done) |
| This branch deployed | Completed | On production since release 77 (built from `ee7206c`, which includes it): the Meta callbacks answer and the deploy applied migration `20261019120000_ad_connection_health`. | None. (Claude) |
| Meta API version | Completed | v26.0 since this branch. The build fails 90 days before a version's end, so a red build is the reminder. | Re-read Meta's changelog by 2027-04-17 (ads-setup.md, "Keeping the API versions current"). (Claude) |

## Order that saves time

1. Google: save branding → Verify Branding → publish → record the video → submit `adwords` verification.
2. Meta: create the business portfolio → Business Verification (with your documents).
3. Done 2026-10-19: this branch is deployed, both secrets are in AWS, the Meta callbacks are registered, the app
   settings point at bizinsights.io and Require App Secret is on.
4. After Meta verifies the business: App Review for `ads_read`.
5. After each approval: Claude flips `GOOGLE_ADS_OAUTH_VERIFIED` or `META_ADS_ADVANCED_ACCESS`.
