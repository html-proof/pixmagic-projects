"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { WA_MESSAGE_STATUSES, WA_STATUS_LABEL } from "@app/shared/whatsapp";
import { LoadError } from "@/components/LoadError";
import { Alert, EmptyState } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { Drawer, fmtWhen, usePagedList } from "@/components/messaging/MessagingUi";
import { SendMessage } from "./SendMessage";
import type { WaMessage, WaOverview, WaWorkflowsAnswer } from "./types";
import { ChatBubble, MessageStatus, reasonText, sourceLabel, useWaAction, waHref } from "./WaUi";

const EVENT_LABEL: Record<string, string> = { sent: "Sent", delivered: "Delivered", read: "Read", failed: "Failed" };

/** Why a message failed, wasn't sent or waits: the reasons the history filters by. */
const REASONS = [
  "refused",
  "undeliverable",
  "uncertain",
  "account",
  "template_not_approved",
  "opted_out",
  "no_marketing_consent",
  "no_order_update_consent",
  "outside_window",
  "missing_values",
  "no_phone",
  "automation_paused",
  "waiting_for_connection",
  "daily_limit",
  "meta_throttled",
  "disconnected",
  "reconnect_timeout",
];

/** The moment a store-time day starts (YYYY-MM-DD in `timeZone`), as an ISO instant; `next`: the day after's. */
export function zonedDayStart(ymd: string, timeZone: string, next = false): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (next ? 1 : 0));
  // Read the zone's offset back through Intl, twice, so a day that starts a daylight-saving change lands right.
  let t = wall;
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
    const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
    const seen = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
    t = wall - (seen - t);
  }
  return new Date(t).toISOString();
}

const FILTER_KEYS = ["status", "direction", "source", "campaignId", "workflowId", "from", "to", "phone", "template", "reason"] as const;
type Filters = Record<(typeof FILTER_KEYS)[number], string>;

/** One message: what it said (for those who may see it), every status Meta reported, and Retry. */
function MessageDrawer({ base, id, tz, canManage, onClose, onChanged }: { base: string; id: string; tz: string; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const { data, error, loading, reload } = useApi<{ message: WaMessage; events: Array<{ status: string; at: string; errorCode: string | null; errorTitle: string | null }> }>(`${base}/messages/${id}`);
  const { busy, run } = useWaAction();
  const m = data?.message;
  return (
    <Drawer title={m ? (m.direction === "in" ? "Message from a customer" : (m.templateName ?? "Message")) : "Message"} sub={m ? `${m.phone ?? ""} · ${sourceLabel(m.source)}` : undefined} onClose={onClose}>
      {error ? (
        <LoadError what="the message" error={error} onRetry={() => void reload()} busy={loading} />
      ) : !m ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <MessageStatus m={m} />
            {m.reasonLabel || m.reason ? <span className="text-sm text-muted">{reasonText(m.reason)}</span> : null}
          </div>
          {m.errorTitle && <Alert>{m.errorTitle}</Alert>}
          {m.preview ? <ChatBubble body={m.preview} /> : <p className="text-sm text-muted">Its words are shown only to people who may see customers&apos; contact information.</p>}
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted">Created</dt>
              <dd>{fmtWhen(m.createdAt, tz)}</dd>
            </div>
            {m.status === "queued" && (
              <div>
                <dt className="text-xs text-muted">Due</dt>
                <dd>{fmtWhen(m.sendAfter, tz)}</dd>
              </div>
            )}
            {m.acceptedAt && (
              <div>
                <dt className="text-xs text-muted">Accepted by WhatsApp</dt>
                <dd>{fmtWhen(m.acceptedAt, tz)}</dd>
              </div>
            )}
            {m.deliveredAt && (
              <div>
                <dt className="text-xs text-muted">Delivered</dt>
                <dd>{fmtWhen(m.deliveredAt, tz)}</dd>
              </div>
            )}
            {m.readAt && (
              <div>
                <dt className="text-xs text-muted">Read</dt>
                <dd>{fmtWhen(m.readAt, tz)}</dd>
              </div>
            )}
            {m.failedAt && (
              <div>
                <dt className="text-xs text-muted">Failed</dt>
                <dd>{fmtWhen(m.failedAt, tz)}</dd>
              </div>
            )}
            <div>
              <dt className="text-xs text-muted">Tries</dt>
              <dd>{m.attempts}</dd>
            </div>
            {m.workflowId && (
              <div>
                <dt className="text-xs text-muted">Workflow</dt>
                <dd>
                  <Link className="text-accent underline-offset-2 hover:underline" href={waHref("workflows", { workflow: m.workflowId })}>
                    Its history
                  </Link>
                </dd>
              </div>
            )}
            <div className="col-span-2">
              <dt className="text-xs text-muted">bizinsights message ID · Meta message ID</dt>
              <dd className="break-all font-mono text-xs">
                {m.id} · {m.wamid ?? "none yet (Meta hasn't accepted it)"}
              </dd>
            </div>
          </dl>
          {data.events.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold">What WhatsApp reported</h3>
              <ol className="mt-2 space-y-1 text-sm">
                {data.events.map((e) => (
                  <li key={`${e.status}-${e.at}`}>
                    <span className="font-medium">{EVENT_LABEL[e.status] ?? e.status}</span> <span className="text-muted">· {fmtWhen(e.at, tz)}</span>
                    {e.errorTitle ? <span className="block text-xs text-danger">{e.errorTitle}</span> : null}
                  </li>
                ))}
              </ol>
            </section>
          )}
          {canManage && m.canRetry && (
            <button
              type="button"
              className="btn-primary"
              disabled={busy === "retry"}
              onClick={() =>
                void run("retry", "send it again", async () => {
                  await api(`${base}/messages/${m.id}/retry`, { method: "POST", body: {} });
                  await reload();
                  onChanged();
                  return "Queued again.";
                })
              }
            >
              {busy === "retry" ? "Queuing…" : "Send it again"}
            </button>
          )}
          {m.reason === "uncertain" && <p className="text-xs text-muted">WhatsApp didn&apos;t answer when this was sent, so the customer may already have it. Check with them before sending it again.</p>}
        </>
      )}
    </Drawer>
  );
}

/** Every message sent and received, with filters, and sending one by hand. */
export function Activity({ base, overview }: { base: string; overview: WaOverview }) {
  const router = useRouter();
  const params = useSearchParams();
  const tz = overview.store.timezone;
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ""])) as Filters;
  // Days are the store's; the API takes instants (the end day is included).
  const asked: Record<string, string> = {};
  for (const k of FILTER_KEYS) {
    const v = filters[k];
    if (!v) continue;
    if (k === "from") asked.from = zonedDayStart(v, tz) ?? "";
    else if (k === "to") asked.to = zonedDayStart(v, tz, true) ?? "";
    else asked[k] = v;
  }
  const q = new URLSearchParams(Object.entries(asked).filter(([, v]) => v)).toString();
  const list = usePagedList<WaMessage>(`${base}/messages${q ? `?${q}` : ""}`, "messages", 400);
  const workflows = useApi<WaWorkflowsAnswer>(`${base}/workflows`);
  const [open, setOpen] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [phone, setPhone] = useState(filters.phone);
  const [template, setTemplate] = useState(filters.template);
  const setFilter = (k: string, v: string) => router.replace(waHref("activity", Object.fromEntries(Object.entries({ ...filters, [k]: v }).filter(([, x]) => x))));
  const canSend = overview.can.manage && overview.can.contacts && overview.connection?.status === "active";
  const any = FILTER_KEYS.some((k) => filters[k]);

  return (
    <div className="space-y-4">
      <section className="card animate-rise">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-semibold">Message history</h2>
            <p className="mt-1 text-sm text-muted">Every WhatsApp message sent and received, with what WhatsApp reported about each.</p>
          </div>
          {canSend && (
            <button type="button" className="btn-primary" onClick={() => setSending(true)}>
              Send a message
            </button>
          )}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <select className="input" aria-label="Status" value={filters.status} onChange={(e) => setFilter("status", e.target.value)}>
            <option value="">Any status</option>
            {WA_MESSAGE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {WA_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <select className="input" aria-label="Direction" value={filters.direction} onChange={(e) => setFilter("direction", e.target.value)}>
            <option value="">Sent and received</option>
            <option value="out">Sent</option>
            <option value="in">Received</option>
          </select>
          <select className="input" aria-label="From" value={filters.source} onChange={(e) => setFilter("source", e.target.value)}>
            <option value="">Anything</option>
            {["workflow", "campaign", "manual", "test", "team_alert", "inbound"].map((s) => (
              <option key={s} value={s}>
                {sourceLabel(s)}
              </option>
            ))}
          </select>
          <select className="input" aria-label="Workflow" value={filters.workflowId} onChange={(e) => setFilter("workflowId", e.target.value)}>
            <option value="">Any workflow</option>
            {(workflows.data?.workflows ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <select className="input" aria-label="Error or reason" value={filters.reason} onChange={(e) => setFilter("reason", e.target.value)}>
            <option value="">Any reason</option>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {reasonText(r)}
              </option>
            ))}
          </select>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setFilter("template", template.trim());
            }}
          >
            <input className="input" aria-label="Template name" placeholder="Template name" value={template} onChange={(e) => setTemplate(e.target.value)} onBlur={() => template.trim() !== filters.template && setFilter("template", template.trim())} />
          </form>
          <label className="flex items-center gap-2 text-sm">
            <span className="shrink-0 text-muted">From</span>
            <input className="input" type="date" aria-label="From day" value={filters.from} onChange={(e) => setFilter("from", e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="shrink-0 text-muted">To</span>
            <input className="input" type="date" aria-label="To day" value={filters.to} onChange={(e) => setFilter("to", e.target.value)} />
          </label>
          {overview.can.contacts && (
            <form
              className="flex gap-2 sm:col-span-3"
              onSubmit={(e) => {
                e.preventDefault();
                setFilter("phone", phone.trim());
              }}
            >
              <input className="input" type="tel" aria-label="Customer's number" placeholder="Customer's number, like +61412345678" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <button type="submit" className="btn-secondary shrink-0">
                Find
              </button>
            </form>
          )}
        </div>
        <p className="mt-2 text-xs text-muted">Days are your store&apos;s ({tz}). A customer&apos;s number is matched without being stored as you typed it.</p>
        {any && (
          <button
            type="button"
            className="mt-2 text-xs text-accent underline"
            onClick={() => {
              setPhone("");
              setTemplate("");
              router.replace(waHref("activity"));
            }}
          >
            {filters.campaignId ? "Showing one campaign's messages · " : filters.workflowId ? "Showing one workflow's messages · " : ""}Clear the filters
          </button>
        )}
      </section>
      {list.error ? (
        <LoadError what="the messages" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
      ) : !list.rows ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : !list.rows.length ? (
        <EmptyState title="No messages" body={any ? "Nothing matches these filters." : "Messages appear here as workflows, campaigns and your team send them, and as customers reply."} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-2 pr-3 font-medium">When</th>
                <th className="py-2 pr-3 font-medium">Customer</th>
                <th className="py-2 pr-3 font-medium">Message</th>
                <th className="py-2 pr-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.rows.map((m) => (
                <tr key={m.id} className="cursor-pointer hover:bg-bg" onClick={() => setOpen(m.id)}>
                  <td className="whitespace-nowrap py-2 pr-3 text-muted">{fmtWhen(m.createdAt, tz)}</td>
                  <td className="whitespace-nowrap py-2 pr-3">{m.phone ?? "—"}</td>
                  <td className="py-2 pr-3">
                    <button type="button" className="text-left text-accent underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); setOpen(m.id); }}>
                      {m.direction === "in" ? "Reply" : (m.templateName ?? m.type)}
                    </button>
                    <span className="text-xs text-muted"> · {sourceLabel(m.source)}</span>
                    {m.preview ? <span className="block max-w-md truncate text-xs text-muted">{m.preview}</span> : null}
                  </td>
                  <td className="py-2 pr-3">
                    <MessageStatus m={m} />
                    {m.status !== "delivered" && m.status !== "read" && (m.errorTitle || m.reason) ? <span className="block max-w-xs truncate text-xs text-muted">{m.errorTitle ?? reasonText(m.reason)}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.cursor && (
            <button type="button" className="btn-secondary mt-3" onClick={list.loadMore} disabled={list.loading}>
              {list.loading ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
      )}
      {open && <MessageDrawer base={base} id={open} tz={tz} canManage={overview.can.manage} onClose={() => setOpen(null)} onChanged={() => void list.reload()} />}
      {sending && <SendMessage base={base} contact={null} open={sending} onClose={() => setSending(false)} onSent={() => void list.reload()} />}
    </div>
  );
}
