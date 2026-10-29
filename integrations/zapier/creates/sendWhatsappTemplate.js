const { apiUrl } = require("../lib/api");

// "Send WhatsApp Template Message" (docs/zapier.md): one customer, one of the store's templates Meta
// approved, the values the Zap maps into its variables. bizinsights queues it through the store's own
// WhatsApp (consent, STOP, daily limits, sending hours, Pause all automation): this answers what was
// queued, and the "WhatsApp Message Failed" trigger tells a Zap if Meta refuses it later. Only for a
// connection allowed to send, by someone who may (ticked on bizinsights' page when connecting).

/** Template variables a Zap fills in, as bizinsights names them (@app/shared/whatsapp's WA_VARIABLE_INFO). */
const VARIABLES = {
  customer_first_name: { label: "Customer's first name", help: "Empty: the name bizinsights already has for this number, or the First name field below." },
  order_number: { label: "Order number", help: "For example #1042." },
  order_total: { label: "Order total", help: "With its currency, for example $58.00." },
  product_names: { label: "Products", help: "For example Linen shirt ×2, Canvas tote." },
  order_status_url: { label: "Order status page link" },
  tracking_number: { label: "Tracking number" },
  tracking_url: { label: "Tracking link" },
  carrier: { label: "Carrier", help: "For example Australia Post." },
  checkout_url: { label: "Checkout link" },
};

/** The chosen template's variables as fields, with its text above them. */
async function templateValues(z, bundle) {
  const id = bundle.inputData.template_id;
  if (!id) return [];
  const templates = (await z.request({ url: apiUrl("/zapier/whatsapp/templates") })).data || [];
  const t = templates.find((x) => x.id === id);
  if (!t) return [];
  return [
    { key: "template_text", type: "copy", helpText: `**${t.name}** (${t.category_label}): ${t.body}${t.automatic.length ? "\n\n{{store_name}} is your business name from bizinsights' WhatsApp Settings." : ""}` },
    ...t.variables.map((v) => ({
      key: `value_${v}`,
      label: (VARIABLES[v] && VARIABLES[v].label) || v,
      required: v !== "customer_first_name",
      helpText: `Goes into {{${v}}}. ${(VARIABLES[v] && VARIABLES[v].help) || ""} At most 200 characters, on one line.`.trim(),
    })),
  ];
}

module.exports = {
  key: "send_whatsapp_template",
  noun: "WhatsApp Message",
  display: {
    label: "Send WhatsApp Template Message",
    description:
      "Sends a customer one of your WhatsApp templates, through your store's WhatsApp in bizinsights. For example: thank a new Meta or Google Ads lead on WhatsApp within minutes.",
  },
  operation: {
    inputFields: [
      {
        key: "template_id",
        label: "Template",
        required: true,
        dynamic: "whatsapp_templates.id.name",
        altersDynamicFields: true,
        helpText: "One of your WhatsApp templates that can send now (WhatsApp page in bizinsights, Templates; on Meta's Business Platform, the ones Meta approved). Marketing templates go only to customers who agreed to marketing.",
      },
      templateValues,
      {
        key: "phone",
        label: "Customer's phone number",
        required: true,
        helpText: "With the country code, for example +61 412 345 678. Testing this step in Zapier sends a real message: use your own number.",
      },
      { key: "country", label: "Country of numbers without a country code", helpText: "Two letters, for example AU. Used only when the number doesn't start with + or 00." },
      { key: "first_name", label: "Customer's first name", helpText: "Kept with their WhatsApp number in bizinsights." },
      {
        key: "customer_agreed",
        label: "The customer agreed to WhatsApp messages from you",
        type: "boolean",
        required: true,
        default: "no",
        helpText:
          "Yes only if they did: for example they ticked a WhatsApp box on your Meta or Google Ads lead form. bizinsights records it as their consent, with Where they agreed. No: the message goes only if bizinsights already has their consent.",
      },
      { key: "consent_note", label: "Where they agreed", helpText: 'Kept with their consent, for example: Meta lead form "Spring sale", WhatsApp checkbox.' },
      {
        key: "unique_key",
        label: "Unique key",
        required: true,
        helpText: "Map the lead's or order's ID. This template goes once per key, however often the Zap runs for it (a replayed task, a copied Zap, Zapier connected again).",
      },
    ],
    perform: async (z, bundle) => {
      const d = bundle.inputData;
      const values = {};
      for (const [k, v] of Object.entries(d)) if (k.startsWith("value_") && v !== undefined && v !== null && v !== "") values[k.slice("value_".length)] = String(v);
      const response = await z.request({
        url: apiUrl("/zapier/whatsapp/messages"),
        method: "POST",
        body: {
          template_id: d.template_id,
          phone: d.phone,
          country: d.country,
          values,
          first_name: d.first_name,
          customer_agreed: d.customer_agreed,
          consent_note: d.consent_note,
          unique_key: d.unique_key,
          zap_id: bundle.meta && bundle.meta.zap ? bundle.meta.zap.id : undefined,
        },
      });
      return response.data;
    },
    sample: {
      id: "msg_example",
      status: "queued",
      duplicate: false,
      phone_masked: "+61 4•• ••• 678",
      template: { id: "tmpl_example", name: "Thanks for your enquiry", category: "transactional" },
      consent_recorded: true,
      send_after: "2026-10-29T09:00:00.000Z",
      queued_at: "2026-10-29T09:00:00.000Z",
      note: null,
      view_url: "https://bizinsights.io/dashboard/whatsapp-automation?tab=messages",
    },
    outputFields: [
      { key: "id", label: "Message ID" },
      { key: "status", label: "Status" },
      { key: "duplicate", label: "Already sent for this key", type: "boolean" },
      { key: "phone_masked", label: "Customer's number (masked)" },
      { key: "template__name", label: "Template" },
      { key: "consent_recorded", label: "Consent recorded", type: "boolean" },
      { key: "send_after", label: "Goes out from", type: "datetime" },
      { key: "note", label: "Note" },
      { key: "view_url", label: "See it in bizinsights" },
    ],
  },
};
