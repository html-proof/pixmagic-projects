const { apiUrl } = require("../lib/api");

// Hidden: the "Send WhatsApp Template Message" action's template dropdown. The store's templates Meta
// approved, for a connection allowed to send (anything else is refused with bizinsights' words).
module.exports = {
  key: "whatsapp_templates",
  noun: "WhatsApp Template",
  display: {
    label: "WhatsApp Templates",
    description: "Lists the store's WhatsApp templates that can send now, for choosing one in an action.",
    hidden: true,
  },
  operation: {
    perform: async (z) => (await z.request({ url: apiUrl("/zapier/whatsapp/templates") })).data,
    sample: {
      id: "tmpl_example",
      name: "Thanks for your enquiry",
      category: "transactional",
      category_label: "Order update",
      language: "en",
      body: "Hi {{customer_first_name}}, thanks for getting in touch with {{store_name}}. Reply here and we'll help.",
      variables: ["customer_first_name"],
      automatic: ["store_name"],
    },
    outputFields: [
      { key: "id", label: "Template ID" },
      { key: "name", label: "Name" },
      { key: "category_label", label: "Kind" },
      { key: "body", label: "Text" },
    ],
  },
};
