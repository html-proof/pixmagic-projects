# The Advertising area

Every ad platform's figures for the store picked in the top bar, in one place: the sidebar's
**Advertising** (`/advertising`). It shows what the dashboard already worked out for its ads and
AdSense modules (`packages/core/src/reports/ads.ts`), arranged per platform; no figure is computed
in the browser. An account's days land in the same tables (`ad_connections`, `ad_campaign_daily`,
`adsense_daily`) whichever platform they come from, so they show here the same way.

| Page | Path | What it shows |
| --- | --- | --- |
| Overview | `/advertising` | Every spend platform together: ad spend, the platforms' own purchases, purchase value and ROAS, the store's Shopify net sales per unit of spend (MER) and AdSense's estimated earnings on a tile of their own; then Shopify's sales against the spend, the platform cards, the daily charts and the platforms side by side. |
| Meta Ads | `/advertising/meta` | The Meta accounts' details (the dashboard's former ads panel, for Meta alone) and Meta's live report. |
| Google Ads | `/advertising/google` | The same for Google Ads, and the way to **Account analytics** (`/advertising/google/analytics`, formerly `/ads/google`: one account, the demo's too, [ads-demo.md](ads-demo.md)). |
| AdSense | `/advertising/adsense` | AdSense's earnings by site from the stored days, each figure marked Estimated or Final; and AdSense's live report by country, device type or ad unit, with ad requests, coverage and Active View viewability (read when opened and cached briefly, never stored with the days). |
| Campaign comparison | `/advertising/campaigns` | Every Meta and Google Ads campaign of the dates side by side, from the stored days, with each one's change. Needs "View campaigns". |
| Reports | `/advertising/reports` | Each report's table as it downloads, and the CSV. |

The stored days behind these pages are kept current by the syncs: one sync per account at a time, and Meta's
paused for every account while Meta says bizinsights' app is over its hourly request limit
([ads-setup.md](ads-setup.md), "Syncing"). During that pause Meta's live report answers "Meta is busy right now.
Try again in a minute." without asking Meta, as it does when Meta throttles one account.

## The question

- **Dates**: the dashboard's own address-bar state (`?preset=&from=&to=`, `?compare=&cfrom=&cto=`), kept
  for the tab, so the dashboard and every Advertising page show the same dates. The presets are the
  dashboard's: Today, Yesterday, This week (`wtd`, Monday to today) and Last week (`lastweek`, Monday to
  Sunday), Last 7/30/90 days, This month, Last month, This year (`ytd`), Last year (`lastyear`, compared
  with the whole year before), Custom (`@app/shared/dates`). Weeks run Monday to Sunday everywhere.
- **By day, week or month**: the overview's charts ("Ad charts group") and the Meta and Google pages'
  trend ("Trend groups") add the days up per week or calendar month once the dates are long enough
  (`groupSeries` in @app/shared/ads): a week or month missing any day's figures is left blank, and a
  rate is worked out from the period's sums.
- **Platform and account**: `?platform=meta|google|adsense` and `?account=<ad connection id>`, picked on
  the page and kept in the address too.
- **Campaign and campaign status** (Campaign comparison): find a campaign by part of its name or its id,
  and keep only one status group: Active, Paused, Removed or archived, Other (in review, with issues...), or
  Status not read yet. The status is the platform's own word as of the account's last sync (Google's
  `campaign.status`, read with the daily figures; Meta's `effective_status`, read from the account's
  campaign list alongside its insights, best effort), kept per campaign in `ad_campaigns` and grouped by
  `campaignStatusGroup` (@app/shared/ads). A filter only picks rows: share of spend stays of all spend,
  and the totals above stay every campaign's. The status is also a column of the `ads_campaigns` report.
- The pages ask `GET /workspaces/:ws/stores/:storeId/overview?<dates>&parts=advertising[&platform=][&account=]`
  (apps/api/src/routes/dashboard.ts): the dashboard's answer with only the ad modules and the store's
  sales and traffic they are set against, every campaign (each with its `change`) rather than the top
  ten, and narrowed to the platform or account (`AdsView` in core). Team & Access applies as on the
  dashboard: the sidebar entry shows for whoever could open the dashboard's ads panel
  (`seesTopic(access, "ads", offers)`), the area's pages need "View advertising analytics" (and the
  campaign comparison "View campaigns", `PAGE_NEED` in apps/web/src/lib/access.ts), and the API leaves
  out what isn't granted.

## Printing

Every Advertising page has **Print or save as PDF** (for whoever may export reports, and owners and
admins, as on the Shopping Funnel): the browser's print dialog, with the menus left out and the store
and dates written under the title instead.

## Rules the pages keep

- A figure exists only for days every account behind it has stored; otherwise it is Unavailable, with
  why, never 0 (the ad modules' rule). A change is shown only where the API compared (`compared`, on
  whole days, never against days an account hasn't stored, `canCompareFrom`); otherwise the reason.
- Purchases, purchase value and ROAS are each platform's own claim and are labelled so; they are never
  added to, or shown as, Shopify sales. Google's other conversions stay apart from purchases.
- The store's sales are set against the whole spend only (MER, share of sales, cost per Shopify order):
  with one platform or one account picked, `sales`, `shareOfSales` (and for one account, `sourced`)
  are left out.
- AdSense's earnings are money in: their own tile, card and report, never added to spend.
- AdSense's earnings say **Estimated** until AdSense has finalized every day of them, then **Final**
  (`final` and `finalThrough` of the AdSense module, from each account's last sync that worked;
  [ads-setup.md](ads-setup.md), "Estimated or final"). Payments aren't read.
- A refresh someone asked for (Sync data now, Sync all now, turning an account back on) shows as
  **Synchronizing** with the time of the last sync that worked, when one ever did (`syncRequestedAt` and
  `lastSyncedAt` of each account, `syncRunning` in `apps/web/src/lib/adConnections.ts`, the same rule as Settings →
  Advertising; a working account's first sync stays "Fetching"), and the page asks again every 5 seconds until it
  lands. An account whose syncs fail says when it was last tried (`lastSyncAttemptAt`), and people who may manage
  integrations get a link to Settings → Advertising to try again, unless a retry is already on its way.
- Clicks, reach and store visits are different counts: the overview says so under its figures, and
  none is added to another (docs/kpis.md, "Ads").

## Reports and downloads

Report sections in core's `EXPORT_SECTIONS` (packages/core/src/reports/export.ts): `ads_summary`,
`ads_platforms`, `ads_daily`, `ads_campaigns`, `adsense_daily` (and the dashboard's older `ads`).
`GET …/export/table?section=…` answers a section's rows as JSON for the Reports page, for a member who
may see that section, not audited; `GET …/export?section=…` downloads the same rows as CSV, needs
"Export approved reports" as well and is in the audit log with the platform and account asked.

## Old addresses

`/dashboard?view=ads` and `?view=adsense` open `/advertising` and `/advertising/adsense` with the dates
on screen (the dashboard page's redirect), and `/ads/google` opens `/advertising/google/analytics`.
