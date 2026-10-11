"use client";
import { useState } from "react";
import { addDays, eachDay } from "@app/shared/dates";
import { Stat } from "@/components/dashboard/primitives";
import { LineChart } from "@/components/dashboard/lineChart";
import { LoadError } from "@/components/LoadError";
import { fmtMoney, fmtNum, fmtPct, useApi } from "@/lib/api";
import { PageHeader, Skeleton, useWa } from "@/components/whatsapp/common";

interface Analytics {
  days: number;
  currency: string;
  messages: { sent: number; delivered: number; read: number; failed: number; skipped: number; scheduled: number; clicks: number };
  byGroup: Record<string, { sent: number; delivered: number; read: number; failed: number; skipped: number }>;
  daily: Array<{ day: string; sent: number; delivered: number; read: number; failed: number }>;
  carts: { withPhone: number; reminded: number; recovered: number; completedWithoutReminder: number; revenue: Array<{ currency: string; amount: number; orders: number }> };
  reviews: { submitted: number; average: number | null };
  campaigns: { messages: number; conversions: Array<{ currency: string; orders: number; revenue: number }> };
  billable: Array<{ category: string; messages: number }>;
}

const GROUP_LABEL: Record<string, string> = {
  orders: "Order notifications",
  delivery: "Delivery updates",
  carts: "Cart reminders",
  reviews: "Review requests",
  campaign: "Campaigns",
  automation: "Automations",
};

/** Every UTC day from `days - 1` days ago to today, so quiet days plot as zero, not as gaps. */
function dayList(days: number): string[] {
  const today = new Date().toISOString().slice(0, 10);
  return eachDay(addDays(today, -(days - 1)), today);
}

const money = (list: Array<{ currency: string; amount?: number; revenue?: number }>) =>
  list.length ? list.map((x) => fmtMoney(x.amount ?? x.revenue ?? 0, x.currency)).join(" + ") : "—";

export default function WhatsappAnalytics() {
  const { base } = useWa();
  const [days, setDays] = useState(30);
  const { data, error, reload } = useApi<Analytics>(base ? `${base}/analytics?days=${days}` : null);
  if (error) return <LoadError what="WhatsApp analytics" error={error} onRetry={() => void reload()} />;
  const m = data?.messages;
  const list = dayList(days);
  const byDay = new Map((data?.daily ?? []).map((d) => [d.day, d]));
  const recoveredOrders = data?.carts.revenue.reduce((s, r) => s + r.orders, 0) ?? 0;
  const conversions = data?.campaigns.conversions.reduce((s, r) => s + r.orders, 0) ?? 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Analytics"
        sub="What WhatsApp did for the store, from Meta's delivery reports and your orders. Test sends aren't counted."
        actions={
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Period</span>
            <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[7, 30, 90, 180].map((d) => <option key={d} value={d}>Last {d} days</option>)}
            </select>
          </label>
        }
      />
      {!data || !m ? (
        <Skeleton lines={6} />
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-label="Messages">
            <Stat label="Messages sent" value={fmtNum(m.sent)} note={m.scheduled ? `${fmtNum(m.scheduled)} still waiting` : "—"} />
            <Stat label="Delivered" value={fmtNum(m.delivered)} note={m.sent ? `${fmtPct(m.delivered / m.sent)} of sent` : "—"} tone={m.delivered ? "good" : undefined} />
            <Stat label="Read" value={fmtNum(m.read)} note="Only customers who share read receipts are counted" />
            <Stat label="Failed" value={fmtNum(m.failed)} note={m.skipped ? `${fmtNum(m.skipped)} more held back (consent, opt-out, cancelled)` : "—"} tone={m.failed ? "danger" : undefined} />
            <Stat label="Link clicks" value={fmtNum(m.clicks)} note="Tracked links in cart reminders and campaigns" />
          </section>

          <section className="card" aria-labelledby="chart-h">
            <h2 id="chart-h" className="font-semibold">Messages per day</h2>
            <p className="text-xs text-muted">By the day each message was created (UTC).</p>
            <div className="mt-3">
              <LineChart
                label="WhatsApp messages sent, delivered and failed per day"
                days={list}
                integer
                format={(v) => fmtNum(v)}
                fmtAxis={(v) => fmtNum(v)}
                series={[
                  { key: "sent", label: "Sent", color: "var(--viz-cat-1)", values: list.map((d) => byDay.get(d)?.sent ?? 0) },
                  { key: "delivered", label: "Delivered", color: "var(--viz-cat-3)", values: list.map((d) => byDay.get(d)?.delivered ?? 0) },
                  { key: "failed", label: "Failed", color: "var(--viz-cat-2)", values: list.map((d) => byDay.get(d)?.failed ?? 0) },
                ]}
              />
            </div>
          </section>

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Results">
            <Stat label="Carts recovered" value={fmtNum(data.carts.recovered)} note={`of ${fmtNum(data.carts.reminded)} reminded · ${fmtNum(data.carts.withPhone)} with a number`} tone={data.carts.recovered ? "good" : undefined} />
            <Stat label="Recovered revenue" value={money(data.carts.revenue)} note={`${fmtNum(recoveredOrders)} order${recoveredOrders === 1 ? "" : "s"}, each counted once`} />
            <Stat label="Reviews submitted" value={fmtNum(data.reviews.submitted)} note={data.reviews.average ? `Average ${data.reviews.average} / 5` : "—"} />
            <Stat label="Campaign conversions" value={fmtNum(conversions)} note={`${money(data.campaigns.conversions)} from ${fmtNum(data.campaigns.messages)} campaign messages`} />
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card" aria-labelledby="grp-h">
              <h2 id="grp-h" className="font-semibold">By type</h2>
              {!Object.keys(data.byGroup).length ? (
                <p className="mt-2 text-sm text-muted">No messages in this period.</p>
              ) : (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-muted">
                      <tr><th className="py-1 text-left font-medium">Type</th><th className="py-1 text-right font-medium">Sent</th><th className="py-1 text-right font-medium">Delivered</th><th className="py-1 text-right font-medium">Read</th><th className="py-1 text-right font-medium">Failed</th><th className="py-1 text-right font-medium">Held back</th></tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {Object.entries(data.byGroup).filter(([g]) => g !== "test").map(([g, v]) => (
                        <tr key={g}>
                          <td className="py-1.5">{GROUP_LABEL[g] ?? g}</td>
                          <td className="py-1.5 text-right tabular-nums">{fmtNum(v.sent)}</td>
                          <td className="py-1.5 text-right tabular-nums">{fmtNum(v.delivered)}</td>
                          <td className="py-1.5 text-right tabular-nums">{fmtNum(v.read)}</td>
                          <td className="py-1.5 text-right tabular-nums">{fmtNum(v.failed)}</td>
                          <td className="py-1.5 text-right tabular-nums">{fmtNum(v.skipped)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="card text-sm" aria-labelledby="cost-h">
              <h2 id="cost-h" className="font-semibold">Messaging costs</h2>
              {data.billable.length ? (
                <ul className="mt-2 space-y-1">
                  {data.billable.map((b) => <li key={b.category}>{fmtNum(b.messages)} billable {b.category} message{b.messages === 1 ? "" : "s"}</li>)}
                </ul>
              ) : (
                <p className="mt-2 text-muted">Meta hasn&apos;t reported any billable messages in this period.</p>
              )}
              <p className="mt-2 text-xs text-muted">
                Meta reports which messages are billable and their category, but not the price: rates depend on each customer&apos;s country and change over time. The amounts
                charged are in WhatsApp Manager → Insights, so no estimate is shown here.
              </p>
            </section>
          </div>

          <section className="card text-xs text-muted">
            <h2 className="text-sm font-semibold text-text">How results are counted</h2>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li><strong>Recovered carts</strong>: the checkout&apos;s own order arrived within 7 days after a reminder was sent. Each order is counted once.</li>
              <li><strong>Campaign conversions</strong>: an order counts once, for the last campaign message its customer received in the attribution window before buying. It shows what followed a message, not that the message caused it.</li>
              <li><strong>Read</strong>: only customers who have read receipts on are reported by WhatsApp, so the real number is higher.</li>
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
