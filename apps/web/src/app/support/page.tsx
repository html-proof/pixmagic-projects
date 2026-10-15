import type { Metadata } from "next";
import Link from "next/link";
import { CONTACT } from "@/lib/contact";

export const metadata: Metadata = {
  title: "Support — Insights",
  description: "How to get help with Insights, and answers to the questions merchants ask first.",
};

/**
 * Shopify app store requirement 4.1 expects a reachable support contact. Three error messages
 * tell a merchant to "contact support" (`app_unavailable` in apps/api/src/routes/shopify.ts and
 * the two /start and /onboarding pages), so this page is where they land.
 */
export default function SupportPage() {
  const mail = CONTACT.supportEmail;
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Support</h1>

      {mail && (
        <p className="mt-4 text-sm">
          Email{" "}
          <a className="underline" href={`mailto:${mail}`}>
            {mail}
          </a>{" "}
          and we will come back to you within one business day. It helps a lot if you include your{" "}
          <strong>store&apos;s .myshopify.com address</strong> and, where it applies, the date the numbers look wrong
          for.
        </p>
      )}

      <h2 className="mt-10 text-lg font-medium">Questions we get first</h2>
      <dl className="mt-3 space-y-6 text-sm">
        <Faq q="Why does my dashboard only go back 60 days?">
          The <code>read_orders</code> permission Shopify grants is limited to the last 60 days of orders. Longer
          history needs an additional permission (<code>read_all_orders</code>) that Shopify grants on request; tell us
          if you need it and we will apply.
        </Faq>

        <Faq q="My figures do not match another analytics app. Which is wrong?">
          Usually neither. The common causes are the day boundary (we use your store&apos;s time zone), refunds (we put
          a refund on the day it was issued, not the day the order was placed), and what &ldquo;sales&rdquo; means — our
          gross sales exclude tax and shipping, so an app reporting the order total always reads higher. Send us the day
          and the two figures and we will reconcile it with you.
        </Faq>

        <Faq q="Why can I not see sessions, conversion rate or new-versus-returning customers?">
          Those need extra permissions — storefront tracking and customer records — that Insights does not take when you
          install it. Each card that needs one has an Enable button on your dashboard that asks Shopify for it, and you
          can give it back any time from Settings → Stores. Until then we hide what we cannot calculate rather than show
          you an empty chart.
        </Faq>

        <Faq q="Shopify says the installation link cannot be used.">
          That means Shopify is refusing the install, not that the app is broken. Send us your store address and we will
          tell you exactly why and what we can do about it.
        </Faq>

        <Faq q="How do I disconnect?">
          Uninstall Insights from your Shopify admin under Settings → Apps and sales channels. Your access tokens are
          destroyed the moment Shopify tells us. To remove the imported history as well, disconnect the store in
          Settings → Stores, or write to us and we will delete your whole workspace and account.
        </Faq>

        <Faq q="Can I connect more than one store?">
          Yes. Settings → Stores → connect another, and switch between them from the store selector on the dashboard.
        </Faq>
      </dl>

      <p className="mt-10 text-sm text-muted">
        How we handle your data: <Link className="underline" href="/privacy">privacy policy</Link>.
      </p>
    </main>
  );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-medium">{q}</dt>
      <dd className="mt-1 text-muted [&_code]:text-xs">{children}</dd>
    </div>
  );
}
