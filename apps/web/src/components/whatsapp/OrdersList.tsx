"use client";
import { useState } from "react";
import { reasonLabel } from "@app/shared/whatsapp";
import { Badge, Empty, type Tone } from "@/components/dashboard/primitives";
import { fmtMoney, api, useApi } from "@/lib/api";
import { useApp } from "@/components/AppContext";
import { LoadError } from "@/components/LoadError";
import { fmtWhen, kindLabel, MessageStatus, overlay, Skeleton, useAction, useToast, useWa } from "./common";

export const ORDER_STATUS: Record<string, { tone: Tone; label: string }> = {
  placed: { tone: "neutral", label: "Placed" },
  paid: { tone: "neutral", label: "Paid" },
  processing: { tone: "neutral", label: "Processing" },
  packed: { tone: "neutral", label: "Packed" },
  shipped: { tone: "good", label: "Shipped" },
  in_transit: { tone: "good", label: "In transit" },
  out_for_delivery: { tone: "good", label: "Out for delivery" },
  delivered: { tone: "good", label: "Delivered" },
  delivery_failed: { tone: "warn", label: "Delivery attempt failed" },
  cancelled: { tone: "danger", label: "Cancelled" },
  refunded: { tone: "neutral", label: "Refunded" },
};

const EVENT_LABEL: Record<string, string> = {
  placed: "Order placed",
  paid: "Payment confirmed",
  processing: "Marked processing",
  packed: "Marked packed",
  shipped: "Shipped",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  delivery_failed: "Delivery attempt failed",
  cancelled: "Cancelled",
  refunded: "Refund recorded",
};
const SOURCE: Record<string, string> = { shopify: "Shopify", carrier: "Courier", merchant: "You" };

interface OrderRow {
  id: string;
  orderName: string;
  status: string;
  placedAt: string;
  total: number;
  currency: string;
  phoneMasked: string | null;
  liveTracking: boolean;
  messages: Record<string, number>;
}

interface OrderDetail {
  order: {
    id: string;
    orderName: string;
    status: string;
    placedAt: string;
    total: number;
    currency: string;
    items: Array<{ title: string; quantity: number }>;
    deliveredAt: string | null;
    cancelledAt: string | null;
    liveTracking: boolean;
    consent: { cartOptIn: boolean; smsConsent: boolean };
    trackingUrl: string;
  };
  customer: { phoneMasked: string; optedOut: boolean; marketing: string; country: string | null } | null;
  events: Array<{ type: string; at: string; source: string; courier: string | null; trackingNumber: string | null; trackingUrl: string | null; estimatedDelivery: string | null }>;
  messages: Array<{ id: string; kind: string; status: string; reason: string | null; templateName: string | null; sentAt: string | null; deliveredAt: string | null; readAt: string | null; scheduledFor: string; failure: string | null }>;
  reviews: Array<{ id: string; productTitle: string | null; rating: number; status: string }>;
}


function OrderDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { base, manage } = useWa();
  const { store } = useApp();
  const tz = store?.timezone;
  const { data, error, reload } = useApi<OrderDetail>(`${base}/orders/${id}`);
  const { busy, run } = useAction();
  const toast = useToast();
  const step = (s: "processing" | "packed" | "delivered") =>
    run(s, `mark the order ${s}`, async () => {
      const r = await api<{ changed: boolean }>(`${base}/orders/${id}/steps`, { method: "POST", body: { step: s } });
      await reload();
      return r.changed ? `Marked ${s}.` : `It was already marked ${s}.`;
    });
  return overlay(
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <aside role="dialog" aria-modal="true" aria-label="Order timeline" className="animate-sheet h-full w-full max-w-xl overflow-y-auto bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold">{data ? `Order ${data.order.orderName}` : "Order"}</h2>
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={onClose} autoFocus>Close</button>
        </div>
        {!data && error ? (
          <div className="mt-4"><LoadError what="this order" error={error} onRetry={() => void reload()} /></div>
        ) : !data ? (
          <div className="mt-4"><Skeleton lines={6} /></div>
        ) : (
          <div className="mt-3 space-y-5 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={ORDER_STATUS[data.order.status]?.tone ?? "neutral"}>{ORDER_STATUS[data.order.status]?.label ?? data.order.status}</Badge>
              <span className="text-muted">{fmtMoney(data.order.total, data.order.currency)} · placed {fmtWhen(data.order.placedAt, tz)}</span>
            </div>
            {data.customer ? (
              <p className="text-muted">
                WhatsApp {data.customer.phoneMasked}
                {data.customer.optedOut ? <span className="text-danger"> · replied STOP (nothing more is sent)</span> : null}
                {data.order.consent.cartOptIn ? " · ticked WhatsApp updates at checkout" : ""}
                {data.order.consent.smsConsent ? " · accepted text-message marketing" : ""}
              </p>
            ) : (
              <p className="text-muted">No WhatsApp number for this order.</p>
            )}
            {!data.order.liveTracking && data.order.status !== "placed" && !data.order.cancelledAt && (
              <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted">No courier has reported progress for this order, so live delivery status isn&apos;t available. Customers see the same.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <a className="btn-secondary h-8 px-3 text-xs" href={data.order.trackingUrl} target="_blank" rel="noreferrer noopener">Open tracking page</a>
              <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => void navigator.clipboard.writeText(data.order.trackingUrl).then(() => toast("success", "Tracking link copied."))}>Copy tracking link</button>
              {manage && !data.order.cancelledAt && !data.order.deliveredAt && (
                <>
                  <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={!!busy} onClick={() => void step("processing")}>Mark processing</button>
                  <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={!!busy} onClick={() => void step("packed")}>Mark packed</button>
                  <button
                    type="button"
                    className="btn-secondary h-8 px-3 text-xs"
                    disabled={!!busy}
                    onClick={() => {
                      if (window.confirm("Mark this order delivered? Only do this if you know it arrived: the customer is told it was delivered.")) void step("delivered");
                    }}
                  >
                    Mark delivered
                  </button>
                </>
              )}
            </div>

            <section aria-label="Timeline">
              <h3 className="font-semibold">Timeline</h3>
              <ol className="mt-2 space-y-3 border-l border-border pl-4">
                {data.events.map((e, i) => (
                  <li key={i} className="relative">
                    <span aria-hidden className={`absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full ${e.type === "delivery_failed" || e.type === "cancelled" ? "bg-danger" : "bg-accent"}`} />
                    <p className="font-medium">{EVENT_LABEL[e.type] ?? e.type}</p>
                    <p className="text-xs text-muted">
                      {fmtWhen(e.at, tz)} · from {SOURCE[e.source] ?? e.source}
                      {e.courier ? ` · ${e.courier}` : ""}
                      {e.trackingNumber ? ` · ${e.trackingNumber}` : ""}
                      {e.estimatedDelivery ? ` · expected ${fmtWhen(e.estimatedDelivery, tz)}` : ""}
                    </p>
                  </li>
                ))}
              </ol>
            </section>

            <section aria-label="WhatsApp messages">
              <h3 className="font-semibold">WhatsApp messages</h3>
              {!data.messages.length ? (
                <p className="mt-1 text-muted">None for this order.</p>
              ) : (
                <ul className="mt-2 divide-y divide-border">
                  {data.messages.map((m) => (
                    <li key={m.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                      <div className="min-w-0">
                        <p className="font-medium">{kindLabel(m.kind)}</p>
                        <p className="text-xs text-muted">
                          {m.sentAt ? `Sent ${fmtWhen(m.sentAt, tz)}` : `Scheduled ${fmtWhen(m.scheduledFor, tz)}`}
                          {m.readAt ? ` · read ${fmtWhen(m.readAt, tz)}` : m.deliveredAt ? ` · delivered ${fmtWhen(m.deliveredAt, tz)}` : ""}
                        </p>
                        {(m.failure || m.reason) && <p className="text-xs text-warn">{m.failure ?? reasonLabel(m.reason)}</p>}
                      </div>
                      <MessageStatus status={m.status} reason={m.reason} />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {data.reviews.length > 0 && (
              <section aria-label="Reviews">
                <h3 className="font-semibold">Reviews</h3>
                <ul className="mt-1 space-y-1">
                  {data.reviews.map((r) => (
                    <li key={r.id}>{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)} {r.productTitle ?? "The order"} <Badge tone="neutral">{r.status}</Badge></li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

/** Recent orders with their WhatsApp status; a row opens its timeline. */
export function OrdersList({ statuses, title, empty }: { statuses?: string[]; title: string; empty: string }) {
  const { base, contact } = useWa();
  const { store } = useApp();
  const [status, setStatus] = useState<string>("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const params = new URLSearchParams({ limit: "30", ...(status ? { status } : {}), ...(q ? { q } : {}) });
  const { data, error } = useApi<{ orders: OrderRow[]; nextCursor: string | null }>(contact && base ? `${base}/orders?${params}` : null);
  if (!contact) return null;
  const rows = (data?.orders ?? []).filter((o) => !statuses || statuses.includes(o.status));
  return (
    <section className="card animate-rise" aria-labelledby="ol-h">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="ol-h" className="font-semibold">{title}</h2>
        <div className="flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="ol-q">Search orders</label>
          <input id="ol-q" className="input w-40" placeholder="Order #" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="sr-only" htmlFor="ol-s">Status</label>
          <select id="ol-s" className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {(statuses ?? Object.keys(ORDER_STATUS)).map((s) => (
              <option key={s} value={s}>{ORDER_STATUS[s]?.label ?? s}</option>
            ))}
          </select>
        </div>
      </div>
      {error ? (
        <p className="mt-3 text-sm text-danger">{error.message}</p>
      ) : !data ? (
        <div className="mt-3 space-y-2">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-10" />)}</div>
      ) : !rows.length ? (
        <div className="mt-3"><Empty>{empty}</Empty></div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-2 pr-3 font-medium">Order</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Placed</th>
                <th className="py-2 pr-3 font-medium">Customer</th>
                <th className="py-2 pr-3 text-right font-medium">Total</th>
                <th className="py-2 font-medium">Messages</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((o) => {
                const sent = (o.messages.sent ?? 0) + (o.messages.delivered ?? 0) + (o.messages.read ?? 0);
                return (
                  <tr key={o.id} className="cursor-pointer hover:bg-bg/60" onClick={() => setOpen(o.id)}>
                    <td className="py-2 pr-3 font-medium">
                      <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); setOpen(o.id); }}>{o.orderName}</button>
                    </td>
                    <td className="py-2 pr-3"><Badge tone={ORDER_STATUS[o.status]?.tone ?? "neutral"}>{ORDER_STATUS[o.status]?.label ?? o.status}</Badge></td>
                    <td className="py-2 pr-3 text-muted">{fmtWhen(o.placedAt, store?.timezone)}</td>
                    <td className="py-2 pr-3 text-muted">{o.phoneMasked ?? "No number"}</td>
                    <td className="py-2 pr-3 text-right">{fmtMoney(o.total, o.currency)}</td>
                    <td className="py-2 text-xs text-muted">
                      {sent} sent
                      {o.messages.failed ? <span className="text-danger"> · {o.messages.failed} failed</span> : null}
                      {o.messages.scheduled ? ` · ${o.messages.scheduled} waiting` : ""}
                      {o.messages.skipped ? ` · ${o.messages.skipped} not sent` : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open && <OrderDrawer id={open} onClose={() => setOpen(null)} />}
    </section>
  );
}
