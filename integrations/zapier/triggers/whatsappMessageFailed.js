const { hookTrigger } = require("../lib/hookTrigger");

module.exports = hookTrigger({
  key: "whatsapp_message_failed",
  event: "whatsapp_message_failed",
  noun: "WhatsApp Message",
  label: "WhatsApp Message Failed",
  description: "Triggers when a WhatsApp message bizinsights sent to one of the store's customers couldn't be delivered. The customer's number is masked.",
  sample: {
    id: "whatsapp_message_failed:example",
    event: "whatsapp_message_failed",
    occurred_at: "2026-10-28T09:00:00.000Z",
    store: { id: "store_example", name: "Example Store", shop_domain: "example.myshopify.com" },
    data: {
      message_id: "example",
      source: "automation",
      type: "text",
      category: "transactional",
      phone_masked: "+61 4•• ••• 678",
      reason: "provider_rejected",
      reason_text: "WhatsApp refused it",
      automation_id: null,
      campaign_id: null,
      failed_at: "2026-10-28T09:00:00.000Z",
      view_url: "https://bizinsights.io/dashboard/whatsapp-automation",
    },
  },
  outputFields: [
    { key: "data__phone_masked", label: "Customer's number (masked)" },
    { key: "data__reason_text", label: "Why it failed" },
    { key: "data__source", label: "Sent by" },
    { key: "data__failed_at", label: "Failed at", type: "datetime" },
  ],
});
