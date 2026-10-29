const { hookTrigger, thresholdFields } = require("../lib/hookTrigger");

module.exports = hookTrigger({
  key: "adsense_earnings_threshold",
  event: "adsense_earnings_threshold",
  noun: "AdSense Earnings",
  label: "AdSense Earnings Passed an Amount",
  description: "Triggers once a day or a month when the store's estimated Google AdSense earnings reach the amount you set. Earnings are Google's estimates and can be adjusted.",
  inputFields: thresholdFields,
  toInputs: (i) => ({ period: i.period, amount: Number(i.amount) }),
  sample: {
    id: "adsense_earnings_threshold:example:2026-10-28",
    event: "adsense_earnings_threshold",
    occurred_at: "2026-10-28T09:00:00.000Z",
    store: { id: "store_example", name: "Example Store", shop_domain: "example.myshopify.com" },
    data: {
      trigger: { platform: "adsense", period: "day", amount: 20 },
      period: "2026-10-28",
      period_start: "2026-10-28",
      period_end: "2026-10-28",
      period_complete: false,
      earnings_estimated: 21.15,
      currency: "AUD",
      accounts: [{ account_id: "pub-example", account_name: "Example AdSense", earnings_estimated: 21.15, currency: "AUD", last_synced_at: "2026-10-28T08:55:00.000Z" }],
      last_successful_sync_at: "2026-10-28T08:55:00.000Z",
      estimates_note: "AdSense earnings are Google's estimates: Google can adjust them, and finalizes a month's earnings after it ends.",
    },
  },
  outputFields: [
    { key: "data__period", label: "Period" },
    { key: "data__earnings_estimated", label: "Estimated earnings", type: "number" },
    { key: "data__currency", label: "Currency" },
  ],
});
