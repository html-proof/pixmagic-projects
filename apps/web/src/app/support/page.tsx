import type { Metadata } from "next";
import Link from "next/link";
import { ContactCard, LegalPage, LegalSection } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Support — bizinsights",
  description: "How to get help with bizinsights, and answers to the questions merchants ask first.",
};

/**
 * Shopify app store requirement 4.1 expects a reachable support contact. Three error messages
 * tell a merchant to "contact support" (`app_unavailable` in apps/api/src/routes/shopify.ts and
 * the two /start and /onboarding pages), so this page is where they land.
 */
export default function SupportPage() {
  return (
    <LegalPage
      current="/support"
      eyebrow="Help"
      title="Support"
      intro={<p>How to reach us, and answers to the questions merchants ask most often.</p>}
    >
      <LegalSection id="contact" title="Contact us">
        <ContactCard title="Email our support team" subject="bizinsights support">
          We reply within one business day. Please include your <strong>store&apos;s .myshopify.com address</strong> and, where it
          applies, the dates the figures look wrong for.
        </ContactCard>
      </LegalSection>

      <LegalSection id="faq" title="Common questions">
        <dl className="divide-y divide-border">
          <Faq q="Why does my dashboard only go back 60 days?">
            The <code>read_orders</code> permission Shopify grants is limited to the last 60 days of orders. Longer history needs an
            additional permission (<code>read_all_orders</code>) that Shopify grants on request. Let us know if you need it and we will
            apply.
          </Faq>

          <Faq q="My figures don't match another analytics app. Which one is wrong?">
            Usually neither. The common causes are the day boundary (we use your store&apos;s time zone), refunds (we record a refund on
            the day it was issued, not the day the order was placed), and what &ldquo;sales&rdquo; means: our gross sales exclude tax and
            shipping, so an app reporting the order total always reads higher. Send us the day and the two figures and we will reconcile
            them with you.
          </Faq>

          <Faq q="Why can't I see sessions, conversion rate or new versus returning customers?">
            Those need extra permissions — storefront tracking and customer records — that bizinsights does not request when you install
            it. Each card that needs one has an Enable button on your dashboard that asks Shopify for it, and you can withdraw it at any
            time from Settings → Stores. Until then we hide what we cannot calculate rather than show an empty chart.
          </Faq>

          <Faq q="Shopify says the installation link cannot be used.">
            Shopify is refusing the installation; the app itself is not broken. Send us your store address and we will tell you exactly
            why, and what we can do about it.
          </Faq>

          <Faq q="How do I disconnect?">
            Uninstall bizinsights from your Shopify admin under Settings → Apps and sales channels. Your access tokens are destroyed as soon
            as Shopify notifies us. To remove the imported history as well, disconnect the store in Settings → Stores, or write to us and
            we will delete your whole workspace and account.
          </Faq>

          <Faq q="Can I connect more than one store?">
            Yes. Go to Settings → Stores and connect another store, then switch between them with the store selector on the dashboard.
          </Faq>
        </dl>
      </LegalSection>

      <LegalSection id="privacy" title="Your data">
        <p>
          What we collect and how we protect it is set out in our <Link href="/privacy">privacy policy</Link>. To delete what came from
          Google or Meta, see <Link href="/data-deletion">Delete your data</Link>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="py-5 first:pt-0 last:pb-0">
      <dt className="font-semibold text-text">{q}</dt>
      <dd className="mt-1.5">{children}</dd>
    </div>
  );
}
