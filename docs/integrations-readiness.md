# Integrations readiness: Google, Meta and AWS checklist

The owner's checklist for opening Google Ads, Google AdSense, Meta Ads and "Continue with Google" sign-in to every
merchant. Each line says where it stands, why, and what happens next and who does it.

Last updated 2026-10-20 (evening: the registration facts from ABN Lookup, the Google Ads account state, and the
list of what only you can do, with the values to paste). Status words:

- **Completed**: done and confirmed.
- **Pending**: can be done now, or is waiting on a step that is under way.
- **Blocked**: can't start until another item is finished (named in the line).
- **Not applicable**: nothing to do.

"This branch" means `claude/google-meta-oauth-integrations-dec503` (the Google/Meta integrations work). Anything that
says "after this branch's deploy" can be done once that branch is merged to `main` and its **Deploy to AWS** run has
succeeded.

Steps marked **Owner** need your own Google, Meta, Cloudflare or AWS login. Claude must not sign in to those consoles,
create a business portfolio or a payments profile, enter payment details, pass a CAPTCHA, or upload business documents
for you, and never automates developers.facebook.com or business.facebook.com: Meta blocked the app admin's developer
account twice (2026-10-14 and 2026-10-15) after automated clicking, which switched Facebook Login off for everyone until
you pressed Confirm Account. The single settings Claude changed there on 2026-10-19 and 2026-10-20 were each on your
explicit word for that one setting. Every Owner step below was re-checked on 2026-10-20: each needs an input that is
not in the repo (the registered address and phone, the certificate, a payment method) or an action Claude does not
perform, so none of them moves without you. The public facts Claude could look up are filled in.

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
| `adwords` data-access verification | Blocked (Google Ads client account) | Branding is published (row above). The demo video must show real Google Ads figures, and the demo login sebanceo@gmail.com has none yet: the manager account bizinsights **892-467-3464** is finished (Australia, Sydney Time, AUD) but managers hold no campaigns, and the client bizinsights **745-450-4478** under it is still "Setup in progress" because its billing page has no payments profile. Google does not enable an account without one, so bizinsights' connect gets CUSTOMER_NOT_ENABLED for it, and its draft Search campaign (A$1/day, Page views goal) cannot be published. Two stray "Setup in progress" accounts (133-520-0897, 944-886-6737) are harmless. Until the review passes, Google Ads sign-ins show "Google hasn't verified this app" and each new user counts toward a lifetime cap of 100. | (1) You, about 10 minutes: open the client's billing page as sebanceo@gmail.com, https://ads.google.com/aw/signup/payment?ocid=8614814876&ascid=8596781735&authuser=0, press **Create new payments profile**, enter the legal name Zodiix Pty Ltd, ABN 40 613 577 834, the registered address and a payment method, submit. (2) Claude on your word: publish the draft campaign and pause it, or leave it running a few days at A$1/day so the video shows spend (the script asks for recent spend; your call). (3) Dry run of the script on bizinsights.io with Claude, then you record the video, upload it unlisted, and paste the justification and link in the Verification Center. (Owner, with Claude) |
| Google Ads API access level | Completed (Explorer) | Explorer granted to insights-511119 on 2026-10-11: real accounts, 2,880 operations a day, which the syncs budget for. Developer tokens were retired by Google on 2026-09-09, so there is no token to get. | None now. (Owner) |
| Google Ads API **Basic** access | Pending (can be applied for) | Brand verification of the project is done (branding row, 2026-10-19). Only needed past roughly 60 busy accounts, so nothing is lost by waiting. | Google Ads API → Access levels → apply for Basic, with the draft answers in ads-review-packs.md ("Google Ads API > Access levels > Basic access"). If the page still shows brand verification as pending, give it a day or two. Then Claude sets `GOOGLE_ADS_DAILY_OPERATIONS` to the new figure. (Owner, then Claude) |
| AdSense Management API enabled | Completed | In use since 2026-10-10: AdSense connections sync in production. | None. |
| Publishing status "In production" | Completed | The consent screen is published (External), so anyone can sign in, not only test users. Re-check it shows "In production" before submitting. | Glance at Audience before submitting. (Owner) |
| Turn off the "unverified app" warning in bizinsights | Blocked | The Google Ads card warns merchants about Google's unverified-app screen while `GOOGLE_ADS_OAUTH_VERIFIED` is empty. | After Google approves `adwords`: Claude sets `GOOGLE_ADS_OAUTH_VERIFIED` to `"1"` in `apps/aws/src/settings.ts` and ships it through `main`. (Claude, on your word) |
| Homepage section on Google data (https://bizinsights.io/#google-data) | Completed | Live since this branch's deploy (release 77, 2026-10-19): the served homepage holds the `google-data` section "Google Ads, Google AdSense and Meta Ads" (`AdPlatforms.tsx`, checked 2026-10-20). Documentation link 3 in the Google form points at it. | None. (Claude) |

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
| Business portfolio | Pending (yours, about 15 minutes) | The app's admin Facebook account (sebanceo@gmail.com) has no portfolio. The "Testbusiness" portfolio (1754818672920174) belongs to the other Facebook account (imeseban@gmail.com) and the WhatsApp app, so it only serves if that account makes yours an Admin of it. Public record on ABN Lookup, 2026-10-20: **Zodiix Pty Ltd**, ACN 613 577 834, ABN 40 613 577 834, Australian private company, ABN active from 11 Jul 2016, GST-registered from 1 Jul 2017, main business location VIC 3977. The only business name registered to that ABN is **PixMagic** (from 19 Jul 2016): "bizinsights" is not registered to it, and the "Bizinsights Pty Ltd" on the register (ABN 89 156 153 196, QLD 4740, since 2012) is an unrelated company. The registered street address and phone number are on your certificate and nowhere in the repo. | As sebanceo@gmail.com, in Meta Business Settings create a portfolio named **Zodiix Pty Ltd** (the legal name, not "bizinsights"), with your name and the business email sales@ikorex.com.au. Then Business info: legal name Zodiix Pty Ltd, ABN 40 613 577 834, the registered address and phone from the certificate, website https://bizinsights.io. Connect the app: App settings → Basic → Verification → pick the portfolio. The values are in ads-review-packs.md ("Meta Business Settings > Business portfolio"). (Owner) |
| Business Verification | Blocked | Needs the portfolio (row above) with business info that matches the certificate. Meta compares the legal name, address and phone with the document: a portfolio named "bizinsights" will not match an ASIC certificate for Zodiix Pty Ltd. | Business Settings → Security Center → Start verification: country Australia, legal name Zodiix Pty Ltd, ABN 40 613 577 834, address and phone as on the certificate, upload the ASIC certificate of registration (and a document showing the address, if Meta asks for one). Confirm by **phone** (the number from Business info gets a code by SMS or call): on 2026-10-20 Meta offered only phone or email for this business, no domain record. Email only lists addresses at bizinsights.io, which has no mailbox; if phone fails, Claude can set up Cloudflare Email Routing (bizinsights.io → sales@ikorex.com.au) on your word. Claude must not do this step. (Owner) |
| App settings on bizinsights.io | Completed | Seen 2026-10-19 in App settings → Basic: app domain `bizinsights.io`, privacy https://bizinsights.io/privacy, terms https://bizinsights.io/terms, user data deletion = callback URL (row below), app icon uploaded; site URL https://bizinsights.io/ saved the same day. | None. (Owner, done) |
| Facebook Login for Business redirect URI | Completed | Valid OAuth Redirect URIs holds only `https://bizinsights.io/api/ads/meta/callback`: the old workers.dev entry was removed 2026-10-20 (its ×, then **Save Changes**, confirmed after a reload), so Continue with Meta Ads now works on bizinsights.io alone. | None. (Claude on your word) |
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

## What is left, in order (checked 2026-10-20)

Everything Claude can do alone is done: the code is live, both secrets are in AWS, the Meta callbacks and settings
point at bizinsights.io, Require App Secret is on, Google branding is verified and published, and the texts, scripts
and reviewer instructions are written. The rest needs your logins, your certificate or your payment method.

1. **You, 10 minutes.** Google Ads: create the payments profile on client 745-450-4478's billing page (link in the
   `adwords` row). Then tell Claude whether to pause the draft campaign or let it run a few days at A$1/day.
2. **You with Claude, about 30 minutes.** Dry run of the Google script on bizinsights.io, record the video, upload
   it unlisted, submit `adwords` verification in the Verification Center.
3. **You, 15 minutes.** Meta: create the portfolio as Zodiix Pty Ltd, fill in Business info, connect the app.
4. **You, 15 minutes, then Meta's days.** Business Verification with the ASIC certificate. If Meta offers domain
   confirmation, paste the TXT record to Claude.
5. **After Meta verifies the business.** App Review for `ads_read` and `public_profile` (texts and script in
   ads-review-packs.md), then Access Verification.
6. **After each approval.** Claude flips `GOOGLE_ADS_OAUTH_VERIFIED` or `META_ADS_ADVANCED_ACCESS` and ships it.
7. **Any time, optional.** Google Ads API Basic access (draft answers in ads-review-packs.md).
