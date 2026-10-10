"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

// ---------------------------------------------------------------------------
// The customer's order tracking page, opened from a WhatsApp message. The link carries a long
// random token (in the query string, so the static site can serve it); the API finds the order by
// the token's hash. No sign-in, no customer details beyond the order itself.
// ---------------------------------------------------------------------------

interface Tracking {
  store: { name: string; supportPhone: string | null; supportEmail: string | null };
  order: {
    name: string;
    placedAt: string;
    total: number;
    currency: string;
    payment: string | null;
    status: string;
    cancelledAt: string | null;
    deliveredAt: string | null;
    items: Array<{ title: string; quantity: number }>;
  };
  steps: Array<{ key: string; label: string; done: boolean; at: string | null }>;
  shipments: Array<{ courier: string | null; trackingNumber: string | null; trackingUrl: string | null; status: string; estimatedDelivery: string | null }>;
  failedAttempts: string[];
  liveTracking: boolean;
  reviewToken: string | null;
}

const HEADLINE: Record<string, string> = {
  placed: "Your order is confirmed",
  paid: "Your order is confirmed and paid",
  processing: "Your order is being prepared",
  packed: "Your order is packed",
  shipped: "Your order is on its way",
  in_transit: "Your order is on its way",
  out_for_delivery: "Your order is out for delivery",
  delivered: "Your order has been delivered",
  delivery_failed: "A delivery attempt didn't succeed",
  cancelled: "This order was cancelled",
  refunded: "This order was refunded",
};

const when = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : null;
const day = (iso: string | null) => (iso ? new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(new Date(iso)) : null);
const money = (n: number, c: string) => {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: c }).format(n);
  } catch {
    return `${n.toFixed(2)} ${c}`;
  }
};

export default function TrackPage() {
  const [data, setData] = useState<Tracking | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("t");
    if (!token) {
      setError("This link is missing its code. Open it again from the WhatsApp message.");
      return;
    }
    fetch(`/api/public/track/${encodeURIComponent(token)}`, { credentials: "omit", referrerPolicy: "no-referrer" })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.message ?? (r.status === 429 ? "Too many requests. Please try again in a minute." : "We couldn't load your order. Please try again."));
        setData(body as Tracking);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
        <div className="card text-center">
          <h1 className="text-lg font-semibold">We can&apos;t show this order</h1>
          <p className="mt-2 text-sm text-muted">{error}</p>
        </div>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="mx-auto max-w-md space-y-3 px-4 py-10" aria-busy="true">
        <div className="skeleton h-8 w-2/3" />
        <div className="skeleton h-40" />
        <div className="skeleton h-24" />
      </main>
    );
  }

  const o = data.order;
  const shipped = data.steps.some((s) => s.key === "shipped" && s.done);
  const support = data.store.supportPhone || data.store.supportEmail;
  return (
    <main className="mx-auto max-w-md space-y-4 px-4 py-8">
      <header>
        <p className="text-sm font-medium text-muted">{data.store.name}</p>
        <h1 className="mt-1 text-2xl font-semibold">{HEADLINE[o.status] ?? "Your order"}</h1>
        <p className="mt-1 text-sm text-muted">
          Order {o.name} · placed {when(o.placedAt)}
        </p>
      </header>

      {o.status !== "cancelled" && (
        <section className="card" aria-label="Progress">
          <ol className="space-y-0">
            {data.steps.map((s, i) => {
              const last = i === data.steps.length - 1;
              return (
                <li key={s.key} className="relative flex gap-3 pb-5 last:pb-0">
                  {!last && <span aria-hidden className={`absolute left-[9px] top-5 h-full w-0.5 ${s.done && data.steps[i + 1]?.done ? "bg-accent" : "bg-border"}`} />}
                  <span aria-hidden className={`relative z-10 mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${s.done ? "bg-accent text-accent-ink" : "border-2 border-border bg-surface"}`}>
                    {s.done ? "✓" : ""}
                  </span>
                  <div>
                    <p className={`text-sm ${s.done ? "font-medium" : "text-muted"}`}>
                      <span className="sr-only">{s.done ? "Done: " : "Not yet: "}</span>
                      {s.label}
                    </p>
                    {s.done && s.at && <p className="text-xs text-muted">{when(s.at)}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {data.failedAttempts.length > 0 && !o.deliveredAt && (
        <div className="rounded-xl border border-warn px-4 py-3 text-sm" role="status">
          The courier couldn&apos;t deliver on {day(data.failedAttempts[data.failedAttempts.length - 1]!)}. They usually try again; use the courier&apos;s link below for their latest news.
        </div>
      )}

      {data.shipments.map((sh, i) => (
        <section key={i} className="card space-y-1 text-sm" aria-label={`Shipment ${i + 1}`}>
          <h2 className="font-semibold">{data.shipments.length > 1 ? `Parcel ${i + 1}` : "Shipping"}</h2>
          <p>
            Courier: <strong>{sh.courier ?? "Not specified"}</strong>
          </p>
          {sh.trackingNumber && (
            <p>
              Tracking number: <span className="font-mono">{sh.trackingNumber}</span>
            </p>
          )}
          {sh.estimatedDelivery && !o.deliveredAt && <p>Expected: {day(sh.estimatedDelivery)}</p>}
          {sh.trackingUrl && (
            <a className="btn-primary mt-2 w-full" href={sh.trackingUrl} target="_blank" rel="noreferrer noopener">
              Track with {sh.courier ?? "the courier"}
            </a>
          )}
        </section>
      ))}

      {shipped && !data.liveTracking && !o.deliveredAt && (
        <p className="rounded-xl border border-dashed border-border px-4 py-3 text-xs text-muted">
          Live delivery updates aren&apos;t available for this courier, so this page can&apos;t show where the parcel is right now.
          {data.shipments.some((s) => s.trackingUrl) ? " The courier's own tracking link above has their latest information." : ""}
        </p>
      )}

      <section className="card text-sm" aria-label="Order details">
        <h2 className="font-semibold">Your order</h2>
        <ul className="mt-2 space-y-1">
          {o.items.map((it, i) => (
            <li key={i} className="flex justify-between gap-3">
              <span className="min-w-0">{it.title}</span>
              <span className="shrink-0 text-muted">× {it.quantity}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 flex justify-between border-t border-border pt-2 font-medium">
          <span>Total</span>
          <span>{money(o.total, o.currency)}</span>
        </p>
        {o.payment && <p className="mt-1 text-xs text-muted">{o.payment}</p>}
      </section>

      {data.reviewToken && (
        <Link href={`/review?t=${encodeURIComponent(data.reviewToken)}`} className="btn-secondary w-full">
          How was your order? Leave a review
        </Link>
      )}

      {support && (
        <p className="text-center text-sm text-muted">
          Questions about your order? Contact {data.store.name}:{" "}
          {data.store.supportPhone && (
            <a className="underline" href={`tel:${data.store.supportPhone.replace(/[^\d+]/g, "")}`}>
              {data.store.supportPhone}
            </a>
          )}
          {data.store.supportPhone && data.store.supportEmail ? " · " : ""}
          {data.store.supportEmail && (
            <a className="underline" href={`mailto:${data.store.supportEmail}`}>
              {data.store.supportEmail}
            </a>
          )}
          , or reply to the store&apos;s WhatsApp message.
        </p>
      )}
      <p className="text-center text-xs text-muted">Keep this link private: anyone who has it can see this order&apos;s status.</p>
    </main>
  );
}
