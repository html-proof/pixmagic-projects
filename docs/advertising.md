# The Advertising area

Every ad platform's figures for the store picked in the top bar, in one place: the sidebar's
**Advertising** (`/advertising`). It shows what the dashboard already worked out for its ads and
AdSense modules (`packages/core/src/reports/ads.ts`), arranged per platform; no figure is computed
in the browser. An account's days land in the same tables (`ad_connections`, `ad_campaign_daily`,
`adsense_daily`) whichever platform they come from, so they show here the same way.

| Page | Path | What it shows |
| --- | --- | --- |
| Overview (Advertising Performance) | `/advertising` | Every spend platform together, the owner's design ("Advertising Performance", below): ad spend, link clicks, impressions, the platforms' own purchases, purchase value and ROAS, then CPC, CTR, cost per purchase, the store's sales per unit of spend (MER), store visits from the ad sites and AdSense's earnings on tiles of their own; spend against purchase value by day, week or month with ROAS under it, the spend by platform, the funnel from an ad to a purchase, a card each for Meta Ads and Google Ads, key insights, the top campaigns, where buyers came from, profitability, and Meta against Google. |
| Meta Ads | `/advertising/meta` | The Meta accounts' details (the dashboard's former ads panel, for Meta alone) and Meta's live report, which opens a campaign to its ad sets and an ad set to its ads ("Down from a campaign", below) and counts purchases by each ad set's own setting or one attribution window ("Meta attribution windows"). |
| Google Ads | `/advertising/google` | The same for Google Ads, each campaign with Google's delivery status and its budget ("Google campaign delivery and budgets") (a campaign opens to its ad groups, a Performance Max campaign to its asset groups, an ad group to its ads), with **Keywords** and **Search terms** tabs for the account and for an opened campaign or ad group ("Keywords and search terms", below), and the way to **Account analytics** (`/advertising/google/analytics`, formerly `/ads/google`: one account, the demo's too, [ads-demo.md](ads-demo.md)). |
| Shopify attribution | `/advertising/attribution` | What the store's own orders record of Meta and Google, connected or not ("Shopify attribution", below): sales and orders from their sites, the tagged-ad part and its ad cost per order, new and returning customers, refunds, the store funnel from their visits, the store's sales against the spend with both ways of crediting a sale, and each platform by site, by campaign and by day. |
| Profitability | `/advertising/profitability` | Did the ads make money ("Profitability", below): the platforms' purchase value less the spend, with Shopify's margin what's left after the products and the break-even ROAS, each platform on its own; then the store's net profit from every cost bizinsights knows. |
| AdSense | `/advertising/adsense` | AdSense's earnings by site from the stored days, each figure marked Estimated or Final; and AdSense's live report by country, device type or ad unit, with ad requests, coverage and Active View viewability (read when opened and cached briefly, never stored with the days). |
| Campaign comparison | `/advertising/campaigns` | Every Meta and Google Ads campaign of the dates side by side, from the stored days, with each one's change; a campaign's name opens it in its platform's live report. Needs "View campaigns". |
| Reports | `/advertising/reports` | Each report's table as it downloads, and the CSV. |

The stored days behind these pages are kept current by the syncs: one sync per account at a time, and Meta's
paused for every account while Meta says bizinsights' app is over its hourly request limit
([ads-setup.md](ads-setup.md), "Syncing"). During that pause Meta's live report answers "Meta is busy right now.
Try again in a minute." without asking Meta, as it does when Meta throttles one account.

## Advertising Performance

The overview follows the owner's mock (2026-11-01): tinted KPI tiles with each figure's shape over the dates,
then cards. Every figure is one the API already sends (`parts=advertising`); deliberate differences from the
mock, so nothing on the page is made up:

- **No ad images.** Neither platform's creative is read ("Down from a campaign"), so a platform card shows its
  logo and accounts where the mock has an ad picture.
- **Funnel in two parts.** Impressions and link clicks are the platforms' own count; store visits, added to
  cart, started checkout and purchased are what the storefront pixel saw of visits from the platforms' sites
  (`journey` on each `ads_from_shopify` platform: the visits from Facebook and Instagram, Google and YouTube
  by their furthest step, counted as the Shopping Funnel counts them). A click isn't always a visit, and a
  visit from those sites isn't always from an ad, so no rate joins the two parts. Without the pixel or "View
  conversion rates" the store part says so.
- **ROAS on its own scale** under the spend and purchase value columns: never a second axis on one chart.
- **"Audience" is where buyers came from** (Facebook, Instagram, Google, YouTube by sales, from the orders)
  with the whole store's new and returning customers; age, gender, country, device and placement are read
  live on the Meta Ads and Google Ads pages, not on every visit to the overview.
- **Key insights** (`advertisingInsights` in `@app/shared/adInsights`): a few sentences from the figures on
  the page (spend outpacing purchases, the purchase value's change, the platform with the better ROAS, a
  platform crediting less than it cost, no purchases at all, the break-even ROAS at Shopify's margin, what a
  ROAS means); one whose figures aren't known is left out.
- **Meta Ads vs Google Ads** marks the platform that does better on each measure where one can (a higher
  click-through rate or ROAS, a lower cost per click, per 1,000 impressions or per purchase), by each
  platform's own count; spend, impressions, clicks and purchases are sizes, never marked.
- **Last synced** is the least recently synced account's last sync; **Refresh** reads the stored figures
  again (it doesn't ask the platforms: Settings → Advertising's Sync data now does).
- A platform card follows `ad_sources`: the platform's own figures, or its Shopify attribution (badged so,
  never a spend or ROAS), or the way to connect it. With no ad account at all the page is the Shopify orders'
  view of both platforms, as before.

## Shopify attribution

`/advertising/attribution`: the store's side, connected or not. Orders count for the site their last visit came
from (the last click), as the traffic module counts them; their sales are net sales.

- **What your store recorded**: sales and orders from Meta's and Google's sites and their average order; the
  part through links tagged as ads ("View conversion attribution") and the **ad cost per tagged-ad order**
  (all spend divided by those orders, only with every day of the spend in the store's currency, never the
  demo's); the whole store's net sales, average order, new and returning customers, **ad spend per new
  customer** (spend divided by every new customer, whatever brought them, said so) and refunds (net sales are
  already after returns).
- The funnel and where buyers came from, as on the overview; the store's sales against the spend with the
  platforms' and Shopify's credit side by side (`ads-vs-sales`, formerly on the overview); and each platform
  from the orders by site, campaign and day (`FromShopify`), which says the platform's own figures are on its
  page once it's connected.
- `parts=advertising` carries the store's `customers` and `refunds` modules for this, each under its own
  Team & Access permission as on the dashboard.

## Profitability

`/advertising/profitability` (and the overview's Profitability summary): a ROAS of 4x isn't a profit, so two
answers are kept apart.

- **From the platforms' purchases**: ad spend, attributed revenue (the platforms' purchase value), ROAS, and
  **advertising profit before product costs** (purchase value less spend). With Shopify's profit report (its
  margin on the sales it has a cost per item for, `marginOnCosted`, in the store's currency, never with the
  demo): **after product costs (estimate)** = purchase value x that margin less spend, and the **break-even
  ROAS** = 1 / margin. The page says it's an estimate: the products those purchases were for may cost more
  or less. Per platform on the full page, with the sales Shopify credits to its tagged ads beside it.
- **Your whole store**: revenue, product costs, ad spend, Shopify and payment fees (the owner's costs in the
  Shopify plan, Shopify apps and payment fees categories), other expenses (the rest of Settings → Costs) and
  **net profit**: the dashboard's Business profit overview's figure (`profitOf`, `netProfit`), or every
  reason it can't be given yet. `parts=advertising` carries `profit` and `expenses` for this, each under its
  own permission.

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
  campaign list alongside its insights, best effort), kept per campaign in `ad_campaigns` (with Google's type,
  primary status and budget, and Meta's budget: "Stored campaign facts", below) and grouped by
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
  keywords, its search terms). Picking another ad account, or another store, starts from all campaigns again:
  the drill belongs to the account it was opened on, so the first read of the other account is already of all of
  it, never the old campaign's rows asked of an account that hasn't it.
- Each step down or up (a row opened, a crumb pressed) moves keyboard focus to where it landed: the crumb now
  current, or back at the top the level tab picked (Meta's, once its answer shows them), as the table and the
  button pressed are swapped for a placeholder while the next level loads (`useDrillFocus`).
- A Google campaign opened from a link (Campaign comparison) is first looked up on the account's campaign list
  (usually cached) for its type, so a Performance Max campaign goes to its asset groups. One not on that list (no
  activity in the dates, or past the 200 that spent most) has a type that isn't known: it opens to its ad groups
  with **Asset groups** beside them, and once its asset groups come back it reads as Performance Max. With none of
  its ad groups listed, the page says Google reported none with any activity, never that the campaign didn't run:
  the top row is then those rows added up, not the campaign's own.
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
campaign whose type isn't known), search terms for Search, Shopping and Performance Max ones. Opened from a
campaign or ad group, what its own row has beyond its keywords is search traffic without one (dynamic search ads,
AI Max keyword-free matching), and the page says so; the whole account's says other campaign types (Shopping,
Performance Max, Display, YouTube), which have no keywords.

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
  hours (30 minutes when the dates end today or yesterday, which Google may still be finishing). Each ad account may read them from Google 25 times a day, and
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
- Both are Google's now, not for the dates picked, and the page says so. The live report reads them each time; the
  sync stores them too ("Stored campaign facts", below), for Campaign comparison and Account analytics.
- The demo's campaigns carry the same fields ([ads-demo.md](ads-demo.md)).

## Stored campaign facts

Each sync keeps, per campaign, what its platform says about it now beyond its status (`ad_campaigns`, migration
`20261030180000_ad_campaign_settings`; `AdCampaignFacts` in @app/shared/ads):

| Column | Google Ads | Meta Ads |
| --- | --- | --- |
| `status` | `campaign.status` (ENABLED, PAUSED, REMOVED) | `effective_status` (ACTIVE, CAMPAIGN_PAUSED, WITH_ISSUES...) |
| `channel_type` | `campaign.advertising_channel_type` (SEARCH, SHOPPING, PERFORMANCE_MAX...) | none |
| `primary_status`, `primary_status_reasons` | `campaign.primary_status` and its reasons | none |
| `budget_period`, `budget_amount` | `campaign_budget.period` DAILY with `amount_micros`, or CUSTOM_PERIOD with `total_amount_micros` | the campaign's own `daily_budget` (DAILY) or `lifetime_budget` (LIFETIME), from minor units in the account's currency; none when its budgets are its ad sets' |

- **No call of their own.** Google's are selected in the daily figures' own campaign query (`googleCampaignDays`), so
  the Explorer allowance is spent as before and the syncs' 80% stop is unchanged. If Google refuses one of their fields,
  the days are read with the plain query (one more operation, only then) and the facts stay as last read. Meta's
  come from the campaign list the sync already reads for the status (`metaListed`, `META_OBJECT_FIELDS`); a list Meta
  gives without its settings' fields leaves the budgets as last read. A fact not read stays as stored, and one never
  read is null: the pages show "—", never a guess.
- **As of the last sync, not for the dates.** A budget or status changed during the dates picked isn't followed; the
  pages say so.
- **During a deploy**, the new code runs for a minute or two before its migration: readers and the sync check the
  columns exist first (`campaignFactsReady` in `packages/core/src/adConnections/campaigns.ts`) and leave the facts out
  until they do.
- **Campaign comparison** shows Google's primary status in words with its reasons (Limited: limited by budget), else the
  platform's status; a **Type** column (Google's channel type) and a **Budget** column ("A$40.00 a day", "A$500.00
  total", "A$900.00 lifetime"). The status filter still groups the platform's status (`campaignStatusGroup`). The
  `ads_campaigns` report adds "Primary status (Google)", "Primary status reasons (Google)", "Campaign type (Google)",
  "Budget" and "Budget period" after "Status", in the platform's own words.
- **Account analytics** for a real account: each campaign with figures in the dates gets its type, status, primary
  status and budget from `ad_campaigns` (the demo's from its generator, as before), so the type and status filters,
  the recommendations (which skip paused and removed campaigns) and **Campaign budget comparison** work as they do for
  the demo. Spend against budget is the daily budget Google states now × the days the campaign ran in the dates; a
  campaign total budget is shown but not paced (it covers the campaign's own dates). `campaignSettings` in the answer
  says where they came from (`generated` or `synced`, with `asOf`, the latest the sync read).

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
  the others), so every window counts the same thing. Meta leaves out what it counted none of: a row with no
  purchase action, or a purchase action without a window's key, reads 0 under that window once the windows were
  asked for and answered, as the default reads 0 for a row with no purchase action (`windows` on
  `metaReportMetrics`, set from what the read actually sent). A figure Meta gave that can't be read reads **Not
  reported**, never 0; so does its cost per purchase (count) or its ROAS (value). A device made of several
  platforms' rows adds each window up; a platform's action without it adds nothing.
- Each is Meta's own count under that window, the same window for every ad set, labelled so ("Purchases (Meta's
  count, 1-day click)"): not Shopify orders, never added to the store's sales. A window's figures can be higher or
  lower than the default's, which mixes each ad set's own setting.
- Meta refusing a parameter of the read: asked again without the status filter, the sort and the windows, so the
  report still comes, with every window Not reported (and so does an answer cached before the windows were read). The stored daily figures (Campaign comparison, the overview)
  stay each ad set's own setting: the windows are the live report's only (`windows` in `MetaLiveReportOptions`), and
  neither the syncs nor the daily "Checked against Meta" read asks for them.

## Where each platform's figures come from

Meta Ads and Google Ads are decided apart, on every read of the overview (`adPlatformSources` in
`@app/shared/adsFromShopify`, its facts read by core `adSourceFacts`), and returned as the module
`ad_sources`: one `{ provider, source, state }` per platform.

| Source | When | What shows |
| --- | --- | --- |
| `platform` (badge "Meta Ads API" / "Google Ads API") | The platform has an account shown on the store that still syncs (or a retry may fix it, or it was closed: its spend is a real 0), or its stored days cover the dates even though its access has ended since. | Its own spend, impressions, clicks, CTR, CPC, CPM, conversions, conversion value and ROAS from the stored days, with the orders Shopify credits to its tagged ads beside them (`ads.sourced`, badged Shopify attribution). |
| `shopify` (badge "Shopify attribution") | No account shown (never connected, removed, every one hidden, or a sign-in still waiting for an ad account), or every account's access ended (`reconnect`, `permission`, `unavailable` and not closed) before the dates were read. | The store's own orders that came from its sites (below). Never spend, impressions, clicks or ROAS. |
| `none` | Neither: the store's traffic sources aren't read, or the member can't see them ("View traffic sources"). | The way to connect it, never a $0. |

`state` says why: `connected`, `access_lost`, `waiting`, `hidden` or `not_connected`. Nothing is stored or
switched: connecting a platform replaces its Shopify figures with its own on the next read, losing access
falls back to the orders, and reconnecting brings the platform's own back. The platform's own figures and the
Shopify-attributed sales are never added together. Team & Access: `ad_sources` goes with "View advertising analytics".

A platform whose source isn't `platform` also carries `marketing: true` when its app reports its spend to
Shopify for the dates (below): its spend, impressions and clicks then come from that report, badged
"Reported to Shopify", with the store's orders from its sites beside them. Never while its own API's
figures are shown, so no spend is counted twice.

## Shopify marketing: the spend the store's apps report to Shopify

The first place bizinsights looks for Meta's and Google's spend, with nothing to connect but Shopify. The
Facebook & Instagram app, the Google & YouTube app and other channel apps send Shopify their own figures
for the campaigns they run for the store (Shopify's `marketingEngagementCreate`); Shopify's ShopifyQL
dataset `marketing_engagements` gives them back by day, channel (`marketing_channel`: "Meta Ads",
"Google Ads", or the app's name), app (`marketing_app_name`) and campaign (`marketing_campaign`). It needs
`read_reports`, as Shopify's sessions and gross profit do (capability `shopify_marketing`, "Ad spend
reported to Shopify").

A connected Facebook or Google channel doesn't guarantee spend: only what the app reports is there. A
channel that reports clicks or sales but no spend has its spend "Data unavailable" (`no_spend`), and a
platform that reports nothing to Shopify is `unavailable`: no figure at all, never a 0. Orders and sales in
this report are the channel's own claim (its attribution), not the store's orders.

- **Reading:** packages/core/src/shopifyMarketing.ts, run by the worker (apps/worker/src/shopifyMarketing.ts)
  as the sync-queue job `shopify_marketing`. The 15-minute tick queues, on per-store leases: the last 3 days
  every 6 hours (`recent`; after a gap, on from the day before the last day read with none missing, 90 days
  at a time until it reaches today), the last 7 days once a day
  (`reconcile`, for Shopify's up-to-24-hour delay and channels revising their spend), and the history back to
  the store's first day 90 days at a time (`backfill`, one walk at a time; each window queues the next). A
  store read for the first time gets its last 90 days first, also asked for by the dashboard's first visit.
  Each read asks both levels (channel and campaign), paging by 1,000 rows (a window cut at 20 pages keeps
  only the days before the last one it reached), and replaces the stored rows of its days in one
  transaction holding the store's lock: a row's key is store, day, channel, app and campaign, so reading a
  day again never counts it twice, and two reads of the same days never keep both. Shopify refusing (no access, a report it won't run) is kept on the store's sync row
  (`last_error`, `consecutive_failures`) for the next schedule; a failed call is retried by the queue's
  backoff (Shopify's throttling is waited out in `shopifyGraphqlWithCost`).
- **Tables:** `shopify_marketing_days` (campaign `''` = the channel's whole day, what totals add up; the
  named campaigns only its breakdown) and `shopify_marketing_syncs` (`covered_from` to `synced_through`:
  the days read with none missing, widened only from where they end; `backfilled`; the last read's outcome). Both under row-level security; deleted with the store.
- **API:** the module `shopify_marketing` of `…/overview` (dashboard and `parts=advertising`):
  Meta and Google always (each `reported`, `no_spend` or `unavailable`, with totals, CTR, CPC, CPM, ROAS,
  cost per order, cost per new customer, day by day, the 10 campaigns that spent most and the last day
  reported), the other channels that reported spend, what every channel reported as spend together
  (`reportedSpend`: a platform whose own API is connected is in it, so it is never added to that API's
  spend), the sync state and the days of the dates read (`from`..`through`: every figure is of those days
  only, a day not read yet is unknown, never 0). Compared with the dates before only once the dates are over
  and those are read whole. Rates set against spend (CPC, CPM, ROAS, cost per order and per new customer)
  use only the rows that reported spend.
  Built by `@app/shared/shopifyMarketing`. Team & Access: "View advertising analytics"; its campaigns also
  "View campaigns".
- **Where:** the overview's "Ad spend reported to Shopify" card (total advertising expenses, each part named
  by where it comes from: a platform's own API or its report to Shopify; per platform; other channels;
  campaigns; Shopify's own sessions, visitors and conversion rate), the platform cards and the dashboard's
  Advertising performance tab of a platform whose figures come from it. Each figure says its source, dates,
  currency (the store's: Shopify reports every channel in it) and when it was last read.

## The Shopify orders stand in

A spend platform whose source is `shopify` isn't an empty page. Its figures come from the store's own
orders instead: the visit Shopify recorded before each order (docs/kpis.md, "Where sales come from")
came from Facebook or Instagram (Meta Ads) or from Google or YouTube (Google Ads). That needs only
`read_orders`, nothing to connect, and stays current with the store's own sync.

- **Where:** the overview (both platforms while nothing is connected; beside connected platforms, the
  others that sold anything), the Meta Ads and Google Ads pages (their platform; under the accounts'
  own state when their access ended), and the dashboard's Advertising performance card, a tab per
  platform, each with its source badge. Each says the platform isn't connected (or that its login waits
  for an ad account, or that its accounts are hidden, or that its access ended) with the way to connect it.
- **What:** per platform, its sales (net sales) and orders with the change on the dates compared with,
  its share of the store's sales, the part from links tagged as ads, day by day, by site (Facebook and
  Instagram; Google and YouTube) and by the campaign named in the links (utm_campaign); and, while the
  storefront pixel records where visits came from, the store visits from its sites (`visits`, counted from
  `visitsFrom`: the days before the pixel recorded sources are left out, never counted as none). Never
  spend, impressions or clicks, which only the platform knows, and never what the platform credits to its ads.
  A platform with no such orders in the dates says so, with no 0 figures.
- **API:** the module `ads_from_shopify` of `…/overview`: on the Advertising pages (`parts=advertising`,
  `AdsView.fromShopify`), and on the dashboard while a platform's source is `shopify`. Core
  `adsFromShopifyModule` in packages/core/src/reports/adsFromShopify.ts, the figures in
  `@app/shared/adsFromShopify`. Not for one account picked or for AdSense alone. Team & Access: "View
  traffic sources"; its tagged-ad figures and campaigns also "View conversion attribution", as the traffic
  module's; its visits also "View conversion rates", as the Shopping Funnel's.
- **AdSense** has no stand-in: what ads shown on a site earn isn't in the orders, so its page only offers
  to connect it, and says why.

## Printing

Every Advertising page has **Print or save as PDF** (for whoever may export reports, and owners and
admins, as on the Shopping Funnel): the browser's print dialog, with the menus left out and the store
and dates written under the title instead. Account analytics (`/advertising/google/analytics`) has the
same header (`AdvertisingHeader`), with the demo's DEMO DATA badge and disclaimer kept on it.

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

The area's own downloads (core's `reports/adsExport.ts`, sent by `sendCsv` in apps/api/src/routes/ads.ts):
each needs "Export approved reports" besides what its page needs (checked before the store, the query or
anything else is read), shares the dashboard downloads' allowance (`dashboardExports`, 30 in 10 minutes
per person), and is in the audit log as `report.exported`.

- **The Meta and Google Ads live reports** (**Download CSV** on `MetaReport.tsx` and `GoogleReport.tsx`):
  `format=csv` on `GET …/ads/meta/report` and `GET …/ads/google/report`, with the page's own query, at every
  level: campaigns, ad sets, ad groups, asset groups, ads, keywords, search terms and the splits, down from
  a campaign or ad group too. Built from the answer the page shows, read back from the report's cache: the
  platform is never asked for a download. An answer no longer kept (10 minutes to 6 hours, as above)
  answers `409 report_expired`, looked up before the download is counted, so it uses none of the person's
  30; the page then reads the report again, as a refresh would, shows it and downloads that. The file holds every row of the answer whatever the page's filters show, with the top
  row (**Whole ad account**, **Whole campaign**, **All ad groups in this campaign**...) and, with dates
  compared, a **Before** row and each row's spend and purchases (Meta) or conversions (Google) then and
  their change. Meta's file has purchases under each ad set's own setting and under each fixed window
  side by side (**Not reported** where Meta gave none, as is reach Meta didn't give); a row the dates
  compared with don't list says **Not listed for the dates compared**. Statuses, budgets and Google's
  delivery and Quality Score are as the platform lists them now, labelled so; a keyword Google gives no
  Quality Score reads **Not rated by Google**. Dates reaching the ad account's today add the page's note
  that today's numbers are still coming in. Down from a campaign or ad group with none of its rows listed,
  the note says what the platform reported (no ad groups with any activity), never that nothing ran, as
  the top row is then those rows added up. The audit entry: `section: "ads_live_report"`, the
  `platform`, `level`, `account` (the ad connection), the campaign, ad set or ad group opened, and the dates.
- **Account analytics** (`/advertising/google/analytics`): a **Section** picked and **Download CSV**, `GET
  …/ads/google/analytics/export?part=overview|campaigns|days|weeks|months|devices|audience|recommendations|combined`
  with the page's dates and `connection`. The same answer as the page, from the stored days: a day, week
  or month the account hasn't stored is **Not stored** (one partly stored says which days), the overview
  with nothing stored says so and one whose dates compared with aren't all stored says **Not compared**,
  never 0. The campaigns and recommendations need "View campaigns" too. A real account's devices and
  audience read Google's splits as the page does; a split that couldn't be read says why. The audit entry:
  `section: "google_ads_analytics"`, the `part`, `platform: "google"`, `account` and the dates.
- **The demo** (Google Ads, [ads-demo.md](ads-demo.md)): its files are named `…-demo-simulated-…`, their
  first row reads **Simulated data** with the demo's disclaimer, and the audit entry has `demo: true`.
  Nothing in them is called Google's: **Conversions (simulated, all conversion actions)**, **Status now
  (simulated)**, **Delivery now (simulated)**, a Quality Score not given reads **Not rated**, and the
  notes say the demo's rows, not Google's.
- Money columns name the ad account's currency ("Spend (USD)"); rates are percentages ("Link click rate
  (%)"); purchases and conversions are each platform's own count, said in their headings, never Shopify
  orders.

## Old addresses

`/dashboard?view=ads` and `?view=adsense` open `/advertising` and `/advertising/adsense` with the dates
on screen (the dashboard page's redirect), and `/ads/google` opens `/advertising/google/analytics`.
