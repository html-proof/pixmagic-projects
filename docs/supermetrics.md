# Supermetrics: Meta Ads, Google Ads and AdSense through Supermetrics

A second way for a merchant to connect Meta Ads (Facebook and Instagram), Google Ads and Google
AdSense, next to bizinsights' own sign-ins with each platform (docs/ads-setup.md). The merchant signs
in to the platform on **Supermetrics' own page**, and bizinsights reads the figures through
**Supermetrics' API**. Everything after that (the daily rows, the dashboard's Marketing view, the
AdSense earnings, ad spend against Shopify sales, alerts, sync history) is the same code as for a
direct connection.

Why it is worth having: merchants authenticate with Supermetrics' Meta and Google apps, which already
have the platforms' approvals. bizinsights' own Meta app still waits for Business Verification and App
Review (only its testers can connect), and its Google Ads access waits for the `adwords` verification
(docs/integrations-readiness.md). A merchant can connect through Supermetrics without either.

**State on 2026-10-22: built, tested against Supermetrics' documented API, switched off.** It shows
only once bizinsights' Supermetrics API key is in Secrets Manager. Nobody has queried the live
Supermetrics API yet: there is no Supermetrics account for bizinsights (the owner's Chrome isn't signed
in to hub.supermetrics.com, and no key was ever stored). See "What the owner has to do".

## How it works

```
Settings → Advertising card ── "Connect through Supermetrics"
  POST /workspaces/:ws/stores/:store/ads/:provider/supermetrics/connect      (apps/api routes/adsSupermetrics.ts)
    → licence check for the platform's data source (GET /query/accounts, cached 1 h)
    → Supermetrics: POST /ds/login/link {ds_id: FA|AW|ADM, expiry 30 min, redirect_url: <APP_URL>/api/ads/supermetrics/callback?state=…}
    ← login_url (Supermetrics' page). State kept in the coordinator, bound to the browser by the ads_sm_state cookie.
  Browser → Supermetrics' page → the platform's own consent screen (it names Supermetrics) → back to the callback
  GET /api/ads/supermetrics/callback?state=…
    → GET /ds/login/link/{id} (server side, by the id kept in the state: never what the browser brought)
    → PUT /ds/login/link/{id}/close, GET /ds/login/{login_id} (same data source?), GET /ds/login/{login_id}/accounts
    → one account (or a reconnect): saved and synced at once → /dashboard
      several: held 15 minutes for the person's choice → /settings/ads?choose=…&via=supermetrics
```

- A connection read through Supermetrics is an ordinary `ad_connections` row with `source =
  'supermetrics'` and `source_login_id` (the Supermetrics login). Its `access_token_enc` holds a
  **sealed credential**, not a token: the login's username (sent as `ds_user`) and the account's id at
  Supermetrics (`ds_accounts`), encrypted with the store/platform AAD like every token and re-encrypted
  on key rotation. Nothing in it opens the platform; only bizinsights' Supermetrics key can use it.
- Account ids are written the way bizinsights writes them for that platform (Meta `act_<digits>`,
  Google Ads the ten digits, AdSense `pub-<digits>`), so the same account connected directly and
  through Supermetrics is **one** connection, never two. Connecting it the other way moves the row to
  the new source, keeps its stored days, and gives back the credential it held before.
- Every query names one login (`ds_user`) and one account (`ds_accounts`), and is sent as a POST body:
  the username never goes into a URL. The API key goes only in the `Authorization` header, server side.
- Syncs use the same engine as direct connections (`packages/core/src/adConnections/sync.ts`): 90 days
  first, history walked back to 25 months, a hole fetched first, conversions re-checked daily (Meta 30
  days, Google 90, AdSense 30 or the month before). The recent days are fetched again **every 6
  hours** (direct: hourly, Google Ads every 3 hours), because every query counts against the team's
  licence. Long queries are followed through `/query/status` (up to 10 minutes in a sync job).
- Each sync attempt sets `last_sync_attempt_at` and leaves one row in `ad_sync_runs` (window, trigger,
  outcome, rows, reason), kept 90 days. The account row on the settings cards shows "Read through",
  "Last successful sync", "Last attempted sync", "Data through", "Data freshness" and "Recent syncs".
- Live reports (the Marketing view's tables) go to Supermetrics too: Meta by campaign / ad set / ad /
  placement / device / country / age / gender, Google Ads by campaign / ad group / device / country,
  AdSense by site / country / device type.
- Disconnecting deletes the account's figures and revokes the Supermetrics login (`DELETE
  /ds/login/{id}`) once no other connection reads with it. The same happens when the person who
  connected it leaves the workspace (rows wait for a reconnect, `connector_left`), when the store's data
  is erased, and when a sign-in ends without a connection (cancelled choice, not allowed any more).
- Reconnecting a connection whose login ended creates a link with `require_username` (the same platform
  user signs in again); the new login replaces the old, which is revoked once unused.

## Supermetrics answers sorted like the platforms'

| Supermetrics error code | Connection becomes | Why |
| --- | --- | --- |
| `API_KEY_*`, `ACCESS_DENIED_*`, `LICENSE_*` (not the daily one), a refused field or setting | error `not_configured` (alerted to the operator, worded "on our side") | the key, the licence or a query bizinsights built |
| `LICENSE_DAILY_QUERY_LIMIT_EXCEEDED` | error `quota_exhausted`, retried later | the team's daily allowance |
| `QUERY_AUTH_EXPIRED`, `QUERY_AUTH_LOGIN_FAILED`, `QUERY_AUTH_NOT_FOUND`, `QUERY_AUTH_UNAVAILABLE`, `QUERY_AUTH_FAILURE`, a revoked or gone login | reconnect `auth_expired` | the platform login ended |
| `QUERY_ACCOUNT_INVALID`, `QUERY_ACCOUNT_UNAVAILABLE`, the login no longer lists the account | permission `no_access` | this login lost the account |
| `QUERY_API_RATE_LIMITED`, `TOO_MANY_REQUESTS`, HTTP 429 | error `rate_limited`, waited out (Retry-After) | throttling |
| HTTP 5xx, `QUERY_ERROR`, `STATUS_NOT_FOUND`, `WORKFLOW_LISTENER_LIMIT_EXCEEDED` | error `temporary`, retried | outages |

Codes are Supermetrics' (https://docs.supermetrics.com/apidocs/errors); only the code is read, never
the message, which reaches the logs through `providerDetail()` only.

## Fields read, and where they differ from the platforms' own APIs

Field ids are Supermetrics' documented ones (docs.supermetrics.com/docs/facebook-ads-fields,
google-ads-fields, google-adsense-fields, read 2026-10-22). Rows are turned into the platforms' own
shapes and worked out by the same functions as direct connections (`@app/shared/ads`).

**Meta Ads (FA)**: `Date`, `adcampaign_id`, `adcampaign_name`, `cost`, `impressions`, `Clicks`,
`inline_link_clicks`, `action_omni_purchase`, `purchase_conversion_value`,
`onsite_conversion.lead_grouped`, `offsite_conversions_fb_pixel_lead`; with the account's daily totals
`currency`, `timezone_name`, `account_status`, `profile`. Reports add `reach`, `Frequency`, the
campaign / ad set / ad dimensions and statuses, budgets, schedule, objective, attribution setting and
creative id, and the breakdowns `publisher_platform`, `platform_position`, `impression_device`,
`Country`, `Age`, `Gender`.

- Purchases are Meta's omni purchases, the first purchase type bizinsights' direct reading takes. Never
  clicks or estimates: a campaign Supermetrics reports no purchases for has 0.
- Leads are on-Facebook (lead form) leads plus website (pixel) leads: Supermetrics has no field for
  Meta's total `lead`.
- Supermetrics reports with the account's attribution setting (by default 7-day click, 1-day view) on
  the day of the impression. bizinsights' direct reading asks Meta for each ad set's own setting
  (`use_unified_attribution_setting`), as Ads Manager shows it. Ad sets with another setting can differ.
- Campaigns are not counted by state in the report (Supermetrics returns only campaigns with activity
  in the range).
- What the account spent beyond its listed campaigns (deleted campaigns) is one "Other campaigns" row
  per day, from the account's daily totals, as in the direct reading.

**Google Ads (AW)**: `Date`, `CampaignID`, `Campaignname`, `Cost`, `Impressions`, `Clicks`,
`Conversions`, `ConversionValue`, `profile`, `Currencycode`, `Timezone`; purchases from a second query by
`ConversionCategory` (the PURCHASE category's conversions). Reports: `Campaignstatus`,
`AdvertisingChannelType`, `ConfiguredBudget`, `AdgroupID`, `Adgroupname`, `Adgroupstatus`, `Device`,
`CountryCode`.

- Conversions follow each conversion action's own counting and attribution model, as in Google Ads.
- Devices come in Supermetrics' words ("Mobile devices with full browsers"...) and are mapped to
  Google's (phones, computers, tablets, TV screens, other).

**AdSense (ADM)**: `date`, `domain_name`, `earnings_usd` (or `earnings`), `page_views`,
`individual_ad_impressions`, `ad_clicks`; reports add `country_code`, `country_name`,
`platform_type_code`, `platform_type_name`.

- **Currency.** Supermetrics names no currency for an AdSense account. Earnings are therefore read as
  `earnings_usd` (Supermetrics' conversion to US dollars) and labelled USD, unless the account was read
  from AdSense directly before (then bizinsights knows its currency, and its stored days are in it):
  then `earnings`, in that currency. The choice is made once, when the account is connected, so its
  history never mixes currencies. A non-USD account read only through Supermetrics shows earnings in
  converted US dollars, which will not match the AdSense report in local currency to the cent.
- **Impressions.** Stored as Supermetrics' "Ad impressions" (each ad shown). AdSense's own
  IMPRESSIONS, which the direct reading stores, counts ad requests that showed ads; Supermetrics doesn't
  offer it. The two are not the same figure.
- Earnings are AdSense's **estimated** earnings, finalized by AdSense after the month ends (the daily
  re-check reads the month before again in the first ten days). Finalized earnings, payments and ad
  unit splits are not read.
- AdSense revenue is never added into ad spend (separate table, separate dashboard section).

## Shopify sales next to the ads

Unchanged: the dashboard's Marketing view sets total ad spend against Shopify's own net sales (MER),
cost per order, and the orders Shopify's visit record credits to each platform, never the platforms'
claimed purchases (docs/kpis.md). Supermetrics-read accounts count exactly like direct ones; the
platforms' purchases stay labelled as their own claims.

## What the owner has to do

1. **A Supermetrics API licence** for bizinsights' team, covering the data sources **FA** (Facebook
   Ads), **AW** (Google Ads) and **ADM** (Google AdSense), with the Management API's **data source login
   links** (`ds_login_links_write`/`read`) and logins (`ds_logins_read`/`write`, `ds_accounts_read`). Ask
   Supermetrics to confirm, in writing, that login links may be sent to bizinsights' own customers (one
   login per merchant in bizinsights' team) under the licence, and what it allows in accounts, daily
   queries, rows and historical days. Optional: Supermetrics' branded connection flow, so its first screen
   names bizinsights (the platforms' consent screens still name Supermetrics).
2. In Supermetrics Hub → API keys, create a key for the team (a service account's, so it doesn't break
   when a person leaves), with the scopes above and `ds_queries_run`.
3. Store it, from a PowerShell on the PC with `aws login` done:
   ```
   node infra/cdk/scripts/put-secrets.mjs --set SUPERMETRICS_API_KEY
   ```
   (copy the key first; only `*` is shown). The functions read secrets at cold start: the next deploy, or
   a restart of api/jobs/cron, picks it up (docs/aws-deployment.md).
4. If the licence leaves out a platform, or limits history: set `SUPERMETRICS_SOURCES` (e.g.
   `meta,google`) and `SUPERMETRICS_HISTORY_DAYS` in `apps/aws/src/settings.ts` and ship it through
   `main`.
5. Then, with Claude: connect one real account of each platform, compare a week's figures with Ads
   Manager, Google Ads and AdSense for the same dates, time zone and currency, and record the result
   here.

Until step 3, nothing about Supermetrics shows anywhere in bizinsights.

## Testing

- `packages/core/test/adsSupermetrics.test.ts`: the client against answers shaped like Supermetrics'
  documented ones (header and body of every request, error codes, asynchronous queries, every platform's
  mapping, account ids, login health, the licence check).
- `apps/api/test/adsSupermetrics.test.ts`: the whole round trip on a database (link, callback, saved
  connection, sync through Supermetrics, sync records, reconnect, choice and cancel, revoke on the last
  disconnect, refused callbacks, another workspace kept out).
- Not done: anything against the live Supermetrics API (no licence yet), and the comparison with the
  platforms' own reports (step 5 above).
