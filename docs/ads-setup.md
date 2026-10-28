# Advertising integrations: Google Ads, Meta Ads and Google AdSense

What a merchant sees, what the owner sets up, and how the connections behave. The owner's checklist of what
is done and what is still open at Google, Meta and AWS is [integrations-readiness.md](integrations-readiness.md);
paste-ready review material is [ads-review-packs.md](ads-review-packs.md). A simulated Google Ads account for development,
demonstrations and tests, which needs none of what follows and never stands in for it: [ads-demo.md](ads-demo.md).
bizinsights signs in with each platform itself and keeps the tokens itself ("How connecting works"). From 2026-10-22
to 2026-10-28 the sign-ins went through Nango instead; the connections made then move off it by themselves, and the
owner's steps after that are in "Leaving Nango".

## How a merchant uses it

1. The dashboard's **Advertising** section offers **Connect advertising accounts** while nothing is connected.
2. That opens **Settings → Advertising** (`/settings/ads`, "Advertising integrations", drawn after the owner's
   design in `components/settings/ads/`): one card per platform, in the order Google Ads, Meta Ads, Google AdSense,
   with what bizinsights reads from it; while nothing is connected, what connecting brings and what it needs; once
   connected, each account's details and data status beside how the integration stands (rules in
   `components/integrations/adPlatformParts.tsx`). **Settings → Integrations** (`/settings/integrations`, the owner's
   2026-10-23 design: `components/integrations/IntegrationRow.tsx`, `AdRow.tsx`) shows a card each for Google Ads,
   Shopify, WhatsApp, Meta Ads and Google AdSense with a **Connect** button that goes straight to the platform's
   sign-in, and once connected each card links to Settings → Advertising
   (**Manage**, or **Fix it** when an account needs attention). WhatsApp's card is the exception: both open the
   WhatsApp Automation page (`/dashboard/whatsapp-automation`, Connect on its Setup tab; docs/whatsapp.md). Signing in with Google is on Settings → Security.
3. They press **Continue with Google Ads**, **Continue with Meta Ads** or **Continue with Google AdSense** (or
   **Connect** on Settings → Integrations): the browser leaves for the platform's own sign-in (Google's account
   chooser and consent screen, or Facebook Login for Business), they approve there, and the platform sends the
   browser back to bizinsights.io. Connecting needs the integrations permission (`integrations.manage`:
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
`adsense.readonly`, and Meta's `ads_read`. bizinsights never creates, changes or pauses an ad. Google sign-ins also
ask for `openid` (only which Google account it is, nothing about it; non-sensitive): without it Google's tokeninfo
may not say whose a token is, and a disconnect then can't take the Google grant back (it never revokes a grant
whose person it doesn't know). Connections made before 2026-10-23 learn it when they reconnect.

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
and **Refresh**, **Show on dashboard** and **Disconnect** (on Settings → Advertising: **Sync data now**, **Show on
dashboard**, **Disconnect**, and who connected it and the permission behind **View data details**).

The cards say nothing about the platforms' own reviews (removed on the owner's word, 2026-10-24): while
`GOOGLE_ADS_OAUTH_VERIFIED` isn't `"1"`, Google first shows "Google hasn't verified this app" (the way on is
**Advanced → Go to bizinsights.io (unsafe)**; AdSense never shows it), and while `META_ADS_ADVANCED_ACCESS` isn't
`"1"`, Facebook lets in only people with a role on the Meta app. The API still reports both as `restricted`.

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

### Checked against the platform

Once a day per account, the cron's reconcile sweep compares what is stored with what the platform reports
(`packages/core/src/adConnections/verify.ts`): the totals of a settled week (the 7 days ending 8 days before the
account's today, inside the days stored) against one account-level read of the same days, on the account's own
calendar and in its currency. **Meta**: spend, impressions, clicks, link clicks, purchases and purchase value (the last
three only when every stored day has them) from `ad_campaign_daily`, against one insights read of the account with
each ad set's own attribution, as the sync reads it; by the 8th day back the longest attribution an ad set can have (7
days after the click) has run out for every day of the week. **AdSense**: earnings, page views, impressions and clicks of every stored site (the store's choice of
sites is for the dashboard, not for this) against the totals of one report of the week. A figure matches within 1%
of the platform's, or within what rounding can make (half a cent per rounded figure; one for counts); the stored
rows' currency must be the account's. The result goes to the cron's log only: `ad figures match the platform`, or
one `ad figures differ from the platform` per figure with both sides, which the alarm `ad-figures-differ` counts
(RUNBOOK.md). Merchants are never told and nothing on the connection changes. Only accounts whose syncs work are
checked; a platform that asks to wait skips the account until the next day, and each cron tick starts checks for a
minute at most, three accounts at a time, each read given 30 seconds (accounts not reached wait for the next tick). **Google Ads isn't checked**: every read spends operations from the one daily
allowance all merchants share.

## Alerts

The 15-minute sweep raises one alert per connection in the bell feed (and email, by the notification settings) to
the people who manage integrations, and closes it when the connection works again, is hidden or disconnected:

- `ads_reconnect`: status `reconnect` or `permission`;
- `ads_unavailable`: status `unavailable`;
- `ads_failing`: status `error` for 6 syncs in a row or more than 24 hours (never for codes that are bizinsights' to
  fix: those go to the operator's logs);
- `ads_expiring`: a Meta sign-in that ends within 7 days.

For the operator, a connection turning to `reconnect` or `permission` also logs `ad connection needs the merchant`
once, when it turns (provider, code and ids, nothing it holds); ten in an hour across stores raise the alarm
`ad-connections-need-merchants` (RUNBOOK.md).

## Disconnecting, and when access is given back

- **Disconnect** deletes the token and every figure fetched for that account, then gives the access back to the
  platform **only when no other connection relies on the same person's grant** (another store, or AdSense next to
  Google Ads, since Google revokes a person's whole grant to the client at once). A connection whose person isn't
  known yet is looked up with its own token first. Google: `POST oauth2.googleapis.com/revoke`. Meta:
  `DELETE /me/permissions/ads_read` (only ads_read), or, when the person's token has ended, the same on their user id
  with the app token. The outcome (`revoked`, `still_used`, `unknown_person`,
  `failed`) is in the response and the audit log.
- **A connect that ends without connecting** (cancelled picker, the permission unticked, the platform refusing) drops
  the grant it just made under the same rules (`dropUnusedGrant`). A Meta login with no ad account yet stays
  connected instead (see "When a Facebook login has no ad account yet").
- **A member removed from a workspace**: their ad connections there are released (`releaseUserAdGrants`): the tokens
  are cleared, the accounts wait for someone else to press Reconnect (`connector_left`), the figures stay, and the
  grant is revoked when nothing else uses it. A sync running at that moment can't undo it.
- **Account deletion**: the same for every workspace, before the user is deleted.
- **Meta's own callbacks** (below): removing bizinsights in Facebook marks the person's Meta connections "reconnect"
  at once; a data deletion request deletes them and their figures.

## How connecting works

bizinsights' own OAuth with each platform, as the Shopify connect does it: the routes are
`apps/api/src/routes/ads.ts`, the state, consent addresses, code exchange and account listing are
`packages/core/src/adConnections/signIn.ts`. The grant is always to bizinsights' own Meta app (971575545351940) or
Google OAuth client ("Insights web"). From 2026-10-22 to 2026-10-28 Nango brokered the same sign-ins ("Leaving
Nango", below); before and since, bizinsights signs in itself.

```
Settings → Advertising / Integrations card: "Continue with Meta Ads" (or Google Ads, Google AdSense)
  POST /api/workspaces/:ws/stores/:storeId/ads/:provider/connect
    → only for "Manage integrations", a verified email, a store of this workspace, a platform set up here,
      10 sign-ins / 10 min / person; Google Ads not while bizinsights' daily operations are used up
    → the state under a random nonce in the coordinator (oauth:ads:<nonce>, 10 minutes): the person,
      workspace, store and platform, and for Google the PKCE verifier
    → httpOnly cookie ads_oauth_state: this browser's open sign-ins, newest first, at most 5
    ← {url}; the page sends the browser there (the same tab, no popup)
       Meta:   facebook.com/<META_API_VERSION>/dialog/oauth, config_id = META_CONFIG_ID (Facebook Login
               for Business; without it scope=ads_read&auth_type=rerequest)
       Google: accounts.google.com, scope adwords (Google Ads) or adsense.readonly (AdSense) plus openid,
               PKCE S256, access_type=offline, prompt=select_account consent (prompt=select_account when
               this person connected the platform before with a Google login whose refresh token
               bizinsights still uses)
  The person signs in at the platform, grants the one read-only permission (on Facebook: and ticks the ad
  accounts to share), and the platform sends the browser back:
  GET /api/ads/:provider/callback?code=…&state=…
    → the state is one of this browser's (cookie, constant-time compare), is used up in the coordinator,
      and is for this platform
    → the person signed in to bizinsights now is the one who started it, and may still connect to that store
    → the code is exchanged on the server: Meta's short-lived token is swapped for its long-lived one (about
      60 days); Google's access and refresh tokens, with the PKCE verifier
    → the permission was granted (Meta /me/permissions, Google's granted scopes), who signed in is looked up
      (Meta /me, Google tokeninfo), and the accounts are listed (Meta /me/adaccounts; the Google Ads
      customers, counted against the daily operations; the AdSense accounts)
    → one account, or a reconnect that sees nothing new: connected, its first 90 days queued
         → /dashboard?adsConnected=<provider>&accounts=<n>&store=<storeId>
      several, some new: held 15 minutes, encrypted, in the coordinator → /settings/ads?choose=<nonce>
      Meta, no ad account yet (or Meta too slow to list them): kept as a waiting login (ad_logins)
         → /settings/ads?waiting=<reason>&provider=meta
      anything else: the grant just made is given back (dropUnusedGrant) → /settings/ads?error=<code>
```

- **Google without a refresh token.** A person sent through without the consent screen gets no new refresh token
  from Google, and keeps using the one bizinsights already holds for that Google login (`reusableRefreshToken`). When
  bizinsights holds none for the login they chose, the callback starts a second sign-in with the consent screen and
  sends the browser there. Google sends one then; if it still doesn't, the code is `no_refresh_token`. Google keeps at
  most 100 live refresh tokens per Google account and client and ends the oldest past that, which is why consent isn't
  asked every time.
- **A database outage during the callback.** The person has just been through the platform's sign-in, so each
  database step waits out a failover (up to 20 seconds). Still no database: the sign-in is held in the coordinator,
  which doesn't need it, and the browser goes to `/settings/ads?choose=…`; the person finishes there once the database
  answers, and the check that they are who started it happens then.
- **The account choice** (`GET`, `POST` and `DELETE /api/workspaces/:ws/stores/:storeId/ads/pending/:nonce`) answers
  only the person, workspace and store it was made for. It can be used once; Cancel gives the grant back unless
  something relies on it. A choice left to expire isn't revoked: nothing runs when it does.
- **The waiting login** is described in "When a Facebook login has no ad account yet" (below, under Meta).

### What keeps it safe

- **State**: single-use (the callback takes it from the coordinator), 10 minutes, and bound to the browser by the
  httpOnly cookie `ads_oauth_state` (SameSite=Lax, Secure in production). A second press of the button, or a second
  tab, doesn't void the first: the cookie holds up to 5 open sign-ins, each still single-use.
- **The person**: the callback is accepted only for the person signed in to bizinsights who started the sign-in, and
  only while they may still manage integrations on that store and the store is still connected (`mayStillConnect`).
  Someone removed or demoted during the sign-in gets nothing attached.
- **PKCE (Google Ads and AdSense)**: the S256 challenge goes to Google; the verifier stays with the state on the
  server, so a code intercepted on its way back is useless. Meta's code exchange needs `META_APP_SECRET`.
- **Tokens never reach the browser.** The code is exchanged on the server; the tokens are sealed on the connection
  rows, on the waiting login, or with the 15-minute account choice. The API's answers carry no token and no
  ciphertext, and the logger redacts token fields.
- **Encryption**: AES-256-GCM with `TOKEN_ENCRYPTION_KEYS`, with the store and platform as associated data
  (`ads:<provider>:<storeId>:access` or `:refresh`), so a ciphertext can't be moved to another store's row. Waiting
  logins (`ad_logins.access_token_enc`) and the account choice are sealed the same way. Key rotation
  (`packages/core/src/keyRotation.ts`) re-seals what the database holds: `reencryptAdTokens` for connections and
  `reencryptAdLoginTokens` for waiting logins, each only over the ciphertext it read. A sign-in left on a removed key
  can't be read again: its accounts wait for a reconnect, and a waiting login is let go.
- **Grants given back**: a sign-in that ends without a connection revokes the grant it just made, unless the person
  isn't known, its refresh token was one they gave before, another account choice of theirs waits, or another
  connection relies on the grant (`dropUnusedGrant`, `packages/core/src/adConnections/connect.ts`).
- **Who signed in** is kept per connection (`external_user_id`: Google's account id, checked to be a token issued to
  bizinsights' own client; Meta's app-scoped user id), with the permissions granted (`granted_scopes`).
- **Meta `appsecret_proof`**: every Graph call made with a person's token carries it (HMAC of the token with
  `META_APP_SECRET`, `packages/core/src/metaGraph.ts`), so a leaked token is useless without the secret.
  **"Require App Secret"** is on in the Meta app (App settings → Advanced → Security, since 2026-10-19).
  WhatsApp's Cloud API option runs on the same app: bizinsights' own calls for it (Embedded Signup, registering the
  number) carry the proof, but its messages go to Meta through Evolution API, which this repository doesn't show
  sending one, so check Cloud API sends still work (docs/whatsapp.md).
- **Google tokens** last an hour. A fresh one is made from the stored refresh token with `GOOGLE_ADS_CLIENT_SECRET`
  when less than 5 minutes are left, and every account of the same sign-in moves to it
  (`packages/core/src/adConnections/credentials.ts`). A grant that no longer covers the reporting permission is
  `scope_missing` (Reconnect).
- **Meta tokens** last about 60 days and can't be renewed silently: Settings warns from 14 days before, the alert from
  7. When it ends the account shows Reconnect required; history is kept.

### What the callback's codes mean

The callback sends problems to `/settings/ads?error=<code>&provider=<provider>`, worded for the merchant in
`apps/web/src/components/settings/ads/callbackErrors.ts`. For the four "that login reaches nothing" codes the page
offers the platform's screen again.

| Code | What happened |
| --- | --- |
| `state_mismatch` | The browser came back without this sign-in in its cookie (another browser or tab, cookies cleared), or with another platform's. |
| `state_expired` | More than 10 minutes passed, or the sign-in was used already. Also every return to Nango's old address, `/api/ads/nango/oauth-callback`. |
| `denied` | The person pressed Cancel or "Not now" on the platform's screen. |
| `missing_params` | The platform sent back no code. |
| `session_mismatch` | The browser came back signed in to bizinsights as someone else, or not signed in. |
| `not_allowed` | During the sign-in the person lost "Manage integrations", or the store was disconnected or moved. |
| `permission_missing` | The read-only permission was unticked on the platform's screen. |
| `no_refresh_token` | Google sent no refresh token, even with its consent screen. |
| `no_accounts`, `manager_only`, `account_not_ready`, `none_shared` | The login reaches nothing that can be connected (logged as `ads: nothing to connect for this login`). For Meta this happens only when the database didn't answer: otherwise the login is kept waiting instead. |
| `not_approved` | Google Ads: the Cloud project isn't approved for real accounts yet. |
| `not_configured` | bizinsights' side: the platform's keys aren't set here, its API isn't switched on, or Meta refused bizinsights' `appsecret_proof` (logged as `ad platform connect failed on our set-up`; for Meta's `Invalid appsecret_proof`, store the App secret again with `put-secrets.mjs --set META_APP_SECRET`, which asks Meta first). |
| `rate_limited` | The platform asked bizinsights to wait, or Google Ads' daily operations are used up. |
| `temporarily_unavailable` | The platform didn't answer in time, or something failed on bizinsights' side (logged as `ads callback failed`). |
| `exchange_failed` | Any other refusal from the platform (logged as `ad platform connect failed`). |
| `unknown_provider` | The address names no platform bizinsights knows. |

A finished sign-in has no error: `/dashboard?adsConnected=…` (connected), `/settings/ads?choose=…` (pick the accounts)
or `/settings/ads?waiting=<reason>&provider=meta` (a Facebook login connected with no ad account yet; `reason` is
`no_ads_account`, `none_shared` or `unanswered`).

## Leaving Nango

From 2026-10-22 to 2026-10-28 every ad platform's sign-in went through Nango (https://app.nango.dev, bizinsights'
**prod** environment). Nango exchanged the code and kept and renewed the tokens; the grant was to bizinsights' own
Meta app and Google client all along, which Nango signed in with. A connection made then is an `ad_connections` row
with `source = 'nango'` whose `access_token_enc` holds a sealed reference to its Nango connection (`{connection id,
integration}`) instead of a token. A waiting login made then (2026-10-26 to 2026-10-28) names its Nango connection in
`ad_logins.source_login_id` and `nango_integration_key`, with an empty `access_token_enc`.

**What the move does.** `leaveNango` (`packages/core/src/adConnections/leaveNango.ts`) runs first in every */15 cron
tick, before the syncs are scheduled: one run at a time, at most 25 Nango connections a run. Each Nango connection
(every row and waiting login reading through it; one store and platform) is moved in one go:

1. its tokens are read from Nango (`GET /connections/{id}`, the refresh token too for Google), with
   `NANGO_SECRET_KEY`;
2. they are tried without Nango: Google renews the access token with bizinsights' own client, and Meta answers `/me`
   with the token, signed with bizinsights' app secret;
3. the rows are rewritten, only over what was read (a disconnect or a reconnect meanwhile wins): the tokens sealed as
   bizinsights' own sign-in seals them, `source = 'direct'`, no Nango connection id; a waiting login gets its token in
   `access_token_enc` and its Nango columns emptied;
4. the connection is deleted at Nango, with Nango's copy of the tokens (never the grant).

Each workspace's audit log gets `ads.moved_off_nango`, and the cron logs `a Nango ad connection now holds
bizinsights' own tokens` per connection.

**What it doesn't do.** The grant doesn't change: nothing is revoked, and no one sees a consent screen again. Ids,
settings (shown or hidden, AdSense sites), stored days and who granted the access are kept. Merchants have nothing to
do. A connection that can't be moved this time (Nango or the platform not answering) stays as it is and is tried
again an hour later; until then its accounts wait rather than sync (a sync asking for its token gets
`AdsMovingOffNangoError`, which is retried, never Reconnect). One that Nango no longer has, or whose grant the
platform refused, can never be read again: its accounts go to Reconnect required, as a sync would have said, and its
waiting login goes. Nango refusing bizinsights' key, or slowing it down, stops the run; the next tick goes on. While a
connection is being moved, the API shows it with `source: "nango"`. A browser coming back to Nango's old callback
address, `/api/ads/nango/oauth-callback`, lands on Settings → Advertising with `state_expired` (press the button
again); Nango's webhook route `/api/webhooks/nango` is gone.

**Rollback.** Nothing to undo: releases from before read `source = 'direct'` rows as they always did, and migration
`20261028100000_ad_logins_own_tokens` is additive (code from before still reads every row it wrote).

**Watching it.** Each tick that finds something to move logs `ad connections moved off Nango` with `moved` (rows and
waiting logins now holding bizinsights' own tokens), `failed` (connections that couldn't be moved this time),
`waiting` (connections still waiting from an earlier failure), `ended` (accounts put on Reconnect) and `left` (rows
and waiting logins still reading through Nango). CloudWatch Logs Insights on the cron function's log group,
`/aws/lambda/insights-production-cron` (ap-southeast-2):

```
fields @timestamp, moved, failed, waiting, ended, left
| filter msg = "ad connections moved off Nango"
| sort @timestamp desc
| limit 20
```

Wait for a line with `left: 0`. After it the line stops: a tick with nothing left to move logs nothing (no line at
all since the deploy means there was nothing to move). A line `rows still read through Nango, but NANGO_SECRET_KEY
isn't set: they can't be moved` means the key went too early.
`pnpm --filter @app/worker ops:ad-health` (docs/RUNBOOK.md) says the same from the database: "Still to move off Nango:
N" (0 when done) and whether the Nango key is still set.

### Owner's steps

(e) is for now. (a) to (d) wait for `left: 0`, in that order.

- [ ] **(a) Remove the move code** (a pull request; Claude, on your word). It takes out `leaveNango.ts`, what is left
  of the Nango client (`packages/core/src/ads/nango.ts`) and every Nango branch (`adConnections/config.ts`,
  `credentials.ts`, `connect.ts`, `logins.ts`, `health.ts`, `apps/api/src/routes/ads.ts`), the settings
  `NANGO_SECRET_KEY` and `NANGO_API_URL` (`packages/core/src/env.ts`, `put-secrets.mjs`, `apps/aws/src/secrets.ts`),
  and the old redirect `GET /api/ads/nango/oauth-callback`. The retired WhatsApp module's `deleteRetiredNangoToken`
  (`packages/core/src/whatsapp/purge.ts`) reads the same key: no store connected through that design
  (docs/whatsapp.md), so it can go in the same pull request. The columns that name Nango connections are dropped
  later, by a migration of their own (migration `20261028100000_ad_logins_own_tokens` says so for `ad_logins`). Merge
  it and confirm its Deploy to AWS run.
- [ ] **(b) Delete the secrets** `NANGO_SECRET_KEY` and `NANGO_WEBHOOK_SECRET` from Secrets Manager
  `insights/production/app` (ap-southeast-2). `put-secrets.mjs` can't do it: it only sets or replaces keys and keeps
  every key it isn't given. In the AWS console: Secrets Manager → `insights/production/app` → **Retrieve secret
  value** → **Edit** → remove the two rows → **Save**. Then `node infra/cdk/scripts/put-secrets.mjs --dry-run` lists
  the keys without them. Nothing has read `NANGO_WEBHOOK_SECRET` since bizinsights left Nango: its webhook route is
  gone.
- [ ] **(c) Nango** (https://app.nango.dev, environment **prod**):
  1. **Connections**: none is left for `bizinsights-meta-ads`, `bizinsights-google-ads` or
     `bizinsights-google-adsense` (the move deletes each one it moves; the cron logs `a moved Nango connection wasn't
     deleted at Nango; delete it in Nango's dashboard` for one it couldn't). Only the retired `whatsapp-business`
     integration may remain; it belongs to WhatsApp's 2026-10-25 design (docs/whatsapp.md, "The old tables").
  2. **Environment Settings**: remove the Callback URL (`https://bizinsights.io/api/ads/nango/oauth-callback`) and the
     Webhook URL (`https://bizinsights.io/api/webhooks/nango`) with its webhooks.
  3. **Integrations**: delete `bizinsights-meta-ads`, `bizinsights-google-ads` and `bizinsights-google-adsense`. They
     hold copies of bizinsights' Meta app secret and Google client secret.
  4. **The account** (Aby Thomas, tangoenery2004@gmail.com): delete it once nothing else uses it.
- [ ] **(d) The old redirect URI**, only after (a) is live, so that the release a failed deploy rolls back to never
  signs in through Nango: remove `https://bizinsights.io/api/ads/nango/oauth-callback` from Meta app 971575545351940 →
  Facebook Login for Business → Settings → **Valid OAuth Redirect URIs** (then **Save Changes** at the bottom of the
  page, and reload to check), and from Google Cloud insights-511119 → Google Auth Platform → Clients → "Insights web" →
  **Authorized redirect URIs** (Save). Keep `https://bizinsights.io/api/ads/meta/callback`,
  `https://bizinsights.io/api/ads/google/callback` and `https://bizinsights.io/api/ads/adsense/callback`.
- [x] **(e) Meta's redirect URI: confirmed working 2026-10-28.** `https://bizinsights.io/api/ads/meta/callback` was in
  Valid OAuth Redirect URIs next to the Nango callback on 2026-10-22
  ([integrations-readiness.md](integrations-readiness.md)), and Continue with Meta Ads needs it again. On 2026-10-28
  (release 128) a Meta connect came back to it and connected, at 17:13Z and 18:17Z (audit log `ads.connected`), so it
  is still there. Should it ever go missing (Facebook's dialog then says "Can't load URL"): Meta app 971575545351940 →
  Facebook Login for Business → Settings, type it, click the suggestion that appears under the field, press **Save
  Changes** at the bottom of the page and reload: the "Changes saved" toast alone doesn't keep it. The Redirect URI
  Validator at the top of that page checks it. (Google's "Insights web" already accepts
  `/api/ads/google/callback` and `/api/ads/adsense/callback`: on 2026-10-28 Google's consent screen loaded for both,
  while a made-up path got `redirect_uri_mismatch`.)

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
| `NANGO_SECRET_KEY` | Secrets Manager (stored 2026-10-22): read only by the move off Nango (and the retired WhatsApp module's erase); deleted after `left: 0` ("Leaving Nango", step (b)). `NANGO_API_URL` defaults to `https://api.nango.dev` | **yes** |

Settings ship by merging to `main` (Deploy to AWS). Secrets go to Secrets Manager with `put-secrets.mjs`, which reads
the clipboard and refuses a value of the wrong shape: a Meta app secret must be 32 hexadecimal characters, a Google
client secret must start with `GOCSPX-`, and a value equal to a public id in `settings.ts` is refused. It never
prints a value. Until a platform's id and secret are both set, its card says **Coming soon** without a button.

**Is every secret there?** `node infra/cdk/scripts/put-secrets.mjs --dry-run` lists the key names. Every deploy also
asks the cron function and puts a warning on the Deploy run for each provider whose public id is set but whose
secret is missing ("Meta Ads isn't set up", with the command to run). Details: [aws-deployment.md](aws-deployment.md),
"Which provider secrets are there".

**Which connections are in trouble?** `pnpm --filter @app/worker ops:ad-health` (docs/RUNBOOK.md, "Maintenance tasks") lists, for the whole server, the connections per platform, source and status, the ones that stopped syncing or keep failing, the last day's syncs, how many still wait to be moved off Nango, and whether the Nango key is still set, with ids and counts only.

### Addresses to register at the platforms

The app builds every address from `APP_URL` (`https://bizinsights.io`), so they must be registered **exactly**:

| Where | Address |
| --- | --- |
| Google client "Insights web" → Authorized redirect URIs | `https://bizinsights.io/api/ads/google/callback` and `https://bizinsights.io/api/ads/adsense/callback` (both accepted: on 2026-10-28 Google's consent screen loaded for them, while a made-up path got `redirect_uri_mismatch`) |
| Meta app → Facebook Login for Business → Settings → Valid OAuth Redirect URIs | `https://bizinsights.io/api/ads/meta/callback` (listed on 2026-10-22; a Meta connect came back to it on 2026-10-28: "Leaving Nango", step (e)) |
| Meta app → Facebook Login for Business → Settings → Deauthorize callback URL | `https://bizinsights.io/api/webhooks/meta/deauthorize` |
| Meta app → App settings → Basic → User data deletion → Data deletion callback URL | `https://bizinsights.io/api/webhooks/meta/data-deletion` |

The old `d2mr8m2p1qkh58.cloudfront.net` and Cloudflare Worker (workers.dev) callbacks are never sent; remove them
(Google's branding verification accepts only verified domains). Nango's old callback,
`https://bizinsights.io/api/ads/nango/oauth-callback`, is still registered at both; it goes once the move off Nango is
done ("Leaving Nango", step (d)).

In the Meta app dashboard, the Valid OAuth Redirect URIs and App domains fields are token lists: type the value, then
**click the suggestion that appears under the field**, then Save Changes. Pressing Enter shows a chip and a "Changes
saved" toast, but a reload shows the list unchanged (seen three times on 2026-10-19). Check with the Redirect URI
Validator at the top of the Facebook Login for Business settings page.

**Local development.** Don't add localhost to "Insights web": Google wants a separate project per deployment tier.
Create an OAuth client in a separate Cloud project and register `<APP_URL>/api/ads/<provider>/callback` for the
local server you run: `http://localhost:8787` for the usual local server (`apps/aws/.env.example`), and
`http://localhost:8789` for the ads demo (`.claude/ads-demo-server.mjs`). Put its id and secret in `apps/aws/.env`.
A new project's Google Ads API access starts at Test (test accounts only). The Google Ads demo needs none of this.

## 1. Meta (Facebook and Instagram ads)

**The app:** "Insights", App ID `971575545351940`, owned by the Facebook account sebanceo@gmail.com, Development mode,
use case "Measure ad performance data with Marketing API" (`ads_read` ready for testing = Standard Access). Facebook
Login for Business configuration "Insights ads reporting" `1521935306664882` (user access token, ad accounts, ads_read
only) = `META_CONFIG_ID`. No business portfolio yet. WhatsApp Automation's Cloud API option runs on this app too since 2026-10-25
(`WHATSAPP_APP_ID` empty; its own Embedded Signup configuration is `WHATSAPP_CONFIG_ID`, docs/whatsapp.md); it used
the separate app "pixmagic" (1799660384680551) before. Linking a phone with a QR code uses no Meta app.

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

### When a Facebook login has no ad account yet

Since 2026-10-26 such a sign-in is **connected, never refused** (`packages/core/src/adConnections/logins.ts`, table
`ad_logins`, one per store and platform). The person authorized bizinsights, so the card says **Connected**, "Signed in
as …", and what happens next; the callback sends the browser to `/settings/ads?waiting=<reason>&provider=meta`
instead of an error:
- `no_ads_account`: the login reaches no ad account (none of its own, or a business-portfolio account it isn't
  assigned to in Business settings → Ad accounts);
- `none_shared`: none was ticked on Facebook's screen (**Choose ad accounts** opens it again);
- `unanswered`: Meta didn't list the accounts in time (asked again after 10 minutes);
- `choose`: it now lists more than 10 (`AD_LOGIN_AUTO_CONNECT_MAX`): the person picks them with **Choose ad accounts**.

The cron tick asks Meta again every hour (`checkAdLogins`), and **Check for ad accounts** on the card asks at once
(`POST …/ads/logins/:id/check`). As soon as Meta lists ad accounts they are connected with the login's own token,
their catch-up is queued, and the `ad_logins` row goes. The login holds the person's token to bizinsights' app,
sealed like a connection's (`access_token_enc`, re-sealed on key rotation by `reencryptAdLoginTokens`), and the
person's grant: Disconnect (`DELETE …/ads/logins/:id`), the token ending (about 60 days), the person removing
bizinsights on Facebook or asking for their data to be deleted, the store going, and its connector leaving all let it
go, giving the grant back unless something else relies on it. A login made through Nango (2026-10-26 to 2026-10-28)
gets its token when it is moved off Nango ("Leaving Nango").

No code change can make Meta list an ad account the profile has no access to: the card only waits for it.

**Which case it is, from the log.** The API's line `ads: nothing to connect for this login` (Logs Insights on
`/aws/lambda/insights-production-api`) carries `diagnosis`. It holds ids, counts and permission names, never the
profile's name or a token:
- `metaUserId`: the profile's app-scoped id (the `externalUserId` a connection made with it would store).
- `token`: what Meta's token inspector says. `type` should be `USER`, `ownApp` and `valid` true. `scopes` are the
  permissions granted. `granted` names, per permission, how many assets it is limited to, or `all` when it names
  none (it covers what the profile reaches).
- `appRole`: the profile's role on Meta app 971575545351940 (`administrators`, `developers`, `testers`), `none`
  when the app's roles don't list it (`appRolesListed` says how many they do). While `ads_read` has Standard Access,
  only a profile with a role can connect.
- `me`, `token` or `appRole` as `{ failed, message }`: that look-up was refused (Meta's code, or `auth` when the
  inspector refused bizinsights' app token: store the App secret again with `put-secrets.mjs --set META_APP_SECRET`,
  which asks Meta first and refuses a secret that isn't the app's).

What to do, by what it says:
- `appRole: "none"`: the person used a profile without a role on the app. Connect with the admin's profile, or add
  this one under App roles → Testers.
- A role, `granted.ads_read: "all"`, and Meta still lists no ad account: Meta itself says this profile reaches none.
  Open <https://adsmanager.facebook.com> in the same browser. If it shows no ad account, create one or have the
  business portfolio assign this profile to its ad account (Business settings → Accounts → Ad accounts → Assign
  people; admins have to assign themselves too). Then connect again.
- `granted.ads_read: 0`: the profile has access, but none was ticked on Facebook's screen (`none_shared`).

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
is no access level to request. A Google login with no AdSense account gets "That Google login has no AdSense account"
(`no_accounts`), whether AdSense answers its 403 or an empty list; one whose AdSense accounts are all closed gets
`account_not_ready` ("…AdSense account is closed"). Each case logs "ads: nothing to connect for this login"; the
answers with a list add `diagnosis: {listed, closed}`.

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
`20261017160000_visits_ads_history_from`, `20261019120000_ad_connection_health` (status, error code, account
health, sites, coverage), `20261020150000_ad_connection_demo`, `20261022120000_ad_connection_source_sync_runs`
(`source`, `source_login_id`, `last_sync_attempt_at`, `ad_sync_runs`), `20261024120000_ad_campaigns`,
`20261026150000_ad_logins` and `20261028100000_ad_logins_own_tokens` (a waiting login holds its own sealed token,
`access_token_enc` and `token_key_version`; its Nango columns are nullable until they are dropped). The Deploy to AWS
workflow applies them.
