import type { ReactNode } from "react";
import { Tick } from "./ui";

/** What the page promises, under its title; each is true of every platform (official APIs, refreshed by the worker, one button). */
const PROMISES = ["Secure, official APIs", "Refreshes by itself", "One-click setup"];

/**
 * Settings → Advertising's header, in the look of the Stitch design's Settings screens (prototype
 * v2, screen 30): the page's title on the page, what it is for, and the three promises. `children`:
 * the lines about this store and this member, under them.
 */
export function AdvertisingHero({ children }: { children?: ReactNode }) {
  return (
    <header>
      <h1 id="ads-hero-h" className="page-title">
        Advertising integrations
      </h1>
      <p className="mt-1 max-w-3xl text-sm text-muted sm:text-base">
        Connect your ad accounts to see Google Ads, Meta Ads and AdSense next to your Shopify sales, all in one place. bizinsights only reads: it can&apos;t create, change or pause
        your ads, or spend money.
      </p>
      <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium">
        {PROMISES.map((p) => (
          <li key={p} className="flex items-center gap-2">
            <Tick />
            {p}
          </li>
        ))}
      </ul>
      {children && <div className="mt-3 space-y-2 text-sm">{children}</div>}
    </header>
  );
}
