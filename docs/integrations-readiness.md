# Integrations readiness: Google, Meta and AWS checklist

The owner's checklist for opening Google Ads, Google AdSense, Meta Ads and "Continue with Google" sign-in to every
merchant. Each line says where it stands, why, and what happens next and who does it.

Last updated 2026-11-02: the Meta rows re-read in the app dashboard (read only: Business Verification, Access
Verification, App Review, Required actions, the Facebook Login for Business settings), Leaving Nango's step (a)
done (live since release 131, 2026-10-30), and its step (d) done that day on the owner's word: Nango's redirect URI
removed at Meta and from Google's "Insights web" client. (b) and (c) are for now. The other Google rows stand as last
checked.

Before that: 2026-10-20 (evening: the registration facts from ABN Lookup, the Google Ads account state, the list of
what only you can do with the values to paste; then the Meta portfolio created and Business Verification submitted;
later that night: what the public sees on Continue with Google's screen, and the own sign-in domain's steps).
Meta rows re-read in the app dashboard on 2026-10-26 (the app's portfolio, Business Verification, App Review), and
again late on 2026-10-26 after Meta verified the business (Access Verification, the API call counts). On 2026-10-28
the ad sign-ins became bizinsights' own again: the Nango rows gave way to "Leaving Nango"; later that day, production
showed the move off Nango done and Meta's redirect URI working.

The readiness check of 2026-10-22 below is older than those Meta rows: where they differ (the portfolio, Business
Verification, App Review), the rows win.

Readiness check, 2026-10-22: Google's live Verification Center for `insights-511119`
still shows approved branding and unverified data access. **Prepare for verification**
lists `adsense.readonly` and the unverified sensitive `adwords` scope; submission is
disabled because the required demo video is missing (Video link: Not provided).
No verification request was submitted during this check. A later live Meta check
on 2026-10-22 showed `ads_read` and `public_profile` as **Ready for testing**, and
Marketing API Access Tier as **Limited access**. Selecting `ads_read` → Actions →
Add to App Review opens a prerequisite dialog: become a Tech Provider, complete
business and access verification, then App Review. Meta explicitly says identifying
as a Tech Provider cannot be reversed. After the owner's subsequent "complete it"
confirmation, Continue was selected and Meta exposed Review → Verification and
App Review. The App Review draft now contains only `ads_read` and `public_profile`:
the unused page permissions, `business_management`, `ads_management`, and optional
Marketing API Access Tier were removed from the draft (not from the app).
The ads_read dashboard/analytics use case and factual explanation were saved and
confirmed by reopening the form. Meta marks its API test calls Completed. The
screencast and allowed-usage declaration remain incomplete; no declaration was
accepted and nothing was submitted. Verification currently asks to connect a
business portfolio, but the session offers only creation of a new portfolio;
no duplicate business was created. Existing business ownership/access must be
resolved before the business/access reviews can finish. The app dashboard displayed
Published, which does not establish advanced permission approval. Business
verification's current result was not confirmed.
The website owner sign-in and Google's passkey identity check were subsequently
completed. Advertising is available in the existing **bizinsights demo** workspace
(the **My store** workspace denied the advertising route). A real Google Ads connect
was attempted as sebanceo@gmail.com using the Google Ads permission that Google
confirmed was already granted. The callback returned: the account is not ready
to report because setup is unfinished, cancelled or suspended. No real Google Ads
connection was created. The known client setup page loaded **Step 4: Set up billing**,
with **Create new payments profile** still offered and no profile selected, confirming
the billing prerequisite remains unfinished. An ad-blocker notice is also present.
No billing, payment or campaign action was performed.
The existing AdSense connection has synced through 2026-10-22, but its account health
says **Needs attention in Google AdSense**. A working real Google Ads account and
the required demonstration recording remain prerequisites for the review.
The existing Google Ads campaign queries include paid YouTube and Display campaigns;
these need no YouTube channel analytics connection. The existing AdSense connection
reports publisher earnings, and Meta Ads reports authorized Facebook/Instagram ad
accounts. The connection screens now explain these differences. Local validation:
80 targeted core advertising tests passed, web typecheck and changed-file lint passed.
Database-backed API checks could not start because the local test database was
unavailable. No production deployment or real client-account connection was performed.

**No-spend alternative (checked 2026-10-22):** Google officially supports test manager
and client accounts with no billing and no ad serving. Earlier checklist entries
requiring paid campaign delivery should not be read as a universal OAuth review
requirement. Google's demo guidance requires the actual OAuth flow and functionality
using the requested scopes; it does not promise acceptance of a particular test-account
demo. A test integration must be disclosed as such, and cannot supply real spend,
clicks or impressions. bizinsights' existing simulated **Try demo** mode is useful
for product demonstrations but does not itself exercise Google OAuth or Google's API.
Sources: https://developers.google.com/google-ads/api/docs/best-practices/test-accounts
and https://support.google.com/cloud/answer/13804565?hl=en .

The no-cost simulated demo is now connected in **bizinsights demo** →
**bizinsights sync check** as **Demo Business Marketing**. Its analytics page shows
campaigns, spending, clicks, conversions and charts with **DEMO DATA** labels; no
Google authorization or verification occurred. The official Create a test manager
account link was followed under the separate imeseban@gmail.com Google login.
The manager creation form is prepared as **bizinsights API Test Manager**, Manage
my accounts, India, India Time and INR. It is waiting at an unsolved reCAPTCHA;
the manager's completed creation, test-account status and any client account have
not been confirmed. No CAPTCHA was solved, payment entered or ad started.

**AdSense follow-up, 2026-10-22:** The connected publisher account under
sebanceo@gmail.com (`pub-8558633671852701`) explicitly showed deactivation for
inactivity. **Reactivate account** was selected; Google advanced to **Let's get you
started**, with Payments **We've got your info** and the required **Connect your site
to AdSense** step. That step opens Add site with a blank Website field. No domain
was submitted: the owner must identify the publisher website to monetize; the SaaS
application's own domain must not be assumed. Refresh Google AdSense in bizinsights
then completed a new successful sync, but account health still says Needs attention.
The Meta developer account was confirmed as sebanceo@gmail.com; Verification still
requires a business portfolio and offers only Create new account. Owner input is
needed to locate the existing Zodiix portfolio or authorize creating a new one.

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
| Redirect URIs on "Insights web" | Completed (2026-10-19; checked again 2026-10-28) | Both bizinsights.io callbacks, `/api/ads/google/callback` and `/api/ads/adsense/callback`, added and saved on 2026-10-19 (they were missing, so Connect from bizinsights.io failed with a redirect error). On 2026-10-28 Google's consent screen loaded for both, while a made-up path got `redirect_uri_mismatch`: bizinsights' own sign-in works with them again. Nango's callback (added 2026-10-22) was removed on 2026-11-02 on the owner's word (Leaving Nango, step (d)); after a fresh load the client lists the two bizinsights.io callbacks and the old Cloudflare Worker's two workers.dev callbacks; no JavaScript origins. | Remove the workers.dev pair when the old Worker is retired. (Owner or Claude on your word) |
| Scope list and justification | Completed | Checked 2026-10-19: Data Access lists exactly `adsense.readonly` (non-sensitive) and `adwords` (sensitive), with the justification. Audience: External, In production, 1 of 100 unverified-scope users used. | None until the demo video (next row). |
| `adwords` data-access verification | Blocked (Google Ads client account) | Branding is published (row above). The demo video must show real Google Ads figures, and the demo login sebanceo@gmail.com has none yet: the manager account bizinsights **892-467-3464** is finished (Australia, Sydney Time, AUD) but managers hold no campaigns, and the client bizinsights **745-450-4478** under it is still "Setup in progress" because its billing page has no payments profile. Google does not enable an account without one, so bizinsights' connect gets CUSTOMER_NOT_ENABLED for it, and its draft Search campaign (A$1/day, Page views goal) cannot be published. Two stray "Setup in progress" accounts (133-520-0897, 944-886-6737) are harmless. Until the review passes, Google Ads sign-ins show "Google hasn't verified this app" and each new user counts toward a lifetime cap of 100. | (1) You, about 10 minutes: open the client's billing page as sebanceo@gmail.com, https://ads.google.com/aw/signup/payment?ocid=8614814876&ascid=8596781735&authuser=0, press **Create new payments profile**, enter the legal name Zodiix Pty Ltd, ABN 40 613 577 834, the registered address and a payment method, submit. (2) Claude on your word: publish the draft campaign and pause it, or leave it running a few days at A$1/day so the video shows spend (the script asks for recent spend; your call). (3) Dry run of the script on bizinsights.io with Claude, then you record the video, upload it unlisted, and paste the justification and link in the Verification Center. (Owner, with Claude) |
| Google Ads API access level | Completed (Explorer) | Explorer granted to insights-511119 on 2026-10-11: real accounts, 2,880 operations a day, which the syncs budget for. Developer tokens were retired by Google on 2026-09-09, so there is no token to get. | None now. (Owner) |
| Google Ads API **Basic** access | Pending (can be applied for) | Brand verification of the project is done (branding row, 2026-10-19). Only needed past roughly 60 busy accounts, so nothing is lost by waiting. | Google Ads API → Access levels → apply for Basic, with the draft answers in ads-review-packs.md ("Google Ads API > Access levels > Basic access"). If the page still shows brand verification as pending, give it a day or two. Then Claude sets `GOOGLE_ADS_DAILY_OPERATIONS` to the new figure. (Owner, then Claude) |
| AdSense Management API enabled | Completed | In use since 2026-10-10: AdSense connections sync in production. | None. |
| Publishing status "In production" | Completed | The consent screen is published (External), so anyone can sign in, not only test users. Re-check it shows "In production" before submitting. | Glance at Audience before submitting. (Owner) |
| `GOOGLE_ADS_OAUTH_VERIFIED` in bizinsights | Blocked (`adwords` verification above) | bizinsights shows merchants no note about Google's unverified-app screen, set or not: the cards' note went on 2026-10-24 (f1825418). The setting only changes what the API reports as `restricted` for Google Ads (`adsRestricted()`: `GET /api/workspaces/:ws/stores/:storeId/ads` and the config report). | After Google approves `adwords`: Claude sets `GOOGLE_ADS_OAUTH_VERIFIED` to `"1"` in `apps/aws/src/settings.ts` and ships it through `main`. (Claude, on your word) |
| Homepage section on Google data (https://bizinsights.io/#google-data) | Completed | Live since this branch's deploy (release 77, 2026-10-19): the served homepage holds the `google-data` section "Google Ads, Google AdSense and Meta Ads" (`AdPlatforms.tsx`, checked 2026-10-20). Documentation link 3 in the Google form points at it. | None. (Claude) |

### "Continue with Google" sign-in to bizinsights (separate from Google Ads)

| Requirement | Status | Why | Next action (who) |
| --- | --- | --- | --- |
| Sign in with Google in production | Completed (2026-10-19, release 75; open to the public since 2026-10-20) | `/api/auth/config` answers `"google":true`; a real Continue with Google sign-in (sebanceo@gmail.com) reached the dashboard. Re-checked 2026-10-20 from a browser signed in to no bizinsights account, after the project was published and its branding verified (rows below): Google's chooser shows the bizinsights logo, "to continue to bizinsights" and "bizinsights's Privacy Policy and Terms of Service", and goes on to the chosen account's own Google sign-in. | None. |
| A separate Cloud project for sign-in | Completed (published 2026-10-20) | Project `bizinsights-sign-in`: External, scopes openid/email/profile only, authorized domains bizinsights.io, amazoncognito.com and the pool's full amazoncognito.com host. Until 2026-10-20 its publishing status was **Testing with 0 test users**, so Google let only the project owner's account sign in and gave everyone else "Error 403: access_denied, the app is currently being tested". Audience → Publish app → Confirm, on the owner's word; it reads "In production" now. With these scopes no review was needed. | None. Never press "Back to testing": it would lock the public out again. |
| Its OAuth client and redirect URI | Completed | Web client "bizinsights sign-in" `567753266621-ltq5j5kij5s3em8gr0err3tbrh5fqciq.apps.googleusercontent.com`, redirect `https://insights-605411278365.auth.ap-southeast-2.amazoncognito.com/oauth2/idpresponse`. | None. |
| Its secret in AWS | Completed | `GOOGLE_SIGNIN_CLIENT_SECRET` in `insights/production/app` (2026-10-19). | None. |
| Its client id in the deploy | Completed | Production's `googleClientId` in `infra/cdk/lib/config.ts`, so every deploy keeps it. The GitHub variable `GOOGLE_SIGNIN_CLIENT_ID` on the `production` environment holds the same id and, while set, overrides it. | None. |
| Own sign-in domain `auth.bizinsights.io` | Completed (2026-10-20, release 81) | Polish rather than a requirement: Google's screen already names bizinsights (branding row below); with the own domain the address bar shows auth.bizinsights.io instead of amazoncognito.com during the hop. Done without an outage through the `inUse` switch of `cognitoCustomDomain` (`infra/cdk/lib/config.ts`): step one (PR #161) created the domain while sign-in stayed on the prefix domain; the DNS-only CNAME `auth` → `db11p1sm9fnn5.cloudfront.net` and the Google client's new origin and redirect URI were added in the owner's Chrome; step two (PR #164, release 81) moved sign-in over. Checked after the deploy: `/api/auth/oauth/google/start` sends to `https://auth.bizinsights.io/oauth2/authorize`, Cognito there sends Google `redirect_uri=https://auth.bizinsights.io/oauth2/idpresponse`, and a Google sign-in from a clean browser reached the dashboard. The certificate `b0849d46-…` (ACM us-east-1) renews by itself while its validation CNAME stays (aws-deployment.md, "Domain: bizinsights.io"). The prefix domain stays beside it, unused by the app. | None. The amazoncognito.com origin, redirect URI and authorized domains were removed from the Google client and consent screen on 2026-10-20; if they ever come back, nothing breaks, they are just unused. |
| Branding of the sign-in project (name and logo on Google's screen) | Completed (2026-10-20) | Google's screen shows an app's name and logo only after brand verification. In the owner's Chrome on 2026-10-20: the 120x120 green-bars logo (the one the Ads project passed with) uploaded through the browser's file input and saved (the form's "Discard changes" button looks like Save to the browser tools: the real Save is the form's submit button). Right after the project was published, the Branding page read "Your branding has been verified and is being shown to users" with nothing submitted. Checked from a browser signed in to nothing: the chooser shows the logo and "to continue to bizinsights". | None. Changing the name, logo or links later sends it back for verification. |
| New-user authorization limit (Google's per-project rate) | Pending (Google's review) | Google allows each project a number of first-time authorizations a day; the Overview page showed 10,000 for `bizinsights-sign-in`. On the owner's word, Claude submitted Google's "OAuth Application: Request Increase to New User Authorization Limit" form on 2026-10-20 (project `bizinsights-sign-in`, homepage https://bizinsights.io/, company email sales@ikorex.com.au, 100,000 a day requested, with the Shopify launch justification). Google answered "Your email has been sent", typically two business days. | Watch sales@ikorex.com.au and sebanceo@gmail.com for Google Cloud Platform Trust & Safety's reply and paste it to Claude; Google may ask questions or grant a smaller figure. (Owner) |

## Meta (developer app "Insights", App ID 971575545351940)

| Requirement | Status | Why | Next action (who) |
| --- | --- | --- | --- |
| Developer app | Completed (published) | Set up 2026-10-11: use case "Measure ad performance data with Marketing API", `ads_read` at Standard Access ("ready for testing"), Facebook Login for Business configuration 1521935306664882. In this state only people with a role on the app (admins, developers, testers) can connect; others see Facebook's "Feature Unavailable" (seen 2026-10-26 inside Nango's window, which opened this app's own login; bizinsights' own sign-in opens the same login, so the same page shows). Required actions: none (2026-10-26, and again 2026-11-02). | Add anyone who must test under App roles → Testers. (Owner) |
| Permissions and access levels | Completed (checked 2026-10-19; call counts 2026-10-26) | Use case "Measure ad performance data with Marketing API": `ads_read` Standard Access ("Ready for testing", **67 API calls** on 2026-10-26, so the "a successful call in the 30 days before submitting" rule is met), `public_profile` the same; `ads_management`, `business_management`, `pages_show_list` and `pages_read_engagement` are listed at Standard Access but bizinsights never asks for them (the Login configuration asks for `ads_read` alone). **Marketing API Access Tier: Limited** (52 calls on 2026-10-26; its Upgrade button needs 500 in 15 days, ads-review-packs.md step 18). The app is **published (Live)**: its Publish page lists the one use case and offers Unpublish. With `ads_read` at Standard Access that changes nothing for merchants: only people with a role on the app can grant it until Advanced Access. Since 2026-10-25 the app also has the use case "Connect with customers through WhatsApp" (WhatsApp's Cloud API option moved to this app, PR #248), whose `whatsapp_business_messaging` and `whatsapp_business_management` sit in the App Review draft too (row below). | Request Advanced Access for `ads_read` and `public_profile` (row below); leave the other ad and page permissions at Standard Access. (Owner) |
| Business portfolio | Changed (the app moved to **bizinsights.io**, seen 2026-10-26) | **The app is now on the portfolio "bizinsights.io" (ID 1415197520268134)**, created 2026-10-24: the app dashboard opens with that `business_id`, and Review → Verification (it has moved there from App settings → Basic) names it. The owner is its only admin. The Zodiix Pty Ltd portfolio below still exists, but the app is no longer on it, so its 2026-10-20 verification doesn't count for the app. **History, 2026-10-20:** a portfolio was created as **Zodiix Pty Ltd** under the app admin's Facebook account (sebanceo@gmail.com), business email sales@ikorex.com.au, website https://bizinsights.io, with the Business info from the ASIC certificate. The legal name is the entity on the register (ABN Lookup, 2026-10-20: ACN 613 577 834, ABN 40 613 577 834, Australian private company, GST-registered, main business location VIC 3977; registered business name "PixMagic" only). "bizinsights" is not a registered business name of that ABN, and the "Bizinsights Pty Ltd" on the register (ABN 89 156 153 196, QLD 4740, since 2012) is an unrelated company. The "Testbusiness" portfolio (1754818672920174) is the other Facebook account's (imeseban@gmail.com, WhatsApp app) and plays no part. On 2026-10-20 the app was connected to Zodiix Pty Ltd (App settings → Basic → Verification named it with verification pending, confirmed by the owner). | Add a second admin to bizinsights.io (Business settings → Users → People) so one locked account can't stop the app. (Owner) |
| Business Verification | **Completed (Verified, seen 2026-10-26; still so 2026-11-02)** | The app's Review → Verification reads "bizinsights.io, ID 1415197520268134, **Verified**". Earlier the same day it read Incomplete ("Pending submission" in the portfolio's Security Center, started 2026-10-25); the owner then submitted it and Meta approved it. The verification submitted 2026-10-20 was for the Zodiix Pty Ltd portfolio, which the app no longer uses. | None. App Review and Access Verification (rows below) can be submitted now. (Owner, done) |
| Access Verification (Tech Provider) | **Pending: submitted 2026-10-26, still in review on 2026-11-02** | Needed on top of App Review: `ads_read` is on Meta's Access Verification list, and without it calls with `ads_read` fail for anyone without a role on the app even after App Review passes. Meta's deadline was 12/25/2026 and reads **1/1/2027** on 2026-11-02 ("to avoid restrictions to 1 app"). Submitted by Claude in the owner's Chrome on the owner's word: business type **SaaS Platform**; the Platform Data text under "Access Verification (Tech Provider)" in ads-review-packs.md, word for word; manages multiple business portfolios **No** (the owner's answer: bizinsights runs no client's portfolio; the older Zodiix Pty Ltd portfolio wasn't listed); website https://bizinsights.io. The page now reads Submitted → In review: "We're reviewing your submission and will reach out within 5 days if we need more information." On 2026-11-02 it still read Submitted, In review since 2026-10-26. | Watch the page (https://developers.facebook.com/1415197520268134/access-verification/), the developer notifications and sebanceo@gmail.com; answer any question from Meta. (Owner) |
| App settings on bizinsights.io | Completed | Seen 2026-10-19 in App settings → Basic: app domain `bizinsights.io`, privacy https://bizinsights.io/privacy, terms https://bizinsights.io/terms, user data deletion = callback URL (row below), app icon uploaded; site URL https://bizinsights.io/ saved the same day. All still so on 2026-10-26, contact email sebanceo@gmail.com (App Review notices go there). **Display name "bizinsights"** since 2026-10-26 (was "Insights"; changed by Claude on the owner's word, "Changes saved", still so after a reload), so Facebook's screen names bizinsights like everything else. | Leave the Basic settings as they are until App Review is decided: changing them after submitting may need a new review. (Owner) |
| Facebook Login for Business redirect URI | **Completed (confirmed working 2026-10-28)** | `https://bizinsights.io/api/ads/meta/callback` is where Facebook sends the browser back since bizinsights does its own sign-in again (2026-10-28). The old workers.dev entry was removed 2026-10-20 (its ×, then **Save Changes**, confirmed after a reload); on 2026-10-22 Nango's `https://bizinsights.io/api/ads/nango/oauth-callback` was added next to the Meta callback, and both were listed after a reload. On 2026-10-28 (release 128) Continue with Meta Ads came back to it and connected twice, at 17:13Z and 18:17Z (audit log `ads.connected`, provider meta; the account synced and its report loaded), so Facebook accepts it. **Dashboard quirk:** typing an address into Valid OAuth Redirect URIs or App domains and pressing Enter shows a chip and "Changes saved" but keeps nothing; type it, click the suggestion that appears under the field, then Save Changes. **2026-11-02:** Nango's `https://bizinsights.io/api/ads/nango/oauth-callback` removed on the owner's word (its ×, then **Save Changes**); after a reload Valid OAuth Redirect URIs list `https://bizinsights.io/api/ads/meta/callback` and `https://bizinsights.io/`. | Keep it. (None) |
| Deauthorize and data deletion callbacks | Completed | Registered 2026-10-19 in Facebook Login for Business → Settings (Deauthorize callback URL `https://bizinsights.io/api/webhooks/meta/deauthorize`, Data Deletion Request URL `https://bizinsights.io/api/webhooks/meta/data-deletion`), both still there after a reload, and both set on 2026-11-02. App settings → Basic → User data deletion switched to "Data deletion callback URL" with the same URL by itself. Before registering, an unsigned POST to each answered 401 in production (signature checked: code and `META_APP_SECRET` both in place). | None. If a URL ever changes, register it again the same way. (Claude on your word) |
| Require App Secret | Completed | On since 2026-10-19 (App settings → Advanced → Security), confirmed after a reload. Release 77 proves every call made with a person's token with `appsecret_proof` (`packages/core/src/metaGraph.ts`), so Meta syncs keep working. | Leave it on. A Meta sync failing with "requires an appsecret_proof" means the code regressed, not the switch. (Claude) |
| App Review: Advanced Access to `ads_read` (and `public_profile`) | **Pending: not submitted** (Business Verification no longer blocks it, 2026-10-26; still Not submitted 2026-11-02) | The one step that lets people without a role on the app connect. App Review submissions page, late 2026-10-26: **Not submitted**; the draft's new requests are now **`ads_read` and `public_profile` only** (both still so on 2026-11-02). **Decided 2026-10-26: this submission is those two alone.** On the owner's word Claude removed `whatsapp_business_messaging` and `whatsapp_business_management` from the draft the same evening (bin icon, "Yes, remove"; still gone after a reload). They stay on the app's WhatsApp use case: they serve the Cloud API option (whatsapp.md, "Owner's steps (Cloud API)"), need a recording of their own, and are re-added to a later submission from that use case's Customize page (ads-review-packs.md, Meta pack, "Remaining gaps" says why). `ads_read` has its successful calls (67): the first production connect worked on 2026-10-26 (login sebanceo, ad account "Sebastian Thomas" act_2033403030827115). That ad account has never delivered an ad, so every figure is 0: a recording of it shows no ad data, which Meta names as a rejection reason. Texts, video script and reviewer instructions are in ads-review-packs.md (Meta pack), updated 2026-10-28 for bizinsights' own Facebook Login. **The usage description pasted 2026-10-26 names Nango and must be replaced** before submitting. | In this order: (1) give the login an ad account with delivery (run a small ad for a few days, or have an ad account that runs ads assigned to it), so the recording shows figures; (2) create the reviewer account in production with a development store connected (Meta pack step 8); (3) record the screencast (step 11); (4) App Review → the draft (submission 980737984435696): Allowed usage → ads_read: replace the usage description pasted 2026-10-26 (it names Nango) with the new text, upload the recording there and tick both agreements (ads_read, public_profile: Meta asks public_profile for nothing else); fill Reviewer instructions; answer Data handling (only you can) → Submit. Meta aims to answer within a week. (Owner) |
| Let every merchant connect in bizinsights | Blocked (App Review and Access Verification above) | bizinsights' side is ready: the Meta card on bizinsights.io offers "Continue with Meta Ads" and a connect works end to end (2026-10-26). Until Meta grants Advanced Access, only people with a role on the app get past Facebook's screen; anyone else gets Facebook's "Feature Unavailable", which never reaches bizinsights. `META_ADS_ADVANCED_ACCESS` only changes what the API reports (`restricted.meta`), never who can connect. | After Meta grants Advanced Access and passes Access Verification: Claude sets `META_ADS_ADVANCED_ACCESS` to `"1"` and ships it through `main`. The app is already published, so nothing else is switched on. (Claude on your word) |

## AWS

| Requirement | Status | Why | Next action (who) |
| --- | --- | --- | --- |
| Provider secrets in production (`META_APP_SECRET`, `GOOGLE_ADS_CLIENT_SECRET`) | Completed | `GOOGLE_ADS_CLIENT_SECRET` stored 2026-10-19 (a new secret on "Insights web"; until then AWS had none, so Google Ads/AdSense never worked on bizinsights.io). An AdSense connection then completed in production. `META_APP_SECRET` is there too since 2026-10-19 evening: `put-secrets.mjs --dry-run` lists the key and the Meta callbacks answer 401, not 503, so the running functions see it. | None. (Owner, done) |
| This branch deployed | Completed | On production since release 77 (built from `ee7206c`, which includes it): the Meta callbacks answer and the deploy applied migration `20261019120000_ad_connection_health`. | None. (Claude) |
| Meta API version | Completed | v26.0 since this branch. The build fails 90 days before a version's end, so a red build is the reminder. | Re-read Meta's changelog by 2027-04-17 (ads-setup.md, "Keeping the API versions current"). (Claude) |

## Leaving Nango (since 2026-10-28 bizinsights signs in with the ad platforms itself again: [ads-setup.md](ads-setup.md#leaving-nango))

From 2026-10-22 to 2026-10-28 every ad platform's sign-in went through Nango, which kept the tokens. Nango's plan,
connection limit and Pay-as-you-go don't matter any more: nothing connects through Nango now, and its last
connections were moved off it on 2026-10-28.

| Requirement | Status | Why | Next action (who) |
| --- | --- | --- | --- |
| bizinsights' own sign-in with Meta Ads, Google Ads and AdSense | Completed (pull request #274, live as release 127 since 2026-10-28 16:47Z) | Facebook Login for Business (`META_CONFIG_ID`) and Google OAuth with PKCE, single-use state bound to the browser and the person, tokens sealed in bizinsights' own database (ads-setup.md, "How connecting works"). The grant is to the same Meta app and Google client as through Nango, so App Review and Google's verification (rows above) are unchanged. | None. |
| Connections made through Nango moved off it | Completed (2026-10-28 17:00Z) | Release 127's */15 tick read each Nango connection's tokens from Nango, tried them without it, sealed them on bizinsights' own rows and deleted the connection at Nango. The grant didn't change and merchants did nothing. The 17:00Z tick logged `ad connections moved off Nango` with `moved: 4, failed: 0, waiting: 0, ended: 0, left: 0` (ads-setup.md, "Leaving Nango"). | None. |
| Meta redirect URI `https://bizinsights.io/api/ads/meta/callback` | **Completed (confirmed working 2026-10-28)** | Listed in Valid OAuth Redirect URIs next to the Nango callback on 2026-10-22 (Facebook Login for Business row above). On 2026-10-28 Continue with Meta Ads came back to it and connected, at 17:13Z and again at 18:17Z. | None. Keep it. |
| (a) Remove the move code | **Completed (release 131, 2026-10-30)** | Pull request #279 (a5e1785f), merged through #290 (691eceb7), took out the move (`leaveNango.ts`), what was left of the Nango client, `NANGO_SECRET_KEY` / `NANGO_API_URL` and the old redirect `/api/ads/nango/oauth-callback`, needed only until `left: 0`. On 2026-11-02 (production on release 151) `/api/ads/nango/oauth-callback` and `/api/webhooks/nango` answer 404. The columns that named Nango connections stayed: `ad_connections.source` is still used, the other three go in two releases (ads-setup.md, "Database"). | None. (Claude, done) |
| (b) Delete `NANGO_SECRET_KEY` and `NANGO_WEBHOOK_SECRET` from Secrets Manager `insights/production/app` | Pending: can be done now | `put-secrets.mjs` only sets or replaces keys, so this is done in the AWS console (Retrieve secret value → Edit → remove the two rows → Save). Nothing reads either since (a) went live. | Step (b). (Owner) |
| (c) Clean up Nango (app.nango.dev, prod) | Pending: can be done now | Its integrations hold copies of bizinsights' Meta app secret and Google client secret. | Check Connections holds none for the three ad integrations (nor for the retired `whatsapp-business`, whatsapp.md); remove the Callback URL and Webhook URL; delete `bizinsights-meta-ads`, `bizinsights-google-ads`, `bizinsights-google-adsense` and `whatsapp-business`; delete the account once nothing else uses it (step (c)). (Owner) |
| (d) Remove `https://bizinsights.io/api/ads/nango/oauth-callback` at Meta and Google | **Completed (2026-11-02)** | Registered 2026-10-22 in Facebook Login for Business and on "Insights web". No release since bizinsights left Nango sends it. Removed from both by Claude on the owner's word on 2026-11-02, each checked on a fresh load (the Facebook Login for Business row above and "Redirect URIs on Insights web"); `/api/ads/{meta,google,adsense}/callback` kept. Google says a change can take 5 minutes to a few hours to apply. | None. (Claude, done) |
| Figures checked against the platforms | Open | One AdSense account connected through Nango on 2026-10-22 (deactivated at AdSense: all zero, matching AdSense); no account with real figures compared yet. The cron now checks every working Meta and AdSense account once a day: a settled week of stored figures against one account-level read of the platform's API for the same days, currency and attribution, logged as `ad figures match the platform` or `ad figures differ from the platform` (alarm `ad-figures-differ`; ads-setup.md, "Checked against the platform"). That compares bizinsights with the API, not with what Ads Manager shows; Google Ads isn't checked that way (its daily allowance). | Once it is live, read the cron log's first `ad figures match the platform` lines. Connect one real account of each platform and compare a week of figures with Ads Manager, Google Ads and AdSense for the same dates, time zone and currency. (Owner with Claude) |

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
4. **Done 2026-10-26.** Meta verified the business portfolio bizinsights.io, the one the app is on.
5. **You, now (Meta, anyone can connect).** Access Verification was submitted 2026-10-26 (still in review on
   2026-11-02; Meta's deadline now reads 1/1/2027) and the display name is "bizinsights" (their rows). For App Review: an ad account with delivery on your Facebook login, the reviewer
   account in production, the screencast, the ads_read usage description replaced (the 2026-10-26 one names Nango),
   then submit `ads_read` and `public_profile` (the draft holds only those two since 2026-10-26; App Review row; texts
   and script in ads-review-packs.md).
6. **You, now: leave Nango.** Meta's redirect URI `/api/ads/meta/callback` works (a Meta connect came back to it on
   2026-10-28), the move logged `left: 0` at 17:00Z that day, and step (a), the pull request that removed Nango's
   code, is live since release 131 (2026-10-30). Leaving Nango's steps (b) and (c), in that order (ads-setup.md,
   "Leaving Nango"); step (d), the redirect URIs, was done on 2026-11-02.
7. **After each approval.** Claude flips `GOOGLE_ADS_OAUTH_VERIFIED` or `META_ADS_ADVANCED_ACCESS` and ships it.
8. **Any time, optional.** Google Ads API Basic access (draft answers in ads-review-packs.md).
9. **Contact address, checked 2026-10-23.** bizinsightsaus@yahoo.com since 2026-10-22: the website (live
   release 97), `security.txt` (Cloudflare's own copy switched off), the AWS budget, the daily cost email and
   Cost Anomaly Detection use it. Outside the code:
   - Shopify Partners (Pixmagic 5229240): the account's emails never were sales@ikorex.com.au (business
     sebanceo@gmail.com, support and emergency imeseban@gmail.com), and review emails for the App Store app
     (cf5c717d) go to imeseban@gmail.com. Only the listing's support email still says sales@ikorex.com.au, and
     Shopify locks the listing during review: change it on **Submit fixes** or after approval
     (listing-copy.md has the new text). Never Withdraw to edit it.
   - **You:** the Meta portfolio's business email (Business settings → Business info); Claude doesn't automate
     Meta's business pages.
   - **You:** Google Cloud's consent-screen contacts in `bizinsights-sign-in` and `insights-511119`, if either still
     names sales@ikorex.com.au (Branding → Developer contact information takes any address; the user support
     email only the signed-in account or a Group).
   - Answers to what was already sent from sales@ikorex.com.au (Google's new-user limit, Meta's verification)
     still arrive there.
