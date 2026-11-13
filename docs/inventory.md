# Inventory

The Inventory section (`/inventory`, sidebar → Inventory) shows a store's stock as Shopify keeps
it, alerts the team when items run low or sell out, and changes stock in Shopify. Everything it
shows was read from Shopify or recorded by bizinsights on the way; a figure it can't work out is
shown as "—" with the reason, never estimated.

| Page | What it shows |
| --- | --- |
| Inventory overview | What needs attention (out of stock, then low) with sold per day, days left, the suggested order and Add stock; under "More detail", 16 figures (definitions behind each "?", `KPI_INFO` in `@app/shared/inventory`) |
| All stock / Low stock / Out of stock | The stock list: search, filters, sorting, pages, row selection, CSV, saved filters (per device); Low and Out show sales rate, days left as a tag, the suggested order and Add stock; All stock adds the stock value at cost |
| Inventory movements | Every stock change bizinsights saw, grouped by the store's day with where it came from, and the changes made here with Shopify's answer |
| Locations | Each Shopify location with its stock |
| Inventory reports | Trends from the day's-end records, top sellers, slow movers, sell-through, turnover, stockouts, stock by location |
| Stock settings | Threshold, alert channels, the check's schedule, restock planning, Shopify access |
| Product panel (`?product=` on any page) | Product information, each variant's stock at every location in every state, sales, history; Adjust stock |

The pages follow the owner's Stitch design (prototype v2, screens 21–24: Needs attention, All
products, History, Stock on a phone), through `components/PageKit.tsx` and the section's own
`components/inventory/StockKit.tsx`: the status pill ("In step with Shopify · checked …") and
Refresh stock in each header, chips between Needs attention, Out of stock and Low stock, tables
with a soft header row that become cards on a phone. The section menu is unchanged; it stands in
for the design's three tabs. "Add stock" opens the stock change dialog on Increase for the row's
item (`inventory.adjust` and the store's `write_inventory`, as the product panel's Adjust stock).
bizinsights never orders from suppliers: the suggested order is a number to act on, worked out
with Stock settings' lead time and days to cover.

## Where the stock comes from

Shopify keeps stock per **inventory item** (one per variant) per **location**, in separate quantity
states: `available`, `on_hand`, `committed`, `incoming`, `reserved`, `damaged`, `safety_stock`,
`quality_control` (`on_hand` = available + committed + reserved + damaged + safety_stock +
quality_control; incoming is separate). bizinsights stores exactly that (`inventory_levels`, one row
per item and location, every state) and never treats one state as another.

Two sources, never mixed in one answer (`stockSource` in `packages/core/src/inventory/stock.ts`):

- **levels**: the store granted `read_inventory` + `read_locations` (capability `stock_levels`) and
  a full pass has stored every location. Everything per location and per state.
- **variants**: only Shopify's own total per variant (`ProductVariant.inventoryQuantity`, read with
  the catalog on `read_products`): available units only. On hand, committed, incoming and per-location
  figures say "Needs stock-level access".

Totals count each item at each location once and leave out untracked items (counted on their own)
and archived products.

## Items sold, and the order of the lists

Every sales figure in the section (units sold today and this month, top sellers and slow movers,
sales rates and days of stock, fast- and slow-moving, a product's sales) counts items from
Shopify's sales records (`order_sales`), exactly as the dashboard's top products do (`SALE_UNITS`
in `packages/core/src/reports/common.ts`): an order's items count, a return's or a cancellation's
come off, an edit's own line counts neither way; revenue is net sales before tax. Gift card
products sold as goods count as items (they leave stock). The dashboard's Stock card reads the same
stock, the same low and out of stock and the same rates (`inventory` in
`packages/core/src/reports/catalog.ts`), so the two never disagree about a store.

Lists come in a fixed order, the same every time they are opened: the stock list by what it is
sorted by, then catalog order (product title, the variant's position in its product, its title,
its id); the overview's low and out of stock by fewest available first; top sellers by most items
sold, then most net sales; slow movers by fewest sold, then most stock held; the dashboard's
"Restock soon" by fewest days of cover (unknown last), then fewest units; ties everywhere in
catalog order.

## Keeping it in step with Shopify

| How | When | Code |
| --- | --- | --- |
| Full pass | Once the scopes are granted (`scopeFollowUpKinds` → `inventory`), "Refresh stock", and every `reconcileHours` (default 6) | `runInventoryStep` (apps/worker/src/handlers/inventory.ts): locations, then each location's levels 200 a page (halved on MAX_COST_EXCEEDED), each message one page |
| Webhooks | As Shopify sends them | `inventory_levels/update` and `/connect` re-read the level (`ITEM_LEVEL_QUERY`: the payload has only `available` and may be stale); `/disconnect` removes it; `inventory_items/update` (cost, tracking, SKU); `locations/*` |
| Subscriptions | Each pass checks them | Shop-specific (`webhookSubscriptionCreate`, `ensureInventoryWebhooks`), to `${API_URL}/webhooks/shopify`, signed with the app's secret like the toml's. Not in the toml: the scopes are optional there |

Writes are guarded by Shopify's `InventoryLevel.updatedAt`: an older read never overwrites a newer
one, so late or out-of-order webhooks can't move stock backwards (`applyLevels`, rows locked
`FOR UPDATE`). A webhook delivered twice is processed once (`webhook_events`) and a level read twice
records one change.

The scheduled pass is the **check against Shopify**: each level that differed is corrected and
recorded as a `reconcile` movement, and the pass's record (`inventory_sync_runs`) counts levels
checked and differences, with up to 20 examples. The sync strip shows the last check, flags stock as
possibly out of date when no check succeeded for twice the interval or the last one failed, and
never claims "live": Shopify gives no freshness guarantee for webhooks.

## History, snapshots, alerts

- **Movements** (`inventory_movements`): each state change seen, with before, after and how it was
  seen: `webhook`, `sync` (a refresh), `reconcile` (the check), `adjustment` (made here, confirmed by
  Shopify, linked to its adjustment). Shopify's own adjustment history isn't in its API, so changes
  before bizinsights followed a store aren't there, and the page says so. Kept two years.
- **Snapshots** (`inventory_snapshots`): the stock storewide and per location under the store-local
  day, written hourly and after each pass (the last write is the day's close). Trend charts and
  turnover read only these: a day without one is "not recorded", never filled in.
- **Alerts** (`inventory_alerts`): one row per variant and kind (`out_of_stock`, `low_stock`,
  `fast_movement`), opened when it crosses in, resolved when it leaves. The 15-minute sweep tells
  people about new ones once (`notifyStockAlerts`): one email per store to members who can see
  inventory and kept "Stock alerts" on (Settings → Notifications), the bell (alert code
  `inventory_stock`, one per store while anything is out of stock or low and Stock settings keep
  dashboard alerts on; when it opens it is also Zapier's New Alert trigger, docs/zapier.md), and
  optionally WhatsApp. One that flaps is told again
  at most once a day.
  Only for a store set up for inventory (stock levels granted, or Stock settings saved), so nobody
  gets alerts they never asked for when the module ships. Low = 1..threshold available counting every location; threshold = variant's, else product's, else
  the store's (default 10). Fast movement = at least 5 units today and 3× the 30-day daily rate.
- **WhatsApp alerts** are a plain text ("Stock alert for <business name>: <summary>") from the
  store's own connected WhatsApp (WhatsApp Automation) to the numbers picked in Stock settings (up
  to 5, stored encrypted, shown masked); no template is needed (`whatsapp/teamAlerts.ts`). They keep
  to the store's WhatsApp sending hours and count against its daily limit. At most one message per
  number and hour. On the Cloud API, Meta delivers such a text only to someone who messaged the
  business number in the last 24 hours (docs/whatsapp.md).

Forecasts (days of stock, run-out date, reorder, fast/slow-moving) need at least 14 days of imported
orders (`MIN_HISTORY_DAYS`); slow-moving needs 30. Reorder (the suggested order, `restockQuantity`
in `@app/shared/inventory`) = rate × (lead time + days to cover) + oversold units still owed −
available (0 when below 0) − incoming, never below 0.

- **Oversold units still owed** (`oversoldOwed`): below 0 available, the oversold units, but no more
  than Shopify's `committed` (units in orders not yet fulfilled). An oversold order that has shipped
  is owed nothing, so a made-to-order item that went negative long ago adds nothing, while −9 with 9
  orders waiting suggests at least 9. Without stock-level access there is no committed figure, and
  every oversold unit counts. The owner's call on 2026-11-06; until then any negative stock counted
  as 0, so an oversold item with no recent sales always suggested 0.
- **Keeps selling**: an out-of-stock item Shopify goes on selling (`inventory_policy` `continue`,
  "Continue selling when out of stock", as made-to-order and print-on-demand items often are) shows
  a neutral "Keeps selling" tag in the Days left column instead of the red "Out now" (`DaysLeftTag`,
  `components/inventory/StockKit.tsx`). It is still listed and counted as out of stock, and alerts
  are unchanged (owner's call, 2026-11-06).

## Changing stock

From the product panel, for members with `inventory.adjust` on a store that granted
`write_inventory` (capability `stock_adjustments`). `adjustStock` (core/inventory/adjust.ts):

| Kind | Shopify mutation |
| --- | --- |
| Increase, Decrease, Correction | `inventoryAdjustQuantities` on `available` (a delta) |
| Set quantity | `inventorySetQuantities` on `available` |
| Stocktake | `inventorySetQuantities` on `on_hand` (reason `cycle_count_available`) |
| Mark damaged | `inventoryMoveQuantities` available → damaged |

- Every mutation carries `@idempotent(key:)` (required since API 2026-04) with the client's key, one
  per confirmation dialog, which is also `inventory_adjustments.idempotency_key`: a repeated request
  answers with the first one's outcome, an unconfirmed one is sent again with the same key.
- `changeFromQuantity` is what the person saw: Shopify refuses (`CHANGE_FROM_QUANTITY_STALE`) if the
  stock moved meanwhile, and the dialog shows the new number. Changes to one item at one location
  also take a lock (`inventory-adjust:<store>:<item>:<location>`).
- Nothing is shown as changed until Shopify answers with an adjustment group and no userErrors; then
  the level is read back from Shopify and stored. A timeout or 5xx is `unknown` ("Shopify didn't
  confirm"), never success. Shopify's own error text stays in the logs.
- `inventory_adjustments` is written `pending` and settled once; a trigger refuses any other update
  (migration `20261019120000_inventory_module`), and the tenant role can't update or delete it or
  the movements. Each change is also in the workspace audit log (`inventory.adjusted`).

## Permissions (Team & Access, module "Inventory")

| Key | Gives |
| --- | --- |
| `inventory.view` | Stock, locations, reports, alerts list, settings (read) |
| `inventory.products` | Product information (description, images, barcodes, options, shipping) |
| `inventory.costs` (sensitive) | Cost per item, stock value, margin, turnover, sales revenue |
| `inventory.history` | Movements and adjustments |
| `inventory.export` (sensitive) | CSV; costs in it only with `inventory.costs` |
| `inventory.adjust` (sensitive) | Changing stock in Shopify |
| `inventory.alerts` (sensitive) | Thresholds and alert channels |
| `inventory.settings` (sensitive) | Check schedule, lead time, cover |

Owners and admins hold all; viewer/analyst/manager templates start with view + products (+ history
for analyst and manager). The API checks each route (`apps/api/src/routes/inventory.ts`) and leaves
out what isn't granted; a shared link never gets the manage ones. Every query is filtered by
workspace and store, with Postgres RLS behind it.

## Turning on stock levels and stock changes

The three scopes are **optional scopes** (docs/shopify-setup.md 3e), asked for from Stock settings
or the "Give access in Shopify" card by an owner or admin, one Shopify consent screen each.

1. Declare them in every app's toml: `optional_scopes` gets `read_inventory`, `read_locations`,
   `write_inventory`, mirrored in `SHOPIFY_OPTIONAL_SCOPES` (apps/aws/src/settings.ts;
   packages/core/test/appConfig.test.ts checks they agree).
2. `shopify app deploy --config <app>` for each app (`pixmagic`, `appstore`, `public`, default)
   **before** the change reaches AWS: an optional scope the deployed app doesn't declare sends the
   merchant to a Shopify error page.
3. Merge to `main` (Deploy to AWS).
4. For App Store workspaces also set `APP_STORE_MODULES.inventory` (apps/web/src/lib/features.ts) and
   describe Inventory in the listing.

Done 2026-10-19 ~07:16Z on the owner's go: released `pixmagic-9`, `insights-16` (default),
`bizinsights-public-3` and `bizinsights-appstore-2` (the App Store app, then under review), each
only adding the three optional scopes; `SHOPIFY_OPTIONAL_SCOPES` followed on `main`.

Until a store grants them the section works from Shopify's per-variant totals (`variants` source).

## Not covered

- Units sold per fulfilment location: the imported orders don't record which location fulfilled
  them, so the report says so instead of guessing.
- Shopify's own adjustment history before bizinsights followed a store (not in Shopify's API).
- Cost at the time of each sale: turnover uses today's cost per item, as stated on the figure.
