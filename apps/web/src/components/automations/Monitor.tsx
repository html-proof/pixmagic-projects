"use client";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { HUB_STATUSES, HUB_STATUS_INFO, type HubCounts, type HubStatus } from "@app/shared/automations";
import { ConfirmDialog, PageHeader, Skeleton, useToast } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Drawer, usePagedList } from "@/components/messaging/MessagingUi";
import { Card, FigureTile } from "@/components/PageKit";
import { Alert, EmptyState } from "@/components/ui";
import { api, fmtNum, useApi } from "@/lib/api";
import { CHANNEL_NAME, ChannelIcon, fmtRate, fmtWhen, HubStatusBadge, hubError, useHub } from "./HubUi";
import { FilterBar, ROW, TableCard, TableHead, TD, Th } from "./MarketingKit";
import type { HubMessage, MessageDetail, OverviewResponse, StatsResponse } from "./types";

// ---------------------------------------------------------------------------
// Message history, as the Stitch design's screen 17 draws Results: the filters on one bar, the
// period's few numbers, what each channel can report, then every automated message of every
// channel, newest first, filtered and paged on the server, on one scale of statuses. "Accepted by
// provider" and "Delivered" are kept apart: only a provider's delivery report makes a message
// delivered, and email through a mailbox never has one.
// ---------------------------------------------------------------------------

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const KIND: Record<string, string> = { automation: "Automation", campaign: "Campaign", test: "Test", manual: "Sent by hand" };

/** Each day's messages as a bar: delivered, accepted only, failed or undelivered, everything else. */
function DayBars({ days }: { days: Array<{ day: string; counts: HubCounts }> }) {
  const totals = days.map((d) => Object.values(d.counts).reduce((a, b) => a + b, 0));
  const max = Math.max(1, ...totals);
  if (!days.length) return null;
  return (
    <Card id="per-day" title="Messages per day" testId="history-per-day">
      <div className="flex h-32 items-end gap-1" role="img" aria-label={`Messages per day: ${days.map((d, i) => `${d.day} ${totals[i]}`).join(", ")}`}>
        {days.map((d, i) => {
          const c = d.counts;
          const parts: Array<[number, string]> = [
            [c.delivered, "bg-good"],
            [c.sent, "bg-accent/60"],
            [c.failed + c.undelivered, "bg-danger"],
            [totals[i]! - c.delivered - c.sent - c.failed - c.undelivered, "bg-muted/40"],
          ];
          return (
            <div key={d.day} className="flex h-full min-w-[3px] flex-1 flex-col justify-end overflow-hidden rounded-t-sm" title={`${d.day}: ${totals[i]} messages`}>
              {parts.map(([n, cls], j) => (n > 0 ? <div key={j} className={cls} style={{ height: `${(n / max) * 100}%` }} /> : null))}
            </div>
          );
        })}
      </div>
      <p className="mt-3 flex flex-wrap gap-3 text-xs text-muted">
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-good" />
          Delivered
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-accent/60" />
          Accepted by provider
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-danger" />
          Failed or undelivered
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-muted/40" />
          Waiting, not sent or test only
        </span>
      </p>
    </Card>
  );
}

export function MessageMonitor() {
  const params = useSearchParams();
  const { path } = useHub();
  const toast = useToast();
  const today = new Date();
  const [from, setFrom] = useState(isoDay(new Date(today.getTime() - 29 * 86400_000)));
  const [to, setTo] = useState(isoDay(today));
  const [channel, setChannel] = useState<"" | "sms" | "email">("");
  const [status, setStatus] = useState<"" | HubStatus>((params.get("status") as HubStatus | null) ?? "");
  const [automation, setAutomation] = useState(params.get("automation") ?? "");
  const [open, setOpen] = useState<HubMessage | null>(null);
  const [retrying, setRetrying] = useState<HubMessage | null>(null);
  const [busy, setBusy] = useState(false);

  const range = `from=${from}&to=${to}`;
  const filters = [range, channel && `channel=${channel}`, status && `status=${status}`, automation && `automation=${encodeURIComponent(automation)}`].filter(Boolean).join("&");
  const overview = useApi<OverviewResponse>(path(""));
  const stats = useApi<StatsResponse>(path(`/stats?${range}`));
  const list = usePagedList<HubMessage>(path(`/messages?${filters}&limit=50`), "messages", 250);
  const detail = useApi<MessageDetail>(open ? path(`/messages/${open.channel}/${open.id}`) : null);

  const retry = async (m: HubMessage) => {
    setBusy(true);
    try {
      await api(path(`/messages/${m.channel}/${m.id}/retry`), { method: "POST", body: {} });
      toast("success", "Queued to send again.");
      setRetrying(null);
      setOpen(null);
      await list.reload();
    } catch (e) {
      toast("error", hubError(e, "send it again"));
    } finally {
      setBusy(false);
    }
  };

  const s = stats.data;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Message history"
        sub="Every automated message, from every channel, with what the provider said about it. Accepted by the provider isn't the same as delivered: only a delivery report confirms that."
      />

      <FilterBar>
        <div>
          <label className="label text-xs text-muted" htmlFor="m-from">
            From
          </label>
          <input id="m-from" className="input" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label text-xs text-muted" htmlFor="m-to">
            To
          </label>
          <input id="m-to" className="input" type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </div>
        <div>
          <label className="label text-xs text-muted" htmlFor="m-channel">
            Channel
          </label>
          <select id="m-channel" className="input" value={channel} onChange={(e) => setChannel(e.target.value as "" | "sms" | "email")}>
            <option value="">All channels</option>
            <option value="sms">SMS</option>
            <option value="email">Email</option>
          </select>
        </div>
        <div>
          <label className="label text-xs text-muted" htmlFor="m-status">
            Status
          </label>
          <select id="m-status" className="input" value={status} onChange={(e) => setStatus(e.target.value as "" | HubStatus)}>
            <option value="">All statuses</option>
            {HUB_STATUSES.map((x) => (
              <option key={x} value={x}>
                {HUB_STATUS_INFO[x].label}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[12rem] flex-1">
          <label className="label text-xs text-muted" htmlFor="m-automation">
            Automation
          </label>
          <select id="m-automation" className="input" value={automation} onChange={(e) => setAutomation(e.target.value)}>
            <option value="">All automations</option>
            {(overview.data?.automations ?? []).map((a) => (
              <option key={`${a.channel}:${a.id}`} value={`${a.channel}:${a.id}`}>
                {a.name} ({CHANNEL_NAME[a.channel]})
              </option>
            ))}
          </select>
        </div>
      </FilterBar>

      {stats.error && !s ? (
        <LoadError what="the figures" error={stats.error} onRetry={() => void stats.reload()} busy={stats.loading} />
      ) : !s ? (
        <Skeleton lines={2} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <FigureTile title="Messages" value={fmtNum(Object.values(s.totals).reduce((a, b) => a + b, 0))} sub={`${from} to ${to}`} />
            <FigureTile
              title="Accepted by providers"
              value={fmtNum(s.totals.sent + s.totals.delivered + s.totals.undelivered)}
              sub={fmtRate(s.acceptanceRate) ? `${fmtRate(s.acceptanceRate)} of those that tried to send` : null}
            />
            <FigureTile
              title="Delivered (confirmed)"
              value={fmtNum(s.totals.delivered)}
              sub={fmtRate(s.deliveryRate) ? `${fmtRate(s.deliveryRate)} of those with a delivery report` : "No delivery reports in this period"}
            />
            <FigureTile
              title="Failed or undelivered"
              value={fmtNum(s.totals.failed + s.totals.undelivered)}
              sub={s.totals.not_sent ? `${fmtNum(s.totals.not_sent)} more not sent on purpose (consent, opt-outs, rules)` : null}
            />
          </div>
          {s.channels.length > 0 && (
            <div className="grid gap-4 lg:grid-cols-2">
              {s.channels.map((c) => (
                <Card key={c.channel} id={`channel-stats-${c.channel}`} title={CHANNEL_NAME[c.channel]} aside={<ChannelIcon channel={c.channel} className="h-4 w-4" />} testId={`history-channel-${c.channel}`}>
                  <div className="space-y-1.5 text-sm">
                    <p className="text-muted">
                      {fmtNum(c.totals.delivered)} delivered · {fmtNum(c.totals.sent)} accepted, no report yet · {fmtNum(c.totals.failed + c.totals.undelivered)} failed · {fmtNum(c.totals.test_only)} test only
                    </p>
                    <p>Delivery rate: {fmtRate(c.deliveryRate) ?? "not reported"}</p>
                    {c.deliveryNote && <p className="text-xs text-muted">{c.deliveryNote}</p>}
                    {c.usage.map((u) => (
                      <p key={u.label} className="text-xs text-muted">
                        {u.label}: <span className="font-medium text-text">{u.value}</span>
                      </p>
                    ))}
                    {c.costUsd !== null && <p className="text-xs text-muted">Billed by the provider in this period: US${c.costUsd.toFixed(4)}</p>}
                  </div>
                </Card>
              ))}
            </div>
          )}
          <DayBars days={s.byDay} />
        </>
      )}

      {list.error && !list.rows ? (
        <LoadError what="the messages" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
      ) : !list.rows ? (
        <Skeleton lines={6} />
      ) : list.rows.length === 0 ? (
        <EmptyState title="No messages" body="Nothing was sent or scheduled with these filters. Try a longer period, or another status." />
      ) : (
        <TableCard id="messages" title="Messages" aside="Newest first. Open one to see what the provider said, step by step.">
          <table className="w-full min-w-[46rem] text-sm">
            <TableHead>
              <Th>Time</Th>
              <Th>Channel</Th>
              <Th>Automation or campaign</Th>
              <Th>To</Th>
              <Th>Status and reason</Th>
              <Th right>Cost</Th>
              <Th right>
                <span className="sr-only">Action</span>
              </Th>
            </TableHead>
            <tbody>
              {list.rows.map((m) => (
                <tr key={`${m.channel}:${m.id}`} className={`${ROW} cursor-pointer hover:bg-home-soft/60`} onClick={() => setOpen(m)}>
                  <td className={`${TD} whitespace-nowrap`}>
                    <button type="button" className="rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent" onClick={() => setOpen(m)}>
                      {fmtWhen(m.createdAt)}
                    </button>
                  </td>
                  <td className={TD}>
                    <span className="inline-flex items-center gap-1.5">
                      <ChannelIcon channel={m.channel} className="h-4 w-4" /> {CHANNEL_NAME[m.channel]}
                    </span>
                  </td>
                  <td className={TD}>{m.automation?.name ?? (m.automation ? "Deleted automation" : (KIND[m.kind] ?? m.kind))}</td>
                  <td className={`${TD} text-muted`}>{m.to ?? "—"}</td>
                  <td className={TD}>
                    <span className="flex flex-col items-start gap-0.5">
                      <HubStatusBadge status={m.status} />
                      {m.reason && <span className="text-xs text-muted">{m.reason}</span>}
                    </span>
                  </td>
                  <td className={`${TD} text-right tabular-nums text-muted`}>{m.costUsd !== null ? `US$${m.costUsd.toFixed(4)}` : "—"}</td>
                  <td className={`${TD} text-right`}>
                    {m.retryable && (
                      <button
                        type="button"
                        className="home-btn h-8 text-xs"
                        disabled={busy}
                        aria-label={`Send again: ${m.automation?.name ?? KIND[m.kind] ?? "message"}, ${fmtWhen(m.createdAt)}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRetrying(m);
                        }}
                      >
                        <RotateCcw aria-hidden className="h-3.5 w-3.5" /> Send again
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.cursor && (
            <div className="border-t border-home-line p-3 text-center">
              <button type="button" className="btn-secondary" disabled={list.loading} onClick={list.loadMore}>
                {list.loading ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </TableCard>
      )}

      {open && (
        <Drawer title={open.automation?.name ?? KIND[open.kind] ?? "Message"} sub={`${CHANNEL_NAME[open.channel]} · ${fmtWhen(open.createdAt)}`} onClose={() => setOpen(null)}>
          {detail.error && !detail.data ? (
            <Alert>{hubError(detail.error, "load the message")}</Alert>
          ) : !detail.data ? (
            <Skeleton lines={4} />
          ) : (
            <>
              <div className="space-y-1">
                <HubStatusBadge status={detail.data.message.status} />
                <p className="text-sm text-muted">{HUB_STATUS_INFO[detail.data.message.status].help}</p>
                {detail.data.message.reason && <p className="text-sm">{detail.data.message.reason}</p>}
                <p className="text-xs text-muted">
                  {CHANNEL_NAME[open.channel]}&apos;s own status: {detail.data.message.channelStatusLabel}
                  {detail.data.message.attempts > 1 ? ` · ${detail.data.message.attempts} attempts` : ""}
                </p>
              </div>
              {detail.data.message.subject && <p className="text-sm font-medium">{detail.data.message.subject}</p>}
              {detail.data.text && <p className="rounded bg-home-soft px-3 py-2 text-sm whitespace-pre-line">{detail.data.text}</p>}
              <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted">To</dt>
                <dd>{detail.data.message.to ?? "Hidden (needs contact details permission)"}</dd>
                <dt className="text-muted">Provider&apos;s id</dt>
                <dd className="break-all">{detail.data.message.providerMessageId ?? "—"}</dd>
                <dt className="text-muted">Accepted</dt>
                <dd>{fmtWhen(detail.data.message.acceptedAt)}</dd>
                <dt className="text-muted">Delivered</dt>
                <dd>{detail.data.message.deliveredAt ? fmtWhen(detail.data.message.deliveredAt) : "No delivery report"}</dd>
              </dl>
              {detail.data.timeline.length > 0 && (
                <ol className="space-y-2 border-l border-home-line pl-4 text-sm" aria-label="What happened">
                  {detail.data.timeline.map((t, i) => (
                    <li key={i}>
                      <p className="font-medium">{t.label}</p>
                      <p className="text-xs text-muted">
                        {fmtWhen(t.at)}
                        {t.detail ? ` · ${t.detail}` : ""}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
              {detail.data.message.retryable ? (
                <button type="button" className="btn-primary inline-flex items-center gap-1.5" onClick={() => setRetrying(detail.data!.message)}>
                  <RotateCcw aria-hidden className="h-4 w-4" /> Send again
                </button>
              ) : (
                detail.data.message.retryNote && <p className="text-xs text-muted">{detail.data.message.retryNote}</p>
              )}
            </>
          )}
        </Drawer>
      )}

      <ConfirmDialog open={!!retrying} title="Send this message again?" confirmLabel="Send again" busy={busy} onCancel={() => setRetrying(null)} onConfirm={() => void retry(retrying!)}>
        {retrying?.status === "unknown" ? (
          <p>Its outcome is unknown: the provider may already have it, so the customer could get it twice. Send it again only if you&apos;re sure it didn&apos;t arrive.</p>
        ) : (
          <p>It is queued again and every check (consent, suppression, limits) runs again before it goes.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}
