"use client";
import { KindsSection, PageHeader } from "@/components/whatsapp/Common";
import { OrdersList } from "@/components/whatsapp/Orders";

export default function DeliveryUpdates() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Delivery updates"
        sub="Shipping updates from Shopify's fulfillments and the courier's own tracking events. Each stage is announced once, and only when it moves the parcel forward: a late or repeated webhook never sends an update twice or out of order."
      />
      <KindsSection
        title="What customers are told"
        kinds={["order_shipped", "out_for_delivery", "order_delivered", "delivery_failed"]}
        help={
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>
              <strong>Delivered</strong> is only ever sent when the courier confirms delivery through Shopify, or when you press &ldquo;Mark delivered&rdquo; yourself. It is never
              guessed from time passing. An order with several parcels counts as delivered once every parcel is.
            </li>
            <li>
              Many couriers don&apos;t report progress to Shopify. For those, customers get &ldquo;Shipped&rdquo; with the tracking number and link, and their tracking page says live
              delivery status isn&apos;t available, rather than inventing one.
            </li>
            <li>Insights also asks Shopify every two hours where parcels in transit are, so updates arrive even when a webhook doesn&apos;t.</li>
          </ul>
        }
      />
      <OrdersList
        title="Orders on their way"
        statuses={["shipped", "in_transit", "out_for_delivery", "delivery_failed", "delivered"]}
        empty="Shipped orders appear here once Shopify reports a fulfillment."
      />
      <section className="card text-sm text-muted">
        <h2 className="font-semibold text-text">The customer&apos;s tracking page</h2>
        <p className="mt-1">
          Each order gets its own page, linked from every WhatsApp message. Its link holds a long random code: an order number alone never opens it, so nobody can look up
          someone else&apos;s order. It shows the order, payment, shipping and delivery steps with times, the courier and tracking number, the expected delivery date when the
          courier gives one, and your support contact. Open any order above to see its page. Links stop working 120 days after the order.
        </p>
      </section>
    </div>
  );
}
