"use client";
import { useState, type ReactNode } from "react";
import { eachDay } from "@app/shared/dates";
import { SMS_PERIOD_LABEL, SMS_PERIODS, TRIGGER_INFO, type SmsPeriod, type SmsTrigger } from "@app/shared/sms";
import { PageHeader, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Empty, Stat } from "@/components/dashboard/Primitives";
import { LineChart } from "@/components/dashboard/LineChart";
import { fmtSpan } from "@/components/dashboard/format";
import { fmtMoney, fmtNum, fmtPct, useApi } from "@/lib/api";
import { CAMPAIGN_STATUS, COUNTRY_CHOICES, countryName, fmtUsd, RULE_STATUS, StatusPill, useSms } from "./MessagingUi";
import type { SmsAnalytics, SmsCampaign, SmsRule } from "./types";

const Th = ({ children, right = false }: { children: ReactNode; right?: boolean }) => <th className={`py-1.5 pr-3 font-medium ${right ? "text-right" : "text-left"}`}>{children}</th>;
const Td = ({ children, right = false }: { children: ReactNode; right?: boolean }) => <td className={`py-1.5 pr-3 ${right ? "text-right tabular-nums" : ""}`}>{children}</td>;

/** Delivery Analytics: what was asked for, what AWS and the carriers did with it, what it cost and what followed. */
export function DeliveryAnalytics() {
  const { base, store } = useSms();
  const [period, setPeriod] = useState<SmsPeriod>("30d");
  const [range, setRange] = useState({ from: "", to: "" });
  const [country, setCountry] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [ruleId, setRuleId] = useState("");
  const campaigns = useApi<{ campaigns: SmsCampaign[] }>(base ? `${base}/campaigns` : null);
  const rules = useApi<{ rules: SmsRule[] }>(base ? `${base}/rules` : null);
  const customReady = period !== "custom" || (!!range.from && !!range.to);
  const q = new URLSearchParams(Object.entries({ period, from: period === "custom" ? range.from : "", to: period === "custom" ? range.to : "", country, campaignId, ruleId }).filter(([, v]) => v));
  const { data, error, reload, loading } = useApi<SmsAnalytics>(base && customReady ? `${base}/analytics?${q}` : null);

  const t = data?.totals;
  const days = data ? eachDay(data.range.from, data.range.to) : [];
  const byDay = new Map<string, { all: number; delivered: number; failed: number }>();
  for (const r of data?.daily ?? []) {
    const d = byDay.get(r.day) ?? { all: 0, delivered: 0, failed: 0 };
    if (r.status !== "dry_run") d.all += r.count;
    if (r.status === "delivered" || r.status === "carrier_accepted") d.delivered += r.count;
    if (r.status === "failed") d.failed += r.count;
    byDay.set(r.day, d);
  }
  // The API gives a campaign's or workflow's revenue only when its attributed orders are in one currency.
  const money = (n: number | null, currency: string | null) => (n === null ? "Several currencies" : fmtMoney(n, currency ?? data?.currency ?? "USD"));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Delivery Analytics"
        sub={`What was sent, what AWS and the carriers reported, what it cost and the orders that followed. Days are the store's (${store?.timezone ?? "store time"}); test texts aren't counted.`}
      />
      <section className="card" aria-label="Filters">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="text-xs text-muted" htmlFor="a-period">Period</label>
            <select id="a-period" className="input" value={period} onChange={(e) => setPeriod(e.target.value as SmsPeriod)}>
              {SMS_PERIODS.map((p) => <option key={p} value={p}>{SMS_PERIOD_LABEL[p]}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted" htmlFor="a-country">Country</label>
            <select id="a-country" className="input" value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="">All countries</option>
              {COUNTRY_CHOICES.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted" htmlFor="a-campaign">Campaign</label>
            <select id="a-campaign" className="input" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
              <option value="">All</option>
              {(campaigns.data?.campaigns ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted" htmlFor="a-rule">Workflow</label>
            <select id="a-rule" className="input" value={ruleId} onChange={(e) => setRuleId(e.target.value)}>
              <option value="">All</option>
              {(rules.data?.rules ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          {period === "custom" && (
            <>
              <div>
                <label className="text-xs text-muted" htmlFor="a-from">From</label>
                <input id="a-from" className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
              </div>
              <div>
                <label className="text-xs text-muted" htmlFor="a-to">To</label>
                <input id="a-to" className="input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
              </div>
            </>
          )}
        </div>
        {data && <p className="mt-2 text-xs text-muted">{fmtSpan(data.range.from, data.range.to, { year: true })}</p>}
      </section>

      {!customReady ? (
        <Empty>Choose a start and an end date.</Empty>
      ) : error ? (
        <LoadError what="the analytics" error={error} onRetry={() => void reload()} busy={loading} />
      ) : !data || !t ? (
        <Skeleton lines={6} />
      ) : t.requested + t.dryRun === 0 ? (
        <Empty>No texts in this period{country || campaignId || ruleId ? " for these filters" : ""}.</Empty>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Totals">
            <Stat label="Requested" value={fmtNum(t.requested)} note="Every text something asked for, sent or not" />
            <Stat label="Accepted by AWS" value={fmtNum(t.accepted)} note={t.pending ? `${fmtNum(t.pending)} still waiting for the carrier` : "—"} />
            <Stat label="Delivered" value={fmtNum(t.delivered)} note="The phone confirmed it" tone={t.delivered ? "good" : undefined} />
            <Stat label="Accepted by carrier" value={fmtNum(t.carrierAccepted)} note="Networks that give no phone receipt" />
            <Stat label="Failed" value={fmtNum(t.failed)} tone={t.failed ? "danger" : undefined} note="AWS or the carrier refused it" />
            <Stat label="Unknown outcome" value={fmtNum(t.unknown)} tone={t.unknown ? "warn" : undefined} note="No final word within 72 hours" />
            <Stat label="Opted out / not sent" value={`${fmtNum(t.optedOut)} / ${fmtNum(t.notSent)}`} note="Opt-out lists; consent, quiet hours, limits…" />
            <Stat label="Dry runs" value={fmtNum(t.dryRun)} note="Recorded, never sent" />
          </section>
          <section className="grid gap-3 sm:grid-cols-2" aria-label="Rate and cost">
            <Stat label="Delivery rate" value={fmtPct(t.deliveryRate)} note="Of texts with a final outcome, delivered or accepted by the carrier. Texts still waiting don't count either way." />
            <Stat label="Cost" value={fmtUsd(data.costUsd)} note="What AWS billed, in US dollars (texts it hasn't priced yet aren't included)" />
          </section>

          {days.length > 1 && (
            <section className="card" aria-labelledby="a-chart-h">
              <h2 id="a-chart-h" className="font-semibold">Texts per day</h2>
              <p className="text-xs text-muted">By the day each text was created, in the store&apos;s time zone. Dry runs aren&apos;t included.</p>
              <div className="mt-3">
                <LineChart
                  label="Texts requested, delivered and failed per day"
                  days={days}
                  integer
                  format={(v) => fmtNum(v)}
                  fmtAxis={(v) => fmtNum(v)}
                  series={[
                    { key: "all", label: "Requested", color: "var(--viz-cat-1)", values: days.map((d) => byDay.get(d)?.all ?? 0) },
                    { key: "delivered", label: "Delivered or accepted by carrier", color: "var(--viz-cat-3)", values: days.map((d) => byDay.get(d)?.delivered ?? 0) },
                    { key: "failed", label: "Failed", color: "var(--viz-cat-2)", values: days.map((d) => byDay.get(d)?.failed ?? 0) },
                  ]}
                />
              </div>
            </section>
          )}

          <section className="card" aria-labelledby="a-country-h">
            <h2 id="a-country-h" className="font-semibold">By country</h2>
            <div className="relative mt-2 overflow-x-auto">
              <table className="w-full min-w-[36rem] text-sm">
                <thead className="text-xs text-muted">
                  <tr><Th>Country</Th><Th right>Requested</Th><Th right>Delivered</Th><Th right>Failed</Th><Th right>Delivery rate</Th><Th right>Cost</Th></tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.byCountry.map((c) => (
                    <tr key={c.country ?? "none"}>
                      <Td>{countryName(c.country)}</Td>
                      <Td right>{fmtNum(c.requested)}</Td>
                      <Td right>{fmtNum(c.delivered + c.carrierAccepted)}</Td>
                      <Td right>{fmtNum(c.failed)}</Td>
                      <Td right>{fmtPct(c.deliveryRate)}</Td>
                      <Td right>{fmtUsd(c.costUsd)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="space-y-4">
            <section className="card min-w-0" aria-labelledby="a-cmp-h">
              <h2 id="a-cmp-h" className="font-semibold">Campaigns</h2>
              {!data.campaigns.length ? (
                <p className="mt-2 text-sm text-muted">No campaign texts in this period.</p>
              ) : (
                <div className="relative mt-2 overflow-x-auto">
                  <table className="w-full min-w-[34rem] text-sm">
                    <thead className="text-xs text-muted">
                      <tr><Th>Campaign</Th><Th right>Requested</Th><Th right>Delivery rate</Th><Th right>Cost</Th><Th right>Orders that followed</Th><Th right>Their value</Th></tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.campaigns.map((c) => (
                        <tr key={c.id}>
                          <Td>
                            {c.name} <StatusPill map={CAMPAIGN_STATUS} status={c.status} />
                          </Td>
                          <Td right>{fmtNum(c.requested)}</Td>
                          <Td right>{fmtPct(c.deliveryRate)}</Td>
                          <Td right>{fmtUsd(c.costUsd)}</Td>
                          <Td right>{fmtNum(c.attributedOrders)}</Td>
                          <Td right>{c.attributedOrders ? money(c.attributedRevenue, c.attributedCurrency) : "—"}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="card min-w-0" aria-labelledby="a-rule-h">
              <h2 id="a-rule-h" className="font-semibold">Automated workflows</h2>
              {!data.automations.length ? (
                <p className="mt-2 text-sm text-muted">No workflow texts in this period.</p>
              ) : (
                <div className="relative mt-2 overflow-x-auto">
                  <table className="w-full min-w-[34rem] text-sm">
                    <thead className="text-xs text-muted">
                      <tr><Th>Workflow</Th><Th right>Requested</Th><Th right>Delivery rate</Th><Th right>Cost</Th><Th right>Orders that followed</Th><Th right>Their value</Th></tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.automations.map((r) => (
                        <tr key={r.id}>
                          <Td>
                            {r.name} <StatusPill map={RULE_STATUS} status={r.status} />
                            {r.trigger && r.trigger in TRIGGER_INFO && <span className="block text-xs text-muted">{TRIGGER_INFO[r.trigger as SmsTrigger].label}</span>}
                          </Td>
                          <Td right>{fmtNum(r.requested)}</Td>
                          <Td right>{fmtPct(r.deliveryRate)}</Td>
                          <Td right>{fmtUsd(r.costUsd)}</Td>
                          <Td right>{fmtNum(r.attributedOrders)}</Td>
                          <Td right>{r.attributedOrders ? money(r.attributedRevenue, r.attributedCurrency) : "—"}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          <section className="card" aria-labelledby="a-attr-h">
            <h2 id="a-attr-h" className="font-semibold">Orders that followed a text</h2>
            <dl className="mt-3 grid gap-3 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted">Orders</dt>
                <dd className="text-xl font-semibold tabular-nums">{fmtNum(data.attribution.orders)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Their value</dt>
                <dd className="text-xl font-semibold tabular-nums">
                  {data.attribution.byCurrency.length ? data.attribution.byCurrency.map((c) => fmtMoney(c.revenue, c.currency)).join(" + ") : "—"}
                </dd>
              </div>
              {data.attribution.roi !== null && (
                <div>
                  <dt className="text-xs text-muted">Order value per US$1 of SMS spend</dt>
                  <dd className="text-xl font-semibold tabular-nums">{new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(data.attribution.roi)}</dd>
                </div>
              )}
            </dl>
            <p className="mt-3 text-sm">{data.attributionRule}</p>
            <p className="mt-1 text-sm font-medium">These are not proven incremental sales.</p>
          </section>
        </>
      )}
    </div>
  );
}
