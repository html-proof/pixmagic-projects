"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { WA_MESSAGE_STATUSES, WA_STATUS_LABEL } from "@app/shared/whatsapp";
import { LoadError } from "@/components/LoadError";
import { Alert, EmptyState } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { Drawer, fmtWhen, usePagedList } from "@/components/messaging/MessagingUi";
import { SendMessage } from "./SendMessage";
import type { WaMessage, WaOverview } from "./types";
import { ChatBubble, MessageStatus, reasonText, sourceLabel, useWaAction, waHref } from "./WaUi";

const EVENT_LABEL: Record<string, string> = { sent: "Sent", delivered: "Delivered", read: "Read", failed: "Failed" };

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
            <div>
              <dt className="text-xs text-muted">Tries</dt>
              <dd>{m.attempts}</dd>
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
  const filters = { status: params.get("status") ?? "", direction: params.get("direction") ?? "", source: params.get("source") ?? "", campaignId: params.get("campaignId") ?? "", workflowId: params.get("workflowId") ?? "" };
  const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const list = usePagedList<WaMessage>(`${base}/messages${q ? `?${q}` : ""}`, "messages");
  const [open, setOpen] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const tz = overview.store.timezone;
  const setFilter = (k: string, v: string) => router.replace(waHref("activity", Object.fromEntries(Object.entries({ ...filters, [k]: v }).filter(([, x]) => x))));
  const canSend = overview.can.manage && overview.can.contacts && overview.connection?.status === "active";

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
        </div>
        {(filters.campaignId || filters.workflowId) && (
          <button type="button" className="mt-2 text-xs text-accent underline" onClick={() => router.replace(waHref("activity"))}>
            Showing one {filters.campaignId ? "campaign" : "workflow"}&apos;s messages · show all
          </button>
        )}
      </section>
      {list.error ? (
        <LoadError what="the messages" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
      ) : !list.rows ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : !list.rows.length ? (
        <EmptyState title="No messages" body={q ? "Nothing matches these filters." : "Messages appear here as workflows, campaigns and your team send them, and as customers reply."} />
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
