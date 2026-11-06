import type { ReactNode } from "react";
import { Megaphone } from "lucide-react";
import { AdsenseIcon, GoogleAdsIcon, MetaIcon } from "@/components/BrandIcons";
import { Tick, tone } from "./ui";

/** What the page promises, under its title; each is true of every platform (official APIs, refreshed by the worker, one button). */
const PROMISES = ["Secure, official APIs", "Refreshes by itself", "One-click setup"];

/** A white tile with a platform's mark, floating in the header's picture. */
function Tile({ className, children }: { className: string; children: ReactNode }) {
  return <span className={`absolute grid size-[4.25rem] place-items-center rounded-2xl border border-border bg-white shadow-[var(--shadow-lift)] ${className}`}>{children}</span>;
}

/**
 * Settings → Advertising's header: the page's title and what it is for on a blue wash, and (on wide
 * screens) the three platforms' marks over a line going up. `children`: the lines about this store
 * and this member, under the promises.
 */
export function AdvertisingHero({ children }: { children?: ReactNode }) {
  return (
    <section
      className="card relative overflow-hidden p-5 sm:p-7"
      aria-labelledby="ads-hero-h"
      style={{
        ...tone("var(--info)"),
        background:
          "radial-gradient(420px 240px at 92% 30%, color-mix(in oklab, var(--tone) 20%, transparent), transparent 72%), linear-gradient(115deg, color-mix(in oklab, var(--tone) 11%, var(--surface)) 0%, var(--surface) 62%)",
        borderColor: "color-mix(in oklab, var(--tone) 24%, var(--border))",
      }}
    >
      <div className="relative z-10 flex flex-col gap-5 sm:flex-row sm:items-start lg:pr-[15rem]">
        <span
          className="grid size-16 shrink-0 place-items-center rounded-2xl text-[var(--surface)] shadow-[var(--shadow-lift)]"
          style={{ background: "linear-gradient(145deg, var(--tone), color-mix(in oklab, var(--tone) 55%, var(--violet)))" }}
          aria-hidden
        >
          <Megaphone size={30} strokeWidth={1.9} />
        </span>
        <div className="min-w-0">
          <h1 id="ads-hero-h" className="page-title">
            Advertising integrations
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">
            Connect your ad accounts to see Google Ads, Meta Ads and AdSense next to your Shopify sales, all in one place. bizinsights only reads: it can&apos;t create, change or pause
            your ads, or spend money.
          </p>
          <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium">
            {PROMISES.map((p) => (
              <li key={p} className="flex items-center gap-2">
                <Tick />
                {p}
              </li>
            ))}
          </ul>
          {children && <div className="mt-4 space-y-2 text-sm">{children}</div>}
        </div>
      </div>

      {/* The picture: decoration only. */}
      <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[16rem] lg:block" aria-hidden>
        <svg viewBox="0 0 304 200" className="absolute inset-0 h-full w-full" preserveAspectRatio="xMaxYMid meet" fill="none">
          <defs>
            <linearGradient id="ads-hero-rise" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="var(--tone)" stopOpacity="0" />
              <stop offset="1" stopColor="var(--tone)" stopOpacity="0.9" />
            </linearGradient>
          </defs>
          <path d="M8 186 C70 178 92 150 132 146 S196 118 226 92 S266 44 286 22" stroke="url(#ads-hero-rise)" strokeWidth="3" strokeLinecap="round" />
          <path d="M272 20 288 20 288 36" stroke="var(--tone)" strokeOpacity="0.9" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <Tile className="left-[6%] top-[38%] -rotate-6">
          <GoogleAdsIcon size={38} />
        </Tile>
        <Tile className="left-[38%] top-[12%] rotate-3">
          <MetaIcon size={26} />
        </Tile>
        <Tile className="left-[58%] top-[54%] rotate-6">
          <AdsenseIcon size={38} />
        </Tile>
      </div>
    </section>
  );
}
