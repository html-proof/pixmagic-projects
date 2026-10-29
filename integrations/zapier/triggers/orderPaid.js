const { hookTrigger } = require("../lib/hookTrigger");

// Never who bought it: no name, email, address, phone, customer id or discount code.
module.exports = hookTrigger({
  key: "order_paid",
  event: "order_paid",
  noun: "Order",
  label: "Order Paid",
  description: "Triggers when one of the store's Shopify orders is paid: its number, amounts and items. The customer's details are never sent.",
  sample: {
    id: "order_paid:store_example:5550001",
    event: "order_paid",
    occurred_at: "2026-10-28T09:00:00.000Z",
    store: { id: "store_example", name: "Example Store", shop_domain: "example.myshopify.com" },
    data: {
      order_id: "5550001",
      order_name: "#1001",
      currency: "AUD",
      total_price: 129.9,
      subtotal: 119.9,
      total_discounts: 10,
      total_tax: 11.81,
      total_shipping: 10,
      financial_status: "paid",
      items: 2,
      line_items: [{ product_id: "7001", variant_id: "8001", sku: "TEE-BLK-M", title: "Black T-shirt", quantity: 2, price: 59.95 }],
      sales_channel: "web",
      processed_at: "2026-10-28T08:59:00.000Z",
    },
  },
  outputFields: [
    { key: "data__order_name", label: "Order number" },
    { key: "data__order_id", label: "Shopify order ID" },
    { key: "data__total_price", label: "Total", type: "number" },
    { key: "data__currency", label: "Currency" },
    { key: "data__items", label: "Items", type: "integer" },
    { key: "data__sales_channel", label: "Sales channel" },
    { key: "data__processed_at", label: "Placed at", type: "datetime" },
  ],
});
