import type { Metadata } from "next";
import Link from "next/link";
import { CONTACT, contactReady, orUnset } from "@/lib/contact";

export const metadata: Metadata = {
  title: "Privacy policy — Insights",
  description: "What Insights collects from a connected Shopify store, why, and how to have it deleted.",
};

/**
 * Required for the Shopify App Store listing, and linked from the install flow.
 *
 * Every claim here is a statement about what the code actually does. Before changing the
 * schema or the scopes, change this page too:
 *   - no customer personal data is stored (packages/core/src/persist.ts: `customerKey` is a
 *     keyed HMAC, and orders keep no name, email, address or phone);
 *   - tokens are AES-256-GCM encrypted at rest (packages/core/src/tokens.ts);
 *   - uninstall wipes tokens and the compliance webhooks redact/purge (apps/worker/src/handlers.ts);
 *   - the funnel stores hashed browser ids and cleaned page paths only (apps/api/src/routes/pixel.ts,
 *     packages/shared/src/journey.ts `cleanPath`).
 */
export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Privacy policy</h1>
      <p className="mt-2 text-sm text-muted">
        Insights is an analytics dashboard for Shopify merchants. This policy explains what it reads from a connected
        store, what it keeps, and how to have that deleted.
      </p>

      {!contactReady && (
        <div className="card mt-6 border-amber-500/40 bg-amber-500/5">
          <p className="text-sm">
            <strong>This policy is incomplete.</strong> The controller identity and support contact are not set yet, so
            the placeholders below are not publishable. Fill in <code>apps/web/src/lib/contact.ts</code> and redeploy
            before submitting the app for review.
          </p>
        </div>
      )}

      <Section title="Who we are">
        <p>
          {orUnset(CONTACT.legalName)} is the controller of the data described here. Reach us at{" "}
          {CONTACT.supportEmail ? (
            <a className="underline" href={`mailto:${CONTACT.supportEmail}`}>
              {CONTACT.supportEmail}
            </a>
          ) : (
            orUnset(CONTACT.supportEmail)
          )}
          . Postal address: {orUnset(CONTACT.postalAddress)}.
        </p>
      </Section>

      <Section title="What we read from your store">
        <p>
          When you connect a store we ask Shopify for two permissions:{" "}
          <code>read_orders</code> and <code>read_products</code>. With them we read, through Shopify&apos;s Admin API:
        </p>
        <ul>
          <li>
            <strong>Orders</strong> — order number, time, currency, status, sales channel, fulfilment status and time,
            discount codes, and the money totals (subtotal, discounts, tax, shipping, total).
          </li>
          <li>
            <strong>Order line items</strong> — product and variant reference, SKU, quantity and price.
          </li>
          <li>
            <strong>Refunds</strong> — amount and the date the refund was created.
          </li>
          <li>
            <strong>Products</strong> — title, status, vendor, type, and per-variant price, stock level and unit cost.
          </li>
          <li>
            <strong>Store settings</strong> — shop name, currency and time zone, so figures are shown in your terms.
          </li>
        </ul>
        <p>
          <strong>We do not store your customers&apos; personal data.</strong> No names, email addresses, postal
          addresses or phone numbers are saved in our database. The one place the dashboard shows them, described
          under &ldquo;Customers to follow up&rdquo; below, reads them from Shopify while you look.
          Where the dashboard distinguishes new from returning buyers, it uses a one-way keyed hash of the Shopify
          customer id, scoped to the single store, from which no identity can be recovered.
        </p>
        <p>
          <strong>Shopping funnel (only if you turn it on).</strong> It needs two more permissions,{" "}
          <code>write_pixels</code> and <code>read_customer_events</code>, and adds a Shopify web pixel to your
          storefront. The pixel runs only for shoppers who accept analytics tracking, and sends five events: viewed a
          page, viewed a product, added to cart, started checkout and completed checkout. Each event carries its
          time, the page address, and Shopify&apos;s anonymous browser id. We keep the page address without its query
          string, and we never keep checkout, order-status or account addresses, because those carry a shopper&apos;s
          token. The browser id is stored only as a one-way hash. From these we record each visit&apos;s landing
          page, its last page, how far it got and which parts of the store it saw. No names, email addresses or IP
          addresses are stored.
        </p>
        <p>
          <strong>Customers to follow up (only if you allow access to your customers).</strong> To help you get back in
          touch, the dashboard shows the name, email address and phone number of shoppers who left an unfinished checkout,
          signed up for your newsletter, or recently became customers, together with whether they agreed to marketing
          emails. Insights reads these from Shopify each time you open that card and shows them only to members of your
          workspace who are owners, admins or analysts. They are not saved in our database. We only record that the card
          was viewed, and by whom, in your workspace&apos;s audit log.
        </p>
      </Section>

      <Section title="What we store about you">
        <p>
          Your email address, whether it has been verified, your workspace and role, your notification preferences, and
          an audit log of actions taken in your workspace. Sign-in is handled by Google Firebase Authentication; we
          never see or store your Shopify password.
        </p>
      </Section>

      <Section title="Access tokens">
        <p>
          The access token Shopify issues for your store is encrypted with AES-256-GCM before it is written down, with
          each ciphertext cryptographically bound to the store it belongs to. Tokens are never returned by our API, are
          never shown in the dashboard, and are destroyed when you uninstall the app.
        </p>
      </Section>

      <Section title="Why we process it">
        <p>
          To provide the dashboard you asked for — that is, to perform our contract with you. We do not sell your data,
          we do not share it with advertisers, and we do not use it to train machine-learning models.
        </p>
      </Section>

      <Section title="Who else sees it">
        <p>Only the processors needed to run the service:</p>
        <ul>
          <li>
            <strong>Cloudflare</strong> — hosting, request routing and background jobs.
          </li>
          <li>
            <strong>Google Firebase</strong> — authentication and sign-in emails.
          </li>
          <li>
            <strong>Shopify</strong> — the source of the store data.
          </li>
        </ul>
        <p>Other members of your workspace see your store&apos;s figures, according to the role you gave them.</p>
      </Section>

      <Section title="How long we keep it">
        <p>
          Store data is kept while the app is installed. Uninstalling the app from Shopify immediately destroys the
          stored access tokens, and we act on Shopify&apos;s mandatory data-request, customer-redact and shop-redact
          webhooks. Disconnecting a store in Settings → Stores deletes its orders and metrics from Insights. To have
          your whole workspace and account deleted, write to {orUnset(CONTACT.supportEmail)}.
        </p>
      </Section>

      <Section title="Your rights">
        <p>
          You may ask us for a copy of your data, for corrections, or for deletion, and you may object to processing or
          ask us to restrict it. Write to {orUnset(CONTACT.supportEmail)} and we will answer within 30 days. If you are
          in the UK or the EEA you may also complain to your data protection authority. This policy is governed by the
          law of {orUnset(CONTACT.jurisdiction)}.
        </p>
        <p>
          A shopper who wants data held by a merchant should contact that merchant: we hold no shopper identities, so we
          cannot identify an individual on their behalf.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          If this policy changes materially we will tell workspace owners by email before the change takes effect.
        </p>
      </Section>

      <p className="mt-10 text-sm text-muted">
        Questions about the app itself? See <Link className="underline" href="/support">support</Link>.
      </p>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-medium">{title}</h2>
      <div className="mt-2 space-y-3 text-sm [&_code]:text-xs [&_li]:ml-4 [&_li]:list-disc [&_ul]:space-y-1">
        {children}
      </div>
    </section>
  );
}
