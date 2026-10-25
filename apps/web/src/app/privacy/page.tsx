import type { Metadata } from "next";
import Link from "next/link";
import { EyeOff, Lock, ShieldCheck, Trash2 } from "lucide-react";
import { ContactCard, LegalPage, LegalSection, SupportEmail, sectionsOf } from "@/components/legal/LegalPage";
import { BRAND_NAME } from "@/components/Brand";
import { CONTACT } from "@/lib/contact";

export const metadata: Metadata = {
  title: "Privacy policy — bizinsights",
  description: "What bizinsights collects from a connected Shopify store, why, how it is protected, and how to have it deleted.",
};

/**
 * Required for the Shopify App Store listing, and linked from the install flow.
 *
 * Every claim here is a statement about what the code actually does. Before changing the
 * schema or the scopes, change this page too:
 *   - analytics store no customer personal data (packages/core/src/persist.ts: `customerKey` is a
 *     keyed HMAC, and orders keep no name, email, address or phone);
 *   - WhatsApp Automation, only once a merchant connects WhatsApp, stores the WhatsApp numbers and first
 *     names of customers it messages, who write in, or who agree to marketing, encrypted, with their
 *     consent history and message texts, the retention in packages/core/src/whatsapp/sweep.ts
 *     (KEEP_RECORDS_MS, KEEP_RUNS_MS, the store's retentionDays) and redaction in
 *     packages/core/src/whatsapp/privacy.ts (redactWhatsappCustomer); a linked phone's WhatsApp
 *     session and a Cloud API number's access token are kept by bizinsights' own WhatsApp service
 *     (Evolution API on AWS, docs/whatsapp.md), the token also encrypted in wapp_connections;
 *   - Customer Messaging (SMS), only once a merchant sets up a sender, stores customers' mobile numbers
 *     and first names encrypted, their SMS consent history and opt-outs, with the retention in
 *     packages/core/src/sms/sweep.ts (SMS_RETENTION) and redaction in packages/core/src/sms/privacy.ts;
 *   - tokens are AES-256-GCM encrypted at rest (packages/core/src/tokens.ts);
 *   - uninstall wipes tokens and the compliance webhooks redact/purge (apps/worker/src/handlers.ts);
 *   - the funnel stores hashed browser ids, cleaned page paths, the products each visit saw, added to cart,
 *     took to checkout and bought, and one word each for the kind of device, the country and where the visit
 *     came from; the referring host and link tags the pixel sends for that are not kept (apps/api/src/routes/pixel.ts,
 *     packages/shared/src/journey.ts `cleanPath`, packages/shared/src/funnel.ts `funnelDevice`, `arrivalSource`);
 *   - ad accounts are read-only in use (Meta ads_read, Google adwords for Google Ads reporting, adsense.readonly) and
 *     their daily figures and token are deleted, and the grant revoked, on disconnect (apps/api/src/routes/ads.ts,
 *     packages/core/src/adConnections.ts); /data-deletion is the Meta app's deletion instructions URL, and Meta's
 *     deauthorize and data deletion callbacks (POST /webhooks/meta/deauthorize, /webhooks/meta/data-deletion, once
 *     their URLs are set in the Meta app; until then the next update finds the token ended) stop the reading and
 *     delete the Meta Ads figures; Google sign-in keeps the email and the Cognito user name (auth_identities,
 *     and the removal note in auth_events);
 *   - Staff Management keeps what the merchant enters about employees, and the IP address and browser of each
 *     clock-in and clock-out from the employee portal (packages/core/src/staff/attendance.ts), until the
 *     workspace is deleted (docs/staff.md, "Retention");
 *   - bizinsights' own email (sign-in codes through Cognito's custom email sender, invitations, alerts) goes
 *     through Resend (apps/aws/src/mailers.ts, cognitoEmail.ts);
 *   - Cloudflare proxies bizinsights.io in front of CloudFront (infra/cdk/lib/cloudflare.ts) and still runs the
 *     old Worker until the cutover.
 * Revise UPDATED with any material change; owners are emailed first (see "Changes to this policy").
 */
const UPDATED = "2026-10-25";

const TOC = [
  { id: "who-we-are", title: "Who we are" },
  { id: "store-data", title: "Information from your store" },
  { id: "optional-features", title: "Optional features" },
  { id: "google-user-data", title: "Google user data" },
  { id: "your-account", title: "Your account" },
  // The homepage footer's "Security" link opens #access-tokens.
  { id: "access-tokens", title: "Security and access tokens" },
  { id: "how-we-use", title: "How we use information" },
  { id: "service-providers", title: "Service providers" },
  { id: "retention", title: "Retention and deletion" },
  { id: "your-rights", title: "Your rights" },
  { id: "shoppers", title: "Information for shoppers" },
  { id: "governing-law", title: "Governing law" },
  { id: "changes", title: "Changes to this policy" },
  { id: "contact", title: "Contact us" },
] as const;
const section = sectionsOf(TOC);

const HIGHLIGHTS = [
  {
    icon: EyeOff,
    title: "No shopper identities in analytics",
    text: "The figures we store hold no names, email addresses, postal addresses or phone numbers of your customers.",
  },
  {
    icon: Lock,
    title: "Encrypted access",
    text: "Every access token is encrypted with AES-256-GCM, never returned by our API and never shown in the dashboard.",
  },
  {
    icon: ShieldCheck,
    title: "Never sold",
    text: "We do not sell your data, share it with advertisers or use it to train machine-learning models.",
  },
  {
    icon: Trash2,
    title: "Deleted when you leave",
    text: "Uninstalling destroys your tokens at once; disconnecting deletes the data that came with them.",
  },
] as const;

const PROVIDERS = [
  {
    name: "Amazon Web Services",
    purpose: "Hosting, the database, storage and background jobs, in Sydney, Australia; accounts and sign-in through Amazon Cognito.",
  },
  {
    name: "Cloudflare",
    purpose:
      "Runs our domain's DNS and the network in front of bizinsights.io (encryption in transit, caching of static files, protection against attacks): every visit to the site passes through it on its way to Amazon Web Services, so it handles your IP address and the pages you request. It was also our previous hosting provider and keeps serving our old address, and the data of stores connected there, until that is retired.",
  },
  {
    name: "Resend",
    purpose: "Sends bizinsights' own emails: sign-in and verification codes, team invitations and alerts, to the address each one is for.",
  },
  { name: "Shopify", purpose: "The source of your store data." },
  { name: "Meta (WhatsApp)", purpose: "Delivers WhatsApp messages and reports whether each was delivered and read, only for stores that connect WhatsApp (a linked phone, or Meta's WhatsApp Business Platform)." },
  {
    name: "Nango",
    purpose: "Keeps, encrypted, the access tokens for the advertising accounts you connect, and renews them, so bizinsights can read your ad reports.",
  },
  { name: "Amazon Web Services (AWS End User Messaging SMS)", purpose: "Delivers text messages, only for stores that set up Customer Messaging, and reports whether each was delivered and what it cost." },
  {
    name: "Meta (Marketing API) and Google (Google Ads API, AdSense)",
    purpose: "The source of advertising reports, only for stores that connect an advertising account.",
  },
  {
    name: "Google (Gmail API), Microsoft (Microsoft Graph) or your own SMTP provider",
    purpose: "Send the emails you set up, from the account you connect, only for workspaces that connect one.",
  },
] as const;

export default function PrivacyPage() {
  return (
    <LegalPage
      current="/privacy"
      eyebrow="Legal"
      title="Privacy policy"
      updated={UPDATED}
      toc={TOC}
      intro={
        <p>
          bizinsights is an analytics dashboard for Shopify merchants. This policy explains what we collect when you connect a store and
          the services you choose to link to it, why we collect it, how we protect it, and how to have it deleted.
        </p>
      }
    >
      <ul className="mb-10 grid gap-3 sm:grid-cols-2" aria-label="At a glance">
        {HIGHLIGHTS.map(({ icon: Icon, title, text }) => (
          <li key={title} className="flex gap-3 rounded-xl border border-border bg-bg p-4">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] text-accent">
              <Icon aria-hidden className="size-[18px]" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{title}</span>
              <span className="mt-0.5 block text-sm leading-relaxed text-muted">{text}</span>
            </span>
          </li>
        ))}
      </ul>

      <LegalSection {...section("who-we-are")}>
        <p>
          {CONTACT.legalName === BRAND_NAME ? (
            <>bizinsights (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;) is the controller of the personal data described in this policy.</>
          ) : (
            <>
              bizinsights is operated by {CONTACT.legalName}
              {CONTACT.companyNumber && <> ({CONTACT.companyNumber})</>} (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;), the controller of the
              personal data described in this policy.
            </>
          )}{" "}
          You can contact us at <SupportEmail subject="Privacy" />
          {CONTACT.postalAddress && <> or by post at {CONTACT.postalAddress}</>}.
        </p>
      </LegalSection>

      <LegalSection {...section("store-data")}>
        <p>
          When you connect a store, we ask Shopify for two permissions, <code>read_orders</code> and <code>read_products</code>. With
          them we read the following through Shopify&apos;s Admin API:
        </p>
        <ul>
          <li>
            <strong>Orders</strong> — order number, time, currency, status, sales channel, fulfilment status and time, discount codes,
            and the money totals (subtotal, discounts, tax, shipping and total).
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
            <strong>Store settings</strong> — shop name, currency and time zone, so that figures are shown in your terms.
          </li>
        </ul>
        <h3>Your customers&apos; personal data</h3>
        <p>
          The analytics we store contain none of your customers&apos; personal data: no names, email addresses, postal addresses or
          phone numbers are saved for the dashboard. The one feature that shows them, Customers to follow up, reads them from Shopify
          while you look. WhatsApp and text messaging, if you turn them on, are the only exceptions. They are described in section 3. Where the
          dashboard distinguishes new from returning buyers, it uses a one-way keyed hash of the Shopify customer ID, scoped to a
          single store, from which no identity can be recovered.
        </p>
      </LegalSection>

      <LegalSection {...section("optional-features")}>
        <p>The following features collect further information only if you turn them on.</p>

        <h3>Shopping funnel</h3>
        <p>
          The funnel needs two further permissions, <code>write_pixels</code> and <code>read_customer_events</code>, and adds a
          Shopify web pixel to your storefront. The pixel runs only for shoppers who accept analytics tracking, and sends five events:
          page viewed, product viewed, added to cart, checkout started and checkout completed. Each event carries its time, the page
          address and Shopify&apos;s anonymous browser ID. When a shopper arrives from outside your store, the page view also carries
          the name of the website they came from (its domain only, never the page), the link&apos;s campaign tags{" "}
          <code>utm_source</code> and <code>utm_medium</code>, and whether the link carried an ad click ID (only that it did, never the
          ID). Adds to cart and checkouts also carry which products they hold.
        </p>
        <p>
          We keep the page address without its query string, and never keep checkout, order-status or account addresses, because those
          carry a shopper&apos;s token. The browser ID is stored only as a one-way hash. From these events we record each visit&apos;s
          landing page, last page, how far it progressed, which parts of the store and which product pages it viewed, which products
          it added to cart, took to checkout and bought, the kind of device it came from (mobile, tablet or desktop, read from the
          browser&apos;s own description of itself), its country (as our network places the request) and one word for where it came
          from (for example Google, Instagram, Email or Direct). The website name and campaign tags are used to choose that word and
          are not kept. No names, email addresses or IP addresses are stored.
        </p>

        <h3>Customers to follow up (only if you allow access to your customers)</h3>
        <p>
          To help you get back in touch, the dashboard shows the name, email address and phone number of shoppers who left a checkout
          unfinished, signed up for your newsletter or recently became customers, together with whether they agreed to receive
          marketing emails. bizinsights reads this information from Shopify each time you open that card, and shows it only to the
          workspace&apos;s owners and admins and to members given permission to see customers&apos; contact details. It is not saved in our
          database; we record only that the card was viewed, and by whom, in your workspace&apos;s audit log.
        </p>

        <h3>WhatsApp messaging (WhatsApp Automation)</h3>
        <p>
          To send the order updates, reminders, campaigns and replies you set up, bizinsights keeps the WhatsApp number and first name of
          the customers an automation messages, who write to your business, or who agree to receive your marketing on WhatsApp. Both are
          encrypted with AES-256-GCM, together with a one-way keyed hash of the number used to recognise replies; the dashboard shows
          numbers masked. We keep a record of every consent and opt-out (when, how, and who recorded it), so that nobody who replied STOP
          is messaged again, and the text of each message sent and received, encrypted, with its delivery reports. Messages leave through
          bizinsights&apos; own WhatsApp service, which runs on our AWS infrastructure: either from a phone you link with a QR code (the
          service keeps that phone&apos;s WhatsApp session, as WhatsApp Web does, until you disconnect) or through Meta&apos;s WhatsApp
          Business Platform (the service keeps your WhatsApp Business account&apos;s access token, encrypted). Messages from people who
          aren&apos;t already your customers in bizinsights are not kept, except a STOP, which is recorded only as a keyed hash of the
          number.
        </p>
        <p>
          Message texts are kept for the period you choose in WhatsApp settings (90 days unless you change it, at most 365 days) and the
          rest of each message&apos;s record for 365 days; what a failed message needs to be sent again, for at most 7 days; WhatsApp&apos;s
          update notifications until they are processed (one that can&apos;t be processed, for up to 30 days); and automation run
          records for 90 days. Records from bizinsights&apos; earlier WhatsApp feature (before 24 October 2026) are kept unchanged
          until they are removed. When Shopify asks us to erase a customer or your store, all of it is deleted, including those earlier
          records.
        </p>

        <h3>Text messages (Customer Messaging)</h3>
        <p>
          To send the order updates, checkout reminders and campaigns you set up, bizinsights keeps each customer&apos;s mobile number
          and first name, encrypted with AES-256-GCM, together with a one-way keyed hash of the number. The dashboard shows numbers
          masked. We keep the customer&apos;s text-message marketing consent as Shopify reports it, a history of every change to it with
          where it came from, and every opt-out, so that nobody who opted out is texted again. Marketing texts go only to customers
          who agreed to them in Shopify, and each one carries a link that stops them at once. Texts are sent through AWS End User
          Messaging, which reports whether each one was delivered and what it cost.
        </p>
        <p>
          The words of each text are kept for 30 days after it is delivered or fails, delivery reports for 180 days, unfinished
          checkouts for 90 days (their links for 30), and the record of which texts were sent, and what they cost, for 13 months. When
          Shopify asks us to erase a customer, their numbers, consent history and texts are deleted; we keep only a one-way hash of an
          opted-out number, so that their opt-out keeps working. When Shopify asks us to erase your store, all of it is deleted.
        </p>

        <h3>Advertising accounts</h3>
        <p>
          With your permission, given on Meta&apos;s or Google&apos;s own consent screen, bizinsights reads your advertising reports: Meta
          Ads with <code>ads_read</code>, Google Ads with Google&apos;s <code>adwords</code> permission (Google offers no read-only
          Google Ads permission; bizinsights uses it only to read), and Google AdSense with <code>adsense.readonly</code>. We read:
        </p>
        <ul>
          <li>account names, IDs, currency and time zone;</li>
          <li>campaign, ad group, ad set and ad names, status, type and budget;</li>
          <li>
            spend, impressions, reach and clicks, and the conversions and purchases the platform attributes to its ads, per day, by
            device and by country;
          </li>
          <li>for AdSense, your site&apos;s estimated earnings, page views and clicks.</li>
        </ul>
        <p>
          We keep these figures so the dashboard can compare periods. With each connection we also keep the platform&apos;s ID for the
          person who signed in (Google&apos;s account ID, Meta&apos;s app-scoped user ID) and the permissions they granted, so that
          disconnecting returns access only when no other account you connected relies on it.
        </p>
        <p>
          When you disconnect an account, bizinsights deletes its figures and access token immediately and then returns the access to
          Google or Meta (Google Ads and AdSense share one Google sign-in, so Google&apos;s access is returned with the last of them). If
          you instead remove bizinsights&apos; access in your Google account, bizinsights stops reading at its next update, shows the
          account as &ldquo;Reconnect required&rdquo; and keeps the figures already fetched until you disconnect it or ask us to delete them
          (see <Link href="/data-deletion">Delete your data</Link>). bizinsights never creates, changes or pauses an ad, never changes a
          budget or billing setting, and never spends money.
        </p>
        <p>
          You can also remove bizinsights from Facebook, under <strong>Settings &amp; privacy → Settings → Business integrations</strong>.
          Its access ends there, and bizinsights stops reading your Meta ad accounts: at once when Facebook lets it know, and at the latest
          at its next update. If you then send
          Facebook&apos;s data deletion request for bizinsights (listed under the apps you removed), bizinsights deletes the Meta Ads figures
          and the access it holds for that Facebook login, and Facebook gives you a confirmation code and a link where you can check the
          request&apos;s status.
        </p>

        <h3>Staff Management</h3>
        <p>
          If you use Staff Management, bizinsights keeps what you enter about your employees: name, work email and phone number, job title,
          department, employment type, start date, working days and hours, pay rates and schedules, and the timesheets, payroll runs and
          payment records (amount, method and any reference you add) that follow from them. Employees you invite get a sign-in of their own
          to see their schedule, timesheets and pay; when they clock in or out there, we record the time and the IP address and browser of
          the device they used. Only the workspace&apos;s owners and admins, and members you give Staff permissions, see these records.
        </p>
        <p>
          Staff records are kept for as long as your workspace exists, because payroll records usually have to be kept for a period set
          by law; deleting the workspace deletes them.
        </p>

        <h3>Email sending</h3>
        <p>To send the emails your automations and tests request, bizinsights connects to the mailbox you choose:</p>
        <ul>
          <li>
            <strong>Gmail or Google Workspace</strong> — permission only to send email as you (<code>gmail.send</code>) and your email
            address;
          </li>
          <li>
            <strong>Outlook or Microsoft 365</strong> — only <code>Mail.Send</code> and your basic profile;
          </li>
          <li>
            <strong>Any other provider</strong> — the SMTP server, user name and password you enter.
          </li>
        </ul>
        <p>
          bizinsights never reads, searches or deletes the mail in your mailbox. Tokens and passwords are encrypted with AES-256-GCM,
          never shown again, and deleted when you disconnect the account (Google&apos;s access is also revoked at that point).
        </p>
        <p>
          For each email we keep the recipient (encrypted, with a one-way keyed hash and a masked form for the activity log), the
          subject, the sender and the provider&apos;s response — never the body, which is filled in from your template when the email
          is sent. The details of the order or event an automation refers to are kept encrypted for up to 35 days, so that a delayed
          email can still be written; the activity log is kept for 180 days. Addresses that unsubscribe or bounce are kept as a keyed
          hash so they are not emailed again. When Shopify asks us to erase a customer or your store, their email events and messages
          are deleted.
        </p>
      </LegalSection>

      <LegalSection {...section("google-user-data")}>
        <p>
          bizinsights&apos; use and transfer of information received from Google APIs adheres to the{" "}
          <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>,
          including the Limited Use requirements. Google user data is used only to show you your own reports and to send the emails
          you set up. It is not sold, not used for advertising, and not read by people, except with your permission, for security
          purposes, or where the law requires it.
        </p>
      </LegalSection>

      <LegalSection {...section("your-account")}>
        <p>
          We store your email address and whether it has been verified, your workspace and role, your notification preferences, and an
          audit log of actions taken in your workspace. Sign-in is handled by Amazon Cognito, which keeps your password only as a
          salted hash, and the codes it emails you are sent through Resend. We never store your password, and we never see your Shopify
          or Google password.
        </p>
        <p>
          If you sign in with Google, Google shares your name, email address and Google account ID with Amazon Cognito when you allow it
          on Google&apos;s screen. We keep that email address and an identifier that includes the Google account ID with your account, so
          Google sign-in reaches it. When you remove Google from your sign-in methods in Settings → Security, the link is deleted and your
          account&apos;s security history notes the removal, so that Google account can&apos;t sign in again unless you link it again.
        </p>
      </LegalSection>

      <LegalSection {...section("access-tokens")}>
        <p>
          The access token Shopify issues for your store is encrypted with AES-256-GCM before it is stored, and each ciphertext is
          cryptographically bound to the store it belongs to. Tokens are never returned by our API, never shown in the dashboard, and
          destroyed when you uninstall the app.
        </p>
        <p>
          The tokens Meta and Google issue when you connect WhatsApp or an advertising account are protected in the same way and
          destroyed when you disconnect it. Email account tokens and SMTP passwords are also encrypted, each with its own key, and
          destroyed when you disconnect the account.
        </p>
      </LegalSection>

      <LegalSection {...section("how-we-use")}>
        <p>
          We process this information to provide the dashboard and the features you ask for — that is, to perform our contract with
          you. We do not sell your data, we do not share it with advertisers, and we do not use it to train machine-learning models.
        </p>
      </LegalSection>

      <LegalSection {...section("service-providers")}>
        <p>We share information only with the service providers needed to run bizinsights:</p>
        <dl className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {PROVIDERS.map((p) => (
            <div key={p.name} className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] sm:gap-6">
              <dt className="font-medium text-text">{p.name}</dt>
              <dd>{p.purpose}</dd>
            </div>
          ))}
        </dl>
        <p>Other members of your workspace see your store&apos;s figures according to the role you give them.</p>
      </LegalSection>

      <LegalSection {...section("retention")}>
        <p>
          We keep store data for as long as the app is installed. Uninstalling the app from Shopify immediately destroys the stored
          access tokens. Shopify then asks us, 48 hours later, to erase the store, and we delete everything we hold about it,
          including the store itself. Disconnecting a store in bizinsights under Settings → Shopify deletes its orders and metrics at once.
        </p>
        <p>
          When one of your customers asks your store what data it holds about them, Shopify tells us, and the store&apos;s owners and
          admins can download what bizinsights holds about that customer from Settings → Privacy requests, to send it to them. When a
          customer asks to be erased, Shopify tells us and we delete what we hold about them.
        </p>
        <p>
          To have your entire workspace and account deleted, email <SupportEmail subject="Delete my account" />. How to remove the data
          that came from Meta and Google is explained on <Link href="/data-deletion">Delete your data</Link>.
        </p>
      </LegalSection>

      <LegalSection {...section("your-rights")}>
        <p>
          You may ask us for a copy of your data, to correct it or to delete it, and you may object to its processing or ask us to
          restrict it. Email <SupportEmail subject="Privacy request" /> and we will respond within 30 days.
        </p>
        <p>
          If you are not satisfied with our response, you may complain to the Office of the Australian Information Commissioner or, if
          you are in the UK or the EEA, to your local data protection authority.
        </p>
      </LegalSection>

      <LegalSection {...section("shoppers")}>
        <p>
          If you bought from a store that uses bizinsights, we process your information on behalf of that merchant. To access or delete
          it, please contact the merchant: when they pass your request on through Shopify, we give them a copy of what we hold about
          you, or erase it.
        </p>
      </LegalSection>

      <LegalSection {...section("governing-law")}>
        <p>This policy is governed by the laws of {CONTACT.jurisdiction}.</p>
      </LegalSection>

      <LegalSection {...section("changes")}>
        <p>
          If we make a material change to this policy, we will notify workspace owners by email before the change takes effect. The
          date at the top of this page shows when it was last updated.
        </p>
      </LegalSection>

      <LegalSection {...section("contact")}>
        <ContactCard title="Questions about this policy?" subject="Privacy">
          Write to us and we will respond within 30 days. For help with the app itself, see <Link className="underline" href="/support">Support</Link>.
        </ContactCard>
      </LegalSection>
    </LegalPage>
  );
}
