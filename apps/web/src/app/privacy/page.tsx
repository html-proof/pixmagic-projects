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
 *   - analytics store no customer personal data (packages/core/src/persist.ts: `customerKey` is a
 *     keyed HMAC, and orders keep no name, email, address or phone);
 *   - WhatsApp messaging, only once a merchant turns it on, stores customers' WhatsApp numbers and
 *     first names encrypted, with the retention in packages/core/src/whatsapp/scheduler.ts
 *     (RETENTION) and redaction in packages/core/src/whatsapp/events.ts (redactWhatsappCustomer);
 *   - tokens are AES-256-GCM encrypted at rest (packages/core/src/tokens.ts);
 *   - uninstall wipes tokens and the compliance webhooks redact/purge (apps/worker/src/handlers.ts);
 *   - the funnel stores hashed browser ids and cleaned page paths only (apps/api/src/routes/pixel.ts,
 *     packages/shared/src/journey.ts `cleanPath`);
 *   - ad accounts are read-only in use (Meta ads_read, Google adwords for Google Ads reporting, adsense.readonly) and
 *     their daily figures and token are deleted, and the grant revoked, on disconnect (apps/api/src/routes/ads.ts,
 *     packages/core/src/adConnections.ts); /data-deletion is the Meta app's deletion instructions URL.
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
          <strong>Analytics store none of your customers&apos; personal data.</strong> No names, email addresses,
          postal addresses or phone numbers are saved for the dashboard. The one place it shows them, described
          under &ldquo;Customers to follow up&rdquo; below, reads them from Shopify while you look. WhatsApp messaging,
          only if you turn it on, is the exception described below.
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
        <p>
          <strong>WhatsApp messaging (only if you connect WhatsApp).</strong> To send your customers the order updates,
          delivery updates, cart reminders, review requests and campaigns you switch on, Insights keeps each
          customer&apos;s WhatsApp number and first name, encrypted with AES-256-GCM, plus a one-way keyed hash of the
          number to recognise replies; the dashboard shows numbers masked. It keeps what each customer agreed to, and
          every opt-out, so nobody who said STOP is messaged again. Delivery addresses are used only to write the
          order confirmation and are deleted once it is sent. Messages are sent through Meta&apos;s WhatsApp Business
          Platform. Message history is kept for 180 days, unfinished-checkout links and names for 30 days, and order
          timelines for a year. Customers&apos; reviews are kept until you delete your store from Insights. When Shopify
          asks us to erase a customer or your store, all of it is deleted.
        </p>
        <p>
          <strong>Advertising accounts (only if you connect them).</strong> With your permission on Meta&apos;s or Google&apos;s own
          screen, Insights reads your ad accounts&apos; reports: Meta Ads with <code>ads_read</code>, Google Ads with Google&apos;s
          <code>adwords</code> permission (Google offers no read-only Google Ads permission; Insights only reads with it), and
          Google AdSense with <code>adsense.readonly</code>. It reads account names, ids, currency and time zone; campaign, ad
          group, ad set and ad names, status, type and budget; and what was spent, shown, reached, clicked and the conversions
          and purchases the platform credits to its ads, per day, by device and by country; and, for AdSense, your site&apos;s
          estimated earnings, page views and clicks. It keeps those figures so the dashboard can compare periods, and deletes
          them, with the access token, when you disconnect the account, and gives the access back to Meta or Google. Insights
          never creates, changes or pauses an ad, never changes a budget or billing, and never spends money.
        </p>
        <p>
          Insights&apos; use and transfer of information received from Google APIs adheres to the{" "}
          <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>,
          including the Limited Use requirements: the data is used only to show you your own reports, it is not sold, not used
          for advertising and not read by people, except with your permission, for security, or where the law requires it.
        </p>
      </Section>

      <Section title="What we store about you">
        <p>
          Your email address, whether it has been verified, your workspace and role, your notification preferences, and
          an audit log of actions taken in your workspace. Sign-in is handled by Google Firebase Authentication; we
          never see or store your Shopify password.
        </p>
      </Section>

      <Section title="Access tokens" id="access-tokens">
        <p>
          The access token Shopify issues for your store is encrypted with AES-256-GCM before it is written down, with
          each ciphertext cryptographically bound to the store it belongs to. Tokens are never returned by our API, are
          never shown in the dashboard, and are destroyed when you uninstall the app. The tokens Meta and Google issue
          when you connect WhatsApp or an ad account are kept the same way, and destroyed when you disconnect it.
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
          <li>
            <strong>Meta (WhatsApp Business Platform)</strong> — delivers WhatsApp messages, only for stores that connect
            WhatsApp.
          </li>
          <li>
            <strong>Meta (Marketing API) and Google (Google Ads API, AdSense)</strong> — the source of advertising reports, only
            for stores that connect an ad account.
          </li>
        </ul>
        <p>Other members of your workspace see your store&apos;s figures, according to the role you gave them.</p>
      </Section>

      <Section title="How long we keep it">
        <p>
          Store data is kept while the app is installed. Uninstalling the app from Shopify immediately destroys the
          stored access tokens, and we act on Shopify&apos;s mandatory data-request, customer-redact and shop-redact
          webhooks. Disconnecting a store in Settings → Stores deletes its orders and metrics from Insights. To have
          your whole workspace and account deleted, write to {orUnset(CONTACT.supportEmail)}. How to remove what came
          from Meta (WhatsApp and ad accounts) is on <Link className="underline" href="/data-deletion">Delete your data</Link>.
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

/** `id` makes a section linkable (the homepage footer's "Security" link opens #access-tokens). */
function Section({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-8 scroll-mt-6">
      <h2 className="text-lg font-medium">{title}</h2>
      <div className="mt-2 space-y-3 text-sm [&_code]:text-xs [&_li]:ml-4 [&_li]:list-disc [&_ul]:space-y-1">
        {children}
      </div>
    </section>
  );
}
