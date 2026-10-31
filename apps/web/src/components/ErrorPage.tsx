import Link from "next/link";
import type { ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { BrandLogo } from "@/components/Brand";
import { CONTACT } from "@/lib/contact";

const FOOTER = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/support", label: "Support" },
] as const;

/**
 * The frame of a full-page error (an unknown address, a crash, the API out of reach): the site's top
 * bar, the message centred on the brand's background, and a short footer. In the body font, not
 * Geist: the 404 page rides along in every route's data, so a font here would be preloaded on every
 * page, and the links to the Geist pages (/, /support, the legal pages) are not prefetched for the
 * same reason (docs/architecture.md, "Fonts and prefetch").
 */
export function ErrorPage({ children }: { children: ReactNode }) {
  const link = "rounded-lg transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none";
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b border-border bg-[color-mix(in_oklab,var(--surface)_84%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link prefetch={false} href="/" aria-label="bizinsights home" className={link}>
            <BrandLogo className="text-[19px]" />
          </Link>
          <Link prefetch={false} href="/support" className={`inline-flex min-h-10 items-center gap-2 px-3 text-sm text-muted hover:bg-bg ${link}`}>
            <CircleHelp aria-hidden className="size-4" />
            Help &amp; support
          </Link>
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6 sm:py-16">{children}</main>
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-2 px-4 py-6 text-sm text-muted sm:flex-row sm:justify-between sm:px-6">
          <p>
            © {new Date().getFullYear()} {CONTACT.legalName}
          </p>
          <nav aria-label="Footer">
            <ul className="flex gap-1">
              {FOOTER.map((p) => (
                <li key={p.href}>
                  <Link prefetch={false} href={p.href} className={`inline-flex min-h-10 items-center px-2 ${link}`}>
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
