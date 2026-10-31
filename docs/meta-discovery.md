# Meta, found through Shopify

Shopify is a store's first connection. Once it is connected, bizinsights works out by itself where
the store's Meta (Facebook and Instagram) stands, and asks the merchant for Meta's own sign-in only
when Meta requires it.

Code: the states and rules in `packages/shared/src/metaDiscovery.ts` (`@app/shared/metaDiscovery`),
the answer in `packages/core/src/integrations/metaDiscovery.ts`, reusing a sign-in in
`packages/core/src/adConnections/reuse.ts`, the routes in `apps/api/src/routes/integrations.ts` and
`ads.ts`, the UI in `apps/web/src/components/integrations/MetaDiscovery.tsx`.

## What Shopify does and doesn't share

Many stores run Facebook and Instagram from Shopify's own **Facebook & Instagram** app. Shopify keeps
that app's Meta authorization to itself:

- No Admin API scope, field or webhook hands another app a Meta access token, or the Meta Business,
  Facebook Page, Instagram account or ad account ids behind the Facebook & Instagram app.
- An app can't read which other apps a store has installed, nor their settings.
- Meta ties an access token to one person and one Meta app. A token issued to Shopify's Meta app
  can't be used by bizinsights' Meta app (971575545351940), and bizinsights never asks for one,
  copies one or makes one.

`SHOPIFY_SHARES_META_ACCESS` (`@app/shared/metaDiscovery`) says this in code and is `false`. Should
Shopify ever offer an official way, that switch is where the change starts, and nothing else may
assume it.

What Shopify does send bizinsights, with the `read_orders` the store granted at install, is each
order's visit: where the shopper came from before buying (`orders.traffic_source`,
`traffic_medium`; `packages/shared/src/traffic.ts`). An order whose visit came from Facebook or
Instagram (a `utm_source`, a referrer, Meta's `fbclid` on the link) shows Meta at work for the
store. That is what "Meta found in Shopify" means here: seen in the store's orders, not connected to
bizinsights.

## The six states

`GET /workspaces/:ws/stores/:storeId/meta/discovery` answers one of them, worked out on every read
from what is already stored (no call to Meta or Shopify):

| State | When | Offered |
| --- | --- | --- |
| `NOT_CONNECTED` | bizinsights holds no Meta sign-in for the store, and none of its orders of the last 90 days came from Facebook or Instagram | Connect Meta |
| `CONNECTED_IN_SHOPIFY` | no Meta sign-in of bizinsights', but some of those orders came from Facebook or Instagram. Marked **`CONNECTED_IN_SHOPIFY_BUT_NOT_AUTHORIZED_FOR_OUR_APP`** (`marker`) | Connect Meta |
| `AUTHORIZED_FOR_OUR_APP` | a Meta sign-in given to bizinsights serves the store: its ad accounts are read, or it waits for its first one (`ad_logins`) | nothing |
| `TOKEN_EXPIRED` | the sign-in reached its end date (Meta's long-lived user tokens last about 60 days) | Sign in to Meta again |
| `REAUTH_REQUIRED` | Meta refused the sign-in before its end date (revoked, password changed), or the person who gave it left the workspace | Sign in to Meta again |
| `PERMISSION_MISSING` | `ads_read` was taken back, or the login can no longer read the ad account | Sign in to Meta again |

With several ad accounts, the most pressing state of the ones shown on the dashboard is the store's.
Whenever the person asking has a working Meta sign-in of their own on another store, "Use my Meta
sign-in" replaces Meta's screen (below). The buttons are only for people with **Manage
integrations**, on a server where Meta's sign-in is set up.

The answer also says what the orders show (`shopify`: orders from Facebook and from Instagram, the
ones through an ad link, the latest one), following the caller's Team & Access permissions as the
dashboard does: the counts need **View traffic sources**, the ad-link ones **View conversion
attribution** as well. The state is told to everyone who may see integration status. `assets` lists
the Meta assets bizinsights reads for the store: its ad accounts (each with its state) and the
campaigns their syncs have seen. Never a token.

## The merchant's way through it

1. Sign in to bizinsights, connect Shopify (unchanged).
2. Once the first import has brought the orders in, the dashboard's Advertising card, the
   Advertising pages and Settings → Integrations show "Meta found through your Shopify store",
   with what the orders show, marked "Not authorized for bizinsights yet". Meanwhile those pages
   already show Meta's part of the sales from the orders (`ads_from_shopify`, docs/advertising.md).
3. One button:
   - **Use my Meta sign-in**, when they gave bizinsights a Meta sign-in for another of their stores
     that still works. No Meta screen: `POST .../ads/meta/reuse` lists what that sign-in reaches and
     connects this store's ad account (or asks which, when there are several).
   - Otherwise **Connect Meta**: Meta's own Facebook Login for Business screen, once, the same
     sign-in as ever (docs/ads-setup.md). Nobody types a Business, Page, Instagram or ad account id,
     nor a token.
4. Meta's figures follow on the dashboard by themselves: campaigns, ad sets, ads, spend,
   impressions, reach, clicks, CTR, CPC, conversions and conversion value (docs/advertising.md).

## Reusing a sign-in

`reusableMetaSignIn` takes only the asking person's own sign-in (`connectedByUserId`), in any of
their workspaces (the `ad_grants` row scope), that still works: not waiting for a reconnect, with
`ads_read` among what was granted, and not ending within a day. It is the same person's grant to
bizinsights' own Meta app; the new store's rows are sealed for that store and keep who granted them
(`externalUserId`), so a disconnect takes the grant back only when no store uses it any more
(`grantStillUsed`), and Meta's deauthorize and data deletion callbacks find every copy. Cancelling
the account choice never takes back a grant another store uses. A store in another workspace is
named only as "another of your stores".

## What needs more than ads_read

Facebook Pages, Instagram Business accounts and the Meta Business portfolio's details need Meta
permissions bizinsights doesn't ask for today (`pages_show_list`, `instagram_basic`,
`business_management`), each through Meta's App Review, as `ads_read` was
(docs/ads-review-packs.md). Until then the answer lists the ad accounts and their campaigns only.
