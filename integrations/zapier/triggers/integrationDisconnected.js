const { hookTrigger } = require("../lib/hookTrigger");

module.exports = hookTrigger({
  key: "integration_disconnected",
  event: "integration_disconnected",
  noun: "Integration",
  label: "Integration Disconnected",
  description: "Triggers when Meta Ads, Google Ads, Google AdSense, WhatsApp or Zapier is disconnected from the store in bizinsights.",
  sample: {
    id: "integration_disconnected:example",
    event: "integration_disconnected",
    occurred_at: "2026-10-28T09:00:00.000Z",
    store: { id: "store_example", name: "Example Store", shop_domain: "example.myshopify.com" },
    data: {
      integration: "whatsapp",
      integration_name: "WhatsApp",
      accounts: null,
      disconnected_at: "2026-10-28T09:00:00.000Z",
      settings_url: "https://bizinsights.io/dashboard/whatsapp-automation",
    },
  },
  outputFields: [
    { key: "data__integration", label: "Integration key" },
    { key: "data__integration_name", label: "Integration" },
    { key: "data__disconnected_at", label: "Disconnected at", type: "datetime" },
    { key: "data__settings_url", label: "Settings page" },
  ],
});
