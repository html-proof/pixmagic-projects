"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { Megaphone } from "lucide-react";
import { fmtMoney, fmtNum } from "@/lib/api";
import { BEING_READ } from "@/components/dashboard/AdsCommon";
import { DemoChip } from "@/components/dashboard/Advertising";
import { fmtTimes } from "@/components/dashboard/format";
import type { AdsModule } from "@/components/dashboard/types";
import { AdCard, CardLink, EmptyNote } from "./AdCard";
import { PLATFORM } from "./AdvertisingUi";
import { CampaignStatus, drillHref } from "./CampaignComparison";

// ---------------------------------------------------------------------------
// The campaigns that spent most in the dates, from their stored days: each with its platform, what
// it spent, its link clicks, the purchases and purchase value its platform credits to it, its ROAS and
// its delivery as the last sync read it. The rest are on Campaign comparison. A campaign's name opens
// it in its platform's live report (ad sets, ad groups, ads).
// ---------------------------------------------------------------------------

const SHOWN = 5;

/** Needs "View campaigns" (Team & Access): without it the API sends no campaigns and the card isn't shown. */
export function TopCampaigns({ a }: { a: AdsModule }) {
  if (!a.campaigns) return null;
  const money = (n: number) => fmtMoney(n, a.currency);
  const top = [...a.campaigns].sort((x, y) => y.spend - x.spend).slice(0, SHOWN);
  const connections = new Map(a.accounts.map((acc) => [`${acc.provider}:${acc.accountId}`, acc]));
  return (
    <AdCard
      id="ads-top-campaigns"
      title="Top campaigns"
      sub={`The ${SHOWN} that spent most in these dates, in ${a.currency}. Purchases and ROAS are each platform's own count.`}
      icon={Megaphone}
      action={<CardLink href="/advertising/campaigns">View all campaigns</CardLink>}
    >
      {top.length === 0 ? (
        <EmptyNote>No campaign spent anything in these dates.</EmptyNote>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="bg-bg/60 text-left text-xs text-muted">
              <tr>
                <th className="rounded-l-lg px-2 py-2 font-medium">Campaign</th>
                <th className="px-2 py-2 font-medium">Platform</th>
                <th className="px-2 py-2 text-right font-medium">Spend</th>
                <th className="px-2 py-2 text-right font-medium">Link clicks</th>
                <th className="px-2 py-2 text-right font-medium">Purchases</th>
                <th className="px-2 py-2 text-right font-medium">Purchase value</th>
                <th className="px-2 py-2 text-right font-medium">ROAS</th>
                <th className="rounded-r-lg px-2 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {top.map((c) => {
                const P = PLATFORM[c.provider];
                const acc = connections.get(`${c.provider}:${c.accountId}`);
                const href = drillHref(c, acc?.id);
                return (
                  <tr key={`${c.provider}:${c.accountId}:${c.campaignId}`} className="border-b border-border last:border-0" data-testid="top-campaign-row">
                    <td className="max-w-[16rem] px-2 py-2.5">
                      {href ? (
                        <Link href={href} className="block truncate font-medium hover:text-accent hover:underline" title={c.name}>
                          {c.name}
                        </Link>
                      ) : (
                        <span className="block truncate font-medium" title={c.name}>
                          {c.name}
                        </span>
                      )}
                      {acc?.demo && <DemoChip small />}
                    </td>
                    <td className="px-2 py-2.5">
                      <span className="inline-flex items-center gap-1.5" title={P.name}>
                        <P.Icon size={16} />
                        <span className="sr-only sm:not-sr-only sm:text-xs sm:text-muted">{c.provider === "meta" ? "Meta" : "Google"}</span>
                      </span>
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums">{money(c.spend)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums">{c.linkClicks === null ? BEING_READ : fmtNum(c.linkClicks)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums">{c.purchases === null ? BEING_READ : fmtNum(c.purchases)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums">{c.purchaseValue === null ? BEING_READ : money(c.purchaseValue)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums">{c.purchases === null ? BEING_READ : fmtTimes(c.roas)}</td>
                    <td className="px-2 py-2.5 text-xs">
                      <StatusPill group={c.statusGroup ?? null}>
                        <CampaignStatus c={c} />
                      </StatusPill>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AdCard>
  );
}

function StatusPill({ group, children }: { group: string | null; children: ReactNode }) {
  const tone = group === "active" ? "bg-good/12 text-good" : group === "paused" ? "bg-border/70 text-muted" : group === "ended" ? "bg-danger/10 text-danger" : "bg-warn/10 text-warn";
  return group ? <span className={`inline-block rounded-md px-2 py-0.5 ${tone}`}>{children}</span> : <>{children}</>;
}
