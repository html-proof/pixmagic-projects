import type { Metadata } from "next";
import Link from "next/link";
import { ContactCard, LegalPage, LegalSection, SupportEmail, sectionsOf } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Delete your data — bizinsights",
  description:
    "How to remove bizinsights' access to your Google (Google Ads, AdSense) and Meta (WhatsApp, Facebook and Instagram ads) accounts and delete the data it holds.",
};

/**
 * The "Data deletion instructions URL" in bizinsights' Meta app settings (App settings → Basic →
 * User data deletion), and the Google data deletion instructions for the OAuth verification of
 * Google Ads / AdSense. Every step here is what the code does: disconnecting deletes the encrypted
 * token and the data fetched with it, then revokes the platform grant once no other connection relies
 * on it (apps/api/src/routes/ads.ts DELETE .../ads/connections/:id, adConnections.ts
 * revokeAdAccessIfUnused; packages/core/src/whatsapp/connect.ts disconnectWhatsapp), and access the
 * person removes at Google or Meta turns the connection to "reconnect" at its next use.
 */
const UPDATED = "2026-10-16";

const TOC = [
  { id: "disconnect", title: "Disconnect in bizinsights" },
  { id: "remove-access", title: "Remove access at Google or Meta" },
  { id: "ask-us", title: "Ask us to delete everything" },
] as const;
const section = sectionsOf(TOC);

export default function DataDeletionPage() {
  return (
    <LegalPage
      current="/data-deletion"
      eyebrow="Legal"
      title="Delete your data"
      updated={UPDATED}
      toc={TOC}
      intro={
        <p>
          How to withdraw the access you gave bizinsights through Google (Google Ads, Google AdSense) or Meta (WhatsApp Business, Facebook
          and Instagram ads), and have the data that came with it deleted.
        </p>
      }
    >
      <LegalSection {...section("disconnect")}>
        <p>
          <strong>Takes effect immediately.</strong> Sign in to bizinsights and open <strong>Settings → Connect your business</strong> (or{" "}
          <strong>Settings → Advertising</strong>), then select <strong>Disconnect</strong> next to Google Ads, Google AdSense, Meta Ads
          or WhatsApp.
        </p>
        <ul>
          <li>
            <strong>Google Ads and Google AdSense</strong> — the access token and every figure bizinsights fetched for those accounts (spend,
            impressions, clicks, conversions and campaign names; AdSense earnings and page views) are deleted immediately. bizinsights then
            returns the access to Google once no other account you connected with the same Google login still uses it (Google Ads and
            AdSense share one Google sign-in). Your ads and your site keep running.
          </li>
          <li>
            <strong>Meta Ads</strong> — the access token and every figure bizinsights fetched for those ad accounts (spend, impressions,
            reach, clicks, purchases, and campaign and ad names) are deleted immediately. bizinsights then withdraws its{" "}
            <code>ads_read</code> permission at Meta once no other ad account you connected with the same Facebook login still uses it.
            Your ads keep running.
          </li>
          <li>
            <strong>WhatsApp</strong> — the access token, your number&apos;s registration PIN and its message templates are deleted, and
            messages waiting to be sent are cancelled. Message history is kept for your records for 180 days and then deleted, or
            immediately on request (see step 3).
          </li>
        </ul>
      </LegalSection>

      <LegalSection {...section("remove-access")}>
        <p>
          <strong>Optional.</strong> You can also withdraw bizinsights&apos; access from your Google or Meta account.
        </p>
        <ul>
          <li>
            <strong>Google</strong> — open <strong>myaccount.google.com → Security → Your connections to third-party apps &amp; services</strong>,
            choose bizinsights and remove its access. Google then withdraws bizinsights&apos; access to Google Ads and AdSense; bizinsights shows
            those accounts as &ldquo;Needs reconnecting&rdquo; and stops reading from them.
          </li>
          <li>
            <strong>Meta</strong> — in Facebook, go to <strong>Settings &amp; privacy → Settings → Business integrations</strong> (or, for a
            business portfolio, <strong>Meta Business Suite → Settings → Integrations → Connected apps</strong>), find bizinsights and remove
            it. Meta then withdraws bizinsights&apos; access; bizinsights shows the connection as &ldquo;Permission expired&rdquo; and stops
            reading from it.
          </li>
        </ul>
        <p>Removing access at Google or Meta does not by itself delete what bizinsights already holds. Use step 1 or step 3 for that.</p>
      </LegalSection>

      <LegalSection {...section("ask-us")}>
        <p>
          Email <SupportEmail subject="Delete my data" /> from the address you sign in with, and tell us which workspace or store the
          request concerns. We will delete your Google and Meta connections and the data fetched with them and, if you ask, your bizinsights
          account and workspace, and confirm by email within 30 days.
        </p>
        <ContactCard title="Request deletion" subject="Delete my data">
          Send the request from the email address you sign in with.
        </ContactCard>
        <p>
          What bizinsights keeps, and why, is set out in our <Link href="/privacy">privacy policy</Link>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
