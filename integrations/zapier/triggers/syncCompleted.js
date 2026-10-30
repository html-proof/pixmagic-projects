const { hookTrigger } = require("../lib/hookTrigger");

module.exports = hookTrigger({
  key: "sync_completed",
  event: "sync_completed",
  noun: "Ad Account Sync",
  label: "Ad Account Synced",
  description:
    "Triggers when bizinsights has read a Meta Ads, Google Ads or AdSense account's latest figures: at most once an hour per account, with the last day it now has. Use it to refresh a sheet with the Find Ad Performance search.",
  sample: {
    id: "sync_completed:conn_example:2026-10-28T09",
    event: "sync_completed",
    occurred_at: "2026-10-28T09:00:00.000Z",
    store: { id: "store_example", name: "Example Store", shop_domain: "example.myshopify.com" },
    data: {
      integration: "google_ads",
      integration_name: "Google Ads",
      connection_id: "conn_example",
      account_id: "1234567890",
      account_name: "Example Ads account",
      synced_at: "2026-10-28T09:00:00.000Z",
      data_through: "2026-10-28",
    },
  },
  outputFields: [
    { key: "data__integration_name", label: "Integration" },
    { key: "data__account_id", label: "Account ID" },
    { key: "data__account_name", label: "Account name" },
    { key: "data__synced_at", label: "Synced at", type: "datetime" },
    { key: "data__data_through", label: "Figures stored through (day)" },
  ],
});
