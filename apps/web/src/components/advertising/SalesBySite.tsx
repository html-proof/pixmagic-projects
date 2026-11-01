"use client";
import Link from "next/link";
import { Users } from "lucide-react";
import type { AdSpendProvider } from "@app/shared/ads";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { BarRow } from "@/components/dashboard/Charts";
import { plural } from "@/components/dashboard/format";
import type { Overview } from "@/components/dashboard/types";
import { AdCard, EmptyNote } from "./AdCard";
import { PLATFORM } from "./AdvertisingUi";
import { SourceBadge } from "./sources";

// ---------------------------------------------------------------------------
// Where the ad platforms' shoppers came from, from the store's own orders (the visit Shopify recorded
// before each): Facebook against Instagram, Google against YouTube, by sales. The ad platforms' own
// audience splits (age, gender, country, device, placement) are read live on their pages, never stored,
// so this card points there instead of asking every platform on every visit to the overview.
// ---------------------------------------------------------------------------

export function SalesBySite({ ov }: { ov: Overview }) {
  const m = ov.modules.ads_from_shopify;
  const sites = m?.platforms.flatMap((p) => p.sources.map((s) => ({ ...s, provider: p.provider }))) ?? [];
  const total = sites.reduce((n, s) => n + s.sales, 0);
  const max = Math.max(0, ...sites.map((s) => s.sales));
  const customers = ov.modules.customers?.current;
  const money = (n: number) => fmtMoney(n, m?.currency ?? ov.store.currency);
  return (
    <AdCard
      id="ads-sales-by-site"
      title="Audience: where buyers came from"
      sub="Your Shopify orders whose last visit came from each site: ads, posts and search results together."
      icon={Users}
      tint="violet"
      action={m ? <SourceBadge provider="meta" source="shopify" /> : undefined}
    >
      {!m ? (
        <EmptyNote>Your orders&apos; visit sources aren&apos;t available to you here.</EmptyNote>
      ) : total <= 0 ? (
        <EmptyNote>No sales from Facebook, Instagram, Google or YouTube in these dates.</EmptyNote>
      ) : (
        <ul className="space-y-3" data-testid="ads-sales-by-site-list">
          {sites
            .filter((s) => s.orders > 0 || s.sales !== 0)
            .sort((x, y) => y.sales - x.sales)
            .map((s) => {
              const P = PLATFORM[s.provider];
              return (
                <BarRow
                  key={s.source}
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      <P.Icon size={14} />
                      {s.label}
                    </span>
                  }
                  value={money(s.sales)}
                  sub={`${plural(s.orders, "order")} · ${fmtPct(total > 0 ? s.sales / total : null)} of these sites' sales`}
                  fraction={max > 0 ? s.sales / max : 0}
                />
              );
            })}
        </ul>
      )}
      {customers && (
        <p className="mt-4 text-xs text-muted" data-testid="ads-customers">
          Your whole store in these dates: {fmtNum(customers.newCustomers)} new and {fmtNum(customers.returningCustomers)} returning {customers.customers === 1 ? "customer" : "customers"}
          {customers.returningCustomerRate !== null ? ` (${fmtPct(customers.returningCustomerRate)} returning)` : ""}, whatever brought them.
        </p>
      )}
      <p className="mt-3 text-xs text-muted print:hidden">
        Age, gender, country, device and placement come from each platform&apos;s live report:{" "}
        {(["meta", "google"] as AdSpendProvider[]).map((p, i) => (
          <span key={p}>
            {i > 0 && " · "}
            <Link href={`/advertising/${p}`} className="font-medium text-accent hover:underline">
              {PLATFORM[p].name}
            </Link>
          </span>
        ))}
        .
      </p>
    </AdCard>
  );
}
