"use client";
import Link from "next/link";
import { KindsSection, PageHeader } from "@/components/whatsapp/common";
import { OrdersList } from "@/components/whatsapp/orders";

export default function OrderNotifications() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Order notifications"
        sub={
          <>
            Sent automatically from Shopify&apos;s verified order webhooks, once per order (Shopify&apos;s retries never send twice). Every message carries the customer&apos;s own
            tracking link. Nothing goes out for abandoned checkouts or orders that fail at payment, and nothing until you&apos;ve chosen how customers agree to updates in{" "}
            <Link className="text-accent underline" href="/whatsapp/settings">Settings</Link>.
          </>
        }
      />
      <KindsSection
        title="What customers are told"
        help="Turn each message on and choose its approved template. Processing and Packed come from tags you add to the order in Shopify (set the tag names in Settings), or from the buttons on an order's timeline."
        kinds={["order_confirmation", "payment_confirmed", "order_processing", "order_packed", "order_cancelled", "refund_processed"]}
      />
      <OrdersList title="Recent orders" empty="Orders appear here as Shopify reports them, from when WhatsApp was turned on." />
    </div>
  );
}
