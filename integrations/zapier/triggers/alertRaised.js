const { hookTrigger } = require("../lib/hookTrigger");

// The sample shows the shape of an event only: Zapier shows the store's real ones when it has some.
module.exports = hookTrigger({
  key: "alert_raised",
  event: "alert_raised",
  noun: "Alert",
  label: "New Alert",
  description: "Triggers when bizinsights raises an alert for the store, such as a sync or sign-in that stopped working (Shopify, ad accounts, WhatsApp, email).",
  sample: {
    id: "alert_raised:example:store_example",
    event: "alert_raised",
    occurred_at: "2026-10-28T09:00:00.000Z",
    store: { id: "store_example", name: "Example Store", shop_domain: "example.myshopify.com" },
    data: {
      alert_id: "example",
      severity: "warning",
      area: "ads",
      title: "An ad account needs reconnecting",
      body: "Open Settings → Advertising to see what it needs.",
      fix_url: "https://bizinsights.io/settings/ads",
      raised_at: "2026-10-28T09:00:00.000Z",
    },
  },
  outputFields: [
    { key: "data__severity", label: "Severity" },
    { key: "data__area", label: "Area" },
    { key: "data__title", label: "Title" },
    { key: "data__body", label: "What it means" },
    { key: "data__fix_url", label: "Page that fixes it" },
    { key: "data__raised_at", label: "Raised at", type: "datetime" },
  ],
});
