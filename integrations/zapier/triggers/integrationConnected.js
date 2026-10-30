const { hookTrigger } = require("../lib/hookTrigger");

module.exports = hookTrigger({
  key: "integration_connected",
  event: "integration_connected",
  noun: "Integration",
  label: "Integration Connected",
  description: "Triggers when Meta Ads, Google Ads, Google AdSense, WhatsApp or Zapier is connected to the store in bizinsights.",
  sample: {
    id: "integration_connected:example",
    event: "integration_connected",
    occurred_at: "2026-10-28T09:00:00.000Z",
    store: { id: "store_example", name: "Example Store", shop_domain: "example.myshopify.com" },
    data: {
      integration: "meta_ads",
      integration_name: "Meta Ads",
      accounts: 1,
      connected_at: "2026-10-28T09:00:00.000Z",
      settings_url: "https://bizinsights.io/settings/ads",
    },
  },
  outputFields: [
    { key: "data__integration", label: "Integration key" },
    { key: "data__integration_name", label: "Integration" },
    { key: "data__accounts", label: "Ad accounts connected", type: "integer" },
    { key: "data__connected_at", label: "Connected at", type: "datetime" },
    { key: "data__settings_url", label: "Settings page" },
  ],
});
