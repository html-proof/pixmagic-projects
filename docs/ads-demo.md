# The Google Ads demo

A simulated Google Ads account that can be connected to a store without a Google account, a Google
Ads account, Google's API, Google's approval or any advertising spend, so the connection flow, the
dashboard, the Google Ads analytics page and the live report can be tried, shown and tested. It is
bizinsights' own simulation: **nothing in it is a Google authorization, a Google verification or a
billing confirmation**, and every screen, row and answer about it says so ("Demo", "Simulated — Not
verified by Google"). The real sign-in ("Continue with Google Ads", [ads-setup.md](ads-setup.md)) is
a separate mode that never falls back to the demo.

## What a merchant sees

1. Settings → **Advertising**: the Google Ads card offers **Try demo** next to (or, while the real
   sign-in isn't set up on this server, instead of) **Continue with Google Ads**. On Settings →
   **Integrations**, the Google Ads card offers it under its **Connect** button (or as its only button
   while the Google Ads sign-in isn't set up). Members with "Manage integrations" see it.
2. **Try demo** opens bizinsights' own five-screen flow: an explanation (no Google account or data is
   used), the demo account (`DEMO-ADS-001`, "Demo Business Marketing", the store's currency and time
   zone), the demo's fictional data permissions (not Google OAuth scopes), "Connecting…" while the
   real request runs, then "Demo Account Connected" with the badge **Simulated — Not verified by
   Google** and **Open Demo Dashboard** / **Disconnect Demo**. No Google page opens, nothing asks for
   a password.
3. The demo appears in the integrations list like any account, with the orange **Demo connected**
   badge (never plain "Connected"), its facts (account type, data source, billing "Not applicable",
   verification "Not verified by Google", seed) and its actions: **Open demo dashboard**, **Sync demo
   data**, **Reset demo data**, **Disconnect demo**. "Continue with Google Ads" stays beside it for
   the real thing.
4. Its figures show wherever a Google Ads account's do, marked **DEMO DATA**: the dashboard's
   Advertising section and the Advertising area's pages ([advertising.md](advertising.md); its spend
   is **not** set against the store's own sales: `sales`, `shareOfSales` and `sourced` are left out of
   the ads module while a demo is among the accounts), the Google Ads live report, and the **Google
   Ads Analytics** page (`/advertising/google/analytics`; the old `/ads/google` opens it).
5. **Disconnect** deletes the demo and its figures; nothing is handed back (there was no grant) and
   no other connection is touched.

## How it works

- **Columns** (`ad_connections.is_demo`, `demo_seed`; migration `20261020150000_ad_connection_demo`):
  a demo is a row like a real account's, with no token (`access_token_enc` empty, key version 0) and
  no `external_user_id` or scopes. One per store (the account id is fixed).
- **Generator** (`packages/shared/src/adsDemo.ts`, pure): seven campaigns (Brand Awareness,
  Search Advertising, Shopping Campaign, Product Remarketing, Lead Generation, Website Traffic
  [paused], Conversion Optimization), each with a type, status, start, daily budget and behaviour.
  `demoCampaignDay(ctx, campaign, day)` gives one day deterministically from the seed, the campaign
  and the day (a hash of the three seeds a small PRNG), so a window of any size agrees with any other
  and "today" can be added later. Figures are consistent: clicks ≤ impressions, conversions ≤
  clicks, purchases + leads = conversions, spend ≤ 1.6 × the daily budget; money is sized in US
  dollars and scaled to the account's currency, rounded to its minor unit. The campaigns' starts and
  the 90-day trends are relative to the demo's **epoch**, the day it was connected (in its own time
  zone), so figures never shift as days pass. Also here: the splits by device, country (home country
  by currency, Google's geo target ids), age group and audience segment, each scaled to add up to the
  totals exactly; the live report by campaign, ad group (two per campaign, none for Performance Max),
  device and country, and down from a campaign: its two ad groups, a Performance Max campaign's two
  asset groups, an ad group's two or three ads (unnamed, as most Google ad types are, so named by
  their type and a stable id from the seed), each level split from the one above so it adds up to it
  to the cent; and the simulated store next to the demo (modeled attribution).
- **Source adapter** (`packages/core/src/ads/googleAdsSource.ts`): `GoogleAdsSource` answers
  `campaignDays`, `accountHealth` and `report`; `GoogleAdsDemoProvider` from the generator,
  `GoogleAdsProductionProvider` from Google's API with the OAuth client and the person's token.
  `googleAdsSource(conn, …)` picks by `is_demo`. The sync (`adConnections/sync.ts`), the health check
  and the live report (`adConnections/reports.ts`) go through it, so a demo is synced by the same
  queue job as a real account (90 days on connect, hourly refreshes, the daily re-check, the history
  walk), without a token, without Google's daily operations and without a network call.
- **Analytics** (`packages/shared/src/adsAnalytics.ts`, `packages/core/src/reports/googleAdsAnalytics.ts`):
  from the stored campaign-days, the same for a demo and a real account: overview metrics (CTR =
  clicks ÷ impressions, CPC = spend ÷ clicks, conversion rate = conversions ÷ clicks, cost per
  conversion = spend ÷ conversions, ROAS = conversion value ÷ spend; a zero denominator gives null,
  shown as "—"), series by day, week and month, the campaign table (search, filters, sorting, pages),
  conversion analytics, rule-based recommendations (`RECOMMENDATION_RULES`), and for a demo its
  splits and simulated store. A real account's device and country splits come from Google's live
  report.
- **Statuses**: `not_connected`, `connecting_demo`, `connected_demo`, `demo_syncing`, `demo_error`,
  `connecting_production`, `connected_production`, `production_error`, `disconnected`
  (`GOOGLE_ADS_CONNECTION_STATUSES`). The API works a connection's out from its row alone
  (`googleAdsConnectionStatus`); "connecting_*" are the browser's own moments. Nothing a browser
  sends can turn a demo row into a production one.

## Setting

| Setting | Where | Meaning |
| --- | --- | --- |
| `GOOGLE_ADS_DEMO_ENABLED` | `apps/aws/src/settings.ts` (`"1"` in production), `apps/aws/.env.example`, `apps/web/e2e/server.env` | Offers **Try demo** and the demo endpoints. Empty: the button isn't shown and `POST …/demo/connect` answers 503 `demo_disabled`; demos already connected keep working. |

The real sign-in's settings (`GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_ENABLED`,
`GOOGLE_ADS_OAUTH_VERIFIED`) are untouched by the demo: it needs none of them, and the status endpoint
names the ones still missing (names only) so the card can say why "Continue with Google Ads" isn't
there yet. The pasted brief's `GOOGLE_ADS_PRODUCTION_ENABLED` is `GOOGLE_ADS_ENABLED` here, and its
`GOOGLE_ADS_DATA_SOURCE` isn't needed: each connection carries its own source (`is_demo`), so a store
can hold a demo and a real account side by side, each marked.

## API

All under `/api/workspaces/:ws/stores/:storeId/ads/google`, cookie-authenticated, tenant-checked
(`requireWorkspace` + RLS), rate limited (`adsDemo`, `adsSync`, `adsReport`), audited
(`ads.demo_connected`, `ads.demo_synced`, `ads.demo_reset`, `ads.demo_disconnected`). Reads need
"View ad accounts" (`marketing.ads`), campaign-level figures "View campaigns" (`marketing.campaigns`),
changes "Manage integrations" (`integrations.manage`).

| Endpoint | What |
| --- | --- |
| `GET /status` | Both modes: `demo` (enabled, status, connection, account facts, badge, disclaimer) and `production` (configured, restricted, `missing` setting names, status, connections). |
| `POST /demo/connect` (`{ seed? }`) | Connects the demo and queues its first 90 days. Answers the brief's shape (`success`, `provider: "google_ads"`, `connection_type: "demo"`, `connection_status`, `account.is_demo: true`, `verification_status: "simulated"`, `message`, `disclaimer`) plus `connection`, `demo` and `sync`. Connecting again brings an existing demo back. |
| `POST /demo/disconnect` | Deletes the demo and its figures (`retention: "delete"`). `DELETE …/ads/connections/:id` does the same for a demo row. |
| `GET /demo/account` | The demo's facts, state, seed and fictional permissions. |
| `POST /demo/sync` | Sync demo data: a catch-up job like a real account's (one at a time; `queued` false while one is on its way). |
| `POST /demo/reset` (`{ seed? }`) | A new seed (or the one given), figures deleted and generated again. |
| `GET /analytics` | Everything the analytics page shows, for `?connection=` (the demo by default) and the dashboard's date query (`preset`, `from`, `to`, `compare`, `cfrom`, `cto`). |
| `GET /analytics/overview`, `/campaigns` (`q`, `status`, `type`, `sort`, `dir`, `page`, `pageSize`), `/performance`, `/conversions`, `/devices`, `/audience`, `/recommendations`, `/combined` | Slices of the same. Also under `/demo/…` (the brief's names). |

The existing `GET …/ads/google/report` (campaign, ad group, device, country, and down from a
campaign with `campaign=` / `adGroup=`, the demo's own ids such as `demo-c2` and `demo-c2-core`)
answers for the demo too, generated instead of fetched: a Google-shaped id is refused there (400).

A connect answer:

```json
{
  "success": true,
  "provider": "google_ads",
  "connection_type": "demo",
  "connection_status": "demo_syncing",
  "account": { "id": "DEMO-ADS-001", "name": "Demo Business Marketing", "currency": "AUD", "is_demo": true },
  "verification_status": "simulated",
  "message": "Demo account connected successfully",
  "disclaimer": "No Google authorization or verification occurred.",
  "connection": { "...": "the row as the integrations pages list it: demo true, connectionType demo, verificationStatus simulated" },
  "demo": { "accountId": "DEMO-ADS-001", "seed": 1234567, "permissions": ["Read demo advertising campaigns", "..."], "badge": "Simulated — Not verified by Google", "...": "..." },
  "sync": { "since": "2026-07-23", "until": "2026-10-20" }
}
```

## Running it

Local server ([local-dev.md](local-dev.md)): `pnpm --filter @app/aws dev --settings` with
`GOOGLE_ADS_DEMO_ENABLED=1` (the example env sets it). Sign in, connect a store (or insert one as
the e2e helpers do), open Settings → Integrations → **Try demo**. The local server runs the
queue in-process, so the demo's 90 days land within seconds; **Open demo dashboard** opens
`/advertising/google/analytics`.

Tests:

```bash
pnpm --filter @app/shared --filter @app/core test
```

(the generator and the analytics: `packages/shared/test/adsDemo.test.ts`, `adsAnalytics.test.ts`;
the source adapter: `packages/core/test/adsGoogleSource.test.ts`), and against a Postgres
(`TEST_PG_PORT`, [local-dev.md](local-dev.md)):

```bash
pnpm --filter @app/api exec vitest run test/adsDemo.test.ts
```

(the endpoints, persistence, the sync without a network call, the dashboard, tenancy, permissions,
reset and disconnect, concurrent syncs, the demo never becoming production), and end to end:

```bash
pnpm --filter @app/web exec playwright test e2e/adsDemo.spec.ts
```

(the five screens, the badge and disclaimers, the analytics page, the dashboard marks, sync, reset,
disconnect, and a view-only member).

## The real Google Ads connection

Unchanged by the demo, and the only way to real figures: "Continue with Google Ads" sends the browser
to Google's own consent screen and back (bizinsights' own sign-in: [ads-setup.md](ads-setup.md#how-connecting-works),
`routes/ads.ts`), bizinsights keeps the tokens encrypted, the person picks the accounts their login
reaches, and the sync reads them through the Google Ads API. What it still needs at Google is
in [integrations-readiness.md](integrations-readiness.md): Google's verification of the `adwords`
scope (until then `GOOGLE_ADS_OAUTH_VERIFIED` stays empty and the card warns about Google's
"unverified app" screen) and an API access level that admits real accounts (`GOOGLE_ADS_ENABLED`).
Setting these turns the real sign-in on; it never turns the demo off, and the demo never counts as
any step of it.
