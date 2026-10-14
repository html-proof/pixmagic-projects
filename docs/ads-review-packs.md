# Review packs: Google OAuth verification and Meta App Review

Paste-ready material for the two reviews that open Google Ads and Meta Ads to every merchant. Drafted on
2026-10-11 from the official requirements and the code, then checked by an independent reviewer against
developers.google.com / support.google.com and developers.facebook.com. Requirements change: re-read the linked
sources before submitting. Anything marked "(unverified)" could not be confirmed from an official page.

Where things stand (2026-10-11):

- Google: Explorer access granted; `adwords` added under Data Access with a justification; Search Console
  ownership of `https://insights.imeseban.workers.dev/` verified (HTML tag in `apps/web/src/app/layout.tsx`).
  Branding verification failed twice for: ownership (now fixed, re-check after 24 hours) and the privacy policy
  (the business details in `apps/web/src/lib/contact.ts` are still blank).
- Meta: app "Insights" (971575545351940) set up with icon, domain, privacy policy, data deletion page, Facebook
  Login for Business configuration and the app secret. No business portfolio yet, so no Business Verification.

## Google: Google OAuth verification pack (corrected 2026-10-11): sensitive scope https://www.googleapis.com/auth/adwords plus non-sensitive https://www.googleapis.com/auth/adsense.readonly for "Insights" (Cloud project insights-511119, OAuth client "Insights web")

### Gaps the review found (fix before submitting)

- OAuth 2.0 Policies: you 'must' use separate Cloud projects for each deployment tier, and delete OAuth clients that are not ready for production (sensitive-scope page and FAQ). Move the localhost redirect out of insights-511119.
- Branding order: add the authorized domain first (Cloud Branding help). Remove the workers.dev and localhost redirect URIs and any JS origins from 'Insights web' before Verify Branding, because every authorized domain, including those of redirect URIs, must be verified.
- Privacy policy must disclose the stored Google account ID ('sub' from tokeninfo) and granted scopes per connection, the conditional revoke, and what happens when access is removed at Google (history kept until Disconnect).
- A Google-specific data deletion page. /data-deletion covers Meta only.
- Reviewer and demo setup: an Insights login with the owner or admin role on an active (not frozen) Shopify store, a real Google Ads account with spend, and an AdSense account.
- Video: disconnect AdSense before Google Ads so the revoke narration is true. Do not record the Firebase 'Continue with Google' sign-in (project saas-89329).
- Owner decision on the unverified period: production already requests adwords, and each new merchant uses one of the 100 lifetime user slots, which cannot be reset.
- Finalise branding before submitting: changes are not permitted while verification is in progress.
- /support must show a real support address (it currently shows 'No support address is set'), because it is a documentation link and on the end card.
- Rename the homepage brand everywhere (58 'Insight' strings, including the wordmark and metadata), and make the consent logo match the homepage mark.
- Confirm the 2026-10-10 security-audit fixes for the production database before attesting that data is secure at rest (User Data Policy).

### Before you submit

1. BLOCKER, read first: a domain you control is required. Google verifies authorized domains only as a Search Console DOMAIN property (DNS-level), and the verification must be done by a Google account that is currently a Project Owner. A 'URL prefix' or 'Site' property, or an HTML file or tag, does not count (support.google.com/cloud/answer/13804266). Google checks the top private domain, 'the domain component available for registration on a public suffix' (developers.google.com brand-verification). workers.dev is on the Public Suffix List, so for insights.imeseban.workers.dev that domain is imeseban.workers.dev. Its DNS is run by Cloudflare's workers.dev zone, so no TXT record can be added there (inference). It exists in DNS but has no address records (checked 2026-10-11). Google's App Homepage page also says the homepage and privacy policy should not be on a third-party platform where you can't verify that you own your subdomain. Cloudflare says workers.dev 'is intended for personal or hobby projects that aren't business-critical'.
2. 1. OWNER ONLY: legal and contact facts. Provide the legal entity name, a monitored support email, the governing jurisdiction and the postal address for apps/web/src/lib/contact.ts. Today /privacy shows the 'This policy is incomplete' banner and '[not set - see apps/web/src/lib/contact.ts]' in six places (legal name, postal address, jurisdiction, support email x3), and /support shows 'No support address is set'. Google: 'Do not submit a template, example, or sample privacy policy.' After the owner provides the values, Claude sets them and redeploys.
3. 2. OWNER ONLY: a domain, either one you buy (a purchase only the owner can make) or a subdomain of a domain you already own, such as insights.<your-domain>. Either way the zone must be active on Cloudflare: Workers Custom Domains need an active zone. If you move an existing domain's DNS to Cloudflare, keep its MX and other records; that is the owner's call.
4. 3. CLAUDE (after 2): in apps/cloudflare/wrangler.jsonc add routes [{ "pattern": "<domain>", "custom_domain": true }] and set "workers_dev": true explicitly, because Wrangler infers false once routes exist. Set APP_URL and API_URL to the new host, so sign-in cookies, the host-bound OAuth state cookie and the Google callback all use one host. Then deploy. Recommended: redirect app pages on the workers.dev host to the new domain. The new homepage itself must never redirect. OWNER (inference, not Google requirements): add the domain to Firebase Auth authorized domains (project saas-89329), and update the Shopify app URLs and the Meta redirect, privacy and data-deletion URLs.
5. 4. OWNER ONLY: Search Console, signed in with the Google account that is Project OWNER of insights-511119. Google's pages differ (Owner, or Owner or Editor), so use Owner. Add a Domain property for the root domain, add the TXT record in Cloudflare DNS, press Verify, and never remove the record: Search Console keeps re-checking it.
6. 5. CLAUDE (after 3; the owner approves any legal text): (a) Create a public /terms page; it is 404 today. Cloud 'Manage OAuth App Branding' says homepage, privacy and terms links 'are required for all external production apps' and you 'will not be able to submit' without them; the developers.google.com page calls terms optional, so follow the stricter rule. The owner supplies the entity and jurisdiction. (b) Rename the homepage brand from 'Insight' to 'Insights' everywhere: about 58 strings in apps/web/src/components/landing, the nav and footer wordmark 'INSIGHT', '© 2026 Insight', and the metadata and OpenGraph title and description ('Insight — Shopify Business Intelligence'). Google requires the homepage to 'Accurately represent and identify' the app, and the consent-screen name must match the submission. (c) Add the homepage section 'Google Ads and Google AdSense' (text in formAnswers) with id="google-data", the Limited Use sentence and a link to /privacy. (d) Add the paragraphs for /privacy in formAnswers (Google account ID, conditional revoke, revoke at Google, Limited Use wording). (e) Add the Google section to /data-deletion (text in formAnswers). (f) Check the homepage loads with no redirect and no login, and that its privacy link is exactly the consent-screen privacy URL.
7. 6. OWNER ONLY: development project. Google's OAuth 2.0 Policies say 'you must create separate projects in the Google Cloud Console for each deployment tier'. Create a dev project with its own OAuth client for http://localhost:8789/api/ads/<provider>/callback and point apps/cloudflare/.dev.vars at it; Claude can update the docs. Its Google Ads API access level starts at Test, which works with test accounts only. In insights-511119, delete every OAuth client except 'Insights web': 'Delete any OAuth clients not ready for production'.
8. 7. OWNER ONLY, Google Auth Platform, in this order: (i) Branding -> Authorized domains: add the new root domain first. Google: 'Add your Authorized Domains before you add your redirect or origin URIs, your homepage URL...'. (ii) Clients -> 'Insights web' (534794119904-9esdp8dhskcupf6ekbb0iej2dr10gomf.apps.googleusercontent.com): add https://<domain>/api/ads/google/callback and https://<domain>/api/ads/adsense/callback. Once step 3 is live, remove both https://insights.imeseban.workers.dev/... URIs, the localhost URI and any JavaScript origins (the flow is server-side, so none are needed). (iii) Branding: app name 'Insights', support email, logo, homepage, privacy and terms URLs on the new domain, and the developer contact. Remove the workers.dev authorized-domain entry. (iv) Press Verify Branding: the automated check takes minutes, and a manual review usually takes 2-3 business days. (v) Press Publish branding within 7 days; after that the status becomes 'Need to re-verify'. The app name shows on the consent screen only after verification, and data-access verification needs published branding, so finish this before recording.
9. 8. OWNER ONLY: Data Access. Scopes must be exactly https://www.googleapis.com/auth/adwords (sensitive) and https://www.googleapis.com/auth/adsense.readonly (non-sensitive). The Google Ads API page 'Secure your credentials' (updated 2026-09-30) says the scope 'is classified as a restricted scope'. If the console lists it as Restricted, an annual third-party (CASA) security assessment applies and the timeline is weeks. The console's category is what counts.
10. 9. OWNER DECISION: the unverified period. Production already requests adwords (GOOGLE_ADS_ENABLED "1"), so merchants see 'Google hasn't verified this app', and each new user counts toward the 100-user cap, which 'applies over the entire lifetime of the project, and it cannot be reset or changed'. Keep the flow on, because reviewers test the live flow, and watch cap usage in the console.
11. 10. OWNER ONLY: security. Confirm the 2026-10-10 audit fixes for the production database (firewall, and recreated or rotated non-default credentials) before attesting secure handling. Google's User Data Policy: 'We expect all user data is secure in transit and at rest.' The current status is unverified.
12. 11. OWNER ONLY: demo and reviewer data. (a) A Google account with access to at least one REAL Google Ads account with recent spend; Explorer access allows production accounts. (b) An AdSense account for the second flow. (c) An Insights demo user who is an owner or admin of a workspace with an ACTIVE Shopify store connected (not the frozen 9kdgux-gq), signed in with email. (d) A separate reviewer login with the same setup, sent only by email reply if asked. (e) Disconnect any existing Google Ads or AdSense connection for the store. (f) Set the browser and Google account to English.
13. 12. OWNER, with Claude's help: a dry run of the whole script, including the disconnect order. Check that disconnecting AdSense reports 'still_used' and the final Google Ads disconnect reports 'revoked'; the outcome is in the API response and the audit log.
14. 13. OWNER ONLY: record the video (script below) and upload it in YouTube Studio with Visibility = Unlisted. Check that it plays in a signed-out window.
15. 14. OWNER ONLY: Google Auth Platform -> Verification Center. Request data-access verification. Declare both scopes under 'Add or remove scopes', paste the justification and YouTube link, add up to three documentation links, and submit. Do not change branding while the review runs: 'Branding modifications are not permitted while verification is in progress'.
16. 15. OWNER ONLY: watch the developer-contact and support-email inboxes. Trust & Safety follows up by email and may pause the review until you answer. Reply to the latest email they sent, and resubmit only after every issue is fixed.

### Form answers (paste as written)

**Audience -> User type / Publishing status**

> External / In production (already published; check before submitting).

**Branding -> App name**

> Insights   (identical to the homepage brand after the rename; no Google product names)

**Branding -> User support email**

> OWNER MUST SUPPLY: a monitored address, the same one as CONTACT.supportEmail in apps/web/src/lib/contact.ts. Google says it is shown to users on the consent screen, and you should monitor it regularly. The console lists only the signed-in account's email or a Google Group that account manages (console behaviour; I did not see it on the help pages I read). For a non-Gmail address, use a Google account registered with that address that is an Owner or Editor of the project, or use a Google Group.

**Branding -> App logo (optional)**

> The Insights mark as a square PNG, 120x120 px, 1 MB or less (JPG, PNG and BMP are accepted). It must match the mark on the homepage and contain no Google icons or product names. A later logo change can require re-verification.

**Branding -> Application home page**

> https://<new-custom-domain>/   (it must load without login or redirect, say 'Insights', describe the app, and include the 'Google Ads and Google AdSense' section)

**Branding -> Application privacy policy link**

> https://<new-custom-domain>/privacy   (exactly the same URL as the homepage's Privacy link)

**Branding -> Application terms of service link**

> https://<new-custom-domain>/terms   (the page must be published first)

**Branding -> Authorized domains**

> <new-custom-domain root, e.g. example.com>, added FIRST and verified as a Search Console DOMAIN property by the Project Owner. Remove imeseban.workers.dev / insights.imeseban.workers.dev once no redirect URI uses them.

**Branding -> Developer contact information**

> OWNER MUST SUPPLY: an address the owner reads daily. Google sends verification notices and Trust & Safety follow-ups here.

**Clients -> Insights web -> Authorized redirect URIs**

> https://<new-custom-domain>/api/ads/google/callback
> https://<new-custom-domain>/api/ads/adsense/callback
> (remove https://insights.imeseban.workers.dev/api/ads/google/callback, https://insights.imeseban.workers.dev/api/ads/adsense/callback and every http://localhost URI)

**Clients -> Insights web -> Authorized JavaScript origins**

> None. The code exchange happens on the server only; remove any existing origins.

**Data Access -> Sensitive scopes**

> https://www.googleapis.com/auth/adwords  (Google Ads API; Google describes it as 'See, edit, create, and delete your Google Ads accounts and data')

**Data Access -> Non-sensitive scopes**

> https://www.googleapis.com/auth/adsense.readonly  (AdSense Management API, 'View your AdSense data')

**Verification Center -> Scope justification for https://www.googleapis.com/auth/adwords (short version; the field's character limit is unverified)**

> Insights is an analytics dashboard for Shopify merchants. When a merchant presses "Continue with Google Ads" (Settings > Connect your business) and picks their ad accounts, Insights reads those accounts' reports through the Google Ads API (customers:listAccessibleCustomers and read-only googleAds:searchStream GAQL queries; no mutate calls). It shows them only inside that merchant's own Insights workspace: spend, impressions, clicks, CTR, CPC, CPM, conversions, conversion value and ROAS per day next to their Shopify sales, plus a report by campaign, ad group, device and country. Google's Google Ads API documentation names https://www.googleapis.com/auth/adwords as the scope for API access, and there is no read-only or narrower Google Ads scope. Insights never creates, edits, pauses or deletes anything in Google Ads. Tokens are AES-256-GCM encrypted at rest and never sent to the browser. Disconnecting deletes the token and every fetched figure, and Insights revokes its grant at Google once no other Insights connection uses that Google sign-in. No selling, transfers, ads use or AI training (Limited Use).

**Verification Center -> Scope justification (full version, for a longer field or a reply to the reviewer's email)**

> What the app does: Insights (https://<new-custom-domain>/) is an analytics dashboard for Shopify merchants. It puts a store's sales next to the cost and results of its advertising.
>
> User-facing feature that uses this scope: in Settings > Connect your business, a workspace owner or admin presses "Continue with Google Ads" and grants access on Google's consent screen. The scope is requested only at that moment, never at sign-in to Insights. If the Google login can see several Google Ads accounts (for example through a manager account), the merchant ticks the ones that belong to the store. The merchant then lands on the dashboard. Its Advertising section shows, per platform and per day, spend, impressions, clicks, CTR, CPC, CPM, conversions, conversion value and ROAS. A detail view shows a Google Ads report by campaign (with status, type and budget), ad group, device and country. A background sync keeps these figures current: the last 90 days are fetched on connect, recent days every hour, and the last 30 days daily because conversions are credited late. That is why the app requests offline access.
>
> Google API calls made with the token: Google Ads API customers:listAccessibleCustomers, to list the accounts the person can see, and googleAds:searchStream with GAQL SELECT queries. These read the account name, id, currency, time zone and manager/client structure; campaign and ad group names, status, type and budget; and daily cost, impressions, clicks, conversions and conversion value by date, device and country. For client accounts reached through a manager account, the manager's id is sent as login-customer-id. Insights makes no mutate call of any kind. Insights also calls Google's OAuth tokeninfo endpoint. It confirms the token was issued to Insights' own client and records the Google account's numeric ID, so Insights can tell when two connections share one Google sign-in. On disconnect it calls the revoke endpoint.
>
> Why no narrower scope works: Google's Google Ads API documentation names https://www.googleapis.com/auth/adwords as the scope to use for Google Ads API access, and Google offers no read-only or narrower Google Ads scope. Without it Insights cannot call googleAds:searchStream, and the merchant's Advertising section would be empty. Google AdSense is a different product. It is read in a separate flow with the non-sensitive https://www.googleapis.com/auth/adsense.readonly scope, which cannot read Google Ads data.
>
> Handling: refresh and access tokens are encrypted with AES-256-GCM at rest, bound to the store, never returned to the browser and never logged. Figures are shown only to members of the merchant's own Insights workspace, according to the role the workspace owner gave them. Disconnecting deletes the token and every figure fetched at once. Google ends a sign-in's whole grant at once, so Insights revokes its grant at https://oauth2.googleapis.com/revoke when no other Insights connection still uses that Google sign-in (for example AdSense on the same Google account). The data is not sold, not transferred to third parties beyond the processors that run the service, not used for advertising, and not used to train AI or ML models. People do not read it except with the merchant's permission, for security, or where the law requires. This follows the Google API Services User Data Policy, including the Limited Use requirements (disclosed at https://<new-custom-domain>/privacy and on the homepage).

**Verification Center -> Demo video (YouTube link)**

> https://youtu.be/<VIDEO_ID>   (uploaded in YouTube Studio with Visibility = Unlisted; checked in a signed-out window)

**Verification Center -> Documentation links (up to 3)**

> 1) https://<new-custom-domain>/#google-data  (what Insights reads from Google Ads and AdSense, and why; Limited Use)
> 2) https://<new-custom-domain>/privacy  (Google data accessed and stored, sharing, protection, retention and deletion, Limited Use)
> 3) https://<new-custom-domain>/data-deletion  (use only after its Google Ads and AdSense section is live; otherwise use https://<new-custom-domain>/support)

**Verification Center -> Additional information for the reviewer (use a free-text field if one is shown, otherwise the email reply; the exact field name is unverified)**

> OAuth client: 'Insights web', 534794119904-9esdp8dhskcupf6ekbb0iej2dr10gomf.apps.googleusercontent.com, the only OAuth client in project insights-511119 (confirm in Clients before sending). Development uses a separate project. Two consent flows use this client, and both appear in the video: (1) 'Continue with Google Ads' (Settings > Connect your business or Settings > Advertising) requests only https://www.googleapis.com/auth/adwords, with access_type=offline, prompt=consent and PKCE S256; (2) 'Continue with Google AdSense' (Settings > Advertising) requests only https://www.googleapis.com/auth/adsense.readonly. Signing in to Insights itself is a separate Firebase Authentication project and does not use this client. Access is read-only: Insights calls only customers:listAccessibleCustomers and googleAds:searchStream (GAQL SELECT) and never makes a mutate call. Disconnect deletes the token and data, and Insights revokes its grant at https://oauth2.googleapis.com/revoke once no other connection uses the same Google sign-in. Google Ads API access level: Explorer (granted 2026-10-11).

**Homepage -> new section 'Google Ads and Google AdSense' (id="google-data"; paste into the landing page)**

> Google Ads and Google AdSense (optional). If you press "Continue with Google Ads" in Settings, Google asks you to allow Insights to "See, edit, create, and delete your Google Ads accounts and data". That is the only permission Google offers for the Google Ads API, and Insights uses it only to read reports. For the ad accounts you pick, Insights reads account names and ids, currency and time zone; campaign and ad group names, status, type and budget; and daily spend, impressions, clicks, conversions and conversion value by device and country. It uses them to show your ad spend, CTR, CPC, CPM and ROAS next to your Shopify sales. "Continue with Google AdSense" asks only for read-only access ("View your AdSense data") to show your site's estimated earnings, page views, ads shown and clicks. Insights never creates, changes, pauses or deletes ads, budgets or billing. You can disconnect at any time in Settings, and the access token and every figure fetched are deleted. Insights' use and transfer of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements. See our Privacy Policy.

**Privacy policy -> paragraphs to add to /privacy (in 'Advertising accounts' and the Limited Use paragraph)**

> Who signed in. For each advertising connection, Insights also keeps the ID that Google or Meta uses for the account you signed in with, and the list of permissions you granted. Insights uses them only to tell whether two connections share one sign-in, so that disconnecting one doesn't cut off another.
>
> Disconnecting. When you press Disconnect, Insights deletes that connection's access token and every figure it fetched, straight away. Google ends a sign-in's whole access to Insights at once (Google Ads and AdSense together), so Insights gives the access back to Google when no other Insights connection still uses the same Google sign-in. If you remove Insights' access in your Google Account instead, Insights stops reading and marks the account as needing reconnection. The figures already fetched stay until you press Disconnect in Insights or ask us at <support email> to delete them.
>
> Limited Use paragraph, replacement wording: Insights' use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. The data is used only to show you your own reports. It is not sold, not transferred to anyone except the processors listed below that run the service, not used for advertising, and not used to train AI or machine-learning models. People do not read it except with your permission, for security, or where the law requires it.

**/data-deletion -> new section 'Google Ads and Google AdSense'**

> 1. Disconnect in Insights (immediate): open Settings > Connect your business (Google Ads) or Settings > Advertising (Google Ads and AdSense) and press Disconnect. Insights deletes the access token and every figure it fetched for those accounts, and gives the access back to Google when no other Insights connection still uses the same Google sign-in.
> 2. Remove Insights in your Google Account (optional): your Google Account's security settings list third-party apps with access (exact menu path unverified). Removing Insights there stops its access, but doesn't delete what Insights already holds, so use step 1 as well.
> 3. Or write to <support email> from the address you sign in with, naming the workspace or store, and we delete the Google connections and their data.

**Privacy policy -> Limited Use statement (reference)**

> Google's FAQ example: "{App's} use of information received from Google APIs will adhere to Google API Services User Data Policy, including the Limited Use requirements." The FAQ says a public web-accessible disclosure, such as one on the homepage or a public FAQ, is enough. The policy must also cover what Google data is accessed, how it is used, shared and protected, and its retention and deletion, and it must name the controller. Today the controller is a placeholder, and the stored Google account ID is not mentioned. Both are fixed by prerequisite 1 and the paragraphs above.

**Email reply template if the reviewer asks you to use a narrower scope**

> Thank you for the review. Insights only reads Google Ads reports. Google's Google Ads API documentation (developers.google.com/google-ads/api/rest/auth) names https://www.googleapis.com/auth/adwords as the scope for Google Ads API access, and Google offers no read-only or narrower Google Ads scope. With any other scope, Insights could not call googleAds:searchStream, and the Advertising section of the merchant's dashboard would show nothing: spend, clicks, conversions and ROAS by day, campaign, ad group, device and country. Insights makes no mutate calls and never changes campaigns, ads, budgets or billing. Disconnect deletes the token and data, Insights revokes its grant once no other connection uses that Google sign-in, and Insights follows the Limited Use requirements. The demo video at <link> shows each of these points. Unable to use narrower scopes.

**Reference (not a form field): expected timelines**

> Brand verification: the automated check after 'Verify Branding' usually takes a few minutes; a manual review 'usually takes 2-3 business days'; you then publish within 7 days. Sensitive-scope verification 'typically takes 3-5 business days' (developers.google.com, updated 2026-08-19). The Cloud FAQ (answer/13463817) table says 10 business days, notes 'these estimates are not guaranteed', and says timing varies with how quickly you respond. The 'Unverified apps' page says verification 'might require several months'. Restricted scope (only if the console lists adwords as restricted): 'several weeks', about 6 weeks per the FAQ, plus an annual CASA security assessment. Until verification, the 100-new-user cap applies for the project's whole lifetime and 'cannot be reset or changed'.

### Screen recording script

1. 0. Setup (not recorded). Branding is published, so the consent screen shows 'Insights'. The Google account and browser language are English. Use a clean browser profile, signed in to Google with only the demo Google account. The Insights demo user is an owner or admin of a workspace with an active Shopify store, and there is no existing Google Ads or AdSense connection. Sign in to Insights with EMAIL before or during the recording. Do NOT use Insights' 'Continue with Google' sign-in, because it belongs to Firebase project saas-89329, a different OAuth client. Record at 1080p, full screen, with the address bar visible and nothing cropped. Narrate in English by voice or captions; Google says narration 'can greatly help'. Never show the client secret, tokens, passwords or the reviewer login. Aim for 3-5 minutes; Google publishes no limit, so this length is unverified guidance.
2. 1. Title card (5 s). VISIBLE: 'Insights - OAuth verification demo - Google Cloud project insights-511119 - OAuth client Insights web 534794119904-9esdp8dhskcupf6ekbb0iej2dr10gomf.apps.googleusercontent.com - Scopes: https://www.googleapis.com/auth/adwords (sensitive), https://www.googleapis.com/auth/adsense.readonly (non-sensitive)'.
3. 2. Homepage. Type https://<new-custom-domain>/ into the address bar. VISIBLE: the URL, the name 'Insights', what the app does, the 'Google Ads and Google AdSense' section with the Limited Use sentence, and the Privacy link. Click Privacy. VISIBLE: https://<new-custom-domain>/privacy, the 'Advertising accounts' paragraphs (adwords used only to read; what is stored, including the Google account ID; delete and revoke on disconnect) and the Limited Use paragraph. NARRATE: 'This is the same privacy policy linked on our OAuth consent screen.'
4. 3. Optional; it helps reviewers match IDs but is not an official requirement. Google Cloud console -> Google Auth Platform -> Clients. VISIBLE: the single client 'Insights web' and its client ID. Then Data Access, listing adwords and adsense.readonly. Do NOT open or show the client secret.
5. 4. Insights (already signed in by email) -> Settings -> Connect your business. VISIBLE: the Google Ads card with 'Continue with Google Ads' and its text 'Google asks you to choose your Google account and allow access. ... Insights only reads reports: it can't create, change or pause ads, or spend money.' NARRATE: 'Signing in to Insights doesn't involve Google Ads. The Google Ads permission is asked for only here, when the merchant chooses to connect Google Ads.'
6. 5. Click 'Continue with Google Ads' and choose the demo Google account. If Google first shows 'Google hasn't verified this app' (expected while verification is pending), keep it in the recording and continue through Advanced. The official pages don't cover this screen, so this is unverified.
7. 6. Google consent screen for Google Ads. Hold for at least 10 seconds. VISIBLE: (a) the language selector at the bottom-left set to English; (b) the app name 'Insights'; (c) the complete consent screen, scrolled so every line shows, with only the Google Ads permission ('See, edit, create, and delete your Google Ads accounts and data' or Google's current wording) and no other scope; (d) the address bar, clicked and zoomed until 'client_id=534794119904-9esdp8dhskcupf6ekbb0iej2dr10gomf.apps.googleusercontent.com' is readable. Google requires showing 'that the browser address bar of the OAuth consent screen correctly includes your app's OAuth client ID.' NARRATE: 'This is the https://www.googleapis.com/auth/adwords scope. Insights uses it only to read reports, because the Google Ads API has no read-only scope.'
8. 7. Allow and press Continue. VISIBLE: the redirect back to https://<new-custom-domain>/... If the login reaches several Google Ads accounts, Insights shows its account picker on Settings -> Advertising: tick the store's account and confirm. With a single account, Insights goes straight to the dashboard.
9. 8. Dashboard -> Advertising section. VISIBLE: the Google Ads figures arriving (spend, impressions, clicks, CTR, CPC, CPM, conversions, conversion value, ROAS), the per-day chart, and the by-platform comparison next to Shopify sales. NARRATE: 'Every number here is read from the Google Ads API with the adwords scope and shown only inside this merchant's workspace.'
10. 9. Open the Advertising detail view -> Google Ads report. VISIBLE: campaigns with status, type and budget; ad groups; the device breakdown; the country breakdown. NARRATE: 'This is the full set of Google Ads data Insights reads. Nothing here creates, edits, pauses or deletes anything in Google Ads.'
11. 10. Settings -> Advertising (management page). VISIBLE: the Google Ads card as Connected, the access line 'Google Ads reporting (Google has no read-only scope; Insights only reads)', the account, the last sync, and the Refresh, Show on dashboard and Disconnect controls. NARRATE: 'There are no write controls. Tokens are encrypted and never reach the browser.'
12. 11. Second consent workflow on the same client. Google: 'if there are multiple OAuth consent workflows, you must demonstrate each of these methods in your video.' On Settings -> Advertising, show the Google AdSense card ('Read-only access to AdSense reports (adsense.readonly)') and click 'Continue with Google AdSense'. VISIBLE on Google's screen: English, 'Insights', only 'View your AdSense data', and client_id in the address bar (hold 10 s). Allow, return, and show the dashboard's 'Ad earnings' card: estimated earnings, page views, ads shown and clicks per site and day. NARRATE: 'This flow uses the same client and requests only adsense.readonly.'
13. 12. Disconnect in this order, as tested in the dry run. (a) Settings -> Advertising -> Google AdSense -> Disconnect -> confirm. NARRATE: 'Insights deletes the AdSense token and figures. Google ends a sign-in's whole grant at once, so Insights keeps the grant while Google Ads still uses this Google account.' (b) Settings -> Connect your business -> Google Ads -> Disconnect. VISIBLE: the confirmation 'Disconnect Google Ads? Insights deletes its access and every number it fetched for your ad accounts. Your ads keep running.' Confirm it; the Advertising section no longer shows Google Ads. NARRATE: 'The token and every figure fetched are deleted, and because no other connection uses this Google sign-in, Insights has revoked its access at Google.' (c) Optional, only if the dry run showed it: open your Google Account's third-party connections page and show that Insights no longer has access.
14. 13. End card (5 s). VISIBLE: 'Read-only. Limited Use compliant. Privacy: https://<new-custom-domain>/privacy - Support: https://<new-custom-domain>/support'. Upload in YouTube Studio with Visibility = Unlisted, open the link in a signed-out window to check it plays, then paste it into the Verification Center.

### Instructions for the reviewer

Paste into the reviewer free-text field if one is shown, otherwise into a reply to the Trust & Safety email. None of the official pages I read require test credentials for sensitive-scope review. If the reviewer asks for access, reply in the same email thread with the reviewer login. Never put credentials in the form or the video.

How to see the Google Ads feature in Insights:
1. Open https://<new-custom-domain>/. The public homepage section 'Google Ads and Google AdSense' explains what is read and why. Sign in with the reviewer login we send on request (email sign-in). Its workspace has a Shopify development store connected, and the reviewer is a workspace admin, which connecting ad accounts requires.
2. Go to Settings -> Connect your business and press "Continue with Google Ads" on the Google Ads card.
3. On Google's screens, choose a Google account that can access a Google Ads account and allow the single permission requested: https://www.googleapis.com/auth/adwords, OAuth client 534794119904-9esdp8dhskcupf6ekbb0iej2dr10gomf.apps.googleusercontent.com. While verification is pending, Google first shows its unverified-app warning. Google always shows its account chooser first. A Google account with no Google Ads account gets 'That Google login has no Google Ads account, so nothing was connected', with a "Choose another Google account" button that reopens Google's chooser.
4. If the login reaches several Google Ads accounts (for example through a manager account), tick the ones for the store and confirm.
5. You land on the dashboard. Within a minute or two the Advertising section shows spend, impressions, clicks, CTR, CPC, CPM, conversions, conversion value and ROAS per day. The detail view's Google Ads report breaks this down by campaign (status, type, budget), ad group, device and country.
6. Settings -> Advertising shows the connection, the permission granted, the last sync, and Refresh, Show on dashboard and Disconnect. Disconnect deletes the token and every figure fetched. Insights then revokes its grant at oauth2.googleapis.com/revoke, unless another Insights connection still uses the same Google sign-in (for example Google AdSense on the same Google account). In that case the grant is revoked when the last such connection is disconnected.

Insights calls only customers:listAccessibleCustomers and googleAds:searchStream (GAQL SELECT) on the Google Ads API. It never creates, edits, pauses or deletes campaigns, ads, budgets, billing or users.

The second flow, Settings -> Advertising -> "Continue with Google AdSense", uses the same client and requests only https://www.googleapis.com/auth/adsense.readonly.

Privacy policy and Limited Use disclosure: https://<new-custom-domain>/privacy. Support: https://<new-custom-domain>/support.

### Common reasons for rejection

- The authorized domain is not verified as a Search Console DOMAIN property (DNS TXT) by a Project Owner. URL-prefix or 'Site' properties, or verification by another account, are not recognised. This is impossible on workers.dev, so a domain the owner controls is required.
- The workers.dev or localhost redirect URIs are still on 'Insights web'. Authorized domains must cover every redirect URI's domain and each must be verified. Dev URIs also break the rule that each deployment tier must be a separate project.
- Another OAuth client in insights-511119 is not ready for production. The video must cover all clients in the project; delete unused ones.
- The homepage or privacy policy is on a third-party platform where you can't verify you own the subdomain (support.google.com/cloud/answer/13807376).
- The homepage brand doesn't match the consent-screen app name. The live site says 'Insight' (title, wordmark, footer); the app is 'Insights'.
- The homepage doesn't explain what the app does with Google user data. It is only a login page, redirects, or uses a shortened link.
- The privacy policy is incomplete or reads like a template: the controller and contact are placeholders today. Or it doesn't cover what Google data is accessed and stored (including the Google account ID Insights keeps), how it is used, shared and protected, and retention and deletion.
- The privacy link on the homepage differs from the consent-screen link, or the privacy URL equals the homepage URL.
- The terms of service link is missing or broken (/terms is 404 today). Cloud Branding help says you can't submit without the homepage, privacy and terms links.
- Demo video problems. The consent screen isn't in English. The app name isn't shown because branding wasn't published before recording. The full scope list isn't visible. client_id isn't readable in the address bar. The features behind each scope aren't shown. The AdSense consent flow is missing. The video is Private instead of Unlisted.
- The video contradicts the app. It narrates that the grant is revoked while AdSense still uses the same Google sign-in, or it shows the Firebase 'Continue with Google' sign-in from another project with a different client_id.
- Documentation links that don't cover Google: /data-deletion is Meta-only until its Google section is added.
- The scope justification doesn't explain why a narrower scope won't work, or the app requests scopes for features not yet built.
- The scopes in the submission, on Data Access and in the app's OAuth requests don't match.
- The app name or logo uses Google product names or icons, or doesn't uniquely identify the brand. The logo differs from the submission. Low, unverified risk: 'Insights' is a generic word; if the reviewer objects, rename it the same way everywhere.
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
- https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- https://developers.cloudflare.com/workers/configuration/routing/custom-domains/

## Meta: Meta App Review pack for Insights (App ID 971575545351940): Advanced Access to ads_read and public_profile, with Business Verification, Access Verification and the Marketing API Access Tier (checked against developers.facebook.com and the code on 2026-10-11)

### Gaps the review found (fix before submitting)

- Reviewer account conditions taken from the code: the email is verified (otherwise 'Verify your email first'), and the role is Owner or Admin of the workspace (otherwise there is no connect button).
- Keep production reachable for the whole review window: up to a week for App Review and about 5 days for Access Verification. Prod Postgres runs in Docker on the owner's PC behind Cloudflare Tunnel, so Docker Desktop and cloudflared (--protocol quic) must stay running. A reviewer who can't reach the app is a stated rejection reason.
- Before you answer the data handling questions or later security questions, close the database exposure found in the 2026-10-10 security audit if it is still open (it was reachable on the LAN with default credentials): firewall or recreate the container, and rotate the credentials.
- Reconnect every Meta connection belonging to the owner after removing Insights from Facebook Business integrations for the recording. This keeps the hourly sync counting toward the Marketing API Access Tier call threshold.
- Optional but recommended: a reviewer workspace that already has a Meta ad account connected, because Meta has temporarily stopped new test-user creation and reviewers' test accounts may own no ad account.
- Ongoing Review (required by Facebook Login for Business for apps with Advanced Access) and the yearly Data Use Checkup or Data Access Renewal after approval.
- A data handling answer for Q2 (the processor list), which was missing.
- Owner-only inputs that are still blank: legalName, supportEmail, jurisdiction and postalAddress in apps/web/src/lib/contact.ts. Checked live on 2026-10-11: /privacy shows 'This policy is incomplete' and '[not set' markers, and /data-deletion step 3 shows '[not set'. Also a Terms of Service page (/terms returns 404), a 1024x1024 app icon, a Meta business portfolio, and Business Verification.

### Before you submit

1. Read this first. Four rules from Meta's docs set the order. (1) Since February 1, 2023, an app that needs Advanced Access must be connected to a business that has passed Business Verification. Until it is, people from other businesses can't grant the app permissions. (2) Facebook Login for Business needs Advanced Access to public_profile before the app goes live, and apps with Advanced Access go through Ongoing Review to keep it. That page's portfolio rules (the app belongs to a portfolio the developer fully controls; onboarding businesses need a portfolio) are listed for system-user tokens. Insights' configuration 'Insights ads reporting' uses a user access token, so merchants need no portfolio. Insights itself still needs one, for Business Verification. (3) ads_read is on Meta's Access Verification (Tech Provider) list. That process is separate from App Review, needs Business Verification first, and a business Admin completes it. (4) Meta's changelog entry dated 05/04/2026 renamed Ads Management Standard Access to the Marketing API Access Tier, with two levels, Limited and Full, and dropped the screen recording for tier upgrades. You can use the Upgrade button once the app has made 500 or more Marketing API calls in the last 15 days, with errors under 15% in the last 500 calls. Meta's pages disagree on whether Limited is enough for other businesses' accounts. The authorization page says both tiers allow unlimited ad accounts. The features reference ties reading reports for owner-granted accounts to this feature plus ads_read. The use-cases page says unlimited accounts and higher limits need approval. So upgrade as soon as the app qualifies.
2. 1. [OWNER ONLY] Fill in all four values in apps/web/src/lib/contact.ts: legalName, supportEmail, jurisdiction and postalAddress. Then redeploy. Checked live on 2026-10-11: /privacy shows the 'This policy is incomplete' banner and '[not set' markers, and step 3 of /data-deletion shows '[not set' instead of a deletion email. Meta's privacy-policy rules: the policy is your own, clearly titled as a privacy policy, public, reachable by Meta's crawler and not geo-blocked. It says what is collected and why, and gives a working way (email or form) to ask for deletion. Meta suggests checking in the Sharing Debugger that the URL returns 200.
3. 2. [OWNER writes the legal text; a developer adds the page] Publish a Terms of Service page, for example /terms, which returns 404 today, and enter it in Settings > Basic. Meta's Basic Settings page lists it among the fields required to switch to Live mode.
4. 3. [OWNER ONLY] Upload a 1024x1024 app icon under Settings > Basic > App Icon (size from Meta's submission guide). It must contain no Meta trademarks or logos, and must not include 'Facebook' or 'FB'.
5. 4. [OWNER ONLY] Create a Meta business portfolio for the same legal entity as CONTACT.legalName. Using the same entity is advice, not a stated Meta rule. Its legal name, address, phone and website should match your registration documents. Make the Facebook account that owns the app an Admin of the portfolio: only a business Admin can complete Business Verification and Access Verification.
6. 5. [OWNER ONLY: app Admin] Connect the app to the portfolio. In the App Dashboard, go to Settings > Basic > Verification > Start Verification and pick the portfolio.
7. 6. [OWNER ONLY: business Admin] Complete Business Verification in Business Manager or Business Suite. Meta's developer docs send you to the Business Help Center for the document list. Those pages don't render outside a browser, so these points come from search summaries and are (unverified): the legal name, address, phone and an HTTPS website must match your documents; a registration or incorporation document is needed if Meta can't find the business; confirmation is by email, phone or domain; an email domain that matches the website helps. Also (unverified): whether a workers.dev subdomain is accepted as the business website or for domain confirmation. A custom domain with a matching email address is the safer choice. Verification isn't required to go Live, but the app can't access data you don't own until it is complete.
8. 7. [OWNER] Finish Settings > Basic using the values in formAnswers: Display name, Contact email (an inbox you read, because App Review notices go there), Privacy Policy URL, Terms of Service URL, User data deletion instructions URL, App icon, Category, App Purpose 'Clients', App Domains and the Website platform Site URL. Do this before submitting. Changing basic or advanced settings after submitting may need a new review.
9. 8. [OWNER] Create the Insights reviewer account in production. It uses email and password, is not your personal account, and is not a Meta account. It must meet three conditions, or the reviewer can't connect. (a) Its email is verified: otherwise connecting fails with 'Verify your email first'. (b) It is Owner or Admin of its workspace: other roles see 'Only a workspace owner or admin can connect or disconnect accounts.' and no button. (c) The workspace has a Shopify development store connected: otherwise the Meta Ads card on Settings > Connect your business only says 'Connect your Shopify store first: ad accounts are connected to a store.' Don't use the frozen store 9kdgux-gq (402). A few test orders make the dashboard less empty. Put the credentials only in the App Verification instructions. Meta says never to give your personal Meta login, because reviewers use their own test accounts.
10. 9. [OWNER] Within the 30 days before you submit, make at least one successful call for each permission requested. In production, while the app is still in Development mode, connect Meta Ads with your own Facebook account (an app Admin) in your own workspace, on an ad account that delivered ads recently. Connecting calls GET /me/permissions and GET /me?fields=id (public_profile), then GET /me/adaccounts, and the sync calls GET /act_{id}/insights (ads_read). Leave it connected: its hourly sync also counts toward the 500-call threshold of the Marketing API Access Tier. One account makes about 25 calls a day by the sync schedule (estimate), so connect two or more ad accounts, or open the Meta Ads report now and then, to pass 500 in 15 days.
11. 10. [OWNER] Keep production up for the whole review: App Review takes up to a week, and Access Verification about 5 days. The production database runs in Docker on your PC behind Cloudflare Tunnel, so Docker Desktop and cloudflared (--protocol quic) must keep running. If the database exposure from the 2026-10-10 security audit is still open (reachable on the LAN with default credentials), close it and rotate the credentials before you answer Meta's data-handling questions.
12. 11. [OWNER] Record and edit the screencast with screencastScript. Removing Insights under Facebook Business integrations for the recording ends the token behind the connection from step 9 and any other Meta connection you made. Reconnect them afterwards.
13. 12. [OWNER, optional, recommended] After recording, connect your own ad account again, this time in the reviewer workspace. Then reviewers see real numbers even if their Facebook test account owns no ad account. Meta has temporarily stopped new test-user creation, so this is likely. The card then shows 'Reconnect or add accounts', which runs the same Facebook Login. A login with no ad accounts leaves the existing data in place.
14. 13. [OWNER] In App Review > Permissions and Features, request Advanced Access for ads_read and public_profile only. Leave everything else in the 'Measure ad performance data with Marketing API' use case at Standard Access: ads_management, business_management, pages_show_list, pages_read_engagement, email, and the Marketing API Access Tier feature until it is eligible. Unneeded permissions are a common reason for rejection. If the dashboard asks for Business Verification at this point (Step 1.5), finish it first.
15. 14. [OWNER ONLY] Answer the data handling questions. They appear once Business Verification is approved, and Meta scores them within about 30 seconds. The drafts are in formAnswers; only you can confirm them. Meta advises checking with legal, policy and privacy advisers.
16. 15. [OWNER] For each permission: paste its own usage description (never copy one to the other), upload the recording, fill in App Verification with reviewerTestInstructions, click Submit for Review and accept the Platform Onboarding Terms. Meta aims to decide within a week.
17. 16. [OWNER ONLY: business Admin] Complete Access Verification (Tech Provider) under App Dashboard > Basics > Verifications > Access verification. It needs Business Verification and a business account with no restrictions, and can run while App Review is in progress. Meta decides in about 5 days. If it is denied, calls that need ads_read fail for anyone without a role on the app, even after App Review passes.
18. 17. [OWNER] After approval: complete the Data Use Checkup, which a Development-mode app must finish before switching to Live. Then switch the app to Live; only approved permissions work in Live mode. After that, watch Required Actions in the App Dashboard for Ongoing Review, the yearly Data Use Checkup, or Data Access Renewal, which Meta is rolling out in phases to merge these checks.
19. 18. [OWNER, as soon as eligible] Upgrade the Marketing API Access Tier from Limited to Full with the Upgrade button on that feature. You need 500 or more Marketing API calls in the last 15 days and errors under 15% in the last 500. No screen recording is needed. Limited's Ads Insights quota per ad account per hour is 600, plus 400 for each active ad. Full's base is 190,000.

### Form answers (paste as written)

**Settings > Basic > Display name**

> Insights

**Settings > Basic > App domains**

> insights.imeseban.workers.dev

**Settings > Basic > Contact email**

> [OWNER: a monitored address, the same as CONTACT.supportEmail in apps/web/src/lib/contact.ts]

**Settings > Basic > Privacy Policy URL**

> https://insights.imeseban.workers.dev/privacy

**Settings > Basic > Terms of Service URL (required for Live mode)**

> [OWNER: publish the page first, e.g. https://insights.imeseban.workers.dev/terms (404 today)]

**Settings > Basic > User data deletion > Data deletion instructions URL**

> https://insights.imeseban.workers.dev/data-deletion

**Settings > Basic > App icon**

> [OWNER: 1024x1024 image, no Meta trademarks or logos, no 'Facebook' or 'FB']

**Settings > Basic > Category**

> Business and pages

**Settings > Basic > App purpose**

> Clients

**Settings > Basic > Website platform > Site URL**

> https://insights.imeseban.workers.dev/

**Facebook Login for Business > Settings > Valid OAuth Redirect URIs**

> https://insights.imeseban.workers.dev/api/ads/meta/callback

**Facebook Login for Business > Configuration in use (reference only, not a form field)**

> Insights ads reporting (1521935306664882): user access token, ad accounts, ads_read only

**App Review > Permissions and Features > what to request**

> Advanced Access for ads_read and public_profile. Nothing else. Request the Marketing API Access Tier upgrade separately, with its Upgrade button, once the app has 500 or more calls in 15 days with errors under 15%.

**Requested Permissions and Features > ads_read > usage description (exact label and character limit unverified)**

> Insights (https://insights.imeseban.workers.dev) is a web analytics dashboard for Shopify merchants. Each merchant is a separate business. It signs in to Insights with its own Insights account and connects its own Meta ad accounts, so it can see what its Facebook and Instagram ads cost and returned next to its store's sales. ads_read is the only Marketing API permission Insights asks people to grant. We don't request ads_management, and Insights has no feature that creates, edits, pauses or deletes campaigns, ad sets, ads, audiences, budgets, billing or users.
>
> How a business grants it: in Insights, Settings > Connect your business > "Continue with Meta Ads" opens Facebook Login for Business. Our configuration uses a user access token and asks for ads_read only. The person grants ads_read and chooses the ad accounts to share. Our server exchanges the code server-side, checks with GET /me/permissions that ads_read was granted, and calls GET /me/adaccounts (id, name, currency, timezone_name, account_status). If the login can see several ad accounts, the merchant ticks the ones that belong to this store. The token is encrypted with AES-256-GCM on our server and is never sent to the browser.
>
> How we use the data:
> 1) Daily performance. GET /act_{id}/insights at campaign level with time_increment=1 (spend, impressions, clicks, actions, action_values; use_unified_attribution_setting=true). We fetch the last 90 days when an account is connected, refresh recent days every hour, and re-read the last 30 days once a day, because Meta keeps crediting purchases for days after a click. When Meta asks for a smaller request on a large account, this sync runs the same query as an asynchronous Insights report (POST /act_{id}/insights, then read the report_run_id). That call only produces a report. The dashboard's Advertising section shows spend, impressions, clicks, CTR, CPC, CPM, conversions, conversion value and ROAS per day, next to the store's Shopify revenue and its Google Ads results.
> 2) On-demand report. When the merchant opens the Meta Ads report, we call GET /act_{id}/insights for the dates they pick, at campaign, ad set or ad level (spend, impressions, reach, frequency, link clicks, purchases, purchase value). We also read account-level splits by placement, device and country, and each campaign's, ad set's and ad's effective_status, so the table can say Active, Paused, In review or Rejected. Answers are cached for 10 to 60 minutes and rate-limited per user, to stay inside Meta's limits.
>
> Examples: a fashion store sees which campaign brings back the most purchase value per dollar spent, then moves budget itself in Ads Manager. A merchant compares Meta and Google spend on the same daily chart against store revenue. A merchant sees frequency rising on an ad set and treats it as a sign of ad fatigue.
>
> Without ads_read, Insights could not show any Meta ad results, and merchants would have to export reports from Ads Manager by hand and match them to their sales. The data is shown only to members of the merchant's own Insights workspace. It is never sold, never shared with other businesses or advertisers, and never used for advertising or to train models. Disconnecting deletes the token and every number we fetched for that account. Insights then withdraws ads_read from Meta (DELETE /me/permissions/ads_read) once no other connection relies on the same person's grant.

**Requested Permissions and Features > public_profile > usage description (requested because Facebook Login for Business needs Advanced Access to public_profile before going live; whether it needs its own recording is unverified, so upload the same annotated recording)**

> Insights uses public_profile only because it uses Facebook Login for Business, and Meta requires Advanced Access to public_profile before such an app goes live. During the sign-in callback, right after exchanging the code, our server calls GET /me?fields=id once to read the app-scoped user ID of the person who granted access. We store that ID with the ad-account connection for two reasons. It tells apart connections made by different people in the same workspace. And when a merchant disconnects, we withdraw ads_read (DELETE /me/permissions/ads_read) only once no other connection made by that same person still relies on the grant, so disconnecting one store doesn't break another. We don't read, store or show the person's name, profile picture or any other profile field. Facebook Login is not used to sign in to Insights: Insights accounts use their own email sign-in.

**App Verification > 'Can app users sign in with a Meta authentication solution?' (recommendation, unverified)**

> Yes. App users go through Facebook Login for Business inside Insights to connect their ad accounts. The instructions explain that signing in to Insights itself uses an Insights email and password.

**App Verification > Platform Settings > instructions for reviewers**

> Paste reviewerTestInstructions with the owner's reviewer credentials filled in.

**Data handling Q1: data processors or service providers (including your own companies) with access to Platform Data from Meta (OWNER must confirm)**

> Draft: Yes. Cloudflare, Inc. hosts the application, background jobs and report cache (Workers, Durable Objects, Queues, Hyperdrive, Tunnel). The code sends Meta data to no other third party; Google Firebase handles Insights sign-in only and never receives Meta data. The Postgres database is run by the responsible entity itself, on a machine it controls.

**Data handling Q2: list all processors and service providers**

> Cloudflare, Inc.

**Data handling Q3: service category for each processor**

> Cloudflare, Inc.: IT solutions and services, including cloud storage and processing

**Data handling Q4: countries where each processor processes Platform Data**

> [OWNER: Cloudflare runs a global network. Take the list from Cloudflare's data processing addendum or your plan's data-localisation settings (unverified how Meta expects a global CDN to be listed). The database machine is not a processor, so it doesn't go here.]

**Data handling Q5: responsible entity**

> [OWNER: the registered legal entity, matching CONTACT.legalName and Business Verification]

**Data handling Q6: country of the responsible entity**

> [OWNER: that entity's country. If the production database machine is in a different country, tell your adviser.]

**Data handling Q7: personal data given to public authorities for national-security requests in the past 12 months**

> [OWNER: answer truthfully. The choices are: No; about 10 or fewer users; 11-100; 101-1,000; more than 1,000; or prohibited by law or company policy from answering]

**Data handling Q8: policies for public-authority requests**

> [OWNER: tick only what really exists. The choices are: legality review; provisions for challenging unlawful requests; data minimization; documentation of requests, responses and reasoning; prohibited from answering; none of the above]

**Access Verification (Tech Provider) > how the business uses other businesses' data (category options unverified)**

> Insights is a SaaS analytics dashboard for Shopify merchants. Each merchant, a separate business, connects its own Meta ad accounts through Facebook Login for Business and grants ads_read. We use that access only to read the merchant's own ad performance (spend, impressions, reach, clicks, conversions, conversion value) and to show it to that merchant in their private Insights dashboard, next to their store's sales. Each merchant's data is kept under its own store and shown only to that merchant's workspace. We never create or change ads, and never sell or share the data. A merchant can disconnect at any time: that deletes the token and the data, and Insights withdraws ads_read once nothing else relies on the grant.

### Screen recording script

1. 0. Setup (Meta's screen-recording guidance). Record at 1080p or better, with the screen or browser width at 1440 or less. Use English UI and an enlarged cursor. No audio; reviewers don't listen. Record only the browser window, and use the mouse rather than the keyboard where possible. Add captions, annotations and zooms in an editor (OBS or QuickTime plus iMovie, or Camtasia or Snagit). Before recording: (a) sign in to Insights as the reviewer account and make sure Meta Ads is not connected in its workspace; (b) in Facebook, open Settings & privacy > Settings > Business integrations and remove Insights, so the full consent screen appears (this ends your other Meta connections; reconnect them afterwards); (c) sign out of Insights and Facebook. Use your own Facebook account (an app Admin) with an ad account that delivered ads recently.
2. 1. Open https://insights.imeseban.workers.dev while signed out. Caption: 'Insights: analytics dashboard for Shopify merchants'.
3. 2. Click sign in. Sign in with the reviewer email and password, keeping the password field masked. You land on /dashboard. Caption: 'Merchants sign in with an Insights account; Facebook is used only to connect ad accounts'. This covers Meta's request to show the whole path from logged out to logged in.
4. 3. Scroll to the dashboard's Advertising section. With nothing connected, it shows the 'Connect advertising accounts' button.
5. 4. Open Settings > Connect your business from the Settings menu. Zoom on the Meta Ads card: 'Facebook and Instagram ads: spend, reach, clicks and the purchases Meta reports', the text 'Meta asks you to log in and choose the ad accounts to share. Access is read-only: Insights can't create, change or pause ads, or spend money.', and the 'Continue with Meta Ads' button. Caption: 'Insights asks Meta for ads_read only'.
6. 5. Click 'Continue with Meta Ads'. The button reads 'Opening Meta…'. The Facebook login page opens. Log in, typing the credentials off-camera or blurring them in the edit. Caption: 'Facebook Login for Business'.
7. 6. On Meta's consent screen, show the app name 'Insights' and the ads-reporting access it asks for (Meta's exact wording is unverified). Select the ad account or accounts and confirm. Annotate: 'ads_read is granted here. public_profile is granted with Facebook Login; Insights reads only the app-scoped user ID on the server'.
8. 7. If the login can see several ad accounts, Insights opens Settings > Advertising with the account picker. Tick the account for this store and confirm. Caption: 'The merchant chooses which ad accounts belong to this store'. With one account, Insights skips this step.
9. 8. You land on the dashboard. The banner 'Fetching the last 90 days from <account> (Meta Ads). The numbers below fill in within a few minutes; this page updates by itself.' appears. Cut the wait and add the caption '(a few minutes later)'.
10. 9. The Advertising section now has numbers. Zoom on the 'Ad spend' card: Ad spend, Impressions, Clicks, Click-through rate, Cost per click, Cost per 1,000 impressions, Conversions, and Conversion value with its return on ad spend. Then show the 'Ad spend per day', 'Impressions per day' and 'Clicks per day' charts and the by-platform comparison. Annotate: 'Spend, impressions, clicks and conversions read with ads_read'.
11. 10. Click 'See details' on the Ad spend card and scroll to the 'Meta Ads report'. Show the Campaigns, Ad sets and Ads tabs, the status badges, and the date range. Zoom on the Spent, Impressions, Reach, Frequency, Link clicks, Purchases, Purchase value and Return columns. Then open the Placements, Devices and Countries tabs. Annotate 'Reach' and 'Conversions (Purchases)'.
12. 11. (Optional, recommended; not a Meta requirement.) Open Meta Ads Manager in a second tab with the same date range and show that spend and impressions match.
13. 12. Open Settings > Advertising. Show the Meta Ads account row (name, act_ ID, currency, time zone), 'Last synced …', the 'Show on dashboard' checkbox, and the line 'Read-only access to ads reporting (ads_read). Connected …'. Zoom on that line. Caption: 'Read-only: no controls to create, edit, pause or delete ads'.
14. 13. Click Disconnect on the account. Show the browser confirmation: 'Disconnect <account>? Its access and every number fetched for it are deleted from Insights, and Insights gives up its access at Meta Ads once no other connected account uses it. Your ads keep running.' Confirm, and show that the account is gone. Caption: 'Token and fetched data deleted; ads_read is withdrawn from Meta (DELETE /me/permissions/ads_read) once no other connection relies on this grant'.
15. 14. Stop recording and export a 1080p MP4. Meta's pages state no length, format or size limits (unverified). Upload it for ads_read. Upload the same file for public_profile; its step-6 annotation covers public_profile. Afterwards, reconnect your other Meta connections (step 0b ended them), and optionally the reviewer workspace (prerequisite 12).

### Instructions for the reviewer

Insights is a web app for Shopify merchants at https://insights.imeseban.workers.dev. Merchants sign in to Insights with an Insights email and password. Facebook Login for Business is used only to connect a merchant's own Meta ad accounts, with the ads_read permission only.

1. Open https://insights.imeseban.workers.dev/login and sign in with this Insights-only test account. It is not a Meta account. Its email is verified, it is the workspace Owner, and its workspace has a Shopify development store connected.
   Email: [OWNER: reviewer email]
   Password: [OWNER: reviewer password]
2. Open Settings > Connect your business. On the "Meta Ads" card, click "Continue with Meta Ads". [OWNER: if you pre-connected an ad account (prerequisite 12), replace this with: the button reads "Reconnect or add accounts" because a Meta ad account is already connected so you can see real data; it runs the same Facebook Login.]
3. Log in to Facebook as your test user, approve Insights' request to read ads reporting (ads_read), and choose an ad account.
4. You return to Insights. If your Facebook account can see several ad accounts, tick the ones to connect and confirm. If it can see none, Insights says "That login can't see any ad accounts. Ask the account's owner to give you access, then connect again." and connects nothing; any account already connected stays. The attached recording shows the same flow with a real ad account.
5. On the Dashboard, the Advertising section shows ad spend, impressions, clicks, CTR, CPC, CPM, conversions, conversion value and ROAS, with daily charts. A newly connected account's first fetch takes a few minutes, and the page updates by itself. Click "See details" on the Ad spend card to open the Meta Ads report: campaigns, ad sets and ads with reach, frequency, link clicks, purchases and purchase value, plus splits by placement, device and country.
6. Insights is read-only. Nothing in it can create, edit, pause or delete campaigns, ads, budgets or billing, and ads_management is never requested. Settings > Advertising > Disconnect deletes the encrypted token and every number fetched for that account. Insights then withdraws ads_read from Meta (DELETE /me/permissions/ads_read) once no other connection relies on the same person's grant.

Privacy policy: https://insights.imeseban.workers.dev/privacy
Data deletion instructions: https://insights.imeseban.workers.dev/data-deletion
Support: https://insights.imeseban.workers.dev/support

### Common reasons for rejection

- Requesting permissions the app doesn't need, a reason Meta calls common. Request Advanced Access only for ads_read and public_profile. Leave ads_management, business_management, the pages permissions and email at Standard.
- A requested permission or feature with no screen recording; Meta won't approve it. Every requested permission must appear in a recording.
- A recording that doesn't start from logged out, skips the Insights sign-in, or doesn't show the person granting ads_read in the full Facebook Login for Business flow.
- A recording that doesn't show ad performance data in the app. The ads_read page names impressions, conversions, spend, clicks and reach, so use an ad account with recent delivery and show the Meta Ads report for reach.
- Usage descriptions that are vague, copied between permissions, or not tied to using the data on behalf of other businesses.
- A privacy policy that is broken, geo-blocked, unreachable by Meta's crawler, not clearly titled, not your own, or with no working way to ask for deletion. Insights shows '[not set' markers on /privacy and /data-deletion today: fill in contact.ts first.
- Reviewers can't reach or use the app: production is down (the database is on the owner's PC), the reviewer email isn't verified ('Verify your email first'), the reviewer isn't Owner or Admin (no connect button), or no store is connected ('Connect your Shopify store first').
- A reviewer's Facebook test account owns no ad account, so they see only the 'can't see any ad accounts' message. Reduce this risk with a pre-connected account and the recording.
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
