# Review packs: Google OAuth verification and Meta App Review

Paste-ready material for the two reviews that open Google Ads and Meta Ads to every merchant. Drafted on
2026-10-11 from the official requirements and the code, then checked by an independent reviewer against
developers.google.com / support.google.com and developers.facebook.com. Requirements change: re-read the linked
sources before submitting. Anything marked "(unverified)" could not be confirmed from an official page.

Updated 2026-10-19 for the app's own domain. The app runs on AWS at **https://bizinsights.io** (since 2026-10-16;
CloudFront `d2mr8m2p1qkh58.cloudfront.net` behind Cloudflare's proxy), and every URL below uses it. Page requests on
the cloudfront.net address and on www get a 301 to bizinsights.io. The OAuth callbacks are built from `APP_URL`
(`adsRedirectUri` in `packages/core/src/adConnections/config.ts`, `emailRedirectUri` in
`packages/core/src/email/oauth.ts`), so since that deploy the app sends only `https://bizinsights.io/api/...` as its
redirect URI. Google and Meta must have exactly those registered, or Connect fails with a redirect mismatch. Of the
old addresses, only the old Cloudflare Worker's two workers.dev redirect URIs on the Google client "Insights web" remain
(kept until the old Worker is retired); Meta holds the bizinsights.io callback alone since 2026-10-20.

## Where things stand (2026-10-20)

Done:

- **Domain.** bizinsights.io is registered at GoDaddy, its DNS is at Cloudflare (zone `bizinsights.io`, nameservers
  `noel.ns.cloudflare.com` and `rosalyn.ns.cloudflare.com`; see [aws-deployment.md](aws-deployment.md#domain-bizinsightsio)),
  and the app has lived there since 2026-10-16.
- **Public pages.** `https://bizinsights.io/`, `/privacy`, `/terms`, `/data-deletion` and `/support` all return 200,
  with no redirect and no login (checked 2026-10-19). The homepage footer's Privacy link is `/privacy`.
- **Brand.** The homepage and every other page say "bizinsights" (renamed 2026-10-16, PR #26). The page title is
  "bizinsights — Shopify Business Intelligence".
- **Contact facts.** `apps/web/src/lib/contact.ts` was filled in on 2026-10-16 and corrected on 2026-10-20 (PR #152):
  legalName "Zodiix Pty Ltd", companyNumber "ACN 613 577 834" (from the ASIC certificate of registration dated
  11 July 2016), supportEmail bizinsightsaus@yahoo.com (sales@ikorex.com.au until 2026-10-22), jurisdiction Victoria, Australia. postalAddress is blank, and the
  pages leave it out. `/support` shows bizinsightsaus@yahoo.com, and no page shows a "[not set" marker or the
  "incomplete" banner. ABN Lookup (2026-10-20) agrees: Zodiix Pty Ltd, ABN 40 613 577 834, active from 11 Jul 2016,
  GST-registered from 1 Jul 2017, main business location VIC 3977, registered business name "PixMagic" (19 Jul 2016).
- **/privacy covers Google user data.** Its section "Google user data" (`#google-user-data`) carries the Limited Use
  statement. "Advertising accounts" (in section 3, `#optional-features`) lists what is read from Google Ads and
  AdSense; says bizinsights keeps Google's account ID and the permissions granted with each connection; says
  Disconnect deletes the token and figures and gives Google's access back only with the last connection that uses
  that Google sign-in; and says that removing access at Google marks the account "Needs reconnecting" and keeps the
  figures until Disconnect.
- **/data-deletion covers Google.** Disconnecting Google Ads and AdSense (with the conditional revoke), removing
  access at myaccount.google.com, and deletion by email.
- **Terms.** `/terms` has existed since 2026-10-16.
- **Search Console Domain property for bizinsights.io**: verified on 2026-10-19 (DNS TXT record in Cloudflare).
- **The homepage explains the Google data.** The section "Google Ads and Google AdSense" (`id="google-data"`,
  `apps/web/src/components/landing/AdPlatforms.tsx`) says what is read from Google Ads, AdSense and Meta Ads and why,
  that Disconnect deletes the tokens and figures, and carries the Limited Use sentence. Live at
  https://bizinsights.io/#google-data since release 77 (2026-10-19). A build test keeps it on the page.
- **Meta's deauthorize and data deletion callbacks** are live (release 77) and registered in the app (2026-10-19):
  `https://bizinsights.io/api/webhooks/meta/deauthorize` and `https://bizinsights.io/api/webhooks/meta/data-deletion`.
  The ads calls send `appsecret_proof`, and "Require App Secret" is on.
- **Google Cloud.** Explorer access granted (2026-10-11); `adwords` and `adsense.readonly` under Data Access with the
  justification; authorized domain bizinsights.io, the bizinsights.io redirect URIs on "Insights web", and branding
  verified and published (2026-10-19).
- **Meta.** App "Insights" (971575545351940) set up 2026-10-11 with an icon, app domain, privacy policy, data
  deletion page, Facebook Login for Business configuration and the app secret; every URL moved to bizinsights.io on
  2026-10-19, and the workers.dev redirect URI was removed on 2026-10-20. From 2026-10-22 to 2026-10-28 the ad
  sign-ins went through Nango; since 2026-10-28 bizinsights signs in with Meta and Google itself again, and Facebook
  sends the browser back to `https://bizinsights.io/api/ads/meta/callback` (listed next to Nango's callback on
  2026-10-22; a Meta connect came back to it on 2026-10-28: [ads-setup.md](ads-setup.md#leaving-nango), step (e)).
  Nango's `https://bizinsights.io/api/ads/nango/oauth-callback` was removed from Valid OAuth Redirect URIs on
  2026-11-02 (left: `/api/ads/meta/callback` and `https://bizinsights.io/`), and from Google's "Insights web" the same
  day (step (d) there). For where Meta stands today, start at "Readiness on 2026-11-02" in the Meta pack below.

Still open (details in each pack; checked 2026-10-20). Each of these needs the owner's login, certificate or payment
method; Claude has nothing left to do alone until one of them moves.

- **A Google Ads account with figures for the demo.** On the demo login sebanceo@gmail.com the manager account
  bizinsights 892-467-3464 is finished (Australia, Sydney Time, AUD), but managers hold no campaigns, and the client
  bizinsights 745-450-4478 under it stays "Setup in progress" until a payments profile exists on its billing page
  (legal name, address, payment method: owner only). Its draft Search campaign (A$1/day, Page views goal) publishes
  after that. Until then bizinsights' connect gets CUSTOMER_NOT_ENABLED for the client. Google step 10.
- **The demo video and the Verification Center submission.** Script, justification and reviewer text are below; the
  owner records, uploads (unlisted) and submits. Google steps 11 to 13.
- **Meta Business Verification is not done for the app's portfolio (re-read 2026-10-26).** The app now sits on the
  portfolio **bizinsights.io** (1415197520268134), whose verification for Zodiix Pty Ltd was started on 2026-10-25 and
  reads "Pending submission" in its Security Center: the owner presses Continue and submits it
  ([integrations-readiness.md](integrations-readiness.md), Business Verification row). The 2026-10-20 history below is
  for the separate Zodiix Pty Ltd portfolio, which the app no longer uses.
- **History, 2026-10-20.** The portfolio **Zodiix Pty Ltd** was created on 2026-10-20 under the
  app admin's Facebook account (sebanceo@gmail.com), the phone code was confirmed and the ASIC certificate uploaded
  the same day; Meta decides in its own time (usually days) and reports under Security Center. Entity facts (ABN
  Lookup, 2026-10-20): ACN 613 577 834, ABN 40 613 577 834, GST-registered, main business location VIC 3977,
  registered business name "PixMagic" only; "bizinsights" is not a registered business name of that ABN, and
  "Bizinsights Pty Ltd" (ABN 89 156 153 196, QLD 4740, since 2012) is an unrelated company. "Testbusiness"
  (1754818672920174) is the other Facebook account's portfolio (imeseban@gmail.com, with the app "pixmagic" WhatsApp
  used before 2026-10-25). While Meta
  decides: the reviewer account, the owner's own Meta Ads connection in production and the screencast (Meta steps
  8, 9 and 11); then App Review and Access Verification.
- **No mailbox on bizinsights.io.** The zone has no MX record, so no @bizinsights.io address receives mail. The
  support and contact address is bizinsightsaus@yahoo.com, which is fine for Google. For Meta's Business Verification,
  confirm by phone: on 2026-10-20 Meta offered only phone or email for this business (no domain record), and email
  lists only addresses at bizinsights.io. Fallback if phone fails: Cloudflare Email Routing for bizinsights.io to
  bizinsightsaus@yahoo.com, which Claude sets up on the owner's word. Meta step 6.
- **The Limited Use paragraph is short.** `#google-user-data` says Google data is used only for the merchant's own
  reports and emails, isn't sold, isn't used for advertising and isn't read by people. That paragraph doesn't say
  the data isn't transferred except to the listed service providers, or that it isn't used to train AI or
  machine-learning models ("How we use information" says the latter for all data). Replacement wording is in the
  Google form answers. Optional.
- **A separate development Cloud project** (Google step 5, owner only). Not a blocker for the review.

## Google: Google OAuth verification pack (corrected 2026-10-11, URLs updated 2026-10-19): sensitive scope https://www.googleapis.com/auth/adwords plus non-sensitive https://www.googleapis.com/auth/adsense.readonly for "bizinsights" (Cloud project insights-511119, OAuth client "Insights web")

### Remaining gaps (fix before submitting; checked 2026-10-20)

No longer gaps: the privacy policy's disclosures (Google account ID, granted permissions, conditional revoke, what
happens when access is removed at Google), the Google section of /data-deletion, a real support address on /support,
the homepage brand "bizinsights" and its `#google-data` section (live since release 77), /terms, `CONTACT.legalName`
(Zodiix Pty Ltd, ACN 613 577 834, since PR #152), the authorized domain bizinsights.io, the bizinsights.io redirect
URIs on "Insights web", and branding (verified and published 2026-10-19 with the 120x120 green-bars logo).

- The demo Google Ads account (step 10): manager bizinsights 892-467-3464 on sebanceo@gmail.com is finished but holds no campaigns; client bizinsights 745-450-4478 under it is "Setup in progress" until the owner creates a payments profile on its billing page (https://ads.google.com/aw/signup/payment?ocid=8614814876&ascid=8596781735&authuser=0). Then its draft Search campaign (A$1/day) can be published; pause it, or let it run a few days so the video shows spend (owner's call). Don't create more accounts: the two stray "Setup in progress" ones (133-520-0897, 944-886-6737) can be removed from the account chooser.
- Reviewer and demo setup: a bizinsights login with the owner or admin role on an active (not frozen) Shopify store, that Google Ads account, and an AdSense account (sebanceo@gmail.com has had one connected in production since 2026-10-19; disconnect it before recording).
- Video: disconnect AdSense before Google Ads so the revoke narration is true. bizinsights' own 'Continue with Google' sign-in (Amazon Cognito, Cloud project bizinsights-sign-in) has been on in production since 2026-10-19 (release 75): don't record it, it is a different client and not part of this review. Sign in to bizinsights by email for the recording.
- Owner decision on the unverified period: production already requests adwords, and each new merchant uses one of the 100 lifetime user slots, which cannot be reset (1 of 100 used on 2026-10-19).
- Finalise branding before submitting: changes are not permitted while verification is in progress.
- OAuth 2.0 Policies: you 'must' use separate Cloud projects for each deployment tier, and delete OAuth clients that are not ready for production (sensitive-scope page and FAQ). Move any localhost redirect out of insights-511119 (step 5). The old Cloudflare Worker's two workers.dev redirect URIs still on 'Insights web' did not stop branding verification; remove them when the old Worker is retired (refresh tokens don't use a redirect URI, so connections made there keep syncing).
- Data at rest (User Data Policy): production data is in Amazon RDS with storage encryption on (`infra/cdk/lib/data-stack.ts`). The old Cloudflare deployment's database on the owner's PC still holds that deployment's data until it is retired: close the 2026-10-10 exposure there (firewall, rotated non-default credentials) or retire it before attesting that data is secure at rest.
- Optional: tighten the Limited Use paragraph on /privacy (wording in the form answers).

### Before you submit

1. [DONE 2026-10-16] Domain. bizinsights.io (GoDaddy registrar, Cloudflare DNS) is a CloudFront alternate domain name with its ACM certificate (`infra/cdk/lib/config.ts`, `infra/cdk/lib/app-stack.ts`) and the app's address: APP_URL, API_URL and Cognito's callback all use it, so sign-in cookies, the host-bound OAuth state cookie and the Google callback share one host. Page requests on www and the cloudfront.net address get a 301 to bizinsights.io; the homepage itself never redirects. Why it was needed: Google checks the top private domain, 'the domain component available for registration on a public suffix' (developers.google.com brand-verification), and cloudfront.net is on the Public Suffix List, so a cloudfront.net address can't be verified.
2. [DONE 2026-10-19] Search Console DOMAIN property for bizinsights.io. Kept for reference. Google verifies authorized domains only as a Search Console DOMAIN property (DNS-level), and the verification must be done by a Google account that is currently a Project Owner. A 'URL prefix' or 'Site' property, or an HTML file or tag, does not count (support.google.com/cloud/answer/13804266). Google's pages differ (Owner, or Owner or Editor), so use Owner.
   1. Open https://search.google.com/search-console signed in with the Google account that is Owner of insights-511119.
   2. Add property -> Domain -> `bizinsights.io` -> Continue. Copy the TXT value Google shows (`google-site-verification=...`).
   3. Cloudflare dashboard (account Tangoenery2004@gmail.com) -> zone bizinsights.io -> DNS -> Records -> Add record: Type `TXT`, Name `@`, Content the copied value, TTL Auto -> Save. Add it at Cloudflare, not on GoDaddy's DNS page: the nameservers are Cloudflare's, so records at GoDaddy are never served.
   4. Check that it is served: `nslookup -type=TXT bizinsights.io noel.ns.cloudflare.com`. Then press Verify in Search Console.
   5. Never remove the record: Search Console keeps re-checking it. Keep the HTML tag in `apps/web/src/app/layout.tsx` too; it verifies the old URL-prefix property.
3. [DONE 2026-10-16] Legal and contact facts in `apps/web/src/lib/contact.ts` (see "Where things stand"; check legalName). Google: 'Do not submit a template, example, or sample privacy policy.'
4. [DONE, except two optional items] Pages. `/terms` is live: Cloud 'Manage OAuth App Branding' says homepage, privacy and terms links 'are required for all external production apps' and you 'will not be able to submit' without them. The brand is 'bizinsights' everywhere: Google requires the homepage to 'Accurately represent and identify' the app, and the consent-screen name must match the submission. `/privacy` and `/data-deletion` carry the Google disclosures. The homepage loads with no redirect and no login, and its Privacy link is exactly https://bizinsights.io/privacy. (a) [DONE in code, live with this branch's deploy] the homepage section 'Google Ads and Google AdSense' (`id="google-data"`, `apps/web/src/components/landing/AdPlatforms.tsx`); the owner approves its wording. Optional: (b) the longer Limited Use paragraph for `/privacy#google-user-data`, text in the form answers. Both are code changes to `apps/web` that ship through `main`; the owner approves the wording.
5. [OWNER ONLY] Development project. Google's OAuth 2.0 Policies say 'you must create separate projects in the Google Cloud Console for each deployment tier'. Create a dev project with its own OAuth client for `<APP_URL>/api/ads/<provider>/callback` of the local server you run (http://localhost:8787 for the usual local server, http://localhost:8789 for the ads demo) and point apps/aws/.env at it; Claude can update the docs. Its Google Ads API access level starts at Test, which works with test accounts only. In insights-511119, delete every OAuth client except 'Insights web': 'Delete any OAuth clients not ready for production'.
6. [OWNER ONLY, after step 2] Google Auth Platform, in this order: (i) Branding -> Authorized domains: add `bizinsights.io` first. Google: 'Add your Authorized Domains before you add your redirect or origin URIs, your homepage URL...'. (ii) Clients -> 'Insights web' (534794119904-9esdp8dhskcupf6ekbb0iej2dr10gomf.apps.googleusercontent.com): keep https://bizinsights.io/api/ads/google/callback and https://bizinsights.io/api/ads/adsense/callback, where bizinsights' own sign-in comes back (both accepted on 2026-10-28). Nango's old https://bizinsights.io/api/ads/nango/oauth-callback was removed on 2026-11-02 (docs/ads-setup.md, "Leaving Nango", step (d)). Remove the URIs on the old Cloudflare Worker's workers.dev host and on `d2mr8m2p1qkh58.cloudfront.net`, every localhost URI and any JavaScript origins (the flow is server-side, so none are needed). (iii) Branding: app name 'bizinsights' (lower case, as on the homepage), support email, logo, homepage https://bizinsights.io/, privacy https://bizinsights.io/privacy, terms https://bizinsights.io/terms, and the developer contact. Remove every authorized-domain entry other than bizinsights.io. (iv) Press Verify Branding: the automated check takes minutes, and a manual review usually takes 2-3 business days. (v) Press Publish branding within 7 days; after that the status becomes 'Need to re-verify'. The app name shows on the consent screen only after verification, and data-access verification needs published branding, so finish this before recording.
7. [OWNER ONLY] Data Access. Scopes must be exactly https://www.googleapis.com/auth/adwords (sensitive) and https://www.googleapis.com/auth/adsense.readonly (non-sensitive). The Google Ads API page 'Secure your credentials' (updated 2026-09-30) says the scope 'is classified as a restricted scope'. If the console lists it as Restricted, an annual third-party (CASA) security assessment applies and the timeline is weeks. The console's category is what counts. Keep the Gmail sender off this client until this review is done: `EMAIL_GOOGLE_CLIENT_ID` is empty today, and putting it on 'Insights web' would add a third consent flow and the sensitive `gmail.send` scope to the review ([email.md](email.md#5-google-gmail--google-workspace-setup)).
8. [OWNER DECISION] The unverified period. Production already requests adwords (GOOGLE_ADS_ENABLED "1"), so merchants see 'Google hasn't verified this app', and each new user counts toward the 100-user cap, which 'applies over the entire lifetime of the project, and it cannot be reset or changed'. Keep the flow on, because reviewers test the live flow, and watch cap usage in the console.
9. [OWNER ONLY] Security. Google's User Data Policy: 'We expect all user data is secure in transit and at rest.' Production data is in Amazon RDS with storage encryption on. Before attesting, close the 2026-10-10 exposure of the old deployment's database on the owner's PC (firewall, and recreated or rotated non-default credentials), or retire that deployment. Its status is unverified.
10. [OWNER ONLY] Demo and reviewer data. (a) A Google account with access to at least one REAL Google Ads account with recent spend; Explorer access allows production accounts. (b) An AdSense account for the second flow. (c) A bizinsights demo user who is an owner or admin of a workspace with an ACTIVE Shopify store connected (not the frozen 9kdgux-gq), signed in with email. (d) A separate reviewer login with the same setup, sent only by email reply if asked. (e) Disconnect any existing Google Ads or AdSense connection for the store. (f) Set the browser and Google account to English.
11. [OWNER, with Claude's help] A dry run of the whole script on https://bizinsights.io, including the disconnect order. Check that disconnecting AdSense reports 'still_used' and the final Google Ads disconnect reports 'revoked'; the outcome is in the API response and the audit log.
12. [OWNER ONLY] Record the video (script below) and upload it in YouTube Studio with Visibility = Unlisted. Check that it plays in a signed-out window.
13. [OWNER ONLY] Google Auth Platform -> Verification Center. Request data-access verification. Declare both scopes under 'Add or remove scopes', paste the justification and YouTube link, add up to three documentation links, and submit. Do not change branding while the review runs: 'Branding modifications are not permitted while verification is in progress'.
14. [OWNER ONLY] Watch the developer-contact and support-email inboxes. Trust & Safety follows up by email and may pause the review until you answer. Reply to the latest email they sent, and resubmit only after every issue is fixed.

### Form answers (paste as written)

**Audience -> User type / Publishing status**

> External / In production (already published; check before submitting).

**Branding -> App name**

> bizinsights   (lower case, identical to the homepage brand; no Google product names)

**Branding -> User support email**

> bizinsightsaus@yahoo.com   (CONTACT.supportEmail in apps/web/src/lib/contact.ts, the address /privacy and /support show). Google says it is shown to users on the consent screen, and you should monitor it regularly. The console lists only the signed-in account's email or a Google Group that account manages (console behaviour; I did not see it on the help pages I read). A Yahoo address is offered only if it is the signed-in Google account's own address: add a Google account under bizinsightsaus@yahoo.com as an Owner or Editor of insights-511119 and sign in with it, or use a Google Group. There is no mailbox on bizinsights.io (no MX record), so don't use an @bizinsights.io address.

**Branding -> App logo (optional)**

> The bizinsights mark as a square PNG, 120x120 px, 1 MB or less (JPG, PNG and BMP are accepted). It must match the mark on the homepage and contain no Google icons or product names. A later logo change can require re-verification.

**Branding -> Application home page**

> https://bizinsights.io/   (loads without login or redirect, says 'bizinsights' and describes the app: checked 2026-10-19. Its 'Google Ads and Google AdSense' section, https://bizinsights.io/#google-data, ships with this branch's deploy.)

**Branding -> Application privacy policy link**

> https://bizinsights.io/privacy   (exactly the same URL as the homepage's Privacy link)

**Branding -> Application terms of service link**

> https://bizinsights.io/terms   (live since 2026-10-16)

**Branding -> Authorized domains**

> bizinsights.io   (added FIRST, and verified as a Search Console DOMAIN property by the Project Owner: step 2. Remove every other authorized domain, such as an old workers.dev or cloudfront.net entry, once no redirect URI uses it.)

**Branding -> Developer contact information**

> OWNER MUST SUPPLY: an address the owner reads daily (bizinsightsaus@yahoo.com, the site's contact address). Google sends verification notices and Trust & Safety follow-ups here.

**Clients -> Insights web -> Authorized redirect URIs**

> https://bizinsights.io/api/ads/google/callback
> https://bizinsights.io/api/ads/adsense/callback
> (where Google sends the browser back after "Continue with Google Ads" and "Continue with Google AdSense". Remove the old paths on the Cloudflare Worker's workers.dev host and on https://d2mr8m2p1qkh58.cloudfront.net, and every http://localhost URI. Nango's old callback, https://bizinsights.io/api/ads/nango/oauth-callback, was removed on 2026-11-02 (docs/ads-setup.md, "Leaving Nango", step (d)).)

**Clients -> Insights web -> Authorized JavaScript origins**

> None. The code exchange happens on the server only; remove any existing origins.

**Data Access -> Sensitive scopes**

> https://www.googleapis.com/auth/adwords  (Google Ads API; Google describes it as 'See, edit, create, and delete your Google Ads accounts and data')

**Data Access -> Non-sensitive scopes**

> https://www.googleapis.com/auth/adsense.readonly  (AdSense Management API, 'View your AdSense data')

**Verification Center -> Scope justification for https://www.googleapis.com/auth/adwords (short version; the field's character limit is unverified)**

> bizinsights is an analytics dashboard for Shopify merchants. When a merchant presses "Continue with Google Ads" (Settings > Advertising) and picks their ad accounts, bizinsights reads those accounts' reports through the Google Ads API (customers:listAccessibleCustomers and read-only googleAds:searchStream GAQL queries; no mutate calls). It shows them only inside that merchant's own bizinsights workspace: spend, impressions, clicks, CTR, CPC, CPM, conversions, conversion value and ROAS per day next to their Shopify sales, plus a report by campaign, ad group, device and country that opens a campaign to its ad groups (a Performance Max campaign to its asset groups) and an ad group to its ads. Google's Google Ads API documentation names https://www.googleapis.com/auth/adwords as the scope for API access, and there is no read-only or narrower Google Ads scope. bizinsights never creates, edits, pauses or deletes anything in Google Ads. Tokens are AES-256-GCM encrypted at rest and never sent to the browser. Disconnecting deletes the token and every fetched figure, and bizinsights revokes its grant at Google once no other bizinsights connection uses that Google sign-in. No selling, transfers, ads use or AI training (Limited Use).

**Verification Center -> Scope justification (full version, for a longer field or a reply to the reviewer's email)**

> What the app does: bizinsights (https://bizinsights.io/) is an analytics dashboard for Shopify merchants. It puts a store's sales next to the cost and results of its advertising.
>
> User-facing feature that uses this scope: in Settings > Advertising, a workspace owner or admin presses "Continue with Google Ads" and grants access on Google's consent screen. The scope is requested only at that moment, never at sign-in to bizinsights. If the Google login can see several Google Ads accounts (for example through a manager account), the merchant ticks the ones that belong to the store. The merchant then lands on the dashboard. Its Advertising section shows, per platform and per day, spend, impressions, clicks, CTR, CPC, CPM, conversions, conversion value and ROAS. A detail view shows a Google Ads report by campaign (with status, type and budget), ad group, device and country; pressing a campaign shows its ad groups (a Performance Max campaign's asset groups), and pressing an ad group shows its ads. A background sync keeps these figures current: the last 90 days are fetched on connect and older days back to 25 months in the background, recent days are refreshed every three hours, and the last 90 days are read again daily because conversions are credited to the day of the click for up to 90 days. That is why the app requests offline access.
>
> Google API calls made with the token: Google Ads API customers:listAccessibleCustomers, to list the accounts the person can see, and googleAds:searchStream with GAQL SELECT queries. These read the account name, id, currency, time zone and manager/client structure; campaign, ad group, Performance Max asset group and ad names, ids, status, type and budget (an ad's id, name, type and status only, never its text or links); and daily cost, impressions, clicks, conversions and conversion value by date, device and country. For client accounts reached through a manager account, the manager's id is sent as login-customer-id. bizinsights makes no mutate call of any kind. bizinsights also calls Google's OAuth tokeninfo endpoint. It confirms the token was issued to bizinsights' own client and records the Google account's numeric ID, so bizinsights can tell when two connections share one Google sign-in. On disconnect it calls the revoke endpoint.
>
> Why no narrower scope works: Google's Google Ads API documentation names https://www.googleapis.com/auth/adwords as the scope to use for Google Ads API access, and Google offers no read-only or narrower Google Ads scope. Without it bizinsights cannot call googleAds:searchStream, and the merchant's Advertising section would be empty. Google AdSense is a different product. It is read in a separate flow with the non-sensitive https://www.googleapis.com/auth/adsense.readonly scope, which cannot read Google Ads data.
>
> Handling: refresh and access tokens are encrypted with AES-256-GCM at rest, bound to the store, never returned to the browser and never logged. Figures are shown only to members of the merchant's own bizinsights workspace, according to the role the workspace owner gave them. Disconnecting deletes the token and every figure fetched at once. Google ends a sign-in's whole grant at once, so bizinsights revokes its grant at https://oauth2.googleapis.com/revoke when no other bizinsights connection still uses that Google sign-in (for example AdSense on the same Google account). The data is not sold, not transferred to third parties beyond the processors that run the service, not used for advertising, and not used to train AI or ML models. People do not read it except with the merchant's permission, for security, or where the law requires. This follows the Google API Services User Data Policy, including the Limited Use requirements (disclosed at https://bizinsights.io/privacy#google-user-data).

**Verification Center -> Demo video (YouTube link)**

> https://youtu.be/<VIDEO_ID>   (uploaded in YouTube Studio with Visibility = Unlisted; checked in a signed-out window)

**Verification Center -> Documentation links (up to 3)**

> 1) https://bizinsights.io/privacy#google-user-data  (the privacy policy, opened at its Limited Use statement; "Advertising accounts" in section 3 says what is read from Google Ads and AdSense and why, what is stored, including the Google account ID, and how it is protected, shared, kept and deleted)
> 2) https://bizinsights.io/data-deletion  (Disconnect for Google Ads and AdSense, removing access at Google, deletion by email)
> 3) https://bizinsights.io/#google-data  (the homepage section 'Google Ads and Google AdSense': what is read, why, read-only, Disconnect, Limited Use. Check it is live first; until then use https://bizinsights.io/terms)

**Verification Center -> Additional information for the reviewer (use a free-text field if one is shown, otherwise the email reply; the exact field name is unverified)**

> OAuth client: 'Insights web', 534794119904-9esdp8dhskcupf6ekbb0iej2dr10gomf.apps.googleusercontent.com, the only OAuth client in project insights-511119 (confirm in Clients before sending). Development uses a separate project. Two consent flows use this client, and both appear in the video: (1) 'Continue with Google Ads' (Settings > Advertising, or "Connect" on the Google Ads card of Settings > Integrations) requests only https://www.googleapis.com/auth/adwords, with access_type=offline, PKCE S256 and prompt=select_account consent (select_account alone for someone whose refresh token bizinsights already holds); (2) 'Continue with Google AdSense' (Settings > Advertising) requests only https://www.googleapis.com/auth/adsense.readonly. Signing in to bizinsights itself goes through Amazon Cognito and does not use this client. Access is read-only: bizinsights calls only customers:listAccessibleCustomers and googleAds:searchStream (GAQL SELECT) and never makes a mutate call. Disconnect deletes the token and data, and bizinsights revokes its grant at https://oauth2.googleapis.com/revoke once no other connection uses the same Google sign-in. Google Ads API access level: Explorer (granted 2026-10-11).

**Homepage -> section 'Google Ads and Google AdSense' (id="google-data"; added in apps/web/src/components/landing/AdPlatforms.tsx, live with this branch's deploy; reference only: the wording on the page is what counts)**

> The draft it was written from: Google Ads and Google AdSense (optional). If you press "Continue with Google Ads" in Settings, Google asks you to allow bizinsights to "See, edit, create, and delete your Google Ads accounts and data". That is the only permission Google offers for the Google Ads API, and bizinsights uses it only to read reports. For the ad accounts you pick, bizinsights reads account names and ids, currency and time zone; campaign, ad group, asset group and ad names, status, type and budget; and daily spend, impressions, clicks, conversions and conversion value by device and country. It uses them to show your ad spend, CTR, CPC, CPM and ROAS next to your Shopify sales. "Continue with Google AdSense" asks only for read-only access ("View your AdSense data") to show your site's estimated earnings, page views, ad impressions and clicks, and in its reports the same by country, device type and ad unit, with ad requests, coverage and Active View viewability. bizinsights never creates, changes, pauses or deletes ads, budgets or billing. You can disconnect at any time in Settings, and the access token and every figure fetched are deleted. bizinsights' use and transfer of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements. See our Privacy Policy.

**Privacy policy -> Google disclosures (live on https://bizinsights.io/privacy; reference, nothing to paste)**

> Section 3 "Advertising accounts" (`#optional-features`): what is read from Google Ads (with adwords, used only to read) and AdSense (adsense.readonly); that bizinsights keeps Google's account ID and the permissions granted with each connection, to tell whether two connections share one sign-in; that Disconnect deletes the token and figures at once and gives Google's access back with the last connection that uses the Google sign-in; and that removing access at Google marks the account "Needs reconnecting" and keeps the figures until Disconnect or a deletion request. Section 4 "Google user data" (`#google-user-data`): the Limited Use statement. Section 8 "Service providers": who processes the data.

**Privacy policy -> optional longer Limited Use paragraph (replaces the paragraph in `#google-user-data` in apps/web/src/app/privacy/page.tsx; the owner approves the wording)**

> bizinsights' use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. Google user data is used only to show you your own reports and to send the emails you set up. It is not sold, not transferred to anyone except the service providers listed below that run the service, not used for advertising, and not used to train AI or machine-learning models. People do not read it except with your permission, for security purposes, or where the law requires it.

**/data-deletion -> Google (live on https://bizinsights.io/data-deletion since 2026-10-16; reference, nothing to paste)**

> Step 1 "Disconnect in bizinsights": Google Ads and Google AdSense, token and figures deleted at once, access given back to Google once no other connection with the same Google login uses it. Step 2 "Remove access at Google or Meta": myaccount.google.com -> Security -> Your connections to third-party apps & services; the accounts then show "Needs reconnecting", and step 1 or 3 deletes the data. Step 3 "Ask us to delete everything": email bizinsightsaus@yahoo.com from the sign-in address.

**Privacy policy -> Limited Use statement (reference)**

> Google's FAQ example: "{App's} use of information received from Google APIs will adhere to Google API Services User Data Policy, including the Limited Use requirements." The FAQ says a public web-accessible disclosure, such as one on the homepage or a public FAQ, is enough. The policy must also cover what Google data is accessed, how it is used, shared and protected, and its retention and deletion, and it must name the controller. /privacy does all of this since 2026-10-16: the controller is "bizinsights" (see the legalName check in "Where things stand"), and the stored Google account ID is disclosed.

**Email reply template if the reviewer asks you to use a narrower scope**

> Thank you for the review. bizinsights only reads Google Ads reports. Google's Google Ads API documentation (developers.google.com/google-ads/api/rest/auth) names https://www.googleapis.com/auth/adwords as the scope for Google Ads API access, and Google offers no read-only or narrower Google Ads scope. With any other scope, bizinsights could not call googleAds:searchStream, and the Advertising section of the merchant's dashboard would show nothing: spend, clicks, conversions and ROAS by day, campaign, ad group, device and country. bizinsights makes no mutate calls and never changes campaigns, ads, budgets or billing. Disconnect deletes the token and data, bizinsights revokes its grant once no other connection uses that Google sign-in, and bizinsights follows the Limited Use requirements. The demo video at <link> shows each of these points. Unable to use narrower scopes.

**Google Ads API > Access levels > Basic access application (draft, 2026-10-20; the form's field names are unverified, so put each answer under the field that asks for it; only needed past roughly 60 busy accounts)**

> Developer / company: Zodiix Pty Ltd (ACN 613 577 834, ABN 40 613 577 834), Victoria, Australia, operating the product "bizinsights". Website https://bizinsights.io. Contact bizinsightsaus@yahoo.com. Cloud project insights-511119, OAuth client "Insights web".
>
> What the tool does: bizinsights is a reporting dashboard for Shopify merchants. A merchant connects their own Google Ads account with OAuth (scope https://www.googleapis.com/auth/adwords) and sees spend, impressions, clicks, CTR, CPC, CPM, conversions, conversion value and ROAS per day, broken down by campaign, ad group, device and country (and down from a campaign to its ad groups or Performance Max asset groups, and from an ad group to its ads), next to their Shopify sales.
>
> Who uses it: external users (Shopify merchants), each on the Google Ads accounts their own Google sign-in can reach. No agency work and no management of accounts on anyone's behalf.
>
> API usage: read-only reporting. CustomerService.ListAccessibleCustomers to find the accounts a sign-in can reach, then GoogleAdsService.SearchStream with GAQL SELECT queries on campaign, ad_group, asset_group (Performance Max), ad_group_ad (each ad's id, name, type and status, never its text) and the device and geographic segments. Opening one campaign's ad groups or one ad group's ads is one query. No mutate calls: nothing is created, edited, paused or deleted, and budgets, billing and users are never touched.
>
> Volume: one scheduled sync per connected account plus on-demand refreshes. The app caps its own calls with a daily operations setting so it stays inside the granted level; Basic access is requested so more than about 60 busy accounts can connect without hitting the Explorer limit.
>
> Design and demo: the live app at https://bizinsights.io, the same demo video as the OAuth verification, and screenshots of the dashboard's Advertising section and the Google Ads report on request. Privacy policy https://bizinsights.io/privacy, terms https://bizinsights.io/terms.

**Reference (not a form field): expected timelines**

> Brand verification: the automated check after 'Verify Branding' usually takes a few minutes; a manual review 'usually takes 2-3 business days'; you then publish within 7 days. Sensitive-scope verification 'typically takes 3-5 business days' (developers.google.com, updated 2026-08-19). The Cloud FAQ (answer/13463817) table says 10 business days, notes 'these estimates are not guaranteed', and says timing varies with how quickly you respond. The 'Unverified apps' page says verification 'might require several months'. Restricted scope (only if the console lists adwords as restricted): 'several weeks', about 6 weeks per the FAQ, plus an annual CASA security assessment. Until verification, the 100-new-user cap applies for the project's whole lifetime and 'cannot be reset or changed'.

### Screen recording script

1. 0. Setup (not recorded). Branding is published, so the consent screen shows 'bizinsights'. The Google account and browser language are English. Use a clean browser profile, signed in to Google with only the demo Google account. The bizinsights demo user is an owner or admin of a workspace with an active Shopify store, and there is no existing Google Ads or AdSense connection. Sign in to bizinsights with EMAIL before or during the recording. Do NOT use bizinsights' 'Continue with Google' sign-in: it is bizinsights' own sign-in (Amazon Cognito), not this client. Record at 1080p, full screen, with the address bar visible and nothing cropped. Narrate in English by voice or captions; Google says narration 'can greatly help'. Never show the client secret, tokens, passwords or the reviewer login. Aim for 3-5 minutes; Google publishes no limit, so this length is unverified guidance.
2. 1. Title card (5 s). VISIBLE: 'bizinsights - OAuth verification demo - Google Cloud project insights-511119 - OAuth client Insights web 534794119904-9esdp8dhskcupf6ekbb0iej2dr10gomf.apps.googleusercontent.com - Scopes: https://www.googleapis.com/auth/adwords (sensitive), https://www.googleapis.com/auth/adsense.readonly (non-sensitive)'.
3. 2. Homepage. Type https://bizinsights.io/ into the address bar. VISIBLE: the URL, the name 'bizinsights', what the app does, and the Privacy link in the footer and the 'Google Ads and Google AdSense' section (https://bizinsights.io/#google-data) with the Limited Use sentence. Click Privacy. VISIBLE: https://bizinsights.io/privacy, the 'Advertising accounts' paragraphs in section 3 (adwords used only to read; what is stored, including the Google account ID; delete and revoke on disconnect) and the Limited Use paragraph in section 4, 'Google user data'. NARRATE: 'This is the same privacy policy linked on our OAuth consent screen.'
4. 3. Optional; it helps reviewers match IDs but is not an official requirement. Google Cloud console -> Google Auth Platform -> Clients. VISIBLE: the single client 'Insights web' and its client ID. Then Data Access, listing adwords and adsense.readonly. Do NOT open or show the client secret.
5. 4. bizinsights (already signed in by email) -> Settings -> Advertising. VISIBLE: the Google Ads card with 'Continue with Google Ads' and its text 'Choose the Google account that manages your advertising, then select the ad accounts for this store. ... bizinsights reads reports without changing campaigns or spending money.' NARRATE: 'Signing in to bizinsights doesn't involve Google Ads. The Google Ads permission is asked for only here, when the merchant chooses to connect Google Ads.'
6. 5. Click 'Continue with Google Ads' and choose the demo Google account. If Google first shows 'Google hasn't verified this app' (expected while verification is pending), keep it in the recording and continue through Advanced. The official pages don't cover this screen, so this is unverified.
7. 6. Google consent screen for Google Ads (the tab leaves bizinsights.io for accounts.google.com, so the address bar is Google's). Hold for at least 10 seconds. VISIBLE: (a) the language selector at the bottom-left set to English; (b) the app name 'bizinsights'; (c) the complete consent screen, scrolled so every line shows, with only the Google Ads permission ('See, edit, create, and delete your Google Ads accounts and data' or Google's current wording) and no other scope; (d) the address bar, clicked and zoomed until 'client_id=534794119904-9esdp8dhskcupf6ekbb0iej2dr10gomf.apps.googleusercontent.com' is readable. Google requires showing 'that the browser address bar of the OAuth consent screen correctly includes your app's OAuth client ID.' NARRATE: 'This is the https://www.googleapis.com/auth/adwords scope. bizinsights uses it only to read reports, because the Google Ads API has no read-only scope.'
8. 7. Allow and press Continue. VISIBLE: the redirect back to https://bizinsights.io/... If the login reaches several Google Ads accounts, bizinsights shows its account picker on Settings -> Advertising: tick the store's account and confirm. With a single account, bizinsights goes straight to the dashboard.
9. 8. Dashboard -> Advertising section. VISIBLE: the Google Ads figures arriving (spend, impressions, clicks, CTR, CPC, CPM, conversions, conversion value, ROAS), the per-day chart, and the by-platform comparison next to Shopify sales. NARRATE: 'Every number here is read from the Google Ads API with the adwords scope and shown only inside this merchant's workspace.'
10. 9. Open the Advertising detail view -> Google Ads report. VISIBLE: campaigns with status, type and budget; press one campaign to show its ad groups (a Performance Max campaign's asset groups) and one ad group to show its ads, then "All campaigns" in the breadcrumb to go back; the Ad groups tab; the device breakdown; the country breakdown. NARRATE: 'This is the full set of Google Ads data bizinsights reads. Nothing here creates, edits, pauses or deletes anything in Google Ads.'
11. 10. Settings -> Advertising (management page). VISIBLE: the Google Ads card as Connected, the access line 'Google Ads reporting (Google has no read-only scope; bizinsights only reads)', the account, the last sync, and the Refresh, Show on dashboard and Disconnect controls. NARRATE: 'There are no write controls. Tokens are encrypted and never reach the browser.'
12. 11. Second consent workflow on the same client. Google: 'if there are multiple OAuth consent workflows, you must demonstrate each of these methods in your video.' On Settings -> Advertising, show the Google AdSense card ('Read-only access to AdSense reports (adsense.readonly)') and click 'Continue with Google AdSense'. VISIBLE on Google's screen: English, 'bizinsights', only 'View your AdSense data', and client_id in the address bar (hold 10 s). Allow, return, and show the dashboard's 'Ad earnings' card: estimated earnings, page views, ad impressions and clicks per site and day. Optionally open Advertising -> Google AdSense and its report 'By ad unit' (ad requests, coverage and Active View viewability per ad unit, read from AdSense when opened). NARRATE: 'This flow uses the same client and requests only adsense.readonly.'
13. 12. Disconnect in this order, as tested in the dry run. (a) Settings -> Advertising -> Google AdSense -> Disconnect -> confirm. NARRATE: 'bizinsights deletes the AdSense token and figures. Google ends a sign-in's whole grant at once, so bizinsights keeps the grant while Google Ads still uses this Google account.' (b) Settings -> Advertising -> Google Ads -> Disconnect. VISIBLE: the confirmation 'Disconnect Google Ads? bizinsights deletes its access and every number it fetched for your ad accounts. Your ads keep running.' Confirm it; the Advertising section no longer shows Google Ads. NARRATE: 'The token and every figure fetched are deleted, and because no other connection uses this Google sign-in, bizinsights has revoked its access at Google.' (c) Optional, only if the dry run showed it: open your Google Account's third-party connections page and show that bizinsights no longer has access.
14. 13. End card (5 s). VISIBLE: 'Read-only. Limited Use compliant. Privacy: https://bizinsights.io/privacy - Support: https://bizinsights.io/support'. Upload in YouTube Studio with Visibility = Unlisted, open the link in a signed-out window to check it plays, then paste it into the Verification Center.

### Instructions for the reviewer

Paste into the reviewer free-text field if one is shown, otherwise into a reply to the Trust & Safety email. None of the official pages I read require test credentials for sensitive-scope review. If the reviewer asks for access, reply in the same email thread with the reviewer login. Never put credentials in the form or the video.

How to see the Google Ads feature in bizinsights:
1. Open https://bizinsights.io/. The privacy policy, https://bizinsights.io/privacy#google-user-data, explains what is read from Google and why. Sign in at https://bizinsights.io/login with the reviewer login we send on request (email sign-in). Its workspace has a Shopify development store connected, and the reviewer is a workspace admin, which connecting ad accounts requires.
2. Go to Settings -> Advertising and press "Continue with Google Ads" on the Google Ads card.
3. On Google's screens, choose a Google account that can access a Google Ads account and allow the single permission requested: https://www.googleapis.com/auth/adwords, OAuth client 534794119904-9esdp8dhskcupf6ekbb0iej2dr10gomf.apps.googleusercontent.com. While verification is pending, Google first shows its unverified-app warning. Google always shows its account chooser first. A Google account with no Google Ads account gets 'That Google login has no Google Ads account, so nothing was connected', with a "Choose another Google account" button that reopens Google's chooser.
4. If the login reaches several Google Ads accounts (for example through a manager account), tick the ones for the store and confirm.
5. You land on the dashboard. Within a minute or two the Advertising section shows spend, impressions, clicks, CTR, CPC, CPM, conversions, conversion value and ROAS per day. The detail view's Google Ads report breaks this down by campaign (status, type, budget), ad group, device and country; pressing a campaign opens its ad groups (or a Performance Max campaign's asset groups), and pressing an ad group its ads.
6. Settings -> Advertising shows the connection, the permission granted, the last sync, and Refresh, Show on dashboard and Disconnect. Disconnect deletes the token and every figure fetched. bizinsights then revokes its grant at oauth2.googleapis.com/revoke, unless another bizinsights connection still uses the same Google sign-in (for example Google AdSense on the same Google account). In that case the grant is revoked when the last such connection is disconnected.

bizinsights calls only customers:listAccessibleCustomers and googleAds:searchStream (GAQL SELECT) on the Google Ads API. It never creates, edits, pauses or deletes campaigns, ads, budgets, billing or users.

The second flow, Settings -> Advertising -> "Continue with Google AdSense", uses the same client and requests only https://www.googleapis.com/auth/adsense.readonly.

Privacy policy and Limited Use disclosure: https://bizinsights.io/privacy. Support: https://bizinsights.io/support.

### Common reasons for rejection

- The authorized domain is not verified as a Search Console DOMAIN property (DNS TXT) by a Project Owner. URL-prefix or 'Site' properties, or verification by another account, are not recognised. Done for bizinsights.io on 2026-10-19 (step 2); keep the TXT record.
- Redirect URIs on other hosts (the old Cloudflare Worker's workers.dev host, `d2mr8m2p1qkh58.cloudfront.net`) or localhost are still on 'Insights web'. Authorized domains must cover every redirect URI's domain and each must be verified. Dev URIs also break the rule that each deployment tier must be a separate project.
- Another OAuth client in insights-511119 is not ready for production. The video must cover all clients in the project; delete unused ones.
- The homepage or privacy policy is on a third-party platform where you can't verify you own the subdomain (support.google.com/cloud/answer/13807376). Not the case on bizinsights.io once the Domain property is verified.
- The homepage brand doesn't match the consent-screen app name. The site says 'bizinsights' everywhere since 2026-10-16, so the consent-screen app name must be exactly 'bizinsights' too (not the old 'Insights').
- The homepage doesn't explain what the app does with Google user data, is only a login page, redirects, or uses a shortened link. bizinsights.io describes the app, doesn't redirect, and its #google-data section explains the Google Ads and AdSense data (once this branch is deployed).
- The privacy policy is incomplete or reads like a template, or doesn't cover what Google data is accessed and stored (including the Google account ID bizinsights keeps), how it is used, shared and protected, and retention and deletion. /privacy covers all of this since 2026-10-16.
- The privacy link on the homepage differs from the consent-screen link, or the privacy URL equals the homepage URL. Use https://bizinsights.io/privacy, the homepage footer's link.
- The terms of service link is missing or broken. Cloud Branding help says you can't submit without the homepage, privacy and terms links. https://bizinsights.io/terms returns 200.
- Demo video problems. The consent screen isn't in English. The app name isn't shown because branding wasn't published before recording. The full scope list isn't visible. client_id isn't readable in the address bar. The features behind each scope aren't shown. The AdSense consent flow is missing. The video is Private instead of Unlisted.
- The video contradicts the app. It narrates that the grant is revoked while AdSense still uses the same Google sign-in, or it shows bizinsights' own 'Continue with Google' sign-in (Amazon Cognito), which is not this client.
- Documentation links that don't cover Google. /privacy#google-user-data and /data-deletion both cover Google Ads and AdSense.
- The scope justification doesn't explain why a narrower scope won't work, or the app requests scopes for features not yet built.
- The scopes in the submission, on Data Access and in the app's OAuth requests don't match.
- The app name or logo uses Google product names or icons, or doesn't uniquely identify the brand. The logo differs from the submission or from the homepage mark.
- Branding was verified but not published within 7 days ('Need to re-verify'), or branding was edited during review, which is not permitted.
- No reply to Trust & Safety emails, or out-of-date developer contact or support email. Reply to the latest email, and don't resubmit until everything is fixed.
- Scope-category surprise: the Google Ads API docs (2026-09-30) call the adwords scope 'restricted'. If the console agrees, an annual CASA security assessment is required, and production data hosting must stand up to it.

### Sources

- https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
- https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification
- https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- https://developers.google.com/identity/protocols/oauth2/policies
- https://developers.google.com/identity/protocols/oauth2/scopes
- https://support.google.com/cloud/answer/13804266?hl=en
- https://support.google.com/cloud/answer/15549049?hl=en
- https://support.google.com/cloud/answer/15549135?hl=en
- https://support.google.com/cloud/answer/13464321?hl=en
- https://support.google.com/cloud/answer/13463817?hl=en
- https://support.google.com/cloud/answer/13461325?hl=en
- https://support.google.com/cloud/answer/13463073?hl=en
- https://support.google.com/cloud/answer/9110914?hl=en
- https://support.google.com/cloud/answer/13804565?hl=en
- https://support.google.com/cloud/answer/13807376?hl=en
- https://support.google.com/cloud/answer/13806988?hl=en
- https://support.google.com/cloud/answer/13804963?hl=en
- https://support.google.com/cloud/answer/13807380?hl=en
- https://support.google.com/cloud/answer/7454865?hl=en
- https://developers.google.com/terms/api-services-user-data-policy
- https://developers.google.com/google-ads/api/docs/productionize/secure-credentials
- https://developers.google.com/google-ads/api/rest/auth
- https://developers.google.com/google-ads/api/docs/oauth/overview
- https://developers.google.com/google-ads/api/docs/api-policy/brand-verification
- https://developers.google.com/google-ads/api/docs/api-policy/access-levels
- https://support.google.com/webmasters/answer/9008080?hl=en
- https://publicsuffix.org/list/public_suffix_list.dat

## Meta: Meta App Review pack for bizinsights (App ID 971575545351940): Advanced Access to ads_read and public_profile, with Business Verification, Access Verification and the Marketing API Access Tier (checked against developers.facebook.com and the code on 2026-10-11; URLs updated to bizinsights.io 2026-10-19)

### Readiness on 2026-11-02 (start here)

Checked against production (release 153), the code on `main` (aeb1877a) and Meta's pages on 2026-11-02. The Meta
dashboard rows are from the owner's Chrome on 2026-11-02 (read only) unless marked otherwise. Where this list and the
older notes below differ, this list is current.

| Item | State | Who |
| --- | --- | --- |
| Business Verification | Verified: portfolio bizinsights.io (1415197520268134), since 2026-10-26 | done |
| Access Verification (Tech Provider) | Submitted 2026-10-26; "In review" on 2026-11-02; Meta's deadline 1/1/2027 | Meta |
| App icon | Uploaded 2026-10-11 from the 1200×1200 listing icon. Meta asks for 1024×1024: in Settings → Basic, check that it shows sharp, and upload a 1024×1024 copy of `shopify-app/listing/app-icon-1200.png` if not | owner |
| Privacy policy URL | https://bizinsights.io/privacy: 200, also to Meta's crawlers (`facebookexternalhit`, `meta-externalagent`). Names ads_read and what it reads, AWS, Cloudflare, Resend and Zapier | done |
| Terms of Service URL | https://bizinsights.io/terms: 200. Missing a Tech Provider clause (below) | owner decision |
| Data deletion | Callback `https://bizinsights.io/api/webhooks/meta/data-deletion` registered; instructions at https://bizinsights.io/data-deletion (200) | done |
| Deauthorize callback | `https://bizinsights.io/api/webhooks/meta/deauthorize` registered | done |
| Category / App purpose | Business and pages / Clients (set 2026-10-19; purpose not re-read since) | check |
| Display name | bizinsights (since 2026-10-26) | done |
| Live mode | The app has been Published (Live) since 2026-10-11. In Live mode, a Facebook login with no role on the app only gets permissions that have Advanced Access, which is what App Review grants. Nothing to switch | done |
| Valid OAuth Redirect URIs | `https://bizinsights.io/api/ads/meta/callback` and `https://bizinsights.io/` (Nango's removed 2026-11-02) | done |
| Require App Secret | On | done |
| A successful ads_read call within 30 days | 67 calls counted on 2026-10-26, and a kept connection syncs hourly. On the day you submit, check that the dialog's "API test calls" says Completed | owner |
| An ad account with delivery | act_2033403030827115 had never delivered an ad (2026-10-26). Without spend, every figure in the recording is 0 | owner |
| Reviewer account | Not created; `AUTH_LOGIN_CODE_EXEMPT` is empty, so a reviewer would be asked for an emailed code | owner, then Claude ships the address |
| ads_read text in draft 980737984435696 | Still the 2026-10-26 text that names Nango: paste the 2026-11-02 text below over it | owner |
| Screencast | Not recorded (script below, updated 2026-11-02 for the current screens) | owner |
| Data handling questions | Not answered (drafts below, updated 2026-11-02: Resend added, Zapier explained) | owner |
| `META_ADS_ADVANCED_ACCESS` | "" in `apps/aws/src/settings.ts`; set to "1" once ads_read Advanced Access is granted | Claude, after approval |

**Tech Provider clause for /terms (owner decision, with your adviser).** As a Tech Provider, bizinsights processes
each merchant's Meta data on its behalf. Meta's Platform Terms 5.b.ii.4 allow a Tech Provider to share Platform Data
with its Client "so long as you first contractually prohibit such Client from Processing Platform Data" in breach of
those terms, and with the Client's own service provider (that is what Zapier is, when a merchant connects it). /terms
section 7 ("Shopify, Google and Meta") has no such promise from the merchant. A draft to add there, which changes the
terms, so section 12 says workspace owners get an email first:

> Meta data. bizinsights reads your Meta ad accounts on your behalf and at your direction, and keeps each store's data
> apart. You agree not to use the Meta data that bizinsights shows you, or sends to your own tools such as Zapier, in
> a way that breaks Meta's Platform Terms (https://developers.facebook.com/terms), and not to sell or license it.

### Code check for reviewers (2026-11-02)

The sign-in and token code was read against what Meta's review, the data handling questions and Access Verification
ask. Nothing in it needs changing before submitting. What the answers can rely on:

- **Sign-in** (`packages/core/src/adConnections/signIn.ts`, route `GET /api/ads/:provider/callback` in
  `apps/api/src/routes/ads.ts`): Facebook Login for Business with configuration 1521935306664882 (`META_CONFIG_ID`),
  user access token, ads_read only. The state is a random nonce, single-use, kept server-side for 10 minutes, matched
  in constant time against a cookie in the same browser, and bound to the bizinsights user who started it (another
  signed-in user gets `session_mismatch`). Starting a connect needs a verified email and the Owner or Admin role, and is
  rate-limited per user. The code is exchanged on the server with the app secret, then swapped for the ~60-day token.
  `GET /me/permissions` must list ads_read as granted, or nothing is kept and the grant is handed back.
- **Tokens** (`credentials.ts`): AES-256-GCM, with the store, platform and token kind as associated data, so a
  ciphertext can't be moved to another store's row; versioned keys with rotation. Never sent to the browser. Every
  Graph call carries `appsecret_proof`. The logger redacts Meta tokens (`EA…`), `access_token`, `client_secret`, `code`
  and `fb_exchange_token` wherever they appear.
- **While the merchant picks accounts** (up to 15 minutes), the token sits in the coordinator table (DynamoDB,
  encrypted at rest with an AWS-managed key, with point-in-time backups kept 35 days), not sealed by bizinsights' own
  key as the database rows are. "Encrypted at rest" stays true. Sealing it with the keyring too would keep it out of
  those backups in readable form: optional hardening, which no reviewer sees.
- **Expiry and removal**: an expired token is never used, and an alert asks for a reconnect 7 days before it ends.
  Disconnect deletes the row, its daily figures and its token in one transaction, then withdraws ads_read
  (`DELETE /me/permissions/ads_read`, or with the app token once the person's token no longer works) unless another
  connection relies on the same grant. The deauthorize and data deletion callbacks check the `signed_request`
  (HMAC-SHA256 with the app secret, constant time, `issued_at` within 24 hours), act once per request, and the data
  deletion one returns a status URL and confirmation code.
- **Where Meta data goes (this changed the form texts).** Besides AWS and Cloudflare: alert emails to the
  workspace's admins go through Resend and name the ad account (no figures); and the Zapier app (live since release
  134) sends spend, impressions, clicks, conversions and purchase value to a merchant's own Zapier account when that
  merchant connects Zapier and turns on an advertising trigger. The texts written before 2026-11-02 said Meta data
  went to no other third party; the usage description, data handling answers and reviewer instructions below now
  say this. bizinsights writes nothing to Shopify: it only reads what other apps report there. No AI or LLM service
  is in the code.

### Gaps as found 2026-10-20 to 10-28 (the readiness list above is current)

No longer gaps: contact.ts is filled in (legalName Zodiix Pty Ltd, ACN 613 577 834 since PR #152; supportEmail bizinsightsaus@yahoo.com since 2026-10-22), /privacy and /data-deletion show no "[not set" marker, /terms exists, and all of /, /privacy, /terms, /data-deletion and /support return 200 on bizinsights.io. The app's settings and its only Valid OAuth Redirect URI are on bizinsights.io (2026-10-19 and 2026-10-20), the deauthorize and data deletion callbacks are registered, and Require App Secret is on.

Re-checked 2026-10-26 (session meta-app-review-submit). These come first:

- **What this submission requests: `ads_read` and `public_profile`, nothing else.** The App Review draft also listed `whatsapp_business_messaging` and `whatsapp_business_management`, added on 2026-10-25 with the use case "Connect with customers through WhatsApp". They were taken out of the draft on 2026-10-26 (it now lists `ads_read` and `public_profile` only); re-add them later from that use case's Customize page. They serve only the Cloud API option of WhatsApp Automation ([whatsapp.md](whatsapp.md)); the QR-code option runs on bizinsights' own Evolution API service and needs no Meta permission. They need a recording of their own (Embedded Signup, then a message sent and received), which can't be made today: Embedded Signup stops on "bizinsights.io can't onboard customers right now" until the app is a Tech Provider. Sent together, a rejected WhatsApp pair holds up the ads pair. Request them in a later submission, once the Cloud API option is offered to merchants.
- **Business Verification: done.** Late on 2026-10-26 the app's Review → Verification read "bizinsights.io, ID 1415197520268134, Verified". App Review and Access Verification can both be submitted now. Access Verification wasn't started yet; its page says it must be completed by 12/25/2026 "to avoid restrictions to 1 app" (step 16).
- **The recording still has no ad figures to show.** The first production Meta connect worked on 2026-10-26 (login sebanceo, ad account "Sebastian Thomas" act_2033403030827115), and the use case page counts 67 `ads_read` calls, so the 30-day call rule is met. But that ad account has never delivered an ad: every figure bizinsights fetched for it (back to 2024-11) is 0. A recording of it shows no ad data, which Meta names as a rejection reason. Run a small ad on it for a few days first, or connect an ad account that runs ads (step 9).
- **Display name and Access Verification: done 2026-10-26.** The app's display name is "bizinsights" (was "Insights"), so Facebook's consent screen matches bizinsights.io, the recording and these texts. Access Verification was submitted the same evening with the text below (SaaS Platform; multiple portfolios: No; https://bizinsights.io) and is in review (step 16).
- **[OWNER] Replace the pasted ads_read text: it names Nango.** From 2026-10-22 to 2026-10-28 the ad sign-ins went through Nango, which exchanged the code and kept the token. Since 2026-10-28 bizinsights does its own Facebook Login again: it exchanges the code on its server and keeps the token encrypted in its own database, and the connections made through Nango were moved off it that day ([ads-setup.md](ads-setup.md#leaving-nango)). The usage description pasted into ads_read's dialog of submission 980737984435696 on 2026-10-26 describes Nango's connect window and Nango holding the token: before you submit, replace all of it with the text under "ads_read > usage description" below, Save, and reload to check. The data handling answers must not list Nango as a processor (Q1 to Q4 below no longer do); answer them once Nango's integrations are deleted (ads-setup.md, "Leaving Nango", steps (b) and (c), which can be done now: the move logged `left: 0` on 2026-10-28 and Nango's code is gone since release 131), so Nango holds no Meta token by then. Entity facts for any follow-up question from Meta: ACN 613 577 834, ABN 40 613 577 834, Australian private company, GST-registered, main business location VIC 3977, registered business name "PixMagic" only (ABN Lookup, 2026-10-20). Claude does not upload documents or automate business.facebook.com (Meta blocked the admin's developer account twice in October after automated clicking).
- App icon: whether a 1024x1024 version is in place is unconfirmed (step 3); the icon uploaded on 2026-10-11 was the 1200x1200 listing icon.
- Cloudflare now proxies bizinsights.io, so every page and API response, including the Meta figures shown to merchants, passes through it. The data handling answers below name it next to AWS.
- No mailbox on bizinsights.io: the zone has no MX record. The contact address is bizinsightsaus@yahoo.com. For Business Verification, confirm by phone: Meta offered only phone or email on 2026-10-20, no domain record (step 6).
- Reviewer account conditions taken from the code: the email is verified (otherwise 'Verify your email first'), and the role is Owner or Admin of the workspace (otherwise there is no connect button).
- **Meta's reviewers and the emailed sign-in code (found 2026-10-26, fixed the same day).** Production asks every password sign-in for a 6-digit code emailed to the account's address, valid 60 seconds (`AUTH_LOGIN_EMAIL_CODE=1` in apps/aws/src/settings.ts). A reviewer can't read the reviewer account's inbox, and "reviewers can't use the app" is a rejection reason. Since 2026-10-26 the setting `AUTH_LOGIN_CODE_EXEMPT` (same file) lists addresses whose password alone signs in; everyone else still gets the code. **Still to do: once the reviewer account exists (step 8), put its address there** (a one-line PR, merged and deployed like any change), and empty it again once Meta has decided. Each such sign-in logs "signed in without the emailed code" (`login_code_exempt`), and the deploy's config report (`auth.loginCodeExempt`) counts the exempt addresses without naming them.
- Keep production reachable for the whole review window: up to a week for App Review and about 5 days for Access Verification. Production runs on AWS (docs/aws-deployment.md): keep it deployed and its alarms quiet. A reviewer who can't reach the app is a stated rejection reason.
- Before you answer the data handling questions or later security questions, close the exposure of the old deployment's database on the owner's PC found in the 2026-10-10 security audit, if it is still open (it was reachable on the LAN with default credentials), or retire that deployment: firewall or recreate the container, and rotate the credentials. Production data is in Amazon RDS with storage encryption on.
- Reconnect every Meta connection belonging to the owner after removing bizinsights from Facebook Business integrations for the recording. This keeps the hourly sync counting toward the Marketing API Access Tier call threshold.
- Optional but recommended: a reviewer workspace that already has a Meta ad account connected, because Meta has temporarily stopped new test-user creation and reviewers' test accounts may own no ad account.
- Ongoing Review (required by Facebook Login for Business for apps with Advanced Access) and the yearly Data Use Checkup or Data Access Renewal after approval.

### Before you submit

Read this first. Four rules from Meta's docs set the order. (1) Since February 1, 2023, an app that needs Advanced Access must be connected to a business that has passed Business Verification. Until it is, people from other businesses can't grant the app permissions. (2) Facebook Login for Business needs Advanced Access to public_profile before the app goes live, and apps with Advanced Access go through Ongoing Review to keep it. That page's portfolio rules (the app belongs to a portfolio the developer fully controls; onboarding businesses need a portfolio) are listed for system-user tokens. bizinsights' configuration 'Insights ads reporting' uses a user access token, so merchants need no portfolio. bizinsights itself still needs one, for Business Verification. (3) ads_read is on Meta's Access Verification (Tech Provider) list. That process is separate from App Review, needs Business Verification first, and a business Admin completes it. (4) Meta's changelog entry dated 05/04/2026 renamed Ads Management Standard Access to the Marketing API Access Tier, with two levels, Limited and Full, and dropped the screen recording for tier upgrades. You can use the Upgrade button once the app has made 500 or more Marketing API calls in the last 15 days, with errors under 15% in the last 500 calls. Meta's pages disagree on whether Limited is enough for other businesses' accounts. The authorization page says both tiers allow unlimited ad accounts. The features reference ties reading reports for owner-granted accounts to this feature plus ads_read. The use-cases page says unlimited accounts and higher limits need approval. So upgrade as soon as the app qualifies.

1. [DONE 2026-10-16, legalName corrected 2026-10-20 in PR #152] Contact facts in apps/web/src/lib/contact.ts: legalName "Zodiix Pty Ltd", companyNumber "ACN 613 577 834", supportEmail sales@ikorex.com.au (bizinsightsaus@yahoo.com since 2026-10-22), jurisdiction Victoria, Australia; postalAddress is blank and the pages leave it out. Checked live on 2026-10-19: https://bizinsights.io/privacy and /data-deletion return 200 with no '[not set' marker and no 'This policy is incomplete' banner, and step 3 of /data-deletion gave sales@ikorex.com.au. Meta's privacy-policy rules: the policy is your own, clearly titled as a privacy policy, public, reachable by Meta's crawler and not geo-blocked. It says what is collected and why, and gives a working way (email or form) to ask for deletion. Because bizinsights.io is behind Cloudflare's proxy, check in Meta's Sharing Debugger that https://bizinsights.io/privacy returns 200 to Meta's crawler (Bot Fight Mode is off, so it shouldn't be challenged).
2. [DONE 2026-10-16] Terms of Service page: https://bizinsights.io/terms. Enter it in Settings > Basic (step 7); Meta's Basic Settings page lists it among the fields required to switch to Live mode.
3. [OWNER ONLY] Upload a 1024x1024 app icon under Settings > Basic > App Icon (size from Meta's submission guide), if the current icon isn't that size. It must contain no Meta trademarks or logos, and must not include 'Facebook' or 'FB'. Use the bizinsights green-bars mark.
4. [DONE 2026-10-20: portfolio "Zodiix Pty Ltd" created under sebanceo@gmail.com] Create a Meta business portfolio for Zodiix Pty Ltd, the entity in CONTACT.legalName and on the ASIC certificate, signed in to business.facebook.com as the Facebook account that administers the app (sebanceo@gmail.com), so that account is the portfolio's Admin from the start: only a business Admin can complete Business Verification and Access Verification. The existing "Testbusiness" portfolio (1754818672920174) is on the other Facebook account (imeseban@gmail.com) with the app "pixmagic" WhatsApp used before 2026-10-25; reuse it only if that account first makes sebanceo an Admin and you rename it and fill in its business info. The values for Create a business portfolio and Business info are under "Meta Business Settings > Business portfolio" in the form answers: name it Zodiix Pty Ltd (not "bizinsights", which is not a registered business name of ABN 40 613 577 834 and is the company name of an unrelated Queensland company), and use the registered address and phone from the certificate, which are not in the repo.
5. [DONE 2026-10-20: App settings > Basic > Verification names Zodiix Pty Ltd, verification pending] Connect the app to the portfolio. In the App Dashboard, go to Settings > Basic > Verification > Start Verification and pick the portfolio.
6. [SUBMITTED 2026-10-20 (phone code confirmed, ASIC certificate uploaded); Meta's decision pending] Complete Business Verification in Business Manager or Business Suite. Meta's developer docs send you to the Business Help Center for the document list. Those pages don't render outside a browser, so these points come from search summaries and are (unverified): the legal name, address, phone and an HTTPS website must match your documents; a registration or incorporation document is needed if Meta can't find the business; confirmation is by email, phone or domain; an email domain that matches the website helps. The website is https://bizinsights.io. It has no MX record, so no @bizinsights.io address can receive Meta's confirmation email. Seen 2026-10-20 while creating the portfolio as Zodiix Pty Ltd: Meta offered only phone or email confirmation for this business, no domain record, so confirm by phone (the Business info number). If phone fails, add mail to the domain first (Cloudflare Email Routing to bizinsightsaus@yahoo.com) and use email. Verification isn't required to go Live, but the app can't access data you don't own until it is complete.
7. [OWNER] Move the app to bizinsights.io and finish Settings > Basic, using the form answers below: Display name, Contact email (an inbox you read, because App Review notices go there), Privacy Policy URL, Terms of Service URL, User data deletion instructions URL, App icon, Category, App Purpose 'Clients', App Domains and the Website platform Site URL. In Facebook Login for Business > Settings, make sure https://bizinsights.io/api/ads/meta/callback is in Valid OAuth Redirect URIs (it is where Facebook sends the browser back since bizinsights does its own sign-in again, 2026-10-28; ads-setup.md, "Leaving Nango", step (e)); if you add it, press the Save Changes button at the bottom of the page: the 'Changes saved' toast alone doesn't keep it, so reload to confirm. Remove any d2mr8m2p1qkh58.cloudfront.net callback (the app never sends it). Once this branch's Deploy to AWS run has succeeded: in Facebook Login for Business > Settings, set Deauthorize callback URL to https://bizinsights.io/api/webhooks/meta/deauthorize; in Settings > Basic > User data deletion, choose the callback option and enter https://bizinsights.io/api/webhooks/meta/data-deletion (Meta then shows people https://bizinsights.io/data-deletion?code=... with their request's status); and in Settings > Advanced > Security turn on Require App Secret (every ads call already sends appsecret_proof). Both callbacks need META_APP_SECRET in production (otherwise they answer 503). The old Cloudflare Worker's workers.dev callback was removed on 2026-10-20 (integrations-readiness.md); remove its app domain too once that deployment no longer serves Meta connections. Do this before submitting: changing basic or advanced settings after submitting may need a new review.
8. [OWNER] Create the bizinsights reviewer account in production. It uses email and password, is not your personal account, and is not a Meta account. It must meet three conditions, or the reviewer can't connect. (a) Its email is verified: otherwise connecting fails with 'Verify your email first'. (b) It is Owner or Admin of its workspace: other roles see 'Only a workspace owner or admin can connect or disconnect accounts.' and no button. (c) The workspace has a Shopify development store connected: otherwise Settings > Advertising only says 'Connect a Shopify store first; ad accounts are connected to a store.' Don't use the frozen store 9kdgux-gq (402). A few test orders make the dashboard less empty. (d) Its address is on `AUTH_LOGIN_CODE_EXEMPT` in apps/aws/src/settings.ts, deployed: otherwise every sign-in asks for a code emailed to its inbox, which reviewers can't read. Give Claude the address and it ships that line. Use a long, unique password: with the code off, the password alone protects this account. Put the credentials only in the App Verification instructions. Meta says never to give your personal Meta login, because reviewers use their own test accounts.
9. [OWNER, after step 7] Within the 30 days before you submit, make at least one successful call for each permission requested. In production (https://bizinsights.io), connect Meta Ads with your own Facebook account (an app Admin) in your own workspace, on an ad account that delivered ads recently. Connecting calls GET /me/permissions and GET /me?fields=id (public_profile), then GET /me/adaccounts, and the sync calls GET /act_{id}/insights (ads_read). If the card says "That Facebook login can't reach any ad account", the login has no ad account of its own and isn't assigned to one: in Meta Business settings → Ad accounts, assign that login to the ad account (admins have to assign themselves too), or create one in Ads Manager, then connect again. The production log line "ads: nothing to connect for this login" has a `diagnosis` that names the login's role on the app ([ads-setup.md](ads-setup.md)). Leave it connected: its hourly sync also counts toward the 500-call threshold of the Marketing API Access Tier. One account makes about 25 calls a day by the sync schedule (estimate), so connect two or more ad accounts, or open the Meta Ads report now and then, to pass 500 in 15 days.
10. [OWNER] Keep production up for the whole review: App Review takes up to a week, and Access Verification about 5 days. Production runs on AWS, so nothing on your PC has to stay on. While the old deployment's database still runs on your PC ([aws-deployment.md](aws-deployment.md#retiring-the-old-cloudflare-deployment)), close the exposure from the 2026-10-10 security audit if it is still open (reachable on the LAN with default credentials) before you answer Meta's data-handling questions.
11. [OWNER] Record and edit the screencast with screencastScript. Removing bizinsights under Facebook Business integrations for the recording ends the token behind the connection from step 9 and any other Meta connection you made. Reconnect them afterwards.
12. [OWNER, optional, recommended] After recording, connect your own ad account again, this time in the reviewer workspace. Then reviewers see real numbers even if their Facebook test account owns no ad account. Meta has temporarily stopped new test-user creation, so this is likely. The card then shows 'Reconnect or add accounts', which runs the same Facebook Login. A login with no ad accounts leaves the existing data in place.
13. [OWNER] In App Review > Permissions and Features, request Advanced Access for ads_read and public_profile only. [DONE 2026-10-26] whatsapp_business_messaging and whatsapp_business_management are out of the draft (Remaining gaps, first item, says why). Leave everything else in the 'Measure ad performance data with Marketing API' use case at Standard Access: ads_management, business_management, pages_show_list, pages_read_engagement, email, and the Marketing API Access Tier feature until it is eligible. Unneeded permissions are a common reason for rejection. If the dashboard asks for Business Verification at this point (Step 1.5), finish it first.
14. [OWNER ONLY] Answer the data handling questions. They appear once Business Verification is approved, and Meta scores them within about 30 seconds. The drafts are in formAnswers; only you can confirm them. Meta advises checking with legal, policy and privacy advisers. Nango is not a processor any more: don't list it (Remaining gaps, the [OWNER] item on the ads_read text).
15. [OWNER] Replace ads_read's usage description: the text pasted on 2026-10-26 names Nango. Paste the new text from the form answers below over all of it, Save, and reload to check; public_profile asks for none. Upload the recording in ads_read's dialog, tick both agreements, fill in App Verification with reviewerTestInstructions, click Submit for Review and accept the Platform Onboarding Terms. Meta aims to decide within a week.
16. [SUBMITTED 2026-10-26, in review] Complete Access Verification (Tech Provider) under App Dashboard > Basics > Verifications > Access verification. It needs Business Verification and a business account with no restrictions, and can run while App Review is in progress. Meta decides in about 5 days. If it is denied, calls that need ads_read fail for anyone without a role on the app, even after App Review passes.
17. [OWNER] After approval: complete the Data Use Checkup if Meta asks for it. The app is already Live (Published since 2026-10-11), so there is nothing to switch; in Live mode only approved permissions work for people without a role on the app. Tell Claude, who sets `META_ADS_ADVANCED_ACCESS` to "1". After that, watch Required Actions in the App Dashboard for Ongoing Review, the yearly Data Use Checkup, or Data Access Renewal, which Meta is rolling out in phases to merge these checks.
18. [OWNER, as soon as eligible] Upgrade the Marketing API Access Tier from Limited to Full with the Upgrade button on that feature. You need 500 or more Marketing API calls in the last 15 days and errors under 15% in the last 500. No screen recording is needed. Limited's Ads Insights quota per ad account per hour is 600, plus 400 for each active ad. Full's base is 190,000.

### Form answers (paste as written)

**Meta Business Settings > Business portfolio (create it as sebanceo@gmail.com, the app's admin; the same values go into Business info and into Security Center > Start verification)**

> Business portfolio name: Zodiix Pty Ltd
> Your name: as on your Facebook profile
> Business email: bizinsightsaus@yahoo.com   (an inbox you read; Meta sends its confirmation there; bizinsights.io has no mailbox)
> Legal business name: Zodiix Pty Ltd
> Country: Australia
> Business number: ABN 40 613 577 834   (the ASIC certificate shows ACN 613 577 834; give whichever the field asks for)
> Address: the registered office address on the certificate   [OWNER: not in the repo; ABN Lookup shows only "VIC 3977"]
> Phone: the number on your documents   [OWNER: not in the repo]
> Website: https://bizinsights.io
> Document for Business Verification: the ASIC certificate of registration for Zodiix Pty Ltd dated 11 July 2016, plus a document showing the same address if Meta asks for one.
> Then App Dashboard > App settings > Basic > Verification: pick this portfolio (step 5).

**Settings > Basic > Display name**

> bizinsights

**Settings > Basic > App domains**

> bizinsights.io   (keep the old Cloudflare Worker's workers.dev domain only while that deployment still serves Meta connections; remove any cloudfront.net entry)

**Settings > Basic > Contact email**

> bizinsightsaus@yahoo.com   (CONTACT.supportEmail in apps/web/src/lib/contact.ts; or another inbox the owner reads, because App Review notices go here)

**Settings > Basic > Privacy Policy URL**

> https://bizinsights.io/privacy

**Settings > Basic > Terms of Service URL (required for Live mode)**

> https://bizinsights.io/terms

**Settings > Basic > User data deletion > Data deletion callback URL (after this branch's deploy)**

> https://bizinsights.io/api/webhooks/meta/data-deletion   (until it is live, use the Data deletion instructions URL https://bizinsights.io/data-deletion; the public instructions stay on that page either way)

**Facebook Login for Business > Settings > Deauthorize callback URL (after this branch's deploy)**

> https://bizinsights.io/api/webhooks/meta/deauthorize

**Settings > Advanced > Security > Require App Secret (after this branch's deploy)**

> On

**Settings > Basic > App icon**

> [OWNER: 1024x1024 image, no Meta trademarks or logos, no 'Facebook' or 'FB']

**Settings > Basic > Category**

> Business and pages

**Settings > Basic > App purpose**

> Clients

**Settings > Basic > Website platform > Site URL**

> https://bizinsights.io/

**Facebook Login for Business > Settings > Valid OAuth Redirect URIs**

> https://bizinsights.io/api/ads/meta/callback   (press Save Changes at the bottom of the page and reload to confirm; remove any cloudfront.net callback; Nango's old callback, https://bizinsights.io/api/ads/nango/oauth-callback, was removed on 2026-11-02: docs/ads-setup.md, "Leaving Nango", step (d))

**Facebook Login for Business > Configuration in use (reference only, not a form field)**

> Insights ads reporting (1521935306664882): user access token, ad accounts, ads_read only

**App Review > Permissions and Features > what to request**

> Advanced Access for ads_read and public_profile. Nothing else. Request the Marketing API Access Tier upgrade separately, with its Upgrade button, once the app has 500 or more calls in 15 days with errors under 15%.

**Requested Permissions and Features > ads_read > usage description (in the form: Allowed usage → "How will this app use ads_read?" → Get started)**

The dialog "Tell us why you're requesting ads_read" has tick boxes, then this text box (no length limit), the screencast upload, the API test calls (ads_read: Completed, 2026-10-26) and the agreement. Tick "Provide API access to your ad performance data for use in custom dashboards and data analytics." A text describing Nango was **pasted 2026-10-26** in the draft (submission 980737984435696) and saved. **[OWNER] It must be replaced with the text below before submitting** (rewritten 2026-10-28 for bizinsights' own Facebook Login; updated 2026-11-02 for the current Advertising screens and for where Meta data goes: alert emails and the merchant's own Zapier. Meta's box has no length limit). Still open in that dialog: the new text, the screencast and the agreement (owner).

> bizinsights (https://bizinsights.io) is a web analytics dashboard for Shopify merchants. Each merchant is a separate business. It signs in to bizinsights with its own bizinsights account and connects its own Meta ad accounts, so it can see what its Facebook and Instagram ads cost and returned next to its store's sales. ads_read is the only Marketing API permission bizinsights asks people to grant. We don't request ads_management, and bizinsights has no feature that creates, edits, pauses or deletes campaigns, ad sets, ads, audiences, budgets, billing or users.
>
> How a business grants it: in bizinsights, Settings > Advertising > "Continue with Meta Ads" takes the browser to Facebook Login for Business for our app. Our configuration uses a user access token and asks for ads_read only. The person grants ads_read and chooses the ad accounts to share, and Facebook sends the browser back to our own callback on bizinsights.io. The sign-in's state is single-use and bound to that browser and to the bizinsights user who started it. Our server exchanges the code with our app secret, swaps the token for a long-lived one, checks with GET /me/permissions that ads_read was granted, and calls GET /me/adaccounts (id, name, currency, timezone_name, account_status, disable_reason). If the login can see several ad accounts, the merchant ticks the ones that belong to this store. The token is encrypted with AES-256-GCM in our own database, never sent to the browser and never logged; no third party holds it. Every call is signed with appsecret_proof, and Require App Secret is on. When the token ends, after about 60 days, the merchant is asked to connect again.
>
> How we use the data:
> 1) Daily performance. GET /act_{id}/insights at campaign level with time_increment=1 (spend, impressions, clicks, inline_link_clicks, actions, action_values; use_unified_attribution_setting=true). We fetch the last 90 days when an account is connected and older days back to 25 months in the background, refresh recent days every hour, and re-read the last 30 days once a day, because Meta keeps crediting purchases for days after a click. When Meta asks for a smaller request on a large account, this sync runs the same query as an asynchronous Insights report (POST /act_{id}/insights, then read the report_run_id). That call only produces a report. bizinsights' Advertising area (the Advertising Performance page and the Meta Ads page) shows spend, impressions, link clicks, CTR, CPC, CPM, purchases, purchase value and ROAS per day, next to the store's Shopify sales and its Google Ads results, and the Profit sheet counts the ad spend among the store's costs.
> 2) On-demand report. When the merchant opens the Meta Ads report, we call GET /act_{id}/insights for the dates they pick, at campaign, ad set or ad level (spend, impressions, reach, frequency, link clicks, purchases, purchase value). We also read account-level splits by placement, device, country, age and gender, and each campaign's, ad set's and ad's effective_status, so the table can say Active, Paused, In review or Rejected. Answers are cached for 10 to 60 minutes and rate-limited per user, to stay inside Meta's limits.
>
> Examples: a fashion store sees which campaign brings back the most purchase value per dollar spent, then moves budget itself in Ads Manager. A merchant compares Meta and Google spend on the same daily chart against store revenue. A merchant sees frequency rising on an ad set and treats it as a sign of ad fatigue.
>
> Without ads_read, bizinsights could not show any Meta ad results, and merchants would have to export reports from Ads Manager by hand and match them to their sales. The data is shown only in the merchant's own bizinsights workspace: to its members, and to people the merchant invites to view it. It leaves bizinsights only where the merchant sends it: a CSV the merchant downloads, and, if the merchant connects its own Zapier account and turns on a Zap with one of our advertising triggers, the figures that Zap asks for (spend, impressions, clicks, conversions and purchase value per ad account) go to that merchant's Zapier account. When a connection needs attention (its access is ending, or Meta disabled the account), the workspace's admins get an email that names the ad account, with no figures. The data is never sold, never shared with other businesses or advertisers, and never used for advertising or to train models. Disconnecting deletes the token and every number we fetched for that account. Once no other connection relies on the same person's grant, bizinsights withdraws ads_read from Meta (DELETE /me/permissions/ads_read). Removing bizinsights in Facebook settings reaches our deauthorize callback, which stops using that person's connections at once; a data deletion request through Facebook deletes them and their figures and returns a status link.

**Requested Permissions and Features > public_profile > usage description (requested because Facebook Login for Business needs Advanced Access to public_profile before going live)**

Seen 2026-10-26: Meta's form asks **no description and no recording** for public_profile. Its dialog "Confirm data usage for public_profile" says the permission "is automatically granted to all apps" and has only the agreement box (owner). Keep this text for a reviewer's question.

> bizinsights uses public_profile only because it uses Facebook Login for Business, and Meta requires Advanced Access to public_profile before such an app goes live. When a connection is finished, our server calls GET /me?fields=id once to read the app-scoped user ID of the person who granted access. We store that ID with the ad-account connection for two reasons. It tells apart connections made by different people in the same workspace. And when a merchant disconnects, we withdraw ads_read (DELETE /me/permissions/ads_read) only once no other connection made by that same person still relies on the grant, so disconnecting one store doesn't break another. One exception reads the name: when the login reaches no ad account yet, our server calls GET /me?fields=id,name, keeps the login connected and shows "Signed in as <name>" on the merchant's Meta Ads card, so a person with two Facebook profiles sees which one is connected. That name is stored with the waiting login, visible only to the merchant's own workspace, and deleted with it (disconnect, Facebook's deauthorize or data deletion callback, or once the login's ad accounts are connected). We don't read the profile picture or any other profile field. Facebook Login is not used to sign in to bizinsights: bizinsights accounts use their own email sign-in.

**App Verification > 'Can app users sign in with a Meta authentication solution?' (recommendation, unverified)**

> Yes. App users go through Facebook Login for Business inside bizinsights to connect their ad accounts. The instructions explain that signing in to bizinsights itself uses a bizinsights email and password.

**App Verification > Platform Settings > instructions for reviewers**

> Paste reviewerTestInstructions with the owner's reviewer credentials filled in.

**Data handling Q1: data processors or service providers (including your own companies) with access to Platform Data from Meta (OWNER must confirm)**

> Draft: Yes. Amazon Web Services hosts the application, background jobs, report cache and the Postgres database (CloudFront, Lambda, SQS, DynamoDB, RDS, S3; region ap-southeast-2, Sydney). Cloudflare runs the DNS for bizinsights.io and proxies it: every page and API response, including the Meta figures shown to the merchant, passes through Cloudflare's network on its way between the browser and AWS (API responses are not cached). Meta access tokens are kept, encrypted, in that database: no third party holds them. Resend delivers bizinsights' own emails; the alert emails to a workspace's admins about an ad connection (access ending, account disabled, syncs failing) name the ad account, with no figures. Amazon Cognito (part of AWS) handles bizinsights sign-in only and never receives Meta data. Not our processor: when a merchant connects its own Zapier account and turns on a Zap with an advertising trigger, that Zap receives the ad figures it asks for, at the merchant's direction and under the merchant's own Zapier account (Platform Terms 5.b.ii.4, a Client's service provider); if Meta's form asks about it, say so. (Updated 2026-11-02: earlier drafts said Meta data went to no other third party.) [OWNER: while the old Cloudflare deployment (Cloudflare Workers, with its database on your PC) still holds Meta connections, it processes Meta data too; retire it before answering, or include it.]

**Data handling Q2: list all processors and service providers**

> Amazon Web Services [OWNER: the AWS entity your account contracts with, as named in your AWS agreement (unverified)]
> Cloudflare [OWNER: the Cloudflare entity in your Cloudflare terms (unverified)]
> Resend [OWNER: the Resend entity in your Resend terms (unverified)]

**Data handling Q3: service category for each processor**

> Amazon Web Services: IT solutions and services, including cloud storage and processing
> Cloudflare: IT solutions and services (DNS, content delivery and network security; option name unverified)
> Resend: IT solutions and services (email delivery; option name unverified)

**Data handling Q4: countries where each processor processes Platform Data**

> [OWNER: the functions and the database run in Australia (AWS ap-southeast-2, Sydney); CloudFront and Cloudflare carry pages and API responses through edge locations worldwide (unverified how Meta expects a CDN or proxy to be listed); Resend: the country in your Resend account's sending region (unverified).]

**Data handling Q5: responsible entity**

> [OWNER: the registered legal entity, matching CONTACT.legalName and Business Verification]

**Data handling Q6: country of the responsible entity**

> [OWNER: that entity's country. The production database is in Australia (AWS Sydney); if the entity is elsewhere, tell your adviser.]

**Data handling Q7: personal data given to public authorities for national-security requests in the past 12 months**

> [OWNER: answer truthfully. The choices are: No; about 10 or fewer users; 11-100; 101-1,000; more than 1,000; or prohibited by law or company policy from answering]

**Data handling Q8: policies for public-authority requests**

> [OWNER: tick only what really exists. The choices are: legality review; provisions for challenging unlawful requests; data minimization; documentation of requests, responses and reasoning; prohibited from answering; none of the above]

**Access Verification (Tech Provider) > how the business uses other businesses' data (category options unverified)**

> bizinsights is a SaaS analytics dashboard for Shopify merchants. Each merchant, a separate business, connects its own Meta ad accounts through Facebook Login for Business and grants ads_read. We use that access only to read the merchant's own ad performance (spend, impressions, reach, clicks, conversions, conversion value) and to show it to that merchant in their private bizinsights dashboard, next to their store's sales. Each merchant's data is kept under its own store and shown only to that merchant's workspace. We never create or change ads, and never sell or share the data. A merchant can disconnect at any time: that deletes the token and the data, and bizinsights withdraws ads_read once nothing else relies on the grant.

### Screen recording script

Rewritten 2026-10-26 against the app's current screens (Settings → Advertising cards, the emailed sign-in code) and Meta's screen-recording guide; updated 2026-10-28 for bizinsights' own Facebook Login (no Nango window: the tab goes to Facebook and comes back); steps 13-16 updated 2026-11-02 for the rebuilt Advertising area (Advertising Performance, the Meta Ads page, "Reconnect account"). One recording covers both permissions: ads_read in steps 10-17, public_profile in the Facebook Login of step 12. Upload it in ads_read's dialog; public_profile's dialog asks for no recording. Meta's guide (re-read 2026-11-02): show every requested permission, the whole path from logged out to logged in, the business login button, the person granting each permission (including choosing the ad accounts), and the data in use; English UI, 1080p or better, screen width 1440 or less, enlarged cursor, mouse rather than keyboard, no audio, captions and zooms added in an editor. It sets no length, format or size limit. The ads_read page asks to see impressions, conversions, spend, clicks and reach in the app.

**Recording tips**

- Tools: Snipping Tool and Clipchamp (both in Windows 11) as below. OBS Studio works the same way (Display Capture, 1920×1080, MP4). Loom also works if you download the MP4 and edit it, since Meta's dialog takes an uploaded file and the cuts and captions are still needed.
- Length: Meta sets none. Aim for 2 to 4 minutes after editing. This script comes to about 3 minutes once the waits are cut.
- No hidden steps: cut only waiting (the first fetch, page loads). Never cut inside Facebook's screens, the sign-in, or the Disconnect.
- No made-up data: record on https://bizinsights.io (not a local or staging address), with a real ad account that spent money in the dates shown. The reviewer workspace must not have the Google Ads demo connected: its figures are labelled "Simulated figures", and a reviewer seeing them could reasonably take the whole video for mocked data.

**No ads_management recording (checked 2026-10-26).** Meta's ads_management page asks for the same screencast as this one (the Facebook Login, then impressions, conversions, spend, clicks and reach shown in the app), which makes it look as if this video could serve ads_management too. It can't, and ads_management stays out of the submission. Three reasons: (1) the Login configuration "Insights ads reporting" (1521935306664882) asks for ads_read only, so no recording can show anyone granting ads_management; (2) Meta allows ads_management "to programmatically create campaigns, manage ads", and its review form asks why the app "requires managing ads on behalf of other businesses", but bizinsights only reads (its only Meta writes are the asynchronous Insights report and withdrawing its own ads_read grant, packages/core/src/ads/meta.ts); (3) the ads_read text already in the draft says "We don't request ads_management", and Meta names unneeded permissions as a common rejection reason. ads_management becomes worth requesting only if bizinsights gains a feature that changes ads (pausing a campaign, changing a budget); that feature then needs its own Login configuration and its own recording.

**Before you record (none of this is in the video)**

1. Ad figures to show. The ad account you connect must have delivered ads in the last few weeks, or every figure is 0 and the video shows no data (a named rejection reason). act_2033403030827115 had never delivered as of 2026-10-26: run a small ad on it for a few days first.
2. The reviewer account in production (prerequisite 8): email verified, Owner or Admin of its workspace, a Shopify development store connected, its address on `AUTH_LOGIN_CODE_EXEMPT` (deployed), Meta Ads not connected there (Settings → Advertising shows "Continue with Meta Ads" on the Meta Ads card), and the Google Ads demo not connected there (its "Simulated figures" must not appear in the video).
3. Facebook: Settings & privacy → Settings → Business integrations → remove bizinsights, so Facebook shows its full consent screen again. This ends the token behind your kept Meta connection; reconnect it afterwards (step 21).
4. Chrome, in English: sign out of bizinsights and Facebook, and close the other tabs. Facebook Login opens in the same tab, so no pop-up needs allowing. Turn on Windows' Do not disturb so no notification lands in the video.
5. Screen: on a 1920×1080 display, Windows Settings → System → Display → Scale 150% (the screen then works at 1280 wide, under Meta's 1440, and stays readable at 1080p). Settings → Accessibility → Mouse pointer and touch → Size 3 for a bigger pointer.
6. Recorder: Snipping Tool (Windows+Shift+R), drag over the whole screen, microphone and system sound off, Start. It records the whole screen, the address bar included, so the trip to facebook.com and back to bizinsights.io is in the video.
7. Sign in once as the reviewer before recording: it should land on the dashboard with no code step. If it asks for a code, the address isn't on `AUTH_LOGIN_CODE_EXEMPT` in production yet (prerequisite 8); fix that first, because Meta's reviewers would hit the same step.

**Record (mouse only; hold about 3 seconds on every new screen)**

8. Open https://bizinsights.io, signed out. Caption: "bizinsights: analytics dashboard for Shopify merchants".
9. Click Sign in. Type the reviewer email and password (the password stays masked) and press Sign in. You land on the dashboard. Caption: "Merchants sign in with a bizinsights account. Facebook is used only to connect ad accounts."
10. Settings → Advertising. On the Meta Ads card, show "Facebook and Instagram ads: spend, reach, clicks and the purchases Meta reports", what it reads (Campaigns, Ad sets, Ads, Audience, Spend & ROAS), "What you'll get", and zoom on the line under it: "Sign in with Facebook and authorize bizinsights to read the ad accounts you choose, including their Facebook and Instagram campaigns. You need access to those ad accounts; connecting a Facebook profile alone does not grant access to every business account. No app download is needed. bizinsights reads reports without changing campaigns or spending money." Caption: "bizinsights asks Meta for ads_read only: read-only ad reporting".
11. Click "Continue with Meta Ads" at the card's top right. It reads "Opening Meta…" and the tab goes to Facebook Login for Business (the address bar shows facebook.com). Caption: "bizinsights sends the merchant to Facebook Login for Business for the bizinsights app".
12. On Facebook's page, log in as yourself (the app Admin). On Facebook's screens, show the name "bizinsights" and what it asks for, choose this store's ad account(s), and confirm. Annotation: "ads_read is granted here. public_profile comes with Facebook Login: bizinsights reads only the app-scoped user ID".
13. Facebook sends the browser back to bizinsights.io (show the address bar). If the login can see several ad accounts, Settings → Advertising lists them: tick this store's and confirm (caption: "The merchant chooses which ad accounts belong to this store"). With one account this step is skipped and you land on the Dashboard, which says "Meta Ads connected: 1 ad account. We're fetching the last 90 days; the Advertising numbers below fill in within a few minutes." Caption: "Back on bizinsights.io: the ad account is connected". Keep recording until the Dashboard's "Advertising performance" card shows figures, then cut the wait in the edit and caption "(a few minutes later)".
14. Advertising in the sidebar opens "Advertising Performance". Zoom on the tiles Total ad spend, Link clicks, Impressions, Purchases, "Ad revenue (purchase value)" and ROAS, then the "Performance overview" chart and the Meta Ads card. Caption: "Spend, impressions, clicks and purchases from Meta's Marketing API, read with ads_read".
15. Meta Ads in the Advertising menu (/advertising/meta). Show the date range at the top, "At a glance", then the daily chart under "Over the days" (caption: "Daily ad spend from Meta"). Scroll to "Meta Ads report": its Campaigns, Ad sets and Ads tabs with each one's status, and zoom on Spent, Impressions, Reach, Frequency, Link clicks, "Purchases (Meta's count)", "Purchase value (Meta's count)" and Purchase ROAS. Then the Placements, Devices, Countries, Age and Gender tabs. Annotate "Reach" and "Purchases = conversions". Optional: Ads Manager in a second tab, same dates, to show spend and impressions match.
16. Settings → Advertising. On the Meta Ads card show "Integration active", then "View data details": Account name, Account ID, Time zone, Currency, Last synced, Freshness and Sync frequency, and Show on dashboard. Caption: "Read-only: nothing here creates, edits, pauses or deletes ads".
17. Click Disconnect at the card's top right. Show the dialog "Disconnect <account>?" ("bizinsights deletes its access to this Meta Ads account and every figure it fetched for it, and stops reading it. It then hands its access back to Meta once no other account here was connected with the same login. Your ads keep running."), press Disconnect, and show the card back on "Continue with Meta Ads". Caption: "Token and fetched data deleted; ads_read withdrawn from Meta (DELETE /me/permissions/ads_read) once no other connection relies on this grant".
18. Stop recording with Snipping Tool's stop button. It saves an MP4 under Videos → Screen Recordings.

**Edit and upload**

19. Clipchamp (built into Windows 11): drag the MP4 in; cut the waits and anything that shows an inbox, a password or a password manager; add each caption above as Text at its moment, 4-6 seconds each; zoom on small text by enlarging the clip in the preview; no music, no voice. Export at 1080p.
20. Meta: App Review → submission 980737984435696 → Allowed usage → ads_read → upload the MP4, tick the agreement, Save. public_profile: tick its agreement only. Then step 15 of Before you submit (data handling, reviewer instructions, Submit for Review).
21. Afterwards, connect Meta Ads again in your own workspace (step 3 ended it), and optionally in the reviewer workspace (prerequisite 12), so the hourly sync keeps counting toward the Marketing API Access Tier.

### Instructions for the reviewer

bizinsights is a web app for Shopify merchants at https://bizinsights.io. Merchants sign in to bizinsights with a bizinsights email and password. Facebook Login for Business is used only to connect a merchant's own Meta ad accounts, with the ads_read permission only.

1. Open https://bizinsights.io/login and sign in with this bizinsights-only test account. It is not a Meta account. Its email is verified, it is the workspace Owner, and its workspace has a Shopify development store connected.
   Email: [OWNER: reviewer email]
   Password: [OWNER: reviewer password]
2. Open Settings > Advertising. On the "Meta Ads" card, click "Continue with Meta Ads". [OWNER: if you pre-connected an ad account (prerequisite 12), replace this with: a Meta ad account is already connected so you can see real data, and the card shows it as "Integration active". "Reconnect account" on that card runs the same Facebook Login.]
3. The browser goes to Facebook Login for Business on facebook.com. Log in to Facebook as your test user, approve bizinsights' request to read ads reporting (ads_read), and choose an ad account. Facebook then sends you back to bizinsights.io.
4. Back in bizinsights: if your Facebook account can see several ad accounts, tick the ones to connect and confirm. If it can see none, the Meta Ads card stays connected and shows "Signed in as" with your Facebook name, "Your Facebook login is connected. It doesn't reach an ad account yet, so there are no figures to show." and a "Check for ad accounts" button; bizinsights looks again every hour. (If no ad account was ticked on Facebook's screen, it says so and offers "Choose ad accounts".) The attached recording shows the same flow with a real ad account.
5. A newly connected account's first fetch takes a few minutes, and the pages update by themselves. Click Advertising in the sidebar: "Advertising Performance" shows total ad spend, link clicks, impressions, purchases, purchase value and ROAS, with a chart over the dates. In the Advertising menu, "Meta Ads" shows Meta's figures day by day and the "Meta Ads report": campaigns, ad sets and ads with spend, impressions, reach, frequency, link clicks, purchases and purchase value, plus splits by placement, device, country, age and gender.
6. bizinsights is read-only. Nothing in it can create, edit, pause or delete campaigns, ads, budgets or billing, and ads_management is never requested. Settings > Advertising > Disconnect deletes the token and every number fetched for that account. Once no other connection relies on the same person's grant, bizinsights withdraws ads_read from Meta (DELETE /me/permissions/ads_read).
7. Optional, not needed to test ads_read: if a merchant connects its own Zapier account (Settings > Integrations), a Zap with one of bizinsights' advertising triggers receives that store's ad figures in the merchant's own Zapier account. Nothing is sent to Zapier unless the merchant sets this up.

Privacy policy: https://bizinsights.io/privacy
Data deletion instructions: https://bizinsights.io/data-deletion
Support: https://bizinsights.io/support

### Common reasons for rejection

- Requesting permissions the app doesn't need, a reason Meta calls common. Request Advanced Access only for ads_read and public_profile. Leave ads_management, business_management, the pages permissions and email at Standard.
- A requested permission or feature with no screen recording; Meta won't approve it. Every requested permission must appear in a recording.
- A recording that doesn't start from logged out, skips the bizinsights sign-in, or doesn't show the person granting ads_read in the full Facebook Login for Business flow.
- A recording that doesn't show ad performance data in the app. The ads_read page names impressions, conversions, spend, clicks and reach, so use an ad account with recent delivery and show the Meta Ads report for reach.
- Usage descriptions that are vague, copied between permissions, or not tied to using the data on behalf of other businesses.
- A privacy policy that is broken, geo-blocked, unreachable by Meta's crawler, not clearly titled, not your own, or with no working way to ask for deletion. /privacy and /data-deletion on bizinsights.io are complete since 2026-10-16; check them in the Sharing Debugger, because the site is behind Cloudflare's proxy.
- Reviewers can't reach or use the app: production is down, the Meta callback on bizinsights.io isn't registered (step 7), the reviewer email isn't verified ('Verify your email first'), the reviewer isn't Owner or Admin (no connect button), or no store is connected ('Connect your Shopify store first').
- A reviewer's Facebook test account owns no ad account, so they see only the 'can't reach any ad account' message. Reduce this risk with a pre-connected account and the recording.
- Including your personal Meta login in the instructions. Reviewers use their own test accounts.
- No successful API call for a requested permission in the 30 days before submitting.
- An unverified business portfolio. Advanced Access isn't granted, and other businesses can't grant permissions.
- Access Verification (Tech Provider) denied or not done. ads_read calls then fail for anyone without a role on the app, even after App Review passes.
- Data that looks made up: the Google Ads demo's "Simulated figures" in the frame, a local or staging address, or an ad account that never delivered, so every figure is 0.
- Texts that contradict what the reviewer sees or the privacy policy: for example "never shared" while the app offers Zapier triggers with ad figures. The 2026-11-02 texts say where Meta data goes; keep the form, the policy and the app saying the same thing.
- A reviewer account that asks for an emailed code (its address isn't on `AUTH_LOGIN_CODE_EXEMPT` in production).
- Changing basic or advanced app settings after submitting, which may need a new review.
- Switching to Live before approval, or before completing the Data Use Checkup.

### Sources

- https://developers.facebook.com/docs/permissions/reference/ads_read
- https://developers.facebook.com/docs/permissions/reference/public_profile
- https://developers.facebook.com/docs/features-reference/
- https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
- https://developers.facebook.com/docs/marketing-api/overview/authorization
- https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog.md
- https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/rate-limiting.md
- https://developers.facebook.com/documentation/development/create-an-app/marketing-api-use-cases.md
- https://developers.facebook.com/docs/graph-api/overview/access-levels
- https://developers.facebook.com/docs/app-review/submission-guide
- https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review/submission-guide
- https://developers.facebook.com/docs/app-review/submission-guide/screen-recordings
- https://developers.facebook.com/docs/development/release/business-verification
- https://developers.facebook.com/documentation/development/release/business-verification.md
- https://developers.facebook.com/docs/development/release/access-verification
- https://developers.facebook.com/docs/development/create-an-app/app-dashboard/basic-settings
- https://developers.facebook.com/documentation/development/terms-and-policies/privacy-policy.md
- https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/data-handling-questions/questions-preview
- https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/data-use-checkup
- https://developers.facebook.com/documentation/development/build-and-test/app-modes.md
- https://developers.facebook.com/documentation/development/build-and-test/test-users.md
- https://developers.facebook.com/terms/ (Platform Terms: 3.c and 5.b.ii.4 on sharing Platform Data, read 2026-11-02)
