"use client";
import { useState } from "react";
import Link from "next/link";
import { kindsOf, reasonLabel } from "@app/shared/whatsapp";
import { Badge, Empty, Stat, type Tone } from "@/components/dashboard/Primitives";
import { fmtRelative } from "@/components/dashboard/format";
import { useApp } from "@/components/AppContext";
import { api, fmtMoney, fmtNum, useApi } from "@/lib/api";
import { fmtWhen, KindsSection, MessageStatus, useWa } from "@/components/whatsapp/WhatsappUi";
import { PageHeader, useAction } from "@/components/AppUi";

interface Cart {
  id: string;
  customerName: string | null;
  phoneMasked: string | null;
  total: number;
  currency: string;
  items: Array<{ title: string; quantity: number; price: number }>;
  abandonedAt: string;
  status: "open" | "reminded" | "recovered" | "completed" | "expired" | "ineligible";
  ineligibleReason: string | null;
  marketingConsent: boolean;
  checkoutUrl: string | null;
  recovered: { orderName: string | null; revenue: number; at: string | null } | null;
  completedAt: string | null;
  reminders: Array<{ kind: string; status: string; reason: string | null; scheduledFor: string; sentAt: string | null; readAt: string | null; clickedAt: string | null }>;
}

const STATUS: Record<Cart["status"], { tone: Tone; label: string }> = {
  open: { tone: "neutral", label: "Waiting" },
  reminded: { tone: "neutral", label: "Reminded" },
  recovered: { tone: "good", label: "Recovered" },
  completed: { tone: "neutral", label: "Bought without a reminder" },
  expired: { tone: "neutral", label: "Expired" },
  ineligible: { tone: "warn", label: "Can't be reminded" },
};

const FILTERS = [
  ["", "All"],
  ["open,reminded", "Not finished"],
  ["recovered", "Recovered"],
  ["ineligible", "Can't be reminded"],
  ["completed,expired", "Closed"],
] as const;

export default function AbandonedCarts() {
  const { base, contact, manage } = useWa();
  const { store } = useApp();
  const [filter, setFilter] = useState<string>("open,reminded");
  const { data, error, reload } = useApi<{ counts: Record<string, number>; carts: Cart[]; nextCursor: string | null }>(
    contact && base ? `${base}/carts?${new URLSearchParams({ limit: "50", ...(filter ? { status: filter } : {}) })}` : null,
  );
  const { busy, run } = useAction();
  const n = (s: string) => data?.counts[s] ?? 0;
  const recoveredRevenue = (data?.carts ?? []).filter((c) => c.recovered).reduce((s, c) => s + (c.recovered?.revenue ?? 0), 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Abandoned cart recovery"
        sub={
          <>
            When someone types their phone number at checkout and leaves without paying, Insights can send one or two WhatsApp reminders with a link back to their own
            Shopify checkout. Only customers who agreed to WhatsApp marketing are reminded (cart reminders are marketing on WhatsApp); anonymous visitors are never
            contacted or stored. A reminder is cancelled the moment the order comes in.
          </>
        }
      />

      <KindsSection
        title="Reminders"
        kinds={kindsOf("carts")}
        extra={(cfg, set) => (
          <div className="mt-3 grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="cart-d1">First reminder after (minutes)</label>
              <input id="cart-d1" type="number" min={15} max={2880} className="input" disabled={!manage} value={cfg.cartFirstDelayMinutes} onChange={(e) => set({ ...cfg, cartFirstDelayMinutes: Number(e.target.value) })} />
              <p className="mt-1 text-xs text-muted">Counted from the customer&apos;s last change to the checkout.</p>
            </div>
            <div>
              <label className="label" htmlFor="cart-d2">Second reminder after the first (minutes)</label>
              <input id="cart-d2" type="number" min={60} max={10080} className="input" disabled={!manage} value={cfg.cartSecondDelayMinutes} onChange={(e) => set({ ...cfg, cartSecondDelayMinutes: Number(e.target.value) })} />
              <p className="mt-1 text-xs text-muted">Only if the first was sent and the checkout is still unfinished.</p>
            </div>
            <p className="text-xs text-muted sm:col-span-2">
              Reminders also respect your sending hours and the weekly limit on marketing messages per customer (Settings).{" "}
              {cfg.smsConsentCountsForMarketing ? "Shopify's text-message marketing consent counts as WhatsApp consent." : "Shopify's text-message consent doesn't count as WhatsApp consent (Settings)."}
            </p>
          </div>
        )}
      />

      {contact && (
        <section className="grid gap-3 sm:grid-cols-4" aria-label="Summary">
          <Stat label="Not finished" value={fmtNum(n("open") + n("reminded"))} note={`${fmtNum(n("reminded"))} reminded`} />
          <Stat label="Recovered" value={fmtNum(n("recovered"))} note={recoveredRevenue ? `${fmtMoney(recoveredRevenue, store?.currency ?? "USD")} in this list` : "Bought within 7 days of a reminder"} tone={n("recovered") ? "good" : undefined} />
          <Stat label="Bought anyway" value={fmtNum(n("completed"))} note="Finished before any reminder" />
          <Stat label="Can't be reminded" value={fmtNum(n("ineligible"))} note="No consent or no checkout link" />
        </section>
      )}

      {!contact ? (
        <div className="card text-sm text-muted">Your role can&apos;t see customers&apos; details. Ask an owner or admin.</div>
      ) : (
        <section className="card animate-rise" aria-labelledby="carts-h">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="carts-h" className="font-semibold">Checkouts</h2>
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter">
              {FILTERS.map(([v, label]) => (
                <button key={v} type="button" role="tab" aria-selected={filter === v} className={`rounded-full px-3 py-1 text-sm ${filter === v ? "bg-accent/12 font-semibold text-accent" : "text-muted hover:text-text"}`} onClick={() => setFilter(v)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {error ? (
            <p className="mt-3 text-sm text-danger">{error.message}</p>
          ) : !data ? (
            <div className="mt-3 space-y-2">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-14" />)}</div>
          ) : !data.carts.length ? (
            <div className="mt-3">
              <Empty>
                No checkouts here. Unfinished checkouts with a phone number show up once Shopify sends them (it needs the checkouts webhooks, see{" "}
                <Link className="underline" href="/whatsapp/settings">Settings</Link>).
              </Empty>
            </div>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {data.carts.map((c) => {
                const st = STATUS[c.status];
                const canRemind = manage && ["open", "reminded"].includes(c.status) && c.marketingConsent && !!c.checkoutUrl && !c.reminders.some((r) => r.status === "scheduled");
                return (
                  <li key={c.id} className="grid gap-2 py-3 md:grid-cols-[1fr_auto]">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {c.customerName ?? "Customer"} <span className="text-sm font-normal text-muted">{c.phoneMasked}</span> <Badge tone={st.tone}>{st.label}</Badge>
                      </p>
                      <p className="text-sm">
                        {fmtMoney(c.total, c.currency)} · {c.items.map((i) => `${i.quantity}× ${i.title}`).join(", ") || "—"}
                      </p>
                      <p className="text-xs text-muted">
                        Left {fmtRelative(c.abandonedAt)} ({fmtWhen(c.abandonedAt, store?.timezone)})
                        {c.ineligibleReason ? ` · ${reasonLabel(c.ineligibleReason)}` : ""}
                        {c.recovered ? ` · became order ${c.recovered.orderName} (${fmtMoney(c.recovered.revenue, c.currency)})` : ""}
                      </p>
                      {c.reminders.length > 0 && (
                        <ul className="mt-1 flex flex-wrap gap-2 text-xs text-muted">
                          {c.reminders.map((r, i) => (
                            <li key={i} className="flex items-center gap-1">
                              {r.kind === "abandoned_cart_2" ? "2nd reminder" : "Reminder"}: <MessageStatus status={r.status} reason={r.reason} />
                              {r.status === "scheduled" ? ` ${fmtWhen(r.scheduledFor, store?.timezone)}` : ""}
                              {r.clickedAt ? " · link opened" : ""}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="flex flex-wrap items-start gap-2">
                      {c.checkoutUrl && (
                        <a className="btn-secondary h-8 px-3 text-xs" href={c.checkoutUrl} target="_blank" rel="noreferrer noopener" title="Shopify's link back to this customer's checkout">
                          Checkout link
                        </a>
                      )}
                      {canRemind && (
                        <button
                          type="button"
                          className="btn-primary h-8 px-3 text-xs"
                          disabled={!!busy}
                          onClick={() =>
                            void run(c.id, "send the reminder", async () => {
                              await api(`${base}/carts/${c.id}/remind`, { method: "POST" });
                              await reload();
                              return "Reminder sent with your approved cart template.";
                            })
                          }
                        >
                          {busy === c.id ? "Sending…" : "Send reminder"}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted">
            &ldquo;Recovered&rdquo; means the checkout&apos;s order came in within 7 days after a reminder was sent. Some of those customers would have bought anyway; the number is a
            ceiling on what reminders brought in, not proof.
          </p>
        </section>
      )}
    </div>
  );
}
