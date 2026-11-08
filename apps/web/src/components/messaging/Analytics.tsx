"use client";
import { useState, type ReactNode } from "react";
import { eachDay } from "@app/shared/dates";
import { SMS_PERIOD_LABEL, SMS_PERIODS, TRIGGER_INFO, type SmsPeriod, type SmsTrigger } from "@app/shared/sms";
import { PageHeader, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { FilterBar, ROW, TableCard, TableHead, TD, Th } from "@/components/automations/MarketingKit";
import { Empty } from "@/components/dashboard/Primitives";
import { LineChart } from "@/components/dashboard/LineChart";
import { fmtSpan } from "@/components/dashboard/format";
import { Card, FigureTile } from "@/components/PageKit";
import { fmtMoney, fmtNum, fmtPct, useApi } from "@/lib/api";
import { CAMPAIGN_STATUS, COUNTRY_CHOICES, countryName, fmtUsd, RULE_STATUS, StatusPill, useSms } from "./MessagingUi";
import type { SmsAnalytics, SmsCampaign, SmsRule } from "./types";

// ---------------------------------------------------------------------------
// Delivery Analytics, as the Stitch design's screen 17 draws Results: the filters on one white
// bar, the period's four numbers (sent, delivered, orders that followed, cost), then the rest of
// what AWS and the carriers reported, by day, by country, by campaign and by automation. Every
// figure is the API's (GET …/sms/analytics); test texts aren't counted, and orders that followed
// a text are said to have followed it, not to have been caused by it.
// ---------------------------------------------------------------------------

const Td = ({ children, right = false }: { children: ReactNode; right?: boolean }) => <td className={`${TD} ${right ? "text-right tabular-nums" : ""}`}>{children}</td>;

/** One of the period's other counts: its name, the figure and what it means. */
function Count({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "good" | "danger" | "warn" }) {
  return (
    <div className="min-w-0 rounded bg-home-soft px-3 py-2.5">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-0.5 text-lg leading-6 font-semibold tabular-nums ${tone === "good" ? "text-good" : tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : ""}`}>{value}</p>
      <p className="mt-0.5 text-xs text-muted">{note}</p>
    </div>
  );
}

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
    <div className="space-y-5">
      <PageHeader
        title="Delivery Analytics"
        sub={`What was sent, what the SMS provider and the carriers reported, what it cost and the orders that followed. Days are the store's (${store?.timezone ?? "store time"}); test texts aren't counted.`}
      />
      <section className="space-y-2" aria-label="Filters">
        <FilterBar>
          <div className="min-w-[10rem] flex-1">
            <label className="label text-xs text-muted" htmlFor="a-period">Period</label>
            <select id="a-period" className="input" value={period} onChange={(e) => setPeriod(e.target.value as SmsPeriod)}>
              {SMS_PERIODS.map((p) => <option key={p} value={p}>{SMS_PERIOD_LABEL[p]}</option>)}
            </select>
          </div>
          <div className="min-w-[10rem] flex-1">
            <label className="label text-xs text-muted" htmlFor="a-country">Country</label>
            <select id="a-country" className="input" value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="">All countries</option>
              {COUNTRY_CHOICES.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}
            </select>
          </div>
          <div className="min-w-[10rem] flex-1">
            <label className="label text-xs text-muted" htmlFor="a-campaign">Campaign</label>
            <select id="a-campaign" className="input" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
              <option value="">All</option>
              {(campaigns.data?.campaigns ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="min-w-[10rem] flex-1">
            <label className="label text-xs text-muted" htmlFor="a-rule">Workflow</label>
            <select id="a-rule" className="input" value={ruleId} onChange={(e) => setRuleId(e.target.value)}>
              <option value="">All</option>
              {(rules.data?.rules ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          {period === "custom" && (
            <>
              <div>
                <label className="label text-xs text-muted" htmlFor="a-from">From</label>
                <input id="a-from" className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
              </div>
              <div>
                <label className="label text-xs text-muted" htmlFor="a-to">To</label>
                <input id="a-to" className="input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
              </div>
            </>
          )}
        </FilterBar>
        {data && <p className="px-1 text-xs text-muted">{fmtSpan(data.range.from, data.range.to, { year: true })}</p>}
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
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Totals">
            <FigureTile title="Accepted by the SMS provider" value={fmtNum(t.accepted)} sub={t.pending ? `${fmtNum(t.pending)} still waiting for the carrier` : `Of ${fmtNum(t.requested)} requested`} />
            <FigureTile title="Delivery rate" value={fmtPct(t.deliveryRate)} sub="Of texts with a final outcome, delivered or accepted by the carrier. Texts still waiting don't count either way." />
            <FigureTile title="Orders that followed" value={fmtNum(data.attribution.orders)} sub="Orders that followed a text: followed, not caused" />
            <FigureTile title="Cost" value={fmtUsd(data.costUsd)} sub="What the SMS provider billed, in US dollars (texts it hasn't priced yet aren't included)" />
          </section>

          <Card id="a-counts" title="Every text, by what happened" testId="analytics-counts">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Count label="Requested" value={fmtNum(t.requested)} note="Every text something asked for, sent or not" />
              <Count label="Accepted by the SMS provider" value={fmtNum(t.accepted)} note={t.pending ? `${fmtNum(t.pending)} still waiting for the carrier` : "—"} />
              <Count label="Delivered" value={fmtNum(t.delivered)} note="The phone confirmed it" tone={t.delivered ? "good" : undefined} />
              <Count label="Accepted by carrier" value={fmtNum(t.carrierAccepted)} note="Networks that give no phone receipt" />
              <Count label="Failed" value={fmtNum(t.failed)} tone={t.failed ? "danger" : undefined} note="The SMS provider or the carrier refused it" />
              <Count label="Unknown outcome" value={fmtNum(t.unknown)} tone={t.unknown ? "warn" : undefined} note="No final word within 72 hours" />
              <Count label="Opted out / not sent" value={`${fmtNum(t.optedOut)} / ${fmtNum(t.notSent)}`} note="Opt-out lists; consent, quiet hours, limits…" />
              <Count label="Dry runs" value={fmtNum(t.dryRun)} note="Recorded, never sent" />
            </div>
          </Card>

          {days.length > 1 && (
            <Card id="a-chart" title="Texts per day" aside="By the day each text was created, in the store's time zone. Dry runs aren't included." testId="analytics-per-day">
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
            </Card>
          )}

          <TableCard id="a-country" title="By country">
            <table className="w-full min-w-[36rem] text-sm">
              <TableHead>
                <Th>Country</Th>
                <Th right>Requested</Th>
                <Th right>Delivered</Th>
                <Th right>Failed</Th>
                <Th right>Delivery rate</Th>
                <Th right>Cost</Th>
              </TableHead>
              <tbody>
                {data.byCountry.map((c) => (
                  <tr key={c.country ?? "none"} className={ROW}>
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
          </TableCard>

          <TableCard id="a-cmp" title="Campaigns">
            {!data.campaigns.length ? (
              <p className="px-5 pb-5 text-sm text-muted sm:px-6">No campaign texts in this period.</p>
            ) : (
              <table className="w-full min-w-[34rem] text-sm">
                <TableHead>
                  <Th>Campaign</Th>
                  <Th right>Requested</Th>
                  <Th right>Delivery rate</Th>
                  <Th right>Cost</Th>
                  <Th right>Orders that followed</Th>
                  <Th right>Their value</Th>
                </TableHead>
                <tbody>
                  {data.campaigns.map((c) => (
                    <tr key={c.id} className={ROW}>
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
            )}
          </TableCard>

          <TableCard id="a-rule" title="Automations">
            {!data.automations.length ? (
              <p className="px-5 pb-5 text-sm text-muted sm:px-6">No workflow texts in this period.</p>
            ) : (
              <table className="w-full min-w-[34rem] text-sm">
                <TableHead>
                  <Th>Workflow</Th>
                  <Th right>Requested</Th>
                  <Th right>Delivery rate</Th>
                  <Th right>Cost</Th>
                  <Th right>Orders that followed</Th>
                  <Th right>Their value</Th>
                </TableHead>
                <tbody>
                  {data.automations.map((r) => (
                    <tr key={r.id} className={ROW}>
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
            )}
          </TableCard>

          <Card id="a-attr" title="Orders that followed a text" testId="analytics-attribution">
            <dl className="grid gap-2 sm:grid-cols-3">
              <div className="rounded bg-home-soft px-3 py-2.5">
                <dt className="text-xs text-muted">Orders</dt>
                <dd className="text-xl font-semibold tabular-nums">{fmtNum(data.attribution.orders)}</dd>
              </div>
              <div className="rounded bg-home-soft px-3 py-2.5">
                <dt className="text-xs text-muted">Their value</dt>
                <dd className="text-xl font-semibold tabular-nums">
                  {data.attribution.byCurrency.length ? data.attribution.byCurrency.map((c) => fmtMoney(c.revenue, c.currency)).join(" + ") : "—"}
                </dd>
              </div>
              {data.attribution.roi !== null && (
                <div className="rounded bg-home-soft px-3 py-2.5">
                  <dt className="text-xs text-muted">Order value per US$1 of SMS spend</dt>
                  <dd className="text-xl font-semibold tabular-nums">{new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(data.attribution.roi)}</dd>
                </div>
              )}
            </dl>
            <p className="mt-3 text-sm">{data.attributionRule}</p>
            <p className="mt-1 text-sm font-medium">These are not proven incremental sales.</p>
          </Card>
        </>
      )}
    </div>
  );
}
