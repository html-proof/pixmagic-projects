# Advertising integrations: Google Ads, Meta Ads and Google AdSense

What a merchant sees, what the owner sets up, and how the connections behave. The owner's checklist of what
is done and what is still open at Google, Meta and AWS is [integrations-readiness.md](integrations-readiness.md);
paste-ready review material is [ads-review-packs.md](ads-review-packs.md). A simulated Google Ads account for development,
demonstrations and tests, which needs none of what follows and never stands in for it: [ads-demo.md](ads-demo.md).
The same sign-ins can run through Nango's Connect UI (one window over the page, tokens kept by Nango):
[nango.md](nango.md).

## How a merchant uses it

1. The dashboard's **Advertising** section offers **Connect advertising accounts** while nothing is connected.
2. That opens **Settings → Advertising** (`/settings/ads`, "Advertising integrations", drawn after the owner's
   design in `components/settings/ads/`): one card per platform with what bizinsights reads from it; while nothing
   is connected, what connecting brings and what it needs; once connected, each account's details and data status
   beside how the integration stands. **Settings → Integrations** (`/settings/integrations`, "Connect your
   business") has shorter cards for the same platforms, next to the **Google Account** (Continue with Google
   sign-in), Shopify and WhatsApp cards. Both follow the same rules (`components/integrations/adPlatformParts.tsx`).
   Card order for ads: Google Ads, Meta Ads, Google AdSense.
3. They press **Connect with Google Ads**, **Connect with Meta Ads** or **Connect with Google AdSense** (on Connect
   your business: **Continue with …**) and approve on the platform's own screen. Connecting needs the integrations permission (`integrations.manage`:
   owners and admins, unless the owner gave it to another role) and a verified email address.
4. When the login can see several accounts and some are new, they tick the ones that belong to this store.
   - The sign-in waits on the server, encrypted, for 15 minutes.
   - One account, or a reconnect that sees nothing new, skips this step.
   - Leaving the picker without choosing (Cancel) gives the platform's access back when nothing else uses it
     (`dropUnusedGrant`, below).
5. They land back on the **dashboard**. The first sync usually arrives within a minute or two; the card says
   **Synchronizing** meanwhile.

**Google AdSense** runs the other way: it is what the store's *site* earns from Google ads shown on it. Its
estimated earnings, page views, ads shown and clicks go on a separate **Ad earnings** card and are never added
to ad spend. On Settings → Advertising the AdSense card lets the merchant pick which **sites** (AdSense domains)
belong to this store; none picked means every site. Accounts that can't be split by site are read as daily
totals for the whole account ("All sites").

Access is **read-only**: Google's `adwords` scope (the only Google Ads scope there is, used only to read),
`adsense.readonly`, and Meta's `ads_read`. bizinsights never creates, changes or pauses an ad.

## The card states

Each connection has a stored **status** (`ad_connections.status`) and, when it isn't working, an
**error code** (`error_code`). The code is worded for the merchant by `adErrorMessage` in
`packages/shared/src/ads.ts`; the platform's own words go only to the logs. Status and code always change together
(`AD_ERROR_STATUS`).

| Status | Codes | What it means |
| --- | --- | --- |
| `active` | none | Working. |
| `reconnect` | `auth_expired`, `scope_missing`, `connector_left` | The sign-in ended, the permission was taken back, or the person whose login powered it left. Reconnect fixes it. |
| `permission` | `no_access` | This login can no longer read this account. |
| `unavailable` | `account_closed`, `account_disabled`, `account_not_ready` | The platform closed, disabled or hasn't finished the account. |
| `error` | `not_approved`, `not_configured`, `rate_limited`, `quota_exhausted`, `temporary`, `provider_error`, `internal` | A failure a retry may fix. `not_approved`, `not_configured`, `quota_exhausted` and `internal` are bizinsights' to fix and are worded "on our side, not yours". |

The account's own health at the platform is stored too (`account_status`: active, payment issue, under review,
disabled, closing, closed, needs attention, set-up unfinished), read from Meta's `account_status`, Google's customer
status and AdSense's account state.

The cards show these as one badge (`AD_STATE` in `apps/web/src/lib/adConnections.ts`): Coming soon, Not connected,
Connecting, Synchronizing, Connected, Authorization required, Permission missing, Verification pending, Sync failed,
Reconnect required, Disconnected, plus Checking… and Status unavailable while the page loads. A platform's card shows
the worst of its accounts. Each account row shows who connected it, when, the permission granted, the last sync,
and **Refresh**, **Show on dashboard** and **Disconnect**.

Two notes appear before anyone is sent to a platform:
- **Google Ads**: while `GOOGLE_ADS_OAUTH_VERIFIED` isn't `"1"`, the card warns that Google first shows "Google
  hasn't verified this app" and that the way on is **Advanced → Go to bizinsights.io (unsafe)**
  (`apps/web/src/components/GoogleAdsAccess.tsx`). AdSense never shows that screen.
- **Meta Ads**: while `META_ADS_ADVANCED_ACCESS` isn't `"1"`, the card says only people with a role on the Meta app
  can connect, and how to ask to be added (`MetaAdsAccess.tsx`).

## What the dashboard shows

- KPI tiles kept separate for spend and earnings, money per day, impressions and **link clicks** per platform, and a
  by-platform comparison.
- **Purchases** are purchase conversions only: Google's conversions in the `PURCHASE` category (a second GAQL query;
  if Google refuses it, purchases are left empty rather than guessed), and Meta's purchase actions. Meta's clicks are
  **inline link clicks** (`inline_link_clicks`), what Google counts as clicks; Meta's `clicks` ("clicks (all)") is
  not used for the tiles.
- Figures cover only days that are stored. When some of the chosen dates aren't stored for an account, the tile says
  **Unavailable** with the reason instead of showing 0, and a range whose last days aren't over yet says
  "figures up to <date>". Comparisons start only where every counted account's history starts ("No earlier data"
  before that).
- Only accounts in one currency are added together (the store's, when any account uses it); others are listed as
  left out.

Details of each figure: [kpis.md](kpis.md), "Ads" and "Ad earnings (AdSense)".

## Syncing

- **First connect**: the last 90 days, then history is walked back 90 days at a time to **25 months**
  (`ADS_HISTORY_DAYS` = 760; less where the platform keeps less: Meta about 37 months, AdSense about 3 years). At most
  3 history walks start per 15-minute scheduler tick, so a deploy doesn't start every account's walk at once.
- **Coverage**: each connection stores one unbroken run of days, `history_from` to `synced_through`. A sync that would
  leave a hole (the account waited for a reconnect, was hidden or kept failing) fetches the hole first ("catch-up").
  A hole the platform no longer reports moves `history_from` past it, so the dashboard says "No earlier data" rather
  than counting those days as nothing spent.
- **Recent days** (the last 3) are refreshed every hour for Meta and AdSense, and **every 3 hours for Google Ads**
  (one daily operations allowance serves every merchant). After 3 failures in a row an account is tried every 6
  hours, after 10 only daily.
- **Daily re-check**, because platforms keep crediting conversions after the click (`recheckDays` in
  `packages/core/src/adConnections/sync.ts`): **Google 90 days**, **Meta 30**, **AdSense 30**, or the whole previous
  month during the first 10 days of a month (when AdSense finalizes earnings). The same daily run reads each account's
  health. Accounts with nothing new to read (closed, or a login that lost them) are only asked once a day whether
  they're back; accounts waiting for a reconnect are left alone.
- **Rate limits**: when a platform says "slow down", the job is sent again after the wait it names (or a backoff of 30
  seconds to an hour) **without spending a retry**.
- **Google Ads API operations budget**: the Cloud project may make a fixed number of operations a day across every
  merchant (Explorer: 2,880). The syncs count what they spend; **scheduled syncs stop at 80%** of the allowance and
  history walks at 60%, leaving the rest to people connecting accounts and opening reports. When Google says the
  allowance is used up, Google syncs pause (an hour unless Google says otherwise) and the account shows
  `quota_exhausted`. Set `GOOGLE_ADS_DAILY_OPERATIONS` when Google grants a higher access level.
- **Meta report jobs**: when Meta answers a big account's long range with "reduce the amount of data", the sync runs
  it as an asynchronous Insights report job.

## Alerts

The 15-minute sweep raises one alert per connection in the bell feed (and email, by the notification settings) to
the people who manage integrations, and closes it when the connection works again, is hidden or disconnected:

- `ads_reconnect`: status `reconnect` or `permission`;
- `ads_unavailable`: status `unavailable`;
- `ads_failing`: status `error` for 6 syncs in a row or more than 24 hours (never for codes that are bizinsights' to
  fix: those go to the operator's logs);
- `ads_expiring`: a Meta sign-in that ends within 7 days.

## Disconnecting, and when access is given back

- **Disconnect** deletes the token and every figure fetched for that account, then gives the access back to the
  platform **only when no other connection relies on the same person's grant** (another store, or AdSense next to
  Google Ads, since Google revokes a person's whole grant to the client at once). A connection whose person isn't
  known yet is looked up with its own token first. Google: `POST oauth2.googleapis.com/revoke`. Meta:
  `DELETE /me/permissions/ads_read` (only ads_read), or, when the person's token has ended, the same on their user id
  with the app token. The outcome (`revoked`, `still_used`, `unknown_person`,
  `failed`) is in the response and the audit log.
- **A connect that ends without connecting** (cancelled picker, an error after the code exchange) drops the grant it
  just made, under the same rules (`dropUnusedGrant`).
- **A member removed from a workspace**: their ad connections there are released (`releaseUserAdGrants`): the tokens
  are cleared, the accounts wait for someone else to press Reconnect (`connector_left`), the figures stay, and the
  grant is revoked when nothing else uses it. A sync running at that moment can't undo it.
- **Account deletion**: the same for every workspace, before the user is deleted.
- **Meta's own callbacks** (below): removing bizinsights in Facebook marks the person's Meta connections "reconnect"
  at once; a data deletion request deletes them and their figures.

## Security

- **The sign-in.** One-time `state` (10 minutes), bound to the browser by an HttpOnly cookie, accepted only for the
  signed-in person who started it. Codes are exchanged on the server only.
- **PKCE (Google Ads and AdSense)**: the S256 challenge goes to Google; the verifier stays on the server.
- **Tokens** are AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEYS`, bound to their store and platform, never sent to
  the browser or logged. A key rotation re-seals them; a sign-in left on a removed key waits for a reconnect.
- **Who signed in** is kept per connection (`external_user_id`: Google's account id, checked to be a token issued to
  bizinsights' own client; Meta's app-scoped user id), with the permissions granted (`granted_scopes`).
- **Meta `appsecret_proof`**: every Graph call made with a person's token carries it (HMAC of the token with
  `META_APP_SECRET`, `packages/core/src/metaGraph.ts`), so a leaked token is useless without the secret. Once this
  is deployed, **"Require App Secret"** can be turned on in the Meta app (App settings → Advanced → Security).
  WhatsApp sends none (a merchant's own WhatsApp app has a secret we don't hold).
- **Meta tokens** last about 60 days and can't be renewed silently: Settings warns from 14 days before, the alert from
  7. When it ends the account shows Reconnect required; history is kept.

## Settings (owner)

| Setting | Where it goes | Secret? |
| --- | --- | --- |
| `META_APP_ID` | `apps/aws/src/settings.ts` (`APP_SETTINGS`): `971575545351940` | no |
| `META_APP_SECRET` | `node infra/cdk/scripts/put-secrets.mjs --set META_APP_SECRET` | **yes** |
| `META_CONFIG_ID` | `settings.ts`: Facebook Login for Business configuration `1521935306664882` | no |
| `META_ADS_ADVANCED_ACCESS` | `settings.ts`: `"1"` once Meta grants Advanced Access to `ads_read` | no |
| `META_API_VERSION` | `settings.ts`: `v26.0` | no |
| `GOOGLE_ADS_CLIENT_ID` | `settings.ts`: the "Insights web" client (Google Ads **and** AdSense) | no |
| `GOOGLE_ADS_CLIENT_SECRET` | `node infra/cdk/scripts/put-secrets.mjs --set GOOGLE_ADS_CLIENT_SECRET` | **yes** |
| `GOOGLE_ADS_ENABLED` | `settings.ts`: `"1"` (Explorer access, since 2026-10-11) | no |
| `GOOGLE_ADS_OAUTH_VERIFIED` | `settings.ts`: `"1"` once Google verifies the `adwords` scope (removes the unverified-app note) | no |
| `GOOGLE_ADS_DAILY_OPERATIONS` | `settings.ts`: empty = Explorer's 2,880; set when Google grants Basic or Standard | no |
| `GOOGLE_ADS_API_VERSION` | `settings.ts`: `v25` | no |

Settings ship by merging to `main` (Deploy to AWS). Secrets go to Secrets Manager with `put-secrets.mjs`, which reads
the clipboard and refuses a value of the wrong shape: a Meta app secret must be 32 hexadecimal characters, a Google
client secret must start with `GOCSPX-`, and a value equal to a public id in `settings.ts` is refused. It never
prints a value. Until a platform's id and secret are both set, its card says **Coming soon** without a button.

**Is every secret there?** `node infra/cdk/scripts/put-secrets.mjs --dry-run` lists the key names. Every deploy also
asks the cron function and puts a warning on the Deploy run for each provider whose public id is set but whose
secret is missing ("Meta Ads isn't set up", with the command to run). Details: [aws-deployment.md](aws-deployment.md),
"Which provider secrets are there".

### Addresses to register at the platforms

The app builds every address from `APP_URL` (`https://bizinsights.io`), so they must be registered **exactly**:

| Where | Address |
| --- | --- |
| Google client "Insights web" → Authorized redirect URIs | `https://bizinsights.io/api/ads/google/callback` and `https://bizinsights.io/api/ads/adsense/callback` |
| Meta app → Facebook Login for Business → Settings → Valid OAuth Redirect URIs | `https://bizinsights.io/api/ads/meta/callback` |
| Meta app → Facebook Login for Business → Settings → Deauthorize callback URL | `https://bizinsights.io/api/webhooks/meta/deauthorize` |
| Meta app → App settings → Basic → User data deletion → Data deletion callback URL | `https://bizinsights.io/api/webhooks/meta/data-deletion` |

The old `d2mr8m2p1qkh58.cloudfront.net` and Cloudflare Worker (workers.dev) callbacks are never sent; remove them
(Google's branding verification accepts only verified domains).

In the Meta app dashboard, the Valid OAuth Redirect URIs and App domains fields are token lists: type the value, then
**click the suggestion that appears under the field**, then Save Changes. Pressing Enter shows a chip and a "Changes
saved" toast, but a reload shows the list unchanged (seen three times on 2026-10-19). Check with the Redirect URI
Validator at the top of the Facebook Login for Business settings page.

**Local development.** Don't add localhost to "Insights web": Google wants a separate project per deployment tier.
Create an OAuth client in a separate Cloud project and register `<APP_URL>/api/ads/<provider>/callback` for the
local server you run: `http://localhost:8787` for the usual local server (`apps/aws/.env.example`), and
`http://localhost:8789` for the ads demo (`.claude/ads-demo-server.mjs`). Put its id and secret in `apps/aws/.env`.
A new project's Google Ads API access starts at Test (test accounts only).

## 1. Meta (Facebook and Instagram ads)

**The app:** "Insights", App ID `971575545351940`, owned by the Facebook account sebanceo@gmail.com, Development mode,
use case "Measure ad performance data with Marketing API" (`ads_read` ready for testing = Standard Access). Facebook
Login for Business configuration "Insights ads reporting" `1521935306664882` (user access token, ad accounts, ads_read
only) = `META_CONFIG_ID`. No business portfolio yet. WhatsApp runs on its own app ("pixmagic", `WHATSAPP_APP_ID`).

To set up a new app from scratch:

1. <https://developers.facebook.com/apps> → **Create app**, use case **Other**, type **Business**.
2. Add **Facebook Login for Business**. In its settings, add the Meta callback and the Deauthorize callback above.
   Under **Configurations**, create one: **User access token**, assets **Ad accounts**, permission **ads_read** only,
   and copy its id into `META_CONFIG_ID`. (Empty `META_CONFIG_ID`: classic Facebook Login with `scope=ads_read` and
   `auth_type=rerequest`.)
3. Add the **Marketing API** product.
4. **App settings → Basic**: App ID into `META_APP_ID`, App secret into `META_APP_SECRET`; privacy policy
   `https://bizinsights.io/privacy`, terms `https://bizinsights.io/terms`, app domain `bizinsights.io`, an app icon,
   and the Data deletion callback above (the public instructions stay at `https://bizinsights.io/data-deletion`).
5. **App settings → Advanced → Security**: turn on **Require App Secret** (after the deploy that sends
   `appsecret_proof`, which is this branch's).
6. **Who can connect.** In Development mode, with Standard Access, only people with a role on the app (admins,
   developers, testers) can grant `ads_read`. Everyone else needs **Advanced Access to `ads_read`** through App Review,
   which needs **Business Verification** first. Then set `META_ADS_ADVANCED_ACCESS` to `"1"` and deploy.
7. Switch the app to **Live** after approval and the Data Use Checkup.

### Meta's deauthorize and data deletion callbacks

`apps/api/src/routes/metaWebhooks.ts`. Both are form POSTs from Meta whose `signed_request` is checked with
`META_APP_SECRET` before anything happens (without the secret they answer 503 `not_configured`).

- `POST /api/webhooks/meta/deauthorize`: the person removed bizinsights in their Facebook settings. Their Meta ad
  connections go to Reconnect required at once, and the account choices they left waiting are dropped.
- `POST /api/webhooks/meta/data-deletion`: their Meta ad connections and every figure fetched for them are deleted.
  Meta gets back a confirmation code and the status page `https://bizinsights.io/data-deletion?code=<code>`, which
  reads `GET /api/meta/data-deletion/:code` ("done", with when, or "unknown"). The same request sent again gets the
  same code.

Refused requests are limited per address, and a request is acted on once.

### When a Facebook login has nothing to connect

bizinsights asks Meta's token inspector which ad accounts the grant names, and Settings says which case it is, with
**Connect again**, **Open Ads Manager** and **Open Business settings**:
- `error=none_shared`: accounts were picked on Facebook's screen but none shared;
- `error=no_accounts`: the login reaches no ad account (business-portfolio accounts need the person assigned in
  Business settings → Ad accounts). Facebook has no account chooser: log out of Facebook in that browser to use
  another login.

### Facebook says "Feature Unavailable"

Facebook's own page, shown instead of its login; nothing reaches our logs. Two causes, both fixed in Meta:

1. **The Facebook account has no role on the app** (usual for anyone but the admin, while `ads_read` has only
   Standard Access). Add the person under App roles → Roles → **Testers**; they accept at
   <https://developers.facebook.com/requests/>. For everyone: Advanced Access (step 6).
2. **Meta paused the app's login for everyone.** Open <https://developers.facebook.com/apps> with the admin's account;
   if it shows "Account confirmation needed", press **Confirm Account**. Seen 2026-10-14 and 2026-10-15. Keep browser
   automation off developers.facebook.com: it is the likely trigger.

## 2. Google Ads

Google retired developer tokens on 2026-09-09: Google Ads API access follows the **Cloud project** that owns the OAuth
client (insights-511119). There is no token and no manager account to set up.

**Access levels** (Cloud console → APIs & Services → Google Ads API → Overview → Access levels → Manage):
- **Test**: test accounts only. Real accounts answer `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`, shown as
  `not_approved` ("Google is still approving bizinsights").
- **Explorer**: real accounts, 2,880 operations a day. **Granted to insights-511119 on 2026-10-11.**
- **Basic**: 15,000 a day; needs Explorer plus brand verification of the project. Then set
  `GOOGLE_ADS_DAILY_OPERATIONS`.

**OAuth client** ("Insights web", Web application, in insights-511119): the two redirect URIs above; Client ID into
`GOOGLE_ADS_CLIENT_ID`, secret into `GOOGLE_ADS_CLIENT_SECRET`. The consent screen (Google Auth Platform) needs
branding (app name bizinsights, homepage, privacy, terms, authorized domain `bizinsights.io`, verified as a Search
Console Domain property) and, under Data Access, `https://www.googleapis.com/auth/adwords`. That scope is
**sensitive**: until Google verifies it (a demo video and a justification, after branding is verified), people
signing in for Google Ads see "Google hasn't verified this app" and new users count toward a lifetime cap of 100.
Once verified, set `GOOGLE_ADS_OAUTH_VERIFIED` to `"1"` and deploy. Steps and texts:
[ads-review-packs.md](ads-review-packs.md).

**Manager accounts:** a login that reaches ad accounts through a manager account (an agency) gets each client account
listed; bizinsights reads them through the manager (`login-customer-id`).

### The Google Ads report (dashboard → Ads → "Google Ads report")

`GET /api/workspaces/:ws/stores/:storeId/ads/google/report?connection=&level=campaign|ad_group|device|country&from=&to=`
(add `cfrom=&cto=` to compare with another range): spent, impressions, clicks, CTR, CPC, CPM, conversions, cost per
conversion, conversion value and ROAS, with the account's totals on top. Campaigns show status, type and daily budget;
countries are where the viewers were (`user_location_view`). Asked of Google for exactly those dates, in the account's
time zone and currency, counted against the operations budget, cached 10 minutes (ranges including today) or an hour,
and limited to 30 reports per 10 minutes.

## 3. Google AdSense

Same Cloud project and OAuth client as Google Ads. In that project: enable the **AdSense Management API**, add the
AdSense callback to the client, and add `https://www.googleapis.com/auth/adsense.readonly` under Data Access. Google
lists it as **non-sensitive**, so AdSense needs no scope verification and never shows the unverified-app screen. There
is no access level to request. A Google login with no AdSense account gets "That Google login has no AdSense account".

**The AdSense report** (`GET .../ads/adsense/report?connection=&level=site|country|platform&from=&to=`): estimated
earnings, page views, ads shown and clicks by site, country or device type, limited to the store's chosen sites.
Earnings are estimated until AdSense finalizes them after the month ends.

## The Meta Ads report (dashboard → Ads → "Meta Ads report")

`GET /api/workspaces/:ws/stores/:storeId/ads/meta/report?connection=&level=&from=&to=` (and `cfrom=&cto=` to compare):
by **campaign, ad set or ad**, or the whole account split by **placement, device, country, age or gender**: spent,
impressions, reach, frequency, link clicks, link click rate, cost per link click, CPM, purchases, cost per purchase,
purchase value and ROAS, with each row's delivery status. Asked of Meta for exactly the dates picked (reach can't be
summed by day), in the ad account's time zone; a comparison reads both ranges at once. Cached 10 minutes or an hour,
30 reports per store and user per 10 minutes. A report that doesn't finish in time says Meta is still preparing it.
Expired or revoked access turns the account to Reconnect required at once.

The panel opens with the account's figures **at a glance** (the twelve above, each with its change against the dates
compared with and the figure before, and **Active campaigns**: how many of the account's campaigns deliver now), then
the table. Each campaign, ad set or ad row carries what it is **set to at Meta now** (`details`, read from the account's
own list of them with the delivery status, `metaListed` in `packages/core/src/ads/meta.ts`): a campaign's objective,
buying type, budget (daily or lifetime, in the account's currency: Meta states budgets in minor units,
`metaBudget`), schedule and bid strategy; an ad set's optimization goal, billing event, budget and schedule; an ad's
shareable preview (only `facebook.com` links are kept). The campaign counts (`campaigns`: active, paused, other,
total, and whether the list was read in full) come from the same list on the campaign level and from one more list
call on the others. A field list Meta refuses (a version that doesn't know one) is asked again as the status alone;
a list that can't be read in time leaves the settings and counts unknown, never the report broken. The table filters
by delivery status (all, active, paused, other) and, on the campaign level, by objective, on the rows already read:
the account's totals always cover every row.

## Next to the store's own sales (dashboard → Ads)

The Ads panel sets the store's Shopify figures against the ad spend (`sales` on the ads module, `salesVsSpend` in
`packages/core/src/reports/ads.ts`): net sales, orders, **sales per unit of ad spend** (MER, net sales ÷ spend), the
spend's share of sales and the **cost per Shopify order** (spend ÷ every order), with the dates compared with and the
changes when the dates picked have ended. A platform's ROAS (the purchase value it credits to its own ads ÷ what it
charged) and MER (every sale ÷ everything spent) are kept apart on every card and in every sentence.

Beside them, two ways to credit a sale to ads: what each platform counts for itself, and what Shopify's record of the
visit behind each order says (`sourced`: `sourcedOrders`, the orders whose last visit came from a Facebook or Instagram
ad for Meta, a Google or YouTube ad for Google Ads, with their net sales and their sales per unit of that platform's
spend). Team & Access "View conversion attribution" shows the second; the formulas are in [kpis.md](kpis.md). The
panel also draws one figure over the days per platform ("Over the days": spend, purchase value, purchases, ROAS, link
clicks, impressions, click-through rate, cost per click, CPM), days a platform has no figures for left blank.

## Keeping the API versions current

The build fails 90 days before a configured API version stops being served
(`packages/core/test/appConfig.test.ts`, table `API_VERSION_ENDS`). For Google Ads, the table holds Google's published
sunset dates. For Meta, a version whose end date is still "TBD" counts as ending at its release date plus the shortest
life of any dated version in the list (v24.0: 363 days), and the table must be re-read within 60 days once a newer
version exists (180 otherwise), or the test fails. A red `main` blocks every deploy, so upgrade before then:

1. Read the platform's changelog (Google: <https://developers.google.com/google-ads/api/docs/sunset-dates> and the
   release notes; Meta: the Marketing API changelog) and check every call and field `packages/core/src/ads/` uses.
2. Change `GOOGLE_ADS_API_VERSION` or `META_API_VERSION` in `apps/aws/src/settings.ts`.
3. Update `API_VERSION_ENDS`: the new version's dates and today's date as `checked`.
4. Run `pnpm --filter @app/core test`, merge to `main` and confirm the Deploy run.

State on 2026-10-19: Meta v26.0 (moved from v25.0 on this branch; its projected end is 2027-07-27, re-read the
changelog by 2027-04-17, sooner once v27.0 is out). Google Ads v25 (ends 2027-08-01).

## Database

Migrations `20261009185831_ad_accounts`, `20261010080000_adsense_daily`, `20261011130000_ad_connection_identity`,
`20261017160000_visits_ads_history_from` and `20261019120000_ad_connection_health` (status, error code, account
health, sites, coverage). The Deploy to AWS workflow applies them.
