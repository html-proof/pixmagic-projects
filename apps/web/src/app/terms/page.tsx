import type { Metadata } from "next";
import Link from "next/link";
import { BellRing, Eye, LogOut, ShieldCheck } from "lucide-react";
import { ContactCard, LegalPage, LegalSection, SupportEmail, sectionsOf } from "@/components/legal/LegalPage";
import { BRAND_NAME } from "@/components/Brand";
import { CONTACT } from "@/lib/contact";

export const metadata: Metadata = {
  title: "Terms of service — bizinsights",
  description: "The terms on which bizinsights provides its analytics dashboard for Shopify merchants.",
};

/**
 * The "Application terms of service link" on Google's OAuth branding page (Google Auth Platform →
 * Branding): Google requires homepage, privacy and terms links for external production apps
 * before it verifies branding. Signing up accepts these terms (the checkbox on /signup).
 *
 * Every promise here must stay true of the code, and agree with /privacy: read-only use of the
 * Google and Meta ad platforms, deletion on disconnect, no selling of data, opt-outs honoured by
 * WhatsApp messaging, and charges approved in Shopify (apps/api/src/routes/workspaces.ts).
 * Revise UPDATED with any material change; owners are emailed first (see "Changes to these terms").
 */
const UPDATED = "2026-11-13";

const TOC = [
  { id: "who-we-are", title: "Who we are" },
  { id: "the-service", title: "What bizinsights does" },
  { id: "your-account", title: "Your account and workspace" },
  { id: "acceptable-use", title: "Acceptable use" },
  { id: "messages", title: "Messages you send" },
  { id: "your-data", title: "Your data" },
  { id: "other-platforms", title: "Shopify, Google and Meta" },
  { id: "fees", title: "Fees" },
  { id: "availability", title: "Availability and accuracy" },
  { id: "liability", title: "Liability" },
  { id: "ending", title: "Ending your use" },
  { id: "changes", title: "Changes to these terms" },
  { id: "governing-law", title: "Governing law" },
  { id: "contact", title: "Contact us" },
] as const;
const section = sectionsOf(TOC);

const HIGHLIGHTS = [
  {
    icon: Eye,
    title: "Read-only on your ad accounts",
    text: "bizinsights never creates, changes or pauses an ad, never touches a budget or billing, and never spends money.",
  },
  {
    icon: ShieldCheck,
    title: "Your data stays yours",
    text: "We use it only to run bizinsights for you. We do not sell it or use it for advertising or to train models.",
  },
  {
    icon: LogOut,
    title: "Leave whenever you like",
    text: "Disconnect an account or uninstall the app at any time; what came from it is deleted.",
  },
  {
    icon: BellRing,
    title: "Changes announced first",
    text: "If these terms change materially, workspace owners hear from us by email before the change takes effect.",
  },
] as const;

export default function TermsPage() {
  return (
    <LegalPage
      current="/terms"
      eyebrow="Legal"
      title="Terms of service"
      updated={UPDATED}
      toc={TOC}
      intro={
        <p>
          These terms apply when you use bizinsights, the analytics dashboard for Shopify merchants. Please read them together with our{" "}
          <Link className="underline" href="/privacy">
            privacy policy
          </Link>
          , which explains what we collect and how we protect it.
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
          {CONTACT.legalName === BRAND_NAME ? "These terms are between you and bizinsights" : <>bizinsights is operated by {CONTACT.legalName}{CONTACT.companyNumber && <> ({CONTACT.companyNumber})</>}</>}{" "}
          (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;)
          {CONTACT.postalAddress && <>, {CONTACT.postalAddress}</>}. You can reach us at <SupportEmail subject="Terms of service" />.
        </p>
        <p>
          By creating an account or connecting a store you agree to these terms, on behalf of yourself and of the business you connect.
          If you do not agree, please do not use bizinsights.
        </p>
      </LegalSection>

      <LegalSection {...section("the-service")}>
        <p>
          bizinsights reads the data you choose to connect and shows it to you as reports in your own workspace: your Shopify store and,
          only if you connect them, your Google Ads, Google AdSense and Meta Ads accounts. If you turn them on, bizinsights also sends the
          WhatsApp messages and emails you set up (see section 5).
        </p>
        <p>
          bizinsights only reads from Google Ads, AdSense and Meta Ads. It never creates, changes or pauses an ad, never changes a budget or
          billing setting, and never spends money on your behalf. What we read, keep and delete is set out in the{" "}
          <Link href="/privacy">privacy policy</Link>, which forms part of these terms.
        </p>
      </LegalSection>

      <LegalSection {...section("your-account")}>
        <ul>
          <li>Keep your sign-in details to yourself. You are responsible for what happens in your workspace.</li>
          <li>Only connect stores and accounts you are allowed to connect, and keep the details you give us accurate.</li>
          <li>
            The people you invite to your workspace see its figures according to the role you give them. You are responsible for whom
            you invite, and for removing access when someone leaves.
          </li>
        </ul>
      </LegalSection>

      <LegalSection {...section("acceptable-use")}>
        <p>Please don&apos;t misuse bizinsights. In particular, do not:</p>
        <ul>
          <li>try to reach another workspace&apos;s data, or get around the roles and limits of your own;</li>
          <li>disrupt, overload or probe the service, or reverse-engineer it except where the law allows;</li>
          <li>use bizinsights to send unlawful, misleading or unsolicited messages;</li>
          <li>resell or share access to bizinsights without our written agreement.</li>
        </ul>
      </LegalSection>

      <LegalSection {...section("messages")}>
        <p>
          If you turn on WhatsApp messaging, bizinsights sends the messages you set up, in your business&apos;s
          name and from the number you connect. You are responsible for their content, for having each recipient&apos;s consent where
          the law requires it, and for following the anti-spam and privacy laws that apply to you and the policies of WhatsApp.
        </p>
        <p>
          bizinsights records opt-outs and does not message anyone again who replied STOP on WhatsApp.
        </p>
      </LegalSection>

      <LegalSection {...section("your-data")}>
        <p>
          The data you connect stays yours. You allow us to process it only to provide bizinsights to you. We do not sell it, we do not use
          it for advertising, and we do not use it to train machine-learning models.
        </p>
        <p>
          You can disconnect any store or account at any time in Settings, which deletes what bizinsights fetched from it. How to remove
          the data that came from Google and Meta is explained on <Link href="/data-deletion">Delete your data</Link>.
        </p>
      </LegalSection>

      <LegalSection {...section("other-platforms")}>
        <p>
          Shopify, Google and Meta provide the data bizinsights shows, and deliver the messages it sends, under their own terms, which you
          accept with them. If one of them changes or withdraws access, the parts of bizinsights that depend on it may stop working until
          it is restored.
        </p>
      </LegalSection>

      <LegalSection {...section("fees")}>
        <p>
          Where bizinsights offers a paid plan, its price is shown before you choose it, and nothing is charged until you approve the plan in
          Shopify. Shopify bills the charge with your store&apos;s Shopify invoice.
        </p>
      </LegalSection>

      <LegalSection {...section("availability")}>
        <p>
          We work to keep bizinsights running and its figures accurate, but we provide it &ldquo;as is&rdquo; and cannot promise it will
          always be available or free of errors. Figures come from the connected platforms and can be delayed or later corrected by them;
          ad platforms, for example, credit conversions late. Please check important decisions against the source platform.
        </p>
      </LegalSection>

      <LegalSection {...section("liability")}>
        <p>
          To the extent the law allows, we are not liable for indirect or consequential loss, or for loss of profit, revenue or data,
          arising from your use of bizinsights.
        </p>
        <p>
          Nothing in these terms excludes or limits rights you have under consumer law that cannot be excluded, including under the
          Australian Consumer Law.
        </p>
      </LegalSection>

      <LegalSection {...section("ending")}>
        <p>
          You can stop using bizinsights at any time: uninstall the app in Shopify and disconnect your accounts, or ask us at{" "}
          <SupportEmail subject="Delete my account" /> to delete your workspace and account.
        </p>
        <p>We may suspend a workspace that breaks these terms, and will tell you why.</p>
      </LegalSection>

      <LegalSection {...section("changes")}>
        <p>
          If we make a material change to these terms, we will notify workspace owners by email before the change takes effect. The date
          at the top of this page shows when they were last updated.
        </p>
      </LegalSection>

      <LegalSection {...section("governing-law")}>
        <p>These terms are governed by the laws of {CONTACT.jurisdiction}.</p>
      </LegalSection>

      <LegalSection {...section("contact")}>
        <ContactCard title="Questions about these terms?" subject="Terms of service">
          Write to us and we will get back to you. For help with the app itself, see <Link className="underline" href="/support">Support</Link>.
        </ContactCard>
      </LegalSection>
    </LegalPage>
  );
}
