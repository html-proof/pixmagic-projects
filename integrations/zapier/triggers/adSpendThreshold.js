const { hookTrigger, thresholdFields } = require("../lib/hookTrigger");

module.exports = hookTrigger({
  key: "ad_spend_threshold",
  event: "ad_spend_threshold",
  noun: "Ad Spend",
  label: "Ad Spend Passed an Amount",
  description: "Triggers once a day or a month when the store's Meta or Google Ads spend, as stored in bizinsights or reported to Shopify, reaches the amount you set.",
  inputFields: [
    { key: "platform", label: "Platform", required: true, choices: { any: "Meta and Google Ads", meta: "Meta Ads", google: "Google Ads" }, default: "any" },
    ...thresholdFields,
  ],
  toInputs: (i) => ({ platform: i.platform || "any", period: i.period, amount: Number(i.amount) }),
  sample: {
    id: "ad_spend_threshold:example:2026-10",
    event: "ad_spend_threshold",
    occurred_at: "2026-10-28T09:00:00.000Z",
    store: { id: "store_example", name: "Example Store", shop_domain: "example.myshopify.com" },
    data: {
      trigger: { platform: "meta", period: "month", amount: 500, direction: "above" },
      period: "2026-10",
      period_start: "2026-10-01",
      period_end: "2026-10-31",
      period_complete: false,
      spend: 512.4,
      currency: "AUD",
      platforms: [{ platform: "meta", name: "Meta Ads", source: "platform_api", spend: 512.4, currency: "AUD", last_synced_at: "2026-10-28T08:55:00.000Z" }],
      accounts: [{ platform: "meta", account_id: "act_example", account_name: "Example ad account", spend: 512.4, currency: "AUD", last_synced_at: "2026-10-28T08:55:00.000Z" }],
      last_successful_sync_at: "2026-10-28T08:55:00.000Z",
      freshness_note: "Figures as stored in bizinsights at its last sync with each platform.",
    },
  },
  outputFields: [
    { key: "data__period", label: "Period" },
    { key: "data__spend", label: "Spend", type: "number" },
    { key: "data__currency", label: "Currency" },
    { key: "data__trigger__amount", label: "Amount set", type: "number" },
    { key: "data__platforms[]source", label: "Where each platform's spend comes from (platform_api or shopify_marketing)" },
    { key: "data__last_successful_sync_at", label: "Last sync", type: "datetime" },
  ],
});
