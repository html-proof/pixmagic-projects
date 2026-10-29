const { hookTrigger } = require("../lib/hookTrigger");

module.exports = hookTrigger({
  key: "ads_daily_summary",
  event: "ads_daily_summary",
  noun: "Advertising Summary",
  label: "Daily Advertising Summary",
  description: "Triggers once a day with yesterday's spend, impressions, clicks and conversions per ad platform, and the store's own Shopify sales beside them.",
  sample: {
    id: "ads_daily_summary:store_example:2026-10-27",
    event: "ads_daily_summary",
    occurred_at: "2026-10-28T02:00:00.000Z",
    store: { id: "store_example", name: "Example Store", shop_domain: "example.myshopify.com" },
    data: {
      day: "2026-10-27",
      platforms: [
        {
          platform: "meta",
          name: "Meta Ads",
          spend: 40,
          currency: "AUD",
          mixed_currencies: null,
          impressions: 900,
          clicks: 30,
          conversions: 2,
          platform_attributed_purchase_value: 160,
          platform_attributed_roas: 4,
        },
      ],
      adsense: null,
      shopify: { net_sales: 450, total_sales: 520, orders: 7, currency: "AUD" },
      accounts_without_the_day: [],
      attribution_note: "Purchase value and ROAS are what each ad platform credits to its own ads (its attribution), not the store's revenue.",
    },
  },
  outputFields: [
    { key: "data__day", label: "Day" },
    { key: "data__shopify__net_sales", label: "Shopify net sales", type: "number" },
    { key: "data__shopify__orders", label: "Shopify orders", type: "integer" },
    { key: "data__attribution_note", label: "About attributed value" },
  ],
});
