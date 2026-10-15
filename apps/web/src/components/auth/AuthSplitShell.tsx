import type { ReactNode } from "react";
import Link from "next/link";
import { GeistSans } from "geist/font/sans";
import { AuthLogo } from "./AuthBrand";
import { AuthShowcase } from "./AuthShowcase";

/**
 * The frame of the sign-in, create-account and password-reset pages: one card split in two, the
 * showcase on the left (wide screens only) and the form on the right, with a link to the other
 * auth page (`action`) in its top bar.
 */
export function AuthSplitShell({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <main className={`${GeistSans.className} flex min-h-svh flex-col items-center justify-center px-4 py-6 sm:px-6 lg:py-10`}>
      <div className="grid w-full max-w-[1200px] overflow-hidden rounded-[28px] border border-border bg-surface shadow-[var(--shadow-lift)] lg:min-h-[min(780px,calc(100svh-6rem))] lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1fr)]">
        <AuthShowcase />
        <section className="flex flex-col px-6 py-7 sm:px-12 sm:py-10 xl:px-16">
          <div className="mx-auto flex w-full max-w-[520px] flex-1 flex-col">
            <header className="flex items-center justify-between gap-4">
              <AuthLogo />
              {action && (
                <Link
                  href={action.href}
                  className="rounded-full border border-border bg-surface px-5 py-2.5 text-sm font-medium shadow-[var(--shadow)] transition hover:border-[color-mix(in_oklab,var(--accent)_40%,var(--border))] hover:bg-bg focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                >
                  {action.label}
                </Link>
              )}
            </header>
            <div className="flex flex-1 flex-col justify-center pt-10 pb-2 lg:pt-12">
              <h1 className="text-[32px] leading-tight font-bold tracking-tight sm:text-[36px]">{title}</h1>
              {subtitle && <p className="mt-2 text-[15px] text-muted sm:text-base">{subtitle}</p>}
              <div className="mt-7 space-y-5">{children}</div>
            </div>
          </div>
        </section>
      </div>
      {/*
        Several failures on these pages tell the merchant to "contact support", and the Shopify
        listing has to link a privacy policy, so both live on every auth and install screen.
      */}
      <p className="mt-5 text-xs text-muted">
        <Link className="underline" href="/support">Support</Link>
        {" · "}
        <Link className="underline" href="/privacy">Privacy</Link>
      </p>
    </main>
  );
}
