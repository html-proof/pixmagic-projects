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
          <Faq q="How quickly do new orders show up?">
            While your dashboard is open, bizinsights checks Shopify for new orders and refunds every 5 minutes, and every night it reads the
            latest days again to catch anything missed. To check straight away, press <strong>Sync now</strong> in Settings → Shopify.
          </Faq>

          <Faq q="I placed a test order and it isn't on my dashboard.">
            Test orders (Shopify&apos;s Bogus Gateway, or a payment provider in test mode) aren&apos;t counted, just as Shopify&apos;s own
            reports leave them out. To try bizinsights on a development store, create an order in your Shopify admin instead (Orders → Create
            order, then mark it as paid).
          </Faq>

          <Faq q="Why does my dashboard only go back 60 days?">
            Shopify shares only the last 60 days of orders with an app until the store also grants it full order history. A store
            connected today grants that as it installs, and its orders are imported back to its first one, newest year first. A store
            connected earlier keeps its 60 days until you use <em>Reconnect to import full history</em> under the dates on your
            dashboard: Shopify then asks you to approve the new permission, and the earlier orders are imported.
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
            time from Settings → Shopify. Until then we hide what we cannot calculate rather than show an empty chart.
          </Faq>

          <Faq q="Shopify says the installation link cannot be used.">
            Shopify is refusing the installation; the app itself is not broken. Send us your store address and we will tell you exactly
            why, and what we can do about it.
          </Faq>

          <Faq q="How do I disconnect?">
            Uninstall bizinsights from your Shopify admin under Settings → Apps and sales channels. Your access tokens are destroyed as soon
            as Shopify notifies us, and the store&apos;s data is erased when Shopify asks us to, 48 hours later. To remove the imported
            history straight away, disconnect the store in bizinsights under Settings → Shopify. To delete everything, an owner can delete the
            whole workspace under Settings → Workspace → Delete workspace, and you can delete your account under Settings → Security; or
            write to us and we will.
          </Faq>

          <Faq q="Can I connect more than one store?">
            Yes. In bizinsights, open Settings → Shopify and click <strong>Continue with Shopify</strong>: Shopify asks which store to add and
            for your approval, then brings you back with it connected. Switch between your stores with the store selector at the top of the
            dashboard. If you install bizinsights on the other store from the Shopify App Store instead, sign in when it opens and the store
            is added to your account.
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
