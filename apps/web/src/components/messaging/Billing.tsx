"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { billingMonth, BUDGET_LEVELS } from "@app/shared/sms";
import { PageHeader, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Empty, Stat } from "@/components/dashboard/Primitives";
import { fmtMonth } from "@/components/dashboard/format";
import { fmtNum, fmtPct, useApi } from "@/lib/api";
import { countryName, fmtUsd, fmtWhen, useSms } from "./MessagingUi";
import type { SmsBilling } from "./types";

const Th = ({ children, right = false }: { children: ReactNode; right?: boolean }) => <th className={`py-1.5 pr-3 font-medium ${right ? "text-right" : "text-left"}`}>{children}</th>;
const Td = ({ children, right = false }: { children: ReactNode; right?: boolean }) => <td className={`py-1.5 pr-3 ${right ? "text-right tabular-nums" : ""}`}>{children}</td>;

function CostTable({ title, rows, empty }: { title: string; rows: Array<{ key: string; label: string; messages: number; parts?: number; costUsd: number }>; empty: string }) {
  const parts = rows.some((r) => r.parts !== undefined);
  return (
    <section className="card min-w-0" aria-label={title}>
      <h2 className="font-semibold">{title}</h2>
      {!rows.length ? (
        <p className="mt-2 text-sm text-muted">{empty}</p>
      ) : (
        <div className="relative mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <Th>{title.replace(/^By /, "").replace(/^./, (c) => c.toUpperCase())}</Th>
                <Th right>Texts</Th>
                {parts && <Th right>Parts</Th>}
                <Th right>Cost</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.key}>
                  <Td>{r.label}</Td>
                  <Td right>{fmtNum(r.messages)}</Td>
                  {parts && <Td right>{fmtNum(r.parts ?? 0)}</Td>}
                  <Td right>{fmtUsd(r.costUsd)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
        sub="AWS prices each text in US dollars when it reports the delivery. Texts it hasn't priced yet count at their estimate until it does, so you see them against the budget straight away. Months are calendar months in UTC, as AWS bills them."
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
          <section className="card animate-rise" aria-labelledby="b-budget-h">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="b-budget-h" className="font-semibold">
                  {fmtMonth(data.month, { year: true })}
                </h2>
                <p className="mt-1 text-3xl font-semibold tabular-nums">{fmtUsd(data.totalUsd)}</p>
                <p className="text-sm text-muted">{data.budgetUsd > 0 ? `of a ${fmtUsd(data.budgetUsd)} monthly budget${pct !== null ? ` · ${fmtPct(pct / 100)} used` : ""}` : "No monthly budget is set, so nothing is sent."}</p>
              </div>
              <Link href="/messaging/sender" className="btn-secondary h-8 px-3 text-xs">
                Change the budget
              </Link>
            </div>
            {data.budgetUsd > 0 && (
              <div className="mt-4">
                <div className="relative h-3 rounded-full bg-bg" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(pct ?? 0))} aria-label="Budget used">
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
          </section>

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="This month">
            <Stat label="Billed by AWS" value={fmtUsd(data.billedUsd)} note="Prices AWS reported with each delivery" />
            <Stat label="Waiting for AWS's price" value={fmtUsd(data.pendingUsd)} note="Estimates for texts AWS hasn't priced yet" />
            <Stat label="Texts accepted by AWS" value={fmtNum(data.messages)} note={data.quota ? `of a ${fmtNum(data.quota)} monthly limit` : "No monthly text limit set"} />
            <Stat
              label="When the budget runs out"
              value={data.hardStop ? "Texts stop" : "Texts continue"}
              note={data.hardStop ? "Nothing more is sent until next month or a bigger budget" : "You're still told at each level; nothing stops sending"}
              tone={data.hardStop ? "good" : "warn"}
            />
          </section>

          <div className="grid gap-4 2xl:grid-cols-3">
            <CostTable
              title="By country"
              empty="Nothing billed this month."
              rows={data.byCountry.map((c) => ({ key: c.country ?? "none", label: countryName(c.country), messages: c.messages, parts: c.parts, costUsd: c.costUsd }))}
            />
            <CostTable title="By campaign" empty="No campaign texts billed this month." rows={data.byCampaign.map((c) => ({ key: c.id ?? c.name, label: c.name, messages: c.messages, costUsd: c.costUsd }))} />
            <CostTable title="By workflow" empty="No workflow texts billed this month." rows={data.byRule.map((r) => ({ key: r.id ?? r.name, label: r.name, messages: r.messages, costUsd: r.costUsd }))} />
          </div>

          <section className="card" aria-labelledby="b-rec-h">
            <h2 id="b-rec-h" className="font-semibold">
              Latest charges
            </h2>
            <p className="text-xs text-muted">Each line is one text as AWS priced it; the 50 most recent this month.</p>
            {!data.records.length ? (
              <p className="mt-2 text-sm text-muted">AWS hasn&apos;t billed any text this month.</p>
            ) : (
              <div className="relative mt-2 overflow-x-auto">
                <table className="w-full min-w-[36rem] text-sm">
                  <thead className="text-xs text-muted">
                    <tr>
                      <Th>When</Th>
                      <Th>Country</Th>
                      <Th right>Parts</Th>
                      <Th right>Price</Th>
                      <Th right>Carrier fee</Th>
                      <Th right>Total</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.records.map((r) => (
                      <tr key={r.id}>
                        <Td>{fmtWhen(r.recordedAt, store?.timezone)}</Td>
                        <Td>{countryName(r.country)}</Td>
                        <Td right>{fmtNum(r.parts)}</Td>
                        <Td right>{fmtUsd(r.priceUsd)}</Td>
                        <Td right>{r.carrierFeeUsd ? fmtUsd(r.carrierFeeUsd) : "—"}</Td>
                        <Td right>{fmtUsd(r.totalUsd)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
