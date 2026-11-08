"use client";
import Link from "next/link";
import { useState } from "react";
import { billingMonth, BUDGET_LEVELS } from "@app/shared/sms";
import { PageHeader, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Card, FigureTile } from "@/components/PageKit";
import { ROW, TableCard, TableHead, TD, Th } from "@/components/automations/MarketingKit";
import { Dot, Empty } from "@/components/dashboard/Primitives";
import { fmtMonth } from "@/components/dashboard/format";
import { fmtNum, fmtPct, useApi } from "@/lib/api";
import { countryName, fmtUsd, fmtWhen, useSms } from "./MessagingUi";
import type { SmsBilling } from "./types";

// ---------------------------------------------------------------------------
// Messaging costs & limit, in the Stitch design's look (screens 17 and 18): the month's spend
// against the budget on a white card, the month's few numbers as tiles, then the costs by country,
// campaign and workflow and the latest charges as tables with a tinted head row. Every amount is
// what AWS billed, or its estimate until it does, as the API returns it.
// ---------------------------------------------------------------------------

function CostTable({ id, title, rows, empty }: { id: string; title: string; rows: Array<{ key: string; label: string; messages: number; parts?: number; costUsd: number }>; empty: string }) {
  const parts = rows.some((r) => r.parts !== undefined);
  return (
    <TableCard id={id} title={title}>
      {!rows.length ? (
        <p className="px-5 pb-5 text-sm text-muted sm:px-6">{empty}</p>
      ) : (
        <table className="w-full text-sm" aria-label={title}>
          <TableHead>
            <Th>{title.replace(/^By /, "").replace(/^./, (c) => c.toUpperCase())}</Th>
            <Th right>Texts</Th>
            {parts && <Th right>Parts</Th>}
            <Th right>Cost</Th>
          </TableHead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={ROW}>
                <td className={TD}>{r.label}</td>
                <td className={`${TD} text-right tabular-nums`}>{fmtNum(r.messages)}</td>
                {parts && <td className={`${TD} text-right tabular-nums`}>{fmtNum(r.parts ?? 0)}</td>}
                <td className={`${TD} text-right font-medium tabular-nums`}>{fmtUsd(r.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TableCard>
  );
}

/** SMS Billing: what AWS charged this month, against the store's budget. */
export function SmsBillingPage() {
  const { base, store } = useSms();
  const [month, setMonth] = useState(() => billingMonth(new Date()));
  const valid = /^\d{4}-\d{2}$/.test(month);
  const { data, error, reload, loading } = useApi<SmsBilling>(base && valid ? `${base}/billing?month=${month}` : null);
  const pct = data?.usedPct ?? null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Messaging costs & limit"
        sub="The SMS provider prices each text in US dollars when it reports the delivery. Texts it hasn't priced yet count at their estimate until it does, so you see them against the budget straight away. Months are calendar months in UTC, as the provider bills them."
        actions={
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Month</span>
            <input className="input w-auto" type="month" value={month} max={billingMonth(new Date())} onChange={(e) => setMonth(e.target.value)} aria-label="Billing month" />
          </label>
        }
      />
      {!valid ? (
        <Empty>Choose a month.</Empty>
      ) : error ? (
        <LoadError what="the billing" error={error} onRetry={() => void reload()} busy={loading} />
      ) : !data ? (
        <Skeleton lines={5} />
      ) : (
        <>
          <Card
            id="b-budget"
            title={fmtMonth(data.month, { year: true })}
            aside={
              <Link href="/messaging/sender" className="home-btn h-8">
                Change the budget
              </Link>
            }
          >
            <p className="text-[28px] leading-8 font-semibold tracking-[-0.02em] tabular-nums">{fmtUsd(data.totalUsd)}</p>
            <p className="mt-1 text-sm text-muted">{data.budgetUsd > 0 ? `of a ${fmtUsd(data.budgetUsd)} monthly budget${pct !== null ? ` · ${fmtPct(pct / 100)} used` : ""}` : "No monthly budget is set, so nothing is sent."}</p>
            {data.budgetUsd > 0 && (
              <div className="mt-4">
                <div className="relative h-3 rounded-full bg-home-soft" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(pct ?? 0))} aria-label="Budget used">
                  <div className={`h-3 rounded-full ${(pct ?? 0) >= 100 ? "bg-danger" : (pct ?? 0) >= 80 ? "bg-warn" : "bg-accent"}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
                  {BUDGET_LEVELS.map((l) => (
                    <span key={l} aria-hidden className="absolute top-[-3px] h-[18px] w-px bg-text/40" style={{ left: `${Math.min(99.8, l)}%` }} />
                  ))}
                </div>
                <div className="relative mt-1 h-4 text-[11px] text-muted" aria-hidden>
                  {BUDGET_LEVELS.map((l) => (
                    <span key={l} className="absolute -translate-x-1/2" style={{ left: `${Math.min(97, l)}%` }}>
                      {l}%
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted">
                  {data.alertsRaised.length
                    ? `You were told when spend reached ${data.alertsRaised.map((l) => `${l}%`).join(", ")} of the budget.`
                    : `You're told when spend reaches ${BUDGET_LEVELS.map((l) => `${l}%`).join(", ")} of the budget.`}
                </p>
              </div>
            )}
          </Card>

          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="This month">
            <FigureTile testId="billing-billed" title="Billed by the SMS provider" value={fmtUsd(data.billedUsd)} sub="Prices the provider reported with each delivery" />
            <FigureTile testId="billing-pending" title="Waiting for the provider's price" value={fmtUsd(data.pendingUsd)} sub="Estimates for texts the provider hasn't priced yet" />
            <FigureTile testId="billing-texts" title="Texts accepted by the SMS provider" value={fmtNum(data.messages)} sub={data.quota ? `of a ${fmtNum(data.quota)} monthly limit` : "No monthly text limit set"} />
            <FigureTile
              testId="billing-hard-stop"
              title="When the budget runs out"
              value={
                <span className="inline-flex items-center gap-2">
                  <Dot tone={data.hardStop ? "good" : "warn"} />
                  {data.hardStop ? "Texts stop" : "Texts continue"}
                </span>
              }
              sub={data.hardStop ? "Nothing more is sent until next month or a bigger budget" : "You're still told at each level; nothing stops sending"}
            />
          </section>

          <div className="grid gap-4 2xl:grid-cols-3">
            <CostTable
              id="b-country"
              title="By country"
              empty="Nothing billed this month."
              rows={data.byCountry.map((c) => ({ key: c.country ?? "none", label: countryName(c.country), messages: c.messages, parts: c.parts, costUsd: c.costUsd }))}
            />
            <CostTable id="b-campaign" title="By campaign" empty="No campaign texts billed this month." rows={data.byCampaign.map((c) => ({ key: c.id ?? c.name, label: c.name, messages: c.messages, costUsd: c.costUsd }))} />
            <CostTable id="b-workflow" title="By workflow" empty="No workflow texts billed this month." rows={data.byRule.map((r) => ({ key: r.id ?? r.name, label: r.name, messages: r.messages, costUsd: r.costUsd }))} />
          </div>

          <TableCard id="b-rec" title="Latest charges" aside="Each line is one text as the SMS provider priced it; the 50 most recent this month.">
            {!data.records.length ? (
              <p className="px-5 pb-5 text-sm text-muted sm:px-6">The SMS provider hasn&apos;t billed any text this month.</p>
            ) : (
              <table className="w-full min-w-[36rem] text-sm">
                <TableHead>
                  <Th>When</Th>
                  <Th>Country</Th>
                  <Th right>Parts</Th>
                  <Th right>Price</Th>
                  <Th right>Carrier fee</Th>
                  <Th right>Total</Th>
                </TableHead>
                <tbody>
                  {data.records.map((r) => (
                    <tr key={r.id} className={ROW}>
                      <td className={`${TD} whitespace-nowrap`}>{fmtWhen(r.recordedAt, store?.timezone)}</td>
                      <td className={TD}>{countryName(r.country)}</td>
                      <td className={`${TD} text-right tabular-nums`}>{fmtNum(r.parts)}</td>
                      <td className={`${TD} text-right tabular-nums`}>{fmtUsd(r.priceUsd)}</td>
                      <td className={`${TD} text-right tabular-nums`}>{r.carrierFeeUsd ? fmtUsd(r.carrierFeeUsd) : "—"}</td>
                      <td className={`${TD} text-right font-medium tabular-nums`}>{fmtUsd(r.totalUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </TableCard>
        </>
      )}
    </div>
  );
}
