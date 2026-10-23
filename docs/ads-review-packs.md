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
  2026-10-19, and the workers.dev redirect URI was removed on 2026-10-20, so Valid OAuth Redirect URIs holds only
  `https://bizinsights.io/api/ads/meta/callback`.

Still open (details in each pack; checked 2026-10-20). Each of these needs the owner's login, certificate or payment
method; Claude has nothing left to do alone until one of them moves.

- **A Google Ads account with figures for the demo.** On the demo login sebanceo@gmail.com the manager account
  bizinsights 892-467-3464 is finished (Australia, Sydney Time, AUD), but managers hold no campaigns, and the client
  bizinsights 745-450-4478 under it stays "Setup in progress" until a payments profile exists on its billing page
  (legal name, address, payment method: owner only). Its draft Search campaign (A$1/day, Page views goal) publishes
  after that. Until then bizinsights' connect gets CUSTOMER_NOT_ENABLED for the client. Google step 10.
- **The demo video and the Verification Center submission.** Script, justification and reviewer text are below; the
  owner records, uploads (unlisted) and submits. Google steps 11 to 13.
- **Meta Business Verification is pending.** The portfolio **Zodiix Pty Ltd** was created on 2026-10-20 under the
  app admin's Facebook account (sebanceo@gmail.com), the phone code was confirmed and the ASIC certificate uploaded
  the same day; Meta decides in its own time (usually days) and reports under Security Center. Entity facts (ABN
  Lookup, 2026-10-20): ACN 613 577 834, ABN 40 613 577 834, GST-registered, main business location VIC 3977,
  registered business name "PixMagic" only; "bizinsights" is not a registered business name of that ABN, and
  "Bizinsights Pty Ltd" (ABN 89 156 153 196, QLD 4740, since 2012) is an unrelated company. "Testbusiness"
  (1754818672920174) is the other Facebook account's portfolio (imeseban@gmail.com, WhatsApp app). While Meta
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
6. [OWNER ONLY, after step 2] Google Auth Platform, in this order: (i) Branding -> Authorized domains: add `bizinsights.io` first. Google: 'Add your Authorized Domains before you add your redirect or origin URIs, your homepage URL...'. (ii) Clients -> 'Insights web' (534794119904-9esdp8dhskcupf6ekbb0iej2dr10gomf.apps.googleusercontent.com): add https://bizinsights.io/api/ads/google/callback and https://bizinsights.io/api/ads/adsense/callback, if they aren't there yet. Remove the URIs on the old Cloudflare Worker's workers.dev host and on `d2mr8m2p1qkh58.cloudfront.net`, every localhost URI and any JavaScript origins (the flow is server-side, so none are needed). (iii) Branding: app name 'bizinsights' (lower case, as on the homepage), support email, logo, homepage https://bizinsights.io/, privacy https://bizinsights.io/privacy, terms https://bizinsights.io/terms, and the developer contact. Remove every authorized-domain entry other than bizinsights.io. (iv) Press Verify Branding: the automated check takes minutes, and a manual review usually takes 2-3 business days. (v) Press Publish branding within 7 days; after that the status becomes 'Need to re-verify'. The app name shows on the consent screen only after verification, and data-access verification needs published branding, so finish this before recording.
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
> (these two only. Remove the same two paths on the old Cloudflare Worker's workers.dev host and on https://d2mr8m2p1qkh58.cloudfront.net, and every http://localhost URI.)

**Clients -> Insights web -> Authorized JavaScript origins**

> None. The code exchange happens on the server only; remove any existing origins.

**Data Access -> Sensitive scopes**

> https://www.googleapis.com/auth/adwords  (Google Ads API; Google describes it as 'See, edit, create, and delete your Google Ads accounts and data')

**Data Access -> Non-sensitive scopes**

> https://www.googleapis.com/auth/adsense.readonly  (AdSense Management API, 'View your AdSense data')

**Verification Center -> Scope justification for https://www.googleapis.com/auth/adwords (short version; the field's character limit is unverified)**

> bizinsights is an analytics dashboard for Shopify merchants. When a merchant presses "Continue with Google Ads" (Settings > Advertising) and picks their ad accounts, bizinsights reads those accounts' reports through the Google Ads API (customers:listAccessibleCustomers and read-only googleAds:searchStream GAQL queries; no mutate calls). It shows them only inside that merchant's own bizinsights workspace: spend, impressions, clicks, CTR, CPC, CPM, conversions, conversion value and ROAS per day next to their Shopify sales, plus a report by campaign, ad group, device and country. Google's Google Ads API documentation names https://www.googleapis.com/auth/adwords as the scope for API access, and there is no read-only or narrower Google Ads scope. bizinsights never creates, edits, pauses or deletes anything in Google Ads. Tokens are AES-256-GCM encrypted at rest and never sent to the browser. Disconnecting deletes the token and every fetched figure, and bizinsights revokes its grant at Google once no other bizinsights connection uses that Google sign-in. No selling, transfers, ads use or AI training (Limited Use).

**Verification Center -> Scope justification (full version, for a longer field or a reply to the reviewer's email)**

> What the app does: bizinsights (https://bizinsights.io/) is an analytics dashboard for Shopify merchants. It puts a store's sales next to the cost and results of its advertising.
>
> User-facing feature that uses this scope: in Settings > Advertising, a workspace owner or admin presses "Continue with Google Ads" and grants access on Google's consent screen. The scope is requested only at that moment, never at sign-in to bizinsights. If the Google login can see several Google Ads accounts (for example through a manager account), the merchant ticks the ones that belong to the store. The merchant then lands on the dashboard. Its Advertising section shows, per platform and per day, spend, impressions, clicks, CTR, CPC, CPM, conversions, conversion value and ROAS. A detail view shows a Google Ads report by campaign (with status, type and budget), ad group, device and country. A background sync keeps these figures current: the last 90 days are fetched on connect and older days back to 25 months in the background, recent days are refreshed every three hours, and the last 90 days are read again daily because conversions are credited to the day of the click for up to 90 days. That is why the app requests offline access.
>
> Google API calls made with the token: Google Ads API customers:listAccessibleCustomers, to list the accounts the person can see, and googleAds:searchStream with GAQL SELECT queries. These read the account name, id, currency, time zone and manager/client structure; campaign and ad group names, status, type and budget; and daily cost, impressions, clicks, conversions and conversion value by date, device and country. For client accounts reached through a manager account, the manager's id is sent as login-customer-id. bizinsights makes no mutate call of any kind. bizinsights also calls Google's OAuth tokeninfo endpoint. It confirms the token was issued to bizinsights' own client and records the Google account's numeric ID, so bizinsights can tell when two connections share one Google sign-in. On disconnect it calls the revoke endpoint.
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

> OAuth client: 'Insights web', 534794119904-9esdp8dhskcupf6ekbb0iej2dr10gomf.apps.googleusercontent.com, the only OAuth client in project insights-511119 (confirm in Clients before sending). Development uses a separate project. Two consent flows use this client, and both appear in the video: (1) 'Continue with Google Ads' (Settings > Advertising, or "Connect" on the Google Ads card of Settings > Integrations) requests only https://www.googleapis.com/auth/adwords, with access_type=offline, prompt=consent and PKCE S256; (2) 'Continue with Google AdSense' (Settings > Advertising) requests only https://www.googleapis.com/auth/adsense.readonly. Signing in to bizinsights itself goes through Amazon Cognito and does not use this client. Access is read-only: bizinsights calls only customers:listAccessibleCustomers and googleAds:searchStream (GAQL SELECT) and never makes a mutate call. Disconnect deletes the token and data, and bizinsights revokes its grant at https://oauth2.googleapis.com/revoke once no other connection uses the same Google sign-in. Google Ads API access level: Explorer (granted 2026-10-11).

**Homepage -> section 'Google Ads and Google AdSense' (id="google-data"; added in apps/web/src/components/landing/AdPlatforms.tsx, live with this branch's deploy; reference only: the wording on the page is what counts)**

> The draft it was written from: Google Ads and Google AdSense (optional). If you press "Continue with Google Ads" in Settings, Google asks you to allow bizinsights to "See, edit, create, and delete your Google Ads accounts and data". That is the only permission Google offers for the Google Ads API, and bizinsights uses it only to read reports. For the ad accounts you pick, bizinsights reads account names and ids, currency and time zone; campaign and ad group names, status, type and budget; and daily spend, impressions, clicks, conversions and conversion value by device and country. It uses them to show your ad spend, CTR, CPC, CPM and ROAS next to your Shopify sales. "Continue with Google AdSense" asks only for read-only access ("View your AdSense data") to show your site's estimated earnings, page views, ads shown and clicks. bizinsights never creates, changes, pauses or deletes ads, budgets or billing. You can disconnect at any time in Settings, and the access token and every figure fetched are deleted. bizinsights' use and transfer of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements. See our Privacy Policy.

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
> What the tool does: bizinsights is a reporting dashboard for Shopify merchants. A merchant connects their own Google Ads account with OAuth (scope https://www.googleapis.com/auth/adwords) and sees spend, impressions, clicks, CTR, CPC, CPM, conversions, conversion value and ROAS per day, broken down by campaign, ad group, device and country, next to their Shopify sales.
>
> Who uses it: external users (Shopify merchants), each on the Google Ads accounts their own Google sign-in can reach. No agency work and no management of accounts on anyone's behalf.
>
> API usage: read-only reporting. CustomerService.ListAccessibleCustomers to find the accounts a sign-in can reach, then GoogleAdsService.SearchStream with GAQL SELECT queries on campaign, ad_group and the device and geographic segments. No mutate calls: nothing is created, edited, paused or deleted, and budgets, billing and users are never touched.
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
5. 4. bizinsights (already signed in by email) -> Settings -> Advertising. VISIBLE: the Google Ads card with 'Continue with Google Ads' and its text 'Google asks you to choose your Google account and allow access. ... bizinsights only reads reports: it can't create, change or pause ads, or spend money.' NARRATE: 'Signing in to bizinsights doesn't involve Google Ads. The Google Ads permission is asked for only here, when the merchant chooses to connect Google Ads.'
6. 5. Click 'Continue with Google Ads' and choose the demo Google account. If Google first shows 'Google hasn't verified this app' (expected while verification is pending), keep it in the recording and continue through Advanced. The official pages don't cover this screen, so this is unverified.
7. 6. Google consent screen for Google Ads. Hold for at least 10 seconds. VISIBLE: (a) the language selector at the bottom-left set to English; (b) the app name 'bizinsights'; (c) the complete consent screen, scrolled so every line shows, with only the Google Ads permission ('See, edit, create, and delete your Google Ads accounts and data' or Google's current wording) and no other scope; (d) the address bar, clicked and zoomed until 'client_id=534794119904-9esdp8dhskcupf6ekbb0iej2dr10gomf.apps.googleusercontent.com' is readable. Google requires showing 'that the browser address bar of the OAuth consent screen correctly includes your app's OAuth client ID.' NARRATE: 'This is the https://www.googleapis.com/auth/adwords scope. bizinsights uses it only to read reports, because the Google Ads API has no read-only scope.'
8. 7. Allow and press Continue. VISIBLE: the redirect back to https://bizinsights.io/... If the login reaches several Google Ads accounts, bizinsights shows its account picker on Settings -> Advertising: tick the store's account and confirm. With a single account, bizinsights goes straight to the dashboard.
9. 8. Dashboard -> Advertising section. VISIBLE: the Google Ads figures arriving (spend, impressions, clicks, CTR, CPC, CPM, conversions, conversion value, ROAS), the per-day chart, and the by-platform comparison next to Shopify sales. NARRATE: 'Every number here is read from the Google Ads API with the adwords scope and shown only inside this merchant's workspace.'
10. 9. Open the Advertising detail view -> Google Ads report. VISIBLE: campaigns with status, type and budget; ad groups; the device breakdown; the country breakdown. NARRATE: 'This is the full set of Google Ads data bizinsights reads. Nothing here creates, edits, pauses or deletes anything in Google Ads.'
11. 10. Settings -> Advertising (management page). VISIBLE: the Google Ads card as Connected, the access line 'Google Ads reporting (Google has no read-only scope; bizinsights only reads)', the account, the last sync, and the Refresh, Show on dashboard and Disconnect controls. NARRATE: 'There are no write controls. Tokens are encrypted and never reach the browser.'
12. 11. Second consent workflow on the same client. Google: 'if there are multiple OAuth consent workflows, you must demonstrate each of these methods in your video.' On Settings -> Advertising, show the Google AdSense card ('Read-only access to AdSense reports (adsense.readonly)') and click 'Continue with Google AdSense'. VISIBLE on Google's screen: English, 'bizinsights', only 'View your AdSense data', and client_id in the address bar (hold 10 s). Allow, return, and show the dashboard's 'Ad earnings' card: estimated earnings, page views, ads shown and clicks per site and day. NARRATE: 'This flow uses the same client and requests only adsense.readonly.'
13. 12. Disconnect in this order, as tested in the dry run. (a) Settings -> Advertising -> Google AdSense -> Disconnect -> confirm. NARRATE: 'bizinsights deletes the AdSense token and figures. Google ends a sign-in's whole grant at once, so bizinsights keeps the grant while Google Ads still uses this Google account.' (b) Settings -> Advertising -> Google Ads -> Disconnect. VISIBLE: the confirmation 'Disconnect Google Ads? bizinsights deletes its access and every number it fetched for your ad accounts. Your ads keep running.' Confirm it; the Advertising section no longer shows Google Ads. NARRATE: 'The token and every figure fetched are deleted, and because no other connection uses this Google sign-in, bizinsights has revoked its access at Google.' (c) Optional, only if the dry run showed it: open your Google Account's third-party connections page and show that bizinsights no longer has access.
14. 13. End card (5 s). VISIBLE: 'Read-only. Limited Use compliant. Privacy: https://bizinsights.io/privacy - Support: https://bizinsights.io/support'. Upload in YouTube Studio with Visibility = Unlisted, open the link in a signed-out window to check it plays, then paste it into the Verification Center.

### Instructions for the reviewer

Paste into the reviewer free-text field if one is shown, otherwise into a reply to the Trust & Safety email. None of the official pages I read require test credentials for sensitive-scope review. If the reviewer asks for access, reply in the same email thread with the reviewer login. Never put credentials in the form or the video.

How to see the Google Ads feature in bizinsights:
1. Open https://bizinsights.io/. The privacy policy, https://bizinsights.io/privacy#google-user-data, explains what is read from Google and why. Sign in at https://bizinsights.io/login with the reviewer login we send on request (email sign-in). Its workspace has a Shopify development store connected, and the reviewer is a workspace admin, which connecting ad accounts requires.
2. Go to Settings -> Advertising and press "Continue with Google Ads" on the Google Ads card.
3. On Google's screens, choose a Google account that can access a Google Ads account and allow the single permission requested: https://www.googleapis.com/auth/adwords, OAuth client 534794119904-9esdp8dhskcupf6ekbb0iej2dr10gomf.apps.googleusercontent.com. While verification is pending, Google first shows its unverified-app warning. Google always shows its account chooser first. A Google account with no Google Ads account gets 'That Google login has no Google Ads account, so nothing was connected', with a "Choose another Google account" button that reopens Google's chooser.
4. If the login reaches several Google Ads accounts (for example through a manager account), tick the ones for the store and confirm.
5. You land on the dashboard. Within a minute or two the Advertising section shows spend, impressions, clicks, CTR, CPC, CPM, conversions, conversion value and ROAS per day. The detail view's Google Ads report breaks this down by campaign (status, type, budget), ad group, device and country.
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

### Remaining gaps (fix before submitting; checked 2026-10-20)

No longer gaps: contact.ts is filled in (legalName Zodiix Pty Ltd, ACN 613 577 834 since PR #152; supportEmail bizinsightsaus@yahoo.com since 2026-10-22), /privacy and /data-deletion show no "[not set" marker, /terms exists, and all of /, /privacy, /terms, /data-deletion and /support return 200 on bizinsights.io. The app's settings and its only Valid OAuth Redirect URI are on bizinsights.io (2026-10-19 and 2026-10-20), the deauthorize and data deletion callbacks are registered, and Require App Secret is on.

- Business Verification pending: submitted 2026-10-20 for the portfolio Zodiix Pty Ltd, created the same day under the app admin's Facebook account (sebanceo@gmail.com), with the phone code confirmed and the ASIC certificate uploaded. Until Meta approves it, App Review and Access Verification can't be submitted. Entity facts for any follow-up question from Meta: ACN 613 577 834, ABN 40 613 577 834, Australian private company, GST-registered, main business location VIC 3977, registered business name "PixMagic" only (ABN Lookup, 2026-10-20). Claude does not upload documents or automate business.facebook.com (Meta blocked the admin's developer account twice in October after automated clicking).
- App icon: whether a 1024x1024 version is in place is unconfirmed (step 3); the icon uploaded on 2026-10-11 was the 1200x1200 listing icon.
- Cloudflare now proxies bizinsights.io, so every page and API response, including the Meta figures shown to merchants, passes through it. The data handling answers below name it next to AWS.
- No mailbox on bizinsights.io: the zone has no MX record. The contact address is bizinsightsaus@yahoo.com. For Business Verification, confirm by phone: Meta offered only phone or email on 2026-10-20, no domain record (step 6).
- Reviewer account conditions taken from the code: the email is verified (otherwise 'Verify your email first'), and the role is Owner or Admin of the workspace (otherwise there is no connect button).
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
4. [DONE 2026-10-20: portfolio "Zodiix Pty Ltd" created under sebanceo@gmail.com] Create a Meta business portfolio for Zodiix Pty Ltd, the entity in CONTACT.legalName and on the ASIC certificate, signed in to business.facebook.com as the Facebook account that administers the app (sebanceo@gmail.com), so that account is the portfolio's Admin from the start: only a business Admin can complete Business Verification and Access Verification. The existing "Testbusiness" portfolio (1754818672920174) is on the other Facebook account (imeseban@gmail.com) with the WhatsApp app; reuse it only if that account first makes sebanceo an Admin and you rename it and fill in its business info. The values for Create a business portfolio and Business info are under "Meta Business Settings > Business portfolio" in the form answers: name it Zodiix Pty Ltd (not "bizinsights", which is not a registered business name of ABN 40 613 577 834 and is the company name of an unrelated Queensland company), and use the registered address and phone from the certificate, which are not in the repo.
5. [DONE 2026-10-20: App settings > Basic > Verification names Zodiix Pty Ltd, verification pending] Connect the app to the portfolio. In the App Dashboard, go to Settings > Basic > Verification > Start Verification and pick the portfolio.
6. [SUBMITTED 2026-10-20 (phone code confirmed, ASIC certificate uploaded); Meta's decision pending] Complete Business Verification in Business Manager or Business Suite. Meta's developer docs send you to the Business Help Center for the document list. Those pages don't render outside a browser, so these points come from search summaries and are (unverified): the legal name, address, phone and an HTTPS website must match your documents; a registration or incorporation document is needed if Meta can't find the business; confirmation is by email, phone or domain; an email domain that matches the website helps. The website is https://bizinsights.io. It has no MX record, so no @bizinsights.io address can receive Meta's confirmation email. Seen 2026-10-20 while creating the portfolio as Zodiix Pty Ltd: Meta offered only phone or email confirmation for this business, no domain record, so confirm by phone (the Business info number). If phone fails, add mail to the domain first (Cloudflare Email Routing to bizinsightsaus@yahoo.com) and use email. Verification isn't required to go Live, but the app can't access data you don't own until it is complete.
7. [OWNER] Move the app to bizinsights.io and finish Settings > Basic, using the form answers below: Display name, Contact email (an inbox you read, because App Review notices go there), Privacy Policy URL, Terms of Service URL, User data deletion instructions URL, App icon, Category, App Purpose 'Clients', App Domains and the Website platform Site URL. In Facebook Login for Business > Settings, add https://bizinsights.io/api/ads/meta/callback to Valid OAuth Redirect URIs and press the Save Changes button at the bottom of the page: the 'Changes saved' toast alone doesn't keep it, so reload to confirm. Remove any d2mr8m2p1qkh58.cloudfront.net callback (the app never sends it). Once this branch's Deploy to AWS run has succeeded: in Facebook Login for Business > Settings, set Deauthorize callback URL to https://bizinsights.io/api/webhooks/meta/deauthorize; in Settings > Basic > User data deletion, choose the callback option and enter https://bizinsights.io/api/webhooks/meta/data-deletion (Meta then shows people https://bizinsights.io/data-deletion?code=... with their request's status); and in Settings > Advanced > Security turn on Require App Secret (every ads call already sends appsecret_proof). Both callbacks need META_APP_SECRET in production (otherwise they answer 503). The old Cloudflare Worker's workers.dev callback was removed on 2026-10-20 (integrations-readiness.md); remove its app domain too once that deployment no longer serves Meta connections. Do this before submitting: changing basic or advanced settings after submitting may need a new review.
8. [OWNER] Create the bizinsights reviewer account in production. It uses email and password, is not your personal account, and is not a Meta account. It must meet three conditions, or the reviewer can't connect. (a) Its email is verified: otherwise connecting fails with 'Verify your email first'. (b) It is Owner or Admin of its workspace: other roles see 'Only a workspace owner or admin can connect or disconnect accounts.' and no button. (c) The workspace has a Shopify development store connected: otherwise Settings > Advertising only says 'Connect a Shopify store first; ad accounts are connected to a store.' Don't use the frozen store 9kdgux-gq (402). A few test orders make the dashboard less empty. Put the credentials only in the App Verification instructions. Meta says never to give your personal Meta login, because reviewers use their own test accounts.
9. [OWNER, after step 7] Within the 30 days before you submit, make at least one successful call for each permission requested. In production (https://bizinsights.io), while the app is still in Development mode, connect Meta Ads with your own Facebook account (an app Admin) in your own workspace, on an ad account that delivered ads recently. Connecting calls GET /me/permissions and GET /me?fields=id (public_profile), then GET /me/adaccounts, and the sync calls GET /act_{id}/insights (ads_read). Leave it connected: its hourly sync also counts toward the 500-call threshold of the Marketing API Access Tier. One account makes about 25 calls a day by the sync schedule (estimate), so connect two or more ad accounts, or open the Meta Ads report now and then, to pass 500 in 15 days.
10. [OWNER] Keep production up for the whole review: App Review takes up to a week, and Access Verification about 5 days. Production runs on AWS, so nothing on your PC has to stay on. While the old deployment's database still runs on your PC ([aws-deployment.md](aws-deployment.md#retiring-the-old-cloudflare-deployment)), close the exposure from the 2026-10-10 security audit if it is still open (reachable on the LAN with default credentials) before you answer Meta's data-handling questions.
11. [OWNER] Record and edit the screencast with screencastScript. Removing bizinsights under Facebook Business integrations for the recording ends the token behind the connection from step 9 and any other Meta connection you made. Reconnect them afterwards.
12. [OWNER, optional, recommended] After recording, connect your own ad account again, this time in the reviewer workspace. Then reviewers see real numbers even if their Facebook test account owns no ad account. Meta has temporarily stopped new test-user creation, so this is likely. The card then shows 'Reconnect or add accounts', which runs the same Facebook Login. A login with no ad accounts leaves the existing data in place.
13. [OWNER] In App Review > Permissions and Features, request Advanced Access for ads_read and public_profile only. Leave everything else in the 'Measure ad performance data with Marketing API' use case at Standard Access: ads_management, business_management, pages_show_list, pages_read_engagement, email, and the Marketing API Access Tier feature until it is eligible. Unneeded permissions are a common reason for rejection. If the dashboard asks for Business Verification at this point (Step 1.5), finish it first.
14. [OWNER ONLY] Answer the data handling questions. They appear once Business Verification is approved, and Meta scores them within about 30 seconds. The drafts are in formAnswers; only you can confirm them. Meta advises checking with legal, policy and privacy advisers.
15. [OWNER] For each permission: paste its own usage description (never copy one to the other), upload the recording, fill in App Verification with reviewerTestInstructions, click Submit for Review and accept the Platform Onboarding Terms. Meta aims to decide within a week.
16. [OWNER ONLY: business Admin] Complete Access Verification (Tech Provider) under App Dashboard > Basics > Verifications > Access verification. It needs Business Verification and a business account with no restrictions, and can run while App Review is in progress. Meta decides in about 5 days. If it is denied, calls that need ads_read fail for anyone without a role on the app, even after App Review passes.
17. [OWNER] After approval: complete the Data Use Checkup, which a Development-mode app must finish before switching to Live. Then switch the app to Live; only approved permissions work in Live mode. After that, watch Required Actions in the App Dashboard for Ongoing Review, the yearly Data Use Checkup, or Data Access Renewal, which Meta is rolling out in phases to merge these checks.
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

> https://bizinsights.io/api/ads/meta/callback   (press Save Changes at the bottom of the page and reload to confirm; remove any cloudfront.net callback)

**Facebook Login for Business > Configuration in use (reference only, not a form field)**

> Insights ads reporting (1521935306664882): user access token, ad accounts, ads_read only

**App Review > Permissions and Features > what to request**

> Advanced Access for ads_read and public_profile. Nothing else. Request the Marketing API Access Tier upgrade separately, with its Upgrade button, once the app has 500 or more calls in 15 days with errors under 15%.

**Requested Permissions and Features > ads_read > usage description (exact label and character limit unverified)**

> bizinsights (https://bizinsights.io) is a web analytics dashboard for Shopify merchants. Each merchant is a separate business. It signs in to bizinsights with its own bizinsights account and connects its own Meta ad accounts, so it can see what its Facebook and Instagram ads cost and returned next to its store's sales. ads_read is the only Marketing API permission bizinsights asks people to grant. We don't request ads_management, and bizinsights has no feature that creates, edits, pauses or deletes campaigns, ad sets, ads, audiences, budgets, billing or users.
>
> How a business grants it: in bizinsights, Settings > Advertising > "Continue with Meta Ads" opens Facebook Login for Business. Our configuration uses a user access token and asks for ads_read only. The person grants ads_read and chooses the ad accounts to share. Our server exchanges the code server-side, checks with GET /me/permissions that ads_read was granted, and calls GET /me/adaccounts (id, name, currency, timezone_name, account_status). If the login can see several ad accounts, the merchant ticks the ones that belong to this store. The token is encrypted with AES-256-GCM on our server and is never sent to the browser.
>
> How we use the data:
> 1) Daily performance. GET /act_{id}/insights at campaign level with time_increment=1 (spend, impressions, clicks, inline_link_clicks, actions, action_values; use_unified_attribution_setting=true). We fetch the last 90 days when an account is connected and older days back to 25 months in the background, refresh recent days every hour, and re-read the last 30 days once a day, because Meta keeps crediting purchases for days after a click. When Meta asks for a smaller request on a large account, this sync runs the same query as an asynchronous Insights report (POST /act_{id}/insights, then read the report_run_id). That call only produces a report. The dashboard's Advertising section shows spend, impressions, clicks, CTR, CPC, CPM, conversions, conversion value and ROAS per day, next to the store's Shopify revenue and its Google Ads results.
> 2) On-demand report. When the merchant opens the Meta Ads report, we call GET /act_{id}/insights for the dates they pick, at campaign, ad set or ad level (spend, impressions, reach, frequency, link clicks, purchases, purchase value). We also read account-level splits by placement, device and country, and each campaign's, ad set's and ad's effective_status, so the table can say Active, Paused, In review or Rejected. Answers are cached for 10 to 60 minutes and rate-limited per user, to stay inside Meta's limits.
>
> Examples: a fashion store sees which campaign brings back the most purchase value per dollar spent, then moves budget itself in Ads Manager. A merchant compares Meta and Google spend on the same daily chart against store revenue. A merchant sees frequency rising on an ad set and treats it as a sign of ad fatigue.
>
> Without ads_read, bizinsights could not show any Meta ad results, and merchants would have to export reports from Ads Manager by hand and match them to their sales. The data is shown only to members of the merchant's own bizinsights workspace. It is never sold, never shared with other businesses or advertisers, and never used for advertising or to train models. Disconnecting deletes the token and every number we fetched for that account. bizinsights then withdraws ads_read from Meta (DELETE /me/permissions/ads_read) once no other connection relies on the same person's grant. Removing bizinsights in Facebook settings reaches our deauthorize callback, which stops using that person's connections at once; a data deletion request through Facebook deletes them and their figures and returns a status link.

**Requested Permissions and Features > public_profile > usage description (requested because Facebook Login for Business needs Advanced Access to public_profile before going live; whether it needs its own recording is unverified, so upload the same annotated recording)**

> bizinsights uses public_profile only because it uses Facebook Login for Business, and Meta requires Advanced Access to public_profile before such an app goes live. During the sign-in callback, right after exchanging the code, our server calls GET /me?fields=id once to read the app-scoped user ID of the person who granted access. We store that ID with the ad-account connection for two reasons. It tells apart connections made by different people in the same workspace. And when a merchant disconnects, we withdraw ads_read (DELETE /me/permissions/ads_read) only once no other connection made by that same person still relies on the grant, so disconnecting one store doesn't break another. We don't read, store or show the person's name, profile picture or any other profile field. Facebook Login is not used to sign in to bizinsights: bizinsights accounts use their own email sign-in.

**App Verification > 'Can app users sign in with a Meta authentication solution?' (recommendation, unverified)**

> Yes. App users go through Facebook Login for Business inside bizinsights to connect their ad accounts. The instructions explain that signing in to bizinsights itself uses a bizinsights email and password.

**App Verification > Platform Settings > instructions for reviewers**

> Paste reviewerTestInstructions with the owner's reviewer credentials filled in.

**Data handling Q1: data processors or service providers (including your own companies) with access to Platform Data from Meta (OWNER must confirm)**

> Draft: Yes. Amazon Web Services hosts the application, background jobs, report cache and the Postgres database (CloudFront, Lambda, SQS, DynamoDB, RDS, S3; region ap-southeast-2, Sydney). Cloudflare runs the DNS for bizinsights.io and proxies it: every page and API response, including the Meta figures shown to the merchant, passes through Cloudflare's network on its way between the browser and AWS (API responses are not cached). The code sends Meta data to no other third party; Amazon Cognito (part of AWS) handles bizinsights sign-in only and never receives Meta data, and Resend sends bizinsights' own emails, which carry no Meta data. [OWNER: while the old Cloudflare deployment (Cloudflare Workers, with its database on your PC) still holds Meta connections, it processes Meta data too; retire it before answering, or include it.]

**Data handling Q2: list all processors and service providers**

> Amazon Web Services [OWNER: the AWS entity your account contracts with, as named in your AWS agreement (unverified)]
> Cloudflare [OWNER: the Cloudflare entity in your Cloudflare terms (unverified)]

**Data handling Q3: service category for each processor**

> Amazon Web Services: IT solutions and services, including cloud storage and processing
> Cloudflare: IT solutions and services (DNS, content delivery and network security; option name unverified)

**Data handling Q4: countries where each processor processes Platform Data**

> [OWNER: the functions and the database run in Australia (AWS ap-southeast-2, Sydney); CloudFront and Cloudflare carry pages and API responses through edge locations worldwide (unverified how Meta expects a CDN or proxy to be listed).]

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

1. 0. Setup (Meta's screen-recording guidance). Record at 1080p or better, with the screen or browser width at 1440 or less. Use English UI and an enlarged cursor. No audio; reviewers don't listen. Record only the browser window, and use the mouse rather than the keyboard where possible. Add captions, annotations and zooms in an editor (OBS or QuickTime plus iMovie, or Camtasia or Snagit). Before recording: (a) sign in to bizinsights as the reviewer account and make sure Meta Ads is not connected in its workspace; (b) in Facebook, open Settings & privacy > Settings > Business integrations and remove bizinsights, so the full consent screen appears (this ends your other Meta connections; reconnect them afterwards); (c) sign out of bizinsights and Facebook. Use your own Facebook account (an app Admin) with an ad account that delivered ads recently.
2. 1. Open https://bizinsights.io while signed out. Caption: 'bizinsights: analytics dashboard for Shopify merchants'.
3. 2. Click sign in. Sign in with the reviewer email and password, keeping the password field masked. You land on /dashboard. Caption: 'Merchants sign in with a bizinsights account; Facebook is used only to connect ad accounts'. This covers Meta's request to show the whole path from logged out to logged in.
4. 3. Scroll to the dashboard's Advertising section. With nothing connected, it shows the 'Connect advertising accounts' button.
5. 4. Open Settings > Advertising from the Settings menu. Zoom on the Meta Ads card: 'Facebook and Instagram ads: spend, reach, clicks and the purchases Meta reports', the text 'Meta asks you to log in and choose the ad accounts to share. Access is read-only: bizinsights can't create, change or pause ads, or spend money.', and the 'Continue with Meta Ads' button. Caption: 'bizinsights asks Meta for ads_read only'.
6. 5. Click 'Continue with Meta Ads'. The button reads 'Opening Meta…'. The Facebook login page opens. Log in, typing the credentials off-camera or blurring them in the edit. Caption: 'Facebook Login for Business'.
7. 6. On Meta's consent screen, show the app name 'bizinsights' and the ads-reporting access it asks for (Meta's exact wording is unverified). Select the ad account or accounts and confirm. Annotate: 'ads_read is granted here. public_profile is granted with Facebook Login; bizinsights reads only the app-scoped user ID on the server'.
8. 7. If the login can see several ad accounts, bizinsights opens Settings > Advertising with the account picker. Tick the account for this store and confirm. Caption: 'The merchant chooses which ad accounts belong to this store'. With one account, bizinsights skips this step.
9. 8. You land on the dashboard. The banner 'Fetching the last 90 days from <account> (Meta Ads). The numbers below fill in within a few minutes; this page updates by itself.' appears. Cut the wait and add the caption '(a few minutes later)'.
10. 9. The Advertising section now has numbers. Zoom on the 'Ad spend' card: Ad spend, Impressions, Clicks, Click-through rate, Cost per click, Cost per 1,000 impressions, Conversions, and Conversion value with its return on ad spend. Then show the 'Ad spend per day', 'Impressions per day' and 'Clicks per day' charts and the by-platform comparison. Annotate: 'Spend, impressions, clicks and conversions read with ads_read'.
11. 10. Click 'See details' on the Ad spend card and scroll to the 'Meta Ads report'. Show the Campaigns, Ad sets and Ads tabs, the status badges, and the date range. Zoom on the Spent, Impressions, Reach, Frequency, Link clicks, Purchases, Purchase value and Return columns. Then open the Placements, Devices and Countries tabs. Annotate 'Reach' and 'Conversions (Purchases)'.
12. 11. (Optional, recommended; not a Meta requirement.) Open Meta Ads Manager in a second tab with the same date range and show that spend and impressions match.
13. 12. Open Settings > Advertising. Show the Meta Ads account row (name, act_ ID, currency, time zone), 'Last synced …', the 'Show on dashboard' checkbox, and the line 'Read-only access to ads reporting (ads_read). Connected …'. Zoom on that line. Caption: 'Read-only: no controls to create, edit, pause or delete ads'.
14. 13. Click Disconnect on the account. Show the browser confirmation: 'Disconnect <account>? Its access and every number fetched for it are deleted from bizinsights, and bizinsights gives up its access at Meta Ads once no other connected account uses it. Your ads keep running.' Confirm, and show that the account is gone. Caption: 'Token and fetched data deleted; ads_read is withdrawn from Meta (DELETE /me/permissions/ads_read) once no other connection relies on this grant'.
15. 14. Stop recording and export a 1080p MP4. Meta's pages state no length, format or size limits (unverified). Upload it for ads_read. Upload the same file for public_profile; its step-6 annotation covers public_profile. Afterwards, reconnect your other Meta connections (step 0b ended them), and optionally the reviewer workspace (prerequisite 12).

### Instructions for the reviewer

bizinsights is a web app for Shopify merchants at https://bizinsights.io. Merchants sign in to bizinsights with a bizinsights email and password. Facebook Login for Business is used only to connect a merchant's own Meta ad accounts, with the ads_read permission only.

1. Open https://bizinsights.io/login and sign in with this bizinsights-only test account. It is not a Meta account. Its email is verified, it is the workspace Owner, and its workspace has a Shopify development store connected.
   Email: [OWNER: reviewer email]
   Password: [OWNER: reviewer password]
2. Open Settings > Advertising. On the "Meta Ads" card, click "Continue with Meta Ads". [OWNER: if you pre-connected an ad account (prerequisite 12), replace this with: the button reads "Reconnect or add accounts" because a Meta ad account is already connected so you can see real data; it runs the same Facebook Login.]
3. Log in to Facebook as your test user, approve bizinsights' request to read ads reporting (ads_read), and choose an ad account.
4. You return to bizinsights. If your Facebook account can see several ad accounts, tick the ones to connect and confirm. If it can see none, bizinsights says "That Facebook login can't reach any ad account, so nothing was connected." with how to get access and a "Connect again" button (or, if no ad account was ticked on Facebook's screen, "No ad account was shared with bizinsights on Facebook's screen"), and connects nothing; any account already connected stays. The attached recording shows the same flow with a real ad account.
5. On the Dashboard, the Advertising section shows ad spend, impressions, clicks, CTR, CPC, CPM, conversions, conversion value and ROAS, with daily charts. A newly connected account's first fetch takes a few minutes, and the page updates by itself. Click "See details" on the Ad spend card to open the Meta Ads report: campaigns, ad sets and ads with reach, frequency, link clicks, purchases and purchase value, plus splits by placement, device and country.
6. bizinsights is read-only. Nothing in it can create, edit, pause or delete campaigns, ads, budgets or billing, and ads_management is never requested. Settings > Advertising > Disconnect deletes the encrypted token and every number fetched for that account. bizinsights then withdraws ads_read from Meta (DELETE /me/permissions/ads_read) once no other connection relies on the same person's grant.

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
