// A bizinsights trigger as a REST hook (Zapier's instant triggers): turning the Zap on subscribes
// Zapier's address at bizinsights (POST /api/zapier/hooks), turning it off unsubscribes it, and
// bizinsights posts each event to that address. While the Zap is set up, performList shows the
// store's last few real events (GET /api/zapier/samples/:event), or none: never made-up data.
const { apiUrl } = require("./api");

/** The envelope every event comes in (bizinsights' ZapierEnvelope). */
const envelopeFields = [
  { key: "id", label: "Event ID" },
  { key: "event", label: "Event type" },
  { key: "occurred_at", label: "Happened at", type: "datetime" },
  { key: "store__id", label: "Store ID" },
  { key: "store__name", label: "Store name" },
  { key: "store__shop_domain", label: "Shopify domain" },
];

/**
 * @param {{ key: string, event: string, noun: string, label: string, description: string,
 *   inputFields?: object[], toInputs?: (inputData: object) => object, sample: object, outputFields?: object[] }} t
 */
function hookTrigger(t) {
  return {
    key: t.key,
    noun: t.noun,
    display: { label: t.label, description: t.description },
    operation: {
      type: "hook",
      inputFields: t.inputFields || [],
      performSubscribe: async (z, bundle) => {
        const response = await z.request({
          url: apiUrl("/zapier/hooks"),
          method: "POST",
          body: {
            event: t.event,
            targetUrl: bundle.targetUrl,
            zapId: bundle.meta && bundle.meta.zap ? bundle.meta.zap.id : undefined,
            ...(t.toInputs ? t.toInputs(bundle.inputData || {}) : {}),
          },
        });
        // Kept by Zapier as bundle.subscribeData: the trigger's id at bizinsights.
        return response.data;
      },
      performUnsubscribe: async (z, bundle) => {
        const response = await z.request({ url: apiUrl(`/zapier/hooks/${encodeURIComponent(bundle.subscribeData.id)}`), method: "DELETE" });
        return response.data;
      },
      // bizinsights posts one event per request: the event is the body.
      perform: (z, bundle) => [bundle.cleanedRequest],
      performList: async (z) => (await z.request({ url: apiUrl(`/zapier/samples/${t.event}`) })).data,
      sample: t.sample,
      outputFields: [...envelopeFields, ...(t.outputFields || [])],
    },
  };
}

/** A threshold's fields: the period and the amount (in the account's own currency). */
const thresholdFields = [
  {
    key: "period",
    label: "Period",
    required: true,
    choices: { day: "Each day", month: "Each month" },
    default: "month",
    helpText: "The trigger fires at most once per day or per month (the store's own calendar), when the total reaches the amount.",
  },
  {
    key: "amount",
    label: "Amount",
    required: true,
    type: "number",
    helpText: "In the ad account's own currency. Accounts in different currencies are never added up: such a trigger isn't checked, and bizinsights' Settings says so.",
  },
];

module.exports = { hookTrigger, thresholdFields };
