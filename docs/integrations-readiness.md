# Integrations readiness: Google, Meta and AWS checklist

The owner's checklist for opening Google Ads, Google AdSense, Meta Ads and "Continue with Google" sign-in to every
merchant. Each line says where it stands, why, and what happens next and who does it.

Last updated 2026-10-20 (evening: the registration facts from ABN Lookup, the Google Ads account state, the list of
what only you can do with the values to paste; then the Meta portfolio created and Business Verification submitted;
later that night: what the public sees on Continue with Google's screen, and the own sign-in domain's steps).
Status words:

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
| Authorized domain `bizinsights.io` on the consent screen | Completed (2026-10-19) | Saved on Branding next to the old Cloudflare Worker's `workers.dev` domain, which stays while "Insights web" still lists the workers.dev redirect URIs. | Once the old Worker is retired: remove the workers.dev redirect URIs on the client, then the workers.dev domain on Branding, save. (Owner or Claude on your word) |
| Branding (app name, logo, homepage, privacy, terms, contacts) | Completed (2026-10-19) | Saved with a 120x120 logo, re-verified ("I have fixed the issues") and published the same day: "Your branding has been verified and is being shown to users." Name **bizinsights**, homepage https://bizinsights.io/, privacy /privacy, terms /terms. | None. Changing the name, logo or links later sends it back for verification. |
| Redirect URIs on "Insights web" | Completed (2026-10-19) | Both bizinsights.io callbacks added and saved (they were missing, so Connect from bizinsights.io failed with a redirect error). The old Cloudflare Worker's two workers.dev callbacks are still listed; no JavaScript origins. | Remove the workers.dev pair when the old Worker is retired. (Owner or Claude on your word) |
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
| Sign in with Google in production | Completed (2026-10-19, release 75; open to the public since 2026-10-20) | `/api/auth/config` answers `"google":true`; a real Continue with Google sign-in (sebanceo@gmail.com) reached the dashboard. Re-checked 2026-10-20 from a browser signed in to no bizinsights account, after the project was published and its branding verified (rows below): Google's chooser shows the bizinsights logo, "to continue to bizinsights" and "bizinsights's Privacy Policy and Terms of Service", and goes on to the chosen account's own Google sign-in. | None. |
| A separate Cloud project for sign-in | Completed (published 2026-10-20) | Project `bizinsights-sign-in`: External, scopes openid/email/profile only, authorized domains bizinsights.io, amazoncognito.com and the pool's full amazoncognito.com host. Until 2026-10-20 its publishing status was **Testing with 0 test users**, so Google let only the project owner's account sign in and gave everyone else "Error 403: access_denied, the app is currently being tested". Audience → Publish app → Confirm, on the owner's word; it reads "In production" now. With these scopes no review was needed. | None. Never press "Back to testing": it would lock the public out again. |
| Its OAuth client and redirect URI | Completed | Web client "bizinsights sign-in" `567753266621-ltq5j5kij5s3em8gr0err3tbrh5fqciq.apps.googleusercontent.com`, redirect `https://insights-605411278365.auth.ap-southeast-2.amazoncognito.com/oauth2/idpresponse`. | None. |
| Its secret in AWS | Completed | `GOOGLE_SIGNIN_CLIENT_SECRET` in `insights/production/app` (2026-10-19). | None. |
| GitHub variable | Completed | `GOOGLE_SIGNIN_CLIENT_ID` on the `production` environment. | None. |
| Own sign-in domain `auth.bizinsights.io` | Completed (2026-10-20, release 81) | Polish rather than a requirement: Google's screen already names bizinsights (branding row below); with the own domain the address bar shows auth.bizinsights.io instead of amazoncognito.com during the hop. Done without an outage through the `inUse` switch of `cognitoCustomDomain` (`infra/cdk/lib/config.ts`): step one (PR #161) created the domain while sign-in stayed on the prefix domain; the DNS-only CNAME `auth` → `db11p1sm9fnn5.cloudfront.net` and the Google client's new origin and redirect URI were added in the owner's Chrome; step two (PR #164, release 81) moved sign-in over. Checked after the deploy: `/api/auth/oauth/google/start` sends to `https://auth.bizinsights.io/oauth2/authorize`, Cognito there sends Google `redirect_uri=https://auth.bizinsights.io/oauth2/idpresponse`, and a Google sign-in from a clean browser reached the dashboard. The certificate `b0849d46-…` (ACM us-east-1) renews by itself while its validation CNAME stays (aws-deployment.md, "Domain: bizinsights.io"). The prefix domain stays beside it, unused by the app. | None. The amazoncognito.com origin, redirect URI and authorized domains were removed from the Google client and consent screen on 2026-10-20; if they ever come back, nothing breaks, they are just unused. |
| Branding of the sign-in project (name and logo on Google's screen) | Completed (2026-10-20) | Google's screen shows an app's name and logo only after brand verification. In the owner's Chrome on 2026-10-20: the 120x120 green-bars logo (the one the Ads project passed with) uploaded through the browser's file input and saved (the form's "Discard changes" button looks like Save to the browser tools: the real Save is the form's submit button). Right after the project was published, the Branding page read "Your branding has been verified and is being shown to users" with nothing submitted. Checked from a browser signed in to nothing: the chooser shows the logo and "to continue to bizinsights". | None. Changing the name, logo or links later sends it back for verification. |
| New-user authorization limit (Google's per-project rate) | Pending (Google's review) | Google allows each project a number of first-time authorizations a day; the Overview page showed 10,000 for `bizinsights-sign-in`. On the owner's word, Claude submitted Google's "OAuth Application: Request Increase to New User Authorization Limit" form on 2026-10-20 (project `bizinsights-sign-in`, homepage https://bizinsights.io/, company email sales@ikorex.com.au, 100,000 a day requested, with the Shopify launch justification). Google answered "Your email has been sent", typically two business days. | Watch sales@ikorex.com.au and sebanceo@gmail.com for Google Cloud Platform Trust & Safety's reply and paste it to Claude; Google may ask questions or grant a smaller figure. (Owner) |

## Meta (developer app "Insights", App ID 971575545351940)

| Requirement | Status | Why | Next action (who) |
| --- | --- | --- | --- |
| Developer app | Completed (Development mode) | Set up 2026-10-11: use case "Measure ad performance data with Marketing API", `ads_read` at Standard Access ("ready for testing"), Facebook Login for Business configuration 1521935306664882. In this state only people with a role on the app (admins, developers, testers) can connect; others see "Feature Unavailable". | Add anyone who must test under App roles → Testers. (Owner) |
| Permissions and access levels | Completed (checked 2026-10-19) | Use case "Measure ad performance data with Marketing API": `ads_read` Standard Access ("Ready for testing"), `public_profile` the same; `ads_management`, `business_management`, `pages_show_list` and `pages_read_engagement` are listed at Standard Access but bizinsights never asks for them (the Login configuration asks for `ads_read` alone). **Marketing API Access Tier: Limited** (the app dashboard says the higher tier needs App Review). The app is **published (Live)**: its Publish page lists the one use case and offers Unpublish. With `ads_read` at Standard Access that changes nothing for merchants: only people with a role on the app can grant it until Advanced Access. | Request Advanced Access for `ads_read` and `public_profile` only (row below); leave the rest at Standard Access. (Owner) |
| Business portfolio | Completed (2026-10-20) | Created as **Zodiix Pty Ltd** under the app admin's Facebook account (sebanceo@gmail.com), business email sales@ikorex.com.au, website https://bizinsights.io, with the Business info from the ASIC certificate. The legal name is the entity on the register (ABN Lookup, 2026-10-20: ACN 613 577 834, ABN 40 613 577 834, Australian private company, GST-registered, main business location VIC 3977; registered business name "PixMagic" only). "bizinsights" is not a registered business name of that ABN, and the "Bizinsights Pty Ltd" on the register (ABN 89 156 153 196, QLD 4740, since 2012) is an unrelated company. The "Testbusiness" portfolio (1754818672920174) is the other Facebook account's (imeseban@gmail.com, WhatsApp app) and plays no part. The app is connected to it: App settings → Basic → Verification names Zodiix Pty Ltd with verification pending (confirmed by the owner 2026-10-20). | None. (Owner, done) |
| Business Verification | Submitted (2026-10-20) | Security Center → Start verification, done as Zodiix Pty Ltd: phone code confirmed (Meta offered only phone or email for this business, no domain record; email lists only addresses at bizinsights.io, which has no mailbox) and the ASIC certificate of registration (11 July 2016) uploaded. Meta decides in its own time, usually within a few days, and shows the result under Security Center. | Watch Security Center and the sales@ikorex.com.au inbox. If Meta asks for another document (address proof), upload it. Claude must not do this step. (Owner) |
| App settings on bizinsights.io | Completed | Seen 2026-10-19 in App settings → Basic: app domain `bizinsights.io`, privacy https://bizinsights.io/privacy, terms https://bizinsights.io/terms, user data deletion = callback URL (row below), app icon uploaded; site URL https://bizinsights.io/ saved the same day. | None. (Owner, done) |
| Facebook Login for Business redirect URI | Completed | Valid OAuth Redirect URIs holds only `https://bizinsights.io/api/ads/meta/callback`: the old workers.dev entry was removed 2026-10-20 (its ×, then **Save Changes**, confirmed after a reload), so Continue with Meta Ads now works on bizinsights.io alone. **Dashboard quirk:** typing an address into Valid OAuth Redirect URIs or App domains and pressing Enter shows a chip and "Changes saved" but keeps nothing; type it, click the suggestion that appears under the field, then Save Changes. | None. (Claude on your word) |
| Deauthorize and data deletion callbacks | Completed | Registered 2026-10-19 in Facebook Login for Business → Settings (Deauthorize callback URL `https://bizinsights.io/api/webhooks/meta/deauthorize`, Data Deletion Request URL `https://bizinsights.io/api/webhooks/meta/data-deletion`), both still there after a reload. App settings → Basic → User data deletion switched to "Data deletion callback URL" with the same URL by itself. Before registering, an unsigned POST to each answered 401 in production (signature checked: code and `META_APP_SECRET` both in place). | None. If a URL ever changes, register it again the same way. (Claude on your word) |
| Require App Secret | Completed | On since 2026-10-19 (App settings → Advanced → Security), confirmed after a reload. Release 77 proves every call made with a person's token with `appsecret_proof` (`packages/core/src/metaGraph.ts`), so Meta syncs keep working. | Leave it on. A Meta sync failing with "requires an appsecret_proof" means the code regressed, not the switch. (Claude) |
| App Review: Advanced Access to `ads_read` (and `public_profile`) | Blocked (Business Verification pending since 2026-10-20) | Can't be submitted until Meta approves the business. Texts, video script and reviewer instructions are in ads-review-packs.md (Meta pack). | While Meta decides: create the reviewer account in production with a development store connected (Meta pack step 8), connect your own Meta ad account in your workspace so the app makes real `ads_read` calls in the 30 days before submitting (step 9), record the screencast (step 11). After approval: request Advanced Access for `ads_read` and `public_profile` only, submit. Then Access Verification (Tech Provider). (Owner) |
| Let every merchant connect in bizinsights | Blocked | The Meta card says only testers can connect while `META_ADS_ADVANCED_ACCESS` is empty. | After Meta grants Advanced Access: Claude sets `META_ADS_ADVANCED_ACCESS` to `"1"` and ships it through `main`; then switch the app to Live after the Data Use Checkup. (Claude on your word, then Owner) |

## AWS

| Requirement | Status | Why | Next action (who) |
| --- | --- | --- | --- |
| Provider secrets in production (`META_APP_SECRET`, `GOOGLE_ADS_CLIENT_SECRET`) | Completed | `GOOGLE_ADS_CLIENT_SECRET` stored 2026-10-19 (a new secret on "Insights web"; until then AWS had none, so Google Ads/AdSense never worked on bizinsights.io). An AdSense connection then completed in production. `META_APP_SECRET` is there too since 2026-10-19 evening: `put-secrets.mjs --dry-run` lists the key and the Meta callbacks answer 401, not 503, so the running functions see it. | None. (Owner, done) |
| This branch deployed | Completed | On production since release 77 (built from `ee7206c`, which includes it): the Meta callbacks answer and the deploy applied migration `20261019120000_ad_connection_health`. | None. (Claude) |
| Meta API version | Completed | v26.0 since this branch. The build fails 90 days before a version's end, so a red build is the reminder. | Re-read Meta's changelog by 2027-04-17 (ads-setup.md, "Keeping the API versions current"). (Claude) |

## Supermetrics (optional second way to connect: [supermetrics.md](supermetrics.md))

| Requirement | Status | Why | Next action (who) |
| --- | --- | --- | --- |
| "Connect through Supermetrics" in bizinsights | Completed (2026-10-22, switched off) | Built and tested against Supermetrics' documented API: login links, sync, live reports, sync records, revoke on disconnect. Shows only once the key below is stored. Merchants sign in with Supermetrics' Meta and Google apps, which don't wait on bizinsights' Meta App Review or Google `adwords` verification above. | None until the licence. (Claude) |
| Supermetrics API licence for bizinsights' team | Blocked (no Supermetrics account) | Checked 2026-10-22: the owner's Chrome isn't signed in to hub.supermetrics.com and no key was ever stored. Needs data sources FA, AW, ADM and the Management API's login links; Supermetrics should confirm in writing that links may go to bizinsights' customers. | Buy it, or ask Supermetrics for a trial with login links (supermetrics.md, "What the owner has to do", step 1). (Owner) |
| `SUPERMETRICS_API_KEY` in production | Blocked (licence) | Read from `insights/production/app` at cold start; empty hides every Supermetrics button. | `node infra/cdk/scripts/put-secrets.mjs --set SUPERMETRICS_API_KEY`, then a deploy or a function restart. (Owner) |
| Figures checked against the platforms | Blocked (key) | Nothing has been read from the live Supermetrics API yet. | Claude connects one account per platform with you and compares a week with Ads Manager, Google Ads and AdSense (supermetrics.md step 5). (Owner with Claude) |

## What is left, in order (checked 2026-10-20)

Everything Claude can do alone is done: the code is live, both secrets are in AWS, the Meta callbacks and settings
point at bizinsights.io, Require App Secret is on, Google branding is verified and published, and the texts, scripts
and reviewer instructions are written. The rest needs your logins, your certificate or your payment method.

1. **Done 2026-10-20.** Continue with Google for the public: the `bizinsights-sign-in` project is published, its
   logo saved and its branding verified, so anyone can sign in and Google's screen shows "bizinsights" with the
   logo; sign-in runs through `auth.bizinsights.io` since release 81. **You:** watch sales@ikorex.com.au and
   sebanceo@gmail.com for Google's answer to the new-user authorization limit request and paste it to Claude.
2. **You, 10 minutes.** Google Ads: create the payments profile on client 745-450-4478's billing page (link in the
   `adwords` row). Then tell Claude whether to pause the draft campaign or let it run a few days at A$1/day.
3. **You with Claude, about 30 minutes.** Dry run of the Google script on bizinsights.io, record the video, upload
   it unlisted, submit `adwords` verification in the Verification Center.
4. **Done 2026-10-20.** Meta: portfolio Zodiix Pty Ltd created, Business Verification submitted (phone code
   confirmed, ASIC certificate uploaded). Meta decides in its own time, usually days.
5. **You, while Meta decides.** Create the reviewer account in production with a development store connected,
   connect your own Meta ad account in your workspace so the app makes real `ads_read` calls in the 30 days before
   submitting, and record the Meta screencast (Meta pack steps 8, 9 and 11).
6. **After Meta verifies the business.** App Review for `ads_read` and `public_profile` (texts and script in
   ads-review-packs.md), then Access Verification.
7. **After each approval.** Claude flips `GOOGLE_ADS_OAUTH_VERIFIED` or `META_ADS_ADVANCED_ACCESS` and ships it.
8. **Any time, optional.** Google Ads API Basic access (draft answers in ads-review-packs.md).
