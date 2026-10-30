# The Advertising area

Every ad platform's figures for the store picked in the top bar, in one place: the sidebar's
**Advertising** (`/advertising`). It shows what the dashboard already worked out for its ads and
AdSense modules (`packages/core/src/reports/ads.ts`), arranged per platform; no figure is computed
in the browser. An account's days land in the same tables (`ad_connections`, `ad_campaign_daily`,
`adsense_daily`) whichever platform they come from, so they show here the same way.

| Page | Path | What it shows |
| --- | --- | --- |
| Overview | `/advertising` | Every spend platform together: ad spend, the platforms' own purchases, purchase value and ROAS, the store's Shopify net sales per unit of spend (MER) and AdSense's estimated earnings on a tile of their own; then Shopify's sales against the spend, the platform cards, the daily charts and the platforms side by side. |
| Meta Ads | `/advertising/meta` | The Meta accounts' details (the dashboard's former ads panel, for Meta alone) and Meta's live report, which opens a campaign to its ad sets and an ad set to its ads ("Down from a campaign", below) and counts purchases by each ad set's own setting or one attribution window ("Meta attribution windows"). |
| Google Ads | `/advertising/google` | The same for Google Ads, each campaign with Google's delivery status and its budget ("Google campaign delivery and budgets") (a campaign opens to its ad groups, a Performance Max campaign to its asset groups, an ad group to its ads), with **Keywords** and **Search terms** tabs for the account and for an opened campaign or ad group ("Keywords and search terms", below), and the way to **Account analytics** (`/advertising/google/analytics`, formerly `/ads/google`: one account, the demo's too, [ads-demo.md](ads-demo.md)). |
| AdSense | `/advertising/adsense` | AdSense's earnings by site from the stored days, each figure marked Estimated or Final; and AdSense's live report by country, device type or ad unit, with ad requests, coverage and Active View viewability (read when opened and cached briefly, never stored with the days). |
| Campaign comparison | `/advertising/campaigns` | Every Meta and Google Ads campaign of the dates side by side, from the stored days, with each one's change; a campaign's name opens it in its platform's live report. Needs "View campaigns". |
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
  Status not read yet. A campaign's name links to its platform's page with `?account=<its connection>&campaign=<its id>`,
  which opens it in the live report (none for Meta's "Other campaigns" row, which is no campaign). The status is the platform's own word as of the account's last sync (Google's
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

## Down from a campaign

The Meta and Google Ads live reports (`MetaReport.tsx`, `GoogleReport.tsx`, with `ReportDrill.tsx`) open a campaign's
row to what is under it, and that to its ads:

| Platform | A campaign opens to | Which opens to | Totals on top |
| --- | --- | --- | --- |
| Meta Ads | its ad sets (`level=adset&campaign=`) | an ad set's ads (`level=ad&campaign=&adset=`) | **Whole campaign** / **Whole ad set**: Meta's own row for it (reach counts each person once). |
| Google Ads | its ad groups (`level=ad_group&campaign=`); a Performance Max campaign, which has none, its asset groups (`level=asset_group&campaign=`) | an ad group's ads (`level=ad&campaign=&adGroup=`) | **All ad groups / asset groups / ads in this campaign or ad group**: the rows added up, every one Google returned. Not Google's own row for the campaign, and said so. |

- The view is in the address bar beside the dates and the account: `?campaign=<id>` and `?adset=<id>` (Meta) or
  `?adgroup=<id>` (Google), so a link reproduces it (`REPORT_DRILL_PARAMS` in `useAdvertising.ts`). The ids are
  the platform's own (digits; the Google Ads demo's `demo-…`); names come from the row clicked, else from the rows
  under it, else "Campaign <id>". A breadcrumb ("All campaigns › campaign › ad set") goes back up; the level tabs
  hide while one is open (on Google Ads, the opened campaign's or ad group's own tabs show instead: its rows, its
  keywords, its search terms). Picking another ad account, or another store, starts from all campaigns again.
- A Google campaign opened from a link (Campaign comparison) is first looked up on the account's campaign list
  (usually cached) for its type, so a Performance Max campaign goes to its asset groups.
- The rows are each platform's live figures for exactly the dates on screen, in the ad account's currency and own time
  zone, read and cached as the rest of the report (10 minutes with today, an hour otherwise; a drill-down's key holds
  its parent). They can differ a little from Campaign comparison's stored days (Meta revises purchases for a few
  days; Google its conversions). Nothing below a campaign is stored.
- What each read costs: Meta, two insights reads (the parent's own row and its children, from the ad account's insights
  filtered to the campaign or ad set) and one list call for the statuses (the campaign's or ad set's own list, not the
  account's); the account's campaigns aren't counted down there. Google, one operation (no account totals query).
  The demo makes no call at all ([ads-demo.md](ads-demo.md)).
- Ads: Meta names every ad; most Google ad types have no name, so a Google ad reads as its type and id
  ("Responsive search ad 7001", `googleAdName`). Neither platform's ad text, images or links are read.

## Keywords and search terms (Google Ads)

The Google Ads report's **Keywords** and **Search terms** tabs: for the whole account, and, once a campaign or ad
group is opened, beside its own rows (a campaign: "Ad groups / Keywords / Search terms", a Performance Max one
"Asset groups / Search terms"; an ad group: "Ads / Keywords"). Keywords show only for Search campaigns (and a
campaign whose type isn't known), search terms for Search, Shopping and Performance Max ones.

- **Keywords**: each ad group's keywords with their match type (Exact, Phrase, Broad), status, Google's Quality Score
  (1 to 10, its rating now rather than for the dates; none when Google gives none) and the report's usual figures.
- **Search terms**: what people typed before an ad showed, by campaign, Performance Max's included.
- **Top row**: "Whole ad account", "Whole campaign" or "Whole ad group": Google's own figures for it, which the rows
  add up to less than. Spend with no keyword (Shopping, Performance Max, Display, YouTube) is in it and in no keyword
  row; Google lists only the search terms enough people searched (its privacy threshold), and Display, YouTube and
  other placements have none. The page says so under the table.
- **The 200 that spent most**, as Google lists them, with "Showing the 200 that spent most" when there are more. A
  comparison matches the same keyword or term: one that wasn't among the earlier dates' 200 shows "—".
- Conversions are Google's own count, on every conversion action, as on the report's other tabs: not Shopify orders.
- **Cost and limits**: read only when the tab is pressed, two Google Ads operations (four with a comparison), kept 6
  hours (30 minutes when the dates include today). Each ad account may read them from Google 25 times a day, and
  none are read once bizinsights has used 70% of the day's shared allowance, so the syncs keep the dashboard's figures
  current; either case is said in words on the tab ([ads-setup.md](ads-setup.md), "Keywords and search terms"). The
  demo's are generated ([ads-demo.md](ads-demo.md)) and never limited.

## Google campaign delivery and budgets

The Google Ads report's **Campaigns** tab says, under each campaign's name, whether Google can show its ads and why
not in full, and what its budget is. Both come with the campaigns' own query (`googleReportQuery`, level `campaign`):
no extra operation.

- **Status**: Google's `campaign.primary_status` (Google Ads API v25, `CampaignPrimaryStatusEnum`) in words:
  Eligible, Limited, Learning, Not eligible, Pending, Misconfigured, Ended, Paused, Removed
  (`googleCampaignStatus` in @app/shared/ads). Beside it, its reasons (`campaign.primary_status_reasons`) in words,
  the most telling first: "limited by budget" (`BUDGET_CONSTRAINED`), "bid strategy learning", "some ads
  disapproved"... Reasons that only say the status again (`CAMPAIGN_PAUSED`, `CAMPAIGN_REMOVED`, `CAMPAIGN_ENDED`)
  aren't repeated; one newer than the list reads as Google words it. Where Google gives no primary status (UNKNOWN),
  the campaign's own status shows as before (Active, Paused, Removed). Ad groups, ads and keywords keep their own
  status.
- **Budget**: "budget A$40.00 a day" for a daily budget (`campaign_budget.amount_micros`, period `DAILY`), "budget
  A$500.00 total" for a campaign total budget, which covers the campaign's own start and end dates
  (`total_amount_micros`, period `CUSTOM_PERIOD`; Google sets one amount or the other). Nothing when Google gives
  neither. A shared budget reads as its own amount, which several campaigns draw on.
- Both are Google's now, not for the dates picked, and the page says so. Neither is stored: Campaign comparison still
  shows the status the daily sync stores (`campaign.status`), and Account analytics' budgets and spend against budget
  are still the demo's only, since a real account's would need them stored first (a schema change, not made yet).
- The demo's campaigns carry the same fields ([ads-demo.md](ads-demo.md)).

## Meta attribution windows

The Meta Ads report's **Attribution** choice says how its purchases are counted: **Each ad set's own setting** (the
default, as Ads Manager shows them, for example 7-day click, 1-day view), **1-day click**, **7-day click** or **1-day
view**. It switches purchases, purchase value, purchase ROAS and cost per purchase in the figures at a glance, the
table (whose purchase headings name the window) and the "Purchases vs before" change, on every level and split.

- Meta is asked once for all of them: every live-report read sends `use_unified_attribution_setting=true` (each
  action's `value`: the ad set's own setting) and `action_attribution_windows=["1d_click","7d_click","1d_view"]`
  (`META_ATTRIBUTION_WINDOWS`), which Meta answers as keys of the same names on each action (AdsActionStats). No
  extra call. Those are the windows Meta's insights still report on; 7-day and 28-day view aren't offered.
- A window's figures are read from the same purchase action as the default (`omni_purchase` first, never added to
  the others), so every window counts the same thing. A window Meta gives no figure for, on a row or the totals,
  reads **Not reported**, never 0; so does its cost per purchase (count missing) or its ROAS (value missing). A
  device made of several platforms' rows has a window only when every platform's purchase action had it.
- Each is Meta's own count under that window, the same window for every ad set, labelled so ("Purchases (Meta's
  count, 1-day click)"): not Shopify orders, never added to the store's sales. A window's figures can be higher or
  lower than the default's, which mixes each ad set's own setting.
- Meta refusing a parameter of the read: asked again without the status filter, the sort and the windows, so the
  report still comes, with every window Not reported. The stored daily figures (Campaign comparison, the overview)
  stay each ad set's own setting: the windows are the live report's only (`windows` in `MetaLiveReportOptions`), and
  neither the syncs nor the daily "Checked against Meta" read asks for them.

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
