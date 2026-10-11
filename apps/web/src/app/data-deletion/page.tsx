import type { Metadata } from "next";
import Link from "next/link";
import { CONTACT, orUnset } from "@/lib/contact";

export const metadata: Metadata = {
  title: "Delete your data — Insights",
  description:
    "How to remove Insights' access to your Google (Google Ads, AdSense) and Meta (WhatsApp, Facebook and Instagram ads) accounts and delete the data it holds.",
};

/**
 * The "Data deletion instructions URL" in Insights' Meta app settings (App settings → Basic →
 * User data deletion), and the Google data deletion instructions for the OAuth verification of
 * Google Ads / AdSense. Every step here is what the code does: disconnecting deletes the encrypted
 * token and the data fetched with it, then revokes the platform grant once no other connection relies
 * on it (apps/api/src/routes/ads.ts DELETE .../ads/connections/:id, adConnections.ts
 * revokeAdAccessIfUnused; packages/core/src/whatsapp/connect.ts disconnectWhatsapp), and access the
 * person removes at Google or Meta turns the connection to "reconnect" at its next use.
 */
export default function DataDeletionPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Delete your data</h1>
      <p className="mt-2 text-sm text-muted">
        How to take back the access you gave Insights through Google (Google Ads, Google AdSense) or Meta (WhatsApp Business, Facebook and Instagram ads), and have the
        data that came with it deleted.
      </p>

      <Section title="1. Disconnect in Insights (immediate)">
        <p>
          Sign in to Insights and open <strong>Settings → Connect your business</strong> (or <strong>Settings → Advertising</strong>). Press{" "}
          <strong>Disconnect</strong> next to Google Ads, Google AdSense, Meta Ads or WhatsApp.
        </p>
        <ul>
          <li>
            <strong>Google Ads and Google AdSense:</strong> the access token and every number Insights fetched for those accounts (spend, impressions, clicks,
            conversions, campaign names; AdSense earnings and page views) are deleted straight away, and Insights gives the access back to Google once no other
            account you connected with the same Google login still uses it (Google Ads and AdSense share one Google sign-in). Your ads and your site keep running.
          </li>
          <li>
            <strong>Meta Ads:</strong> the access token and every number Insights fetched for those ad accounts (spend, impressions, reach, clicks, purchases, campaign and ad
            names) are deleted straight away, and Insights withdraws its ads_read permission at Meta once no other ad account you connected with the same Facebook login
            still uses it. Your ads keep running.
          </li>
          <li>
            <strong>WhatsApp:</strong> the access token, your number&apos;s registration PIN and its message templates are deleted, and messages waiting to go out are
            cancelled. Message history is kept for your records for 180 days and then deleted (or straight away, on request, see 3).
          </li>
        </ul>
      </Section>

      <Section title="2. Remove Insights in your Google or Meta account (optional)">
        <p>
          <strong>Google:</strong> open <strong>myaccount.google.com → Security → Your connections to third-party apps &amp; services</strong>, choose Insights and remove
          its access. Google then withdraws Insights&apos; access to Google Ads and AdSense; Insights shows those accounts as &ldquo;Needs reconnecting&rdquo; and stops
          reading from them.
        </p>
        <p>
          <strong>Meta:</strong>
          In Facebook, go to <strong>Settings &amp; privacy → Settings → Business integrations</strong> (or, for a business portfolio,{" "}
          <strong>Meta Business Suite → Settings → Integrations → Connected apps</strong>), find Insights and remove it. Meta then withdraws Insights&apos; access; Insights
          shows the connection as &ldquo;Permission expired&rdquo; and stops reading from it.
        </p>
        <p>
          Removing access at Google or Meta alone doesn&apos;t delete what Insights already holds: use step 1 or 3 for that.
        </p>
      </Section>

      <Section title="3. Ask us to delete everything">
        <p>
          Write to {orUnset(CONTACT.supportEmail)} from the email address you sign in with, and say which workspace or store. We delete your Meta connections, the data
          fetched with them and, if you ask, your Insights account and workspace, and confirm by email within 30 days. The same goes for your Google Ads and AdSense
          connections.
        </p>
      </Section>

      <p className="mt-10 text-sm text-muted">
        What Insights keeps, and why, is in the <Link className="underline" href="/privacy">privacy policy</Link>.
      </p>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-medium">{title}</h2>
      <div className="mt-2 space-y-3 text-sm [&_li]:ml-4 [&_li]:list-disc [&_ul]:space-y-1">{children}</div>
    </section>
  );
}
