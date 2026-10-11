"use client";
import { useEffect, useRef, useState } from "react";
import { KIND_INFO, reasonLabel, type NotificationKind } from "@app/shared/whatsapp";
import { Empty } from "@/components/dashboard/primitives";
import { useApp } from "@/components/AppContext";
import { actionError, api } from "@/lib/api";
import { fmtWhen, MessageStatus, PageHeader, useAction, useWa } from "@/components/whatsapp/common";

interface Message {
  id: string;
  kind: string;
  category: string;
  templateName: string | null;
  phoneMasked: string | null;
  orderName: string | null;
  campaign: { id: string; name: string | null } | null;
  status: string;
  reason: string | null;
  scheduledFor: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failure: string | null;
  providerMessageId: string | null;
  attempts: number;
  clickedAt: string | null;
  attributedOrderId: string | null;
  test: boolean;
  createdAt: string;
  canRetry: boolean;
  canCancel: boolean;
}

const GROUPS = [
  ["", "All types"],
  ["orders", "Order notifications"],
  ["delivery", "Delivery updates"],
  ["carts", "Cart reminders"],
  ["reviews", "Review requests"],
  ["campaign", "Campaigns"],
  ["automation", "Automations"],
  ["test", "Tests"],
] as const;
const STATUSES = [
  ["", "Any status"],
  ["scheduled", "Scheduled"],
  ["sent,delivered,read", "Sent"],
  ["delivered,read", "Delivered"],
  ["read", "Read"],
  ["failed", "Failed"],
  ["skipped,cancelled", "Not sent"],
] as const;

const kindLabel = (k: string) => KIND_INFO[k as NotificationKind]?.label ?? ({ automation: "Automation", campaign: "Campaign", test: "Test" } as Record<string, string>)[k] ?? k;

export default function MessageHistory() {
  const { base, contact, manage } = useWa();
  const { store } = useApp();
  const tz = store?.timezone;
  const [filters, setFilters] = useState({ status: "", group: "", from: "", to: "", q: "" });
  const [rows, setRows] = useState<Message[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { busy, run } = useAction();

  // Arriving from the overview with ?status=failed.
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get("status");
    if (s) setFilters((f) => ({ ...f, status: s }));
  }, []);

  const query = (c?: string | null) => new URLSearchParams(Object.fromEntries(Object.entries({ ...filters, limit: "50", cursor: c ?? "" }).filter(([, v]) => v)));
  // Only the latest request may fill the list: an older one answering late (filters changed while
  // it was in flight) would show results for filters that are no longer selected.
  const latest = useRef(0);
  const load = async (append = false) => {
    if (!base || !contact) return;
    const request = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ messages: Message[]; nextCursor: string | null }>(`${base}/messages?${query(append ? cursor : null)}`);
      if (request !== latest.current) return;
      setRows((prev) => (append && prev ? [...prev, ...r.messages] : r.messages));
      setCursor(r.nextCursor);
    } catch (e) {
      if (request === latest.current) setError(actionError(e, "load the messages"));
    } finally {
      if (request === latest.current) setLoading(false);
    }
  };
  useEffect(() => {
    const t = window.setTimeout(() => void load(), filters.q ? 300 : 0);
    return () => window.clearTimeout(t);
    // Reload when a filter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, contact, filters]);

  const set = (k: keyof typeof filters) => (e: { target: { value: string } }) => setFilters({ ...filters, [k]: e.target.value });

  return (
    <div className="space-y-4">
      <PageHeader title="Message history" sub="Every WhatsApp message Insights scheduled, sent or held back, and why. Customers' numbers are masked. Kept for 180 days." />
      {!contact ? (
        <div className="card text-sm text-muted">Your role can&apos;t see customers&apos; messages. Ask an owner or admin.</div>
      ) : (
        <section className="card" aria-label="Messages">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <label className="text-xs text-muted" htmlFor="f-s">Status</label>
              <select id="f-s" className="input" value={filters.status} onChange={set("status")}>
                {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted" htmlFor="f-g">Type</label>
              <select id="f-g" className="input" value={filters.group} onChange={set("group")}>
                {GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted" htmlFor="f-from">From</label>
              <input id="f-from" className="input" type="date" value={filters.from} onChange={set("from")} />
            </div>
            <div>
              <label className="text-xs text-muted" htmlFor="f-to">To</label>
              <input id="f-to" className="input" type="date" value={filters.to} onChange={set("to")} />
            </div>
            <div>
              <label className="text-xs text-muted" htmlFor="f-q">Order #, message ID or last digits</label>
              <input id="f-q" className="input" value={filters.q} onChange={set("q")} placeholder="#1042" />
            </div>
          </div>
          {error && <p className="mt-3 text-sm text-danger">{error}</p>}
          {!rows ? (
            <div className="mt-4 space-y-2">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-10" />)}</div>
          ) : !rows.length ? (
            <div className="mt-4"><Empty>No messages match.</Empty></div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[60rem] text-left text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Customer</th>
                    <th className="py-2 pr-3 font-medium">About</th>
                    <th className="py-2 pr-3 font-medium">Template</th>
                    <th className="py-2 pr-3 font-medium">Sent</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">Read</th>
                    <th className="py-2 pr-3 font-medium">Why / failure</th>
                    <th className="py-2 pr-3 font-medium">Message ID</th>
                    {manage && <th className="py-2 font-medium"><span className="sr-only">Actions</span></th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((m) => (
                    <tr key={m.id} className="align-top">
                      <td className="py-2 pr-3 whitespace-nowrap">{m.test ? <span className="text-muted">Test send</span> : (m.phoneMasked ?? "—")}</td>
                      <td className="py-2 pr-3">
                        <span className="font-medium">{kindLabel(m.kind)}</span>
                        <span className="block text-xs text-muted">
                          {m.orderName ?? (m.campaign ? `Campaign: ${m.campaign.name ?? "—"}` : "")}
                          {m.attributedOrderId ? " · followed by an order" : ""}
                          {m.clickedAt ? " · link opened" : ""}
                        </span>
                      </td>
                      <td className="py-2 pr-3">
                        {m.templateName ?? "—"}
                        <span className="block text-xs text-muted">{m.category !== "unknown" ? m.category : ""}</span>
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap text-muted">{m.sentAt ? fmtWhen(m.sentAt, tz) : m.status === "scheduled" ? `for ${fmtWhen(m.scheduledFor, tz)}` : "—"}</td>
                      <td className="py-2 pr-3"><MessageStatus status={m.status} reason={m.reason} /></td>
                      <td className="py-2 pr-3 whitespace-nowrap text-muted">{m.readAt ? fmtWhen(m.readAt, tz) : "—"}</td>
                      <td className="max-w-xs py-2 pr-3 text-xs text-muted">{m.failure ?? reasonLabel(m.reason) ?? ""}{m.attempts > 1 ? ` (${m.attempts} attempts)` : ""}</td>
                      <td className="max-w-[10rem] truncate py-2 pr-3 font-mono text-xs text-muted" title={m.providerMessageId ?? undefined}>{m.providerMessageId ?? "—"}</td>
                      {manage && (
                        <td className="py-2 whitespace-nowrap">
                          {m.canRetry && (
                            <button type="button" className="btn-secondary h-7 px-2 text-xs" disabled={!!busy} onClick={() => void run(m.id, "retry", async () => { await api(`${base}/messages/${m.id}/retry`, { method: "POST" }); await load(); return "Queued again; consent and eligibility are checked again before it goes."; })}>
                              Retry
                            </button>
                          )}
                          {m.canCancel && (
                            <button type="button" className="btn-secondary h-7 px-2 text-xs" disabled={!!busy} onClick={() => void run(m.id, "cancel", async () => { await api(`${base}/messages/${m.id}/cancel`, { method: "POST" }); await load(); return "Cancelled."; })}>
                              Cancel
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {cursor && (
            <button type="button" className="btn-secondary mt-3" disabled={loading} onClick={() => void load(true)}>{loading ? "Loading…" : "Load more"}</button>
          )}
        </section>
      )}
    </div>
  );
}
