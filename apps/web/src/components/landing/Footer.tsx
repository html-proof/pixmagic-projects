"use client";
import Link from "next/link";
import { BrandLogo } from "@/components/Brand";

/** The only pages the footer points to; Security is the token section of the privacy page. */
const LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/privacy#access-tokens", label: "Security" },
  { href: "/support", label: "Support" },
] as const;

/**
 * A quiet sign-off in two lines: brand and links, then a hairline with the copyright and what
 * bizinsights is. Phones stack the brand over the links (each still a 44px tap target).
 * The grid and the oversized wordmark are atmosphere only and fade out before any edge.
 */
export function Footer() {
  return (
    <footer className="relative isolate overflow-hidden bg-lp-bg">
      {/* Soft top edge: a hairline that dies out at both ends, over a faint violet glow. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 mx-auto h-px max-w-[1380px] bg-[linear-gradient(90deg,transparent,var(--lp-line-strong)_30%,var(--lp-line-strong)_70%,transparent)]" />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 -z-10 h-48 w-[min(720px,90%)] -translate-x-1/2 bg-[radial-gradient(ellipse_at_50%_0%,rgb(140_123_255/0.08),transparent_70%)]"
      />
      <div
        aria-hidden
        className="lp-grid pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[70%] [mask-image:radial-gradient(ellipse_60%_100%_at_50%_100%,#000_10%,transparent_70%)] opacity-60"
      />

      {/* Oversized wordmark, rising out of the bottom edge and fading away towards it. Sized so the 11 letters fit the width the old 8-letter wordmark took. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 translate-y-[34%] select-none text-center text-[clamp(56px,13.6vw,196px)] font-semibold leading-none tracking-[-0.03em] whitespace-nowrap"
      >
        <span className="bg-[linear-gradient(180deg,rgb(255_255_255/0.07),rgb(255_255_255/0)_70%)] bg-clip-text text-transparent">bizinsights</span>
      </span>

      <div className="mx-auto max-w-[1380px] px-4 pb-[clamp(96px,14vw,216px)] pt-14 md:px-8 md:pt-20 xl:px-12">
        <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <BrandLogo size={26} className="self-start text-[16px] text-lp-text md:self-auto" />

          <nav aria-label="Footer">
            <ul className="-ml-3 flex flex-wrap items-center md:-mr-3 md:ml-0">
              {LINKS.map((l) => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    data-cursor="OPEN"
                    className="lp-focus inline-flex min-h-11 items-center rounded-lg px-3 text-[15px] text-lp-text-2 transition-colors duration-300 ease-lp hover:text-lp-text"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="mt-8 flex flex-col gap-2 border-t border-lp-line pt-6 sm:flex-row sm:items-center sm:justify-between md:mt-10">
          <p className="text-[13px] text-lp-muted">© 2026 bizinsights</p>
          <p className="lp-eyebrow">Shopify Business Intelligence</p>
        </div>
      </div>
    </footer>
  );
}
