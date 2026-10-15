import type { ReactNode } from "react";
import Link from "next/link";
import { GeistSans } from "geist/font/sans";
import { ChevronDown, Mail } from "lucide-react";
import { BrandLogo } from "@/components/Brand";
import { CONTACT } from "@/lib/contact";

/**
 * The frame of the public legal and help pages (/privacy, /terms, /data-deletion, /support), which Shopify,
 * Google and Meta reviewers open from the app listings: a top bar back to the site, the page title
 * with its revision date, a numbered contents list beside the text on wide screens (folded above it
 * on phones), and a footer with the controller's name.
 */

const PAGES = [
  { href: "/privacy", label: "Privacy policy" },
  { href: "/terms", label: "Terms of service" },
  { href: "/data-deletion", label: "Data deletion" },
  { href: "/support", label: "Support" },
] as const;

export type LegalHref = (typeof PAGES)[number]["href"];
export type TocEntry = { id: string; title: string };

/** Props for each numbered section, looked up by id so the contents list and the headings never disagree. */
export function sectionsOf<const T extends readonly TocEntry[]>(toc: T) {
  return (id: T[number]["id"]) => {
    const i = toc.findIndex((e) => e.id === id);
    return { id, n: i + 1, title: toc[i].title };
  };
}

const longDate = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export function LegalPage({
  current,
  eyebrow,
  title,
  intro,
  updated,
  toc,
  children,
}: {
  current: LegalHref;
  eyebrow: string;
  title: string;
  intro: ReactNode;
  /** ISO date of the last material revision, shown under the title. */
  updated?: string;
  toc?: readonly TocEntry[];
  children: ReactNode;
}) {
  return (
    <div className={`${GeistSans.className} legal-page flex min-h-svh flex-col`}>
      <header className="sticky top-0 z-20 border-b border-border bg-[color-mix(in_oklab,var(--surface)_84%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/" aria-label="bizinsights home" className="rounded-lg focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
            <BrandLogo className="text-[19px]" />
          </Link>
          <nav aria-label="Legal and help" className="hidden sm:block">
            <ul className="flex items-center gap-1">
              {PAGES.map((p) => (
                <li key={p.href}>
                  <Link
                    href={p.href}
                    aria-current={p.href === current ? "page" : undefined}
                    className="inline-flex min-h-10 items-center rounded-lg px-3 text-sm text-muted transition-colors hover:bg-bg hover:text-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none aria-[current=page]:font-medium aria-[current=page]:text-text"
                  >
                    {p.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-12 pb-20 sm:px-6 sm:pt-16">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold tracking-[0.14em] text-accent uppercase">{eyebrow}</p>
          <h1 className="mt-3 text-[34px] leading-[1.1] font-bold tracking-tight sm:text-[44px]">{title}</h1>
          <div className="mt-4 text-base leading-relaxed text-muted sm:text-[17px]">{intro}</div>
          {updated && (
            <p className="mt-5 text-sm text-muted">
              Last updated <time dateTime={updated}>{longDate.format(new Date(updated))}</time>
            </p>
          )}
        </div>

        <div className={`mt-10 grid gap-8 ${toc ? "lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-14" : "max-w-3xl"}`}>
          {toc && <Contents toc={toc} />}
          <article className="min-w-0 rounded-2xl border border-border bg-surface px-5 py-8 shadow-[var(--shadow)] sm:px-10 sm:py-10">
            {children}
          </article>
        </div>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>
            © {new Date().getFullYear()} {CONTACT.legalName}. All rights reserved.
          </p>
          <nav aria-label="Footer">
            <ul className="-mx-2 flex flex-wrap">
              {[{ href: "/", label: "Home" }, ...PAGES].map((p) => (
                <li key={p.href}>
                  <Link className="inline-flex min-h-10 items-center rounded-md px-2 transition-colors hover:text-text" href={p.href}>
                    {p.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </footer>
    </div>
  );
}

/** Numbered links to the sections: a sticky column on wide screens, a fold-out above the text on phones. */
function Contents({ toc }: { toc: readonly TocEntry[] }) {
  const list = (
    <ol className="space-y-0.5 text-sm">
      {toc.map((e, i) => (
        <li key={e.id}>
          <a
            href={`#${e.id}`}
            className="flex gap-3 rounded-md px-2 py-1.5 text-muted transition-colors hover:bg-bg hover:text-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <span className="w-5 shrink-0 text-right tabular-nums opacity-70">{i + 1}.</span>
            <span>{e.title}</span>
          </a>
        </li>
      ))}
    </ol>
  );
  return (
    <aside>
      <details className="group rounded-xl border border-border bg-surface shadow-[var(--shadow)] lg:hidden">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 text-sm font-medium [&::-webkit-details-marker]:hidden">
          On this page
          <ChevronDown aria-hidden className="size-4 text-muted transition-transform group-open:rotate-180" />
        </summary>
        <nav aria-label="On this page" className="border-t border-border px-2 py-2">
          {list}
        </nav>
      </details>
      <nav aria-label="On this page" className="sticky top-24 hidden lg:block">
        <p className="mb-3 px-2 text-xs font-semibold tracking-[0.12em] text-muted uppercase">On this page</p>
        {list}
      </nav>
    </aside>
  );
}

export function LegalSection({ id, n, title, children }: { id: string; n?: number; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="legal-section scroll-mt-24">
      <h2 id={`${id}-title`} className="flex items-baseline gap-3 text-xl font-semibold tracking-tight">
        {n !== undefined && <span className="text-sm font-semibold tabular-nums text-accent">{String(n).padStart(2, "0")}</span>}
        {title}
      </h2>
      <div className="legal-prose mt-4">{children}</div>
    </section>
  );
}

/** The support address as a mail link, or the support page while no address is set. */
export function SupportEmail({ subject }: { subject?: string }) {
  const mail = CONTACT.supportEmail;
  if (!mail) return <Link href="/support">our support page</Link>;
  return <a href={`mailto:${mail}${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`}>{mail}</a>;
}

/** A highlighted panel with the support address as a button. */
export function ContactCard({ title, children, subject }: { title: string; children: ReactNode; subject?: string }) {
  const mail = CONTACT.supportEmail;
  return (
    <div className="flex flex-col gap-5 rounded-xl border border-[color-mix(in_oklab,var(--accent)_28%,var(--border))] bg-[color-mix(in_oklab,var(--accent)_6%,var(--surface))] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        <div className="mt-1 text-sm leading-relaxed text-muted">{children}</div>
      </div>
      {mail ? (
        <a className="btn-primary shrink-0 px-5 py-2.5 no-underline" href={`mailto:${mail}${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`}>
          <Mail aria-hidden className="size-4" />
          {mail}
        </a>
      ) : (
        <Link className="btn-primary shrink-0 px-5 py-2.5 no-underline" href="/support">
          Contact support
        </Link>
      )}
    </div>
  );
}
