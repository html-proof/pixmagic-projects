"use client";
import { useState } from "react";
import { CONSENT_SOURCE_LABEL, type ConsentSource } from "@app/shared/whatsapp";
import { ConfirmDialog } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge } from "@/components/dashboard/Primitives";
import { Alert, EmptyState } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { countryName, Drawer, fmtWhen, usePagedList } from "@/components/messaging/MessagingUi";
import { SendMessage } from "./SendMessage";
import type { WaContact, WaContactDetail, WaOverview } from "./types";
import { MessageStatus, useWaAction } from "./WaUi";

/** A customer's consent in a few words. */
function ConsentBadge({ c }: { c: Pick<WaContact, "optedOut" | "marketing" | "optedIn"> }) {
  if (c.optedOut) return <Badge tone="danger">Replied STOP</Badge>;
  if (c.marketing === "opted_in") return <Badge tone="good">Agreed to marketing</Badge>;
  if (c.marketing === "opted_out") return <Badge tone="warn">Stopped promotions</Badge>;
  if (c.optedIn) return <Badge tone="good">Agreed to updates</Badge>;
  return <Badge tone="neutral">No consent recorded</Badge>;
}

type Recording = { scope: "all" | "marketing"; status: "opted_in" | "opted_out" };

function ContactDrawer({ base, id, overview, onClose, onChanged }: { base: string; id: string; overview: WaOverview; onClose: () => void; onChanged: () => void }) {
  const { data, error, loading, reload } = useApi<WaContactDetail>(`${base}/contacts/${id}`);
  const { busy, run } = useWaAction();
  const [recording, setRecording] = useState<Recording | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const tz = overview.store.timezone;
  const c = data?.contact;
  return (
    <Drawer title={c ? (c.firstName ?? c.phone) : "Customer"} sub={c ? `${c.phone} · ${countryName(c.country)}` : undefined} onClose={onClose}>
      {error ? (
        <LoadError what="the customer" error={error} onRetry={() => void reload()} busy={loading} />
      ) : !c ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <ConsentBadge c={c} />
            {c.windowOpen && <Badge tone="good">Wrote in the last 24 hours</Badge>}
          </div>
          {overview.can.manage && (
            <div className="flex flex-wrap gap-2">
              {!c.optedOut && overview.connection?.status === "active" && (
                <button type="button" className="btn-primary h-8 px-3 text-xs" onClick={() => setSending(true)}>
                  Send a message
                </button>
              )}
              {!c.optedOut && c.marketing !== "opted_in" && (
                <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setRecording({ scope: "marketing", status: "opted_in" })}>
                  Record marketing consent
                </button>
              )}
              {!c.optedOut && c.marketing === "opted_in" && (
                <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setRecording({ scope: "marketing", status: "opted_out" })}>
                  Record &ldquo;no more offers&rdquo;
                </button>
              )}
              {!c.optedOut && (
                <button type="button" className="btn-secondary h-8 px-3 text-xs text-danger" onClick={() => setRecording({ scope: "all", status: "opted_out" })}>
                  Record an opt-out
                </button>
              )}
            </div>
          )}
          {c.optedOut && <p className="text-sm text-muted">Nothing is sent to this customer. Only they can undo it, by replying START on WhatsApp.</p>}
          <section>
            <h3 className="text-sm font-semibold">Consent history</h3>
            {!data.consent.length ? (
              <p className="mt-1 text-sm text-muted">Nothing recorded.</p>
            ) : (
              <ol className="mt-2 space-y-2 text-sm">
                {data.consent.map((e, i) => (
                  <li key={i}>
                    <span className="font-medium">
                      {e.status === "opted_in" ? "Agreed to" : "Stopped"} {e.scope === "all" ? "all messages" : "marketing"}
                    </span>{" "}
                    <span className="text-muted">
                      · {CONSENT_SOURCE_LABEL[e.source as ConsentSource] ?? e.source} · {fmtWhen(e.at, tz)}
                    </span>
                    {e.note ? <span className="block text-xs text-muted">{e.note}</span> : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section>
            <h3 className="text-sm font-semibold">Messages</h3>
            {!data.messages.length ? (
              <p className="mt-1 text-sm text-muted">None yet.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {data.messages.map((m) => (
                  <li key={m.id} className={`rounded-lg border border-border p-2 text-sm ${m.direction === "in" ? "bg-bg" : ""}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs text-muted">
                        {m.direction === "in" ? "Customer" : (m.templateName ?? "Your team")} · {fmtWhen(m.createdAt, tz)}
                      </span>
                      <MessageStatus m={m} />
                    </div>
                    {m.preview && <p className="mt-1 whitespace-pre-wrap break-words">{m.preview}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <ConfirmDialog
            open={!!recording}
            title={recording?.status === "opted_in" ? "Record their consent" : recording?.scope === "all" ? "Record an opt-out" : "Record “no more offers”"}
            confirmLabel="Record it"
            danger={recording?.status === "opted_out"}
            busy={busy === "consent"}
            confirmDisabled={note.trim().length < 3}
            onCancel={() => setRecording(null)}
            onConfirm={() =>
              void run("consent", "record it", async () => {
                await api(`${base}/contacts/${c.id}/consent`, { method: "POST", body: { ...recording, note } });
                setRecording(null);
                setNote("");
                await reload();
                onChanged();
                return "Recorded.";
              })
            }
          >
            <p>
              {recording?.status === "opted_in"
                ? "Only record consent the customer actually gave you (in your shop, on a form, on the phone). It is kept with your name and the note, as evidence."
                : recording?.scope === "all"
                  ? "Nothing at all will be sent to them any more. Only they can undo it, by replying START."
                  : "They'll stop receiving offers and campaigns; order updates continue."}
            </p>
            <label className="label" htmlFor="wa-consent-note">
              How did they tell you?
            </label>
            <input id="wa-consent-note" className="input" maxLength={300} placeholder="Asked at the counter on 3 November" value={note} onChange={(e) => setNote(e.target.value)} />
          </ConfirmDialog>
          {sending && <SendMessage base={base} contact={c} open={sending} onClose={() => setSending(false)} onSent={() => void reload()} />}
        </>
      )}
    </Drawer>
  );
}

/** The customers WhatsApp knows: their consent, and their messages. */
export function Contacts({ base, overview }: { base: string; overview: WaOverview }) {
  const [consent, setConsent] = useState("any");
  const [phone, setPhone] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const q = new URLSearchParams({ consent, ...(phone.trim() ? { phone: phone.trim() } : {}) }).toString();
  const list = usePagedList<WaContact>(overview.can.contacts ? `${base}/contacts?${q}` : null, "contacts", 300);
  const tz = overview.store.timezone;
  if (!overview.can.contacts) return <Alert kind="info">Customers&apos; numbers and consent are shown only to people with the View contact information permission.</Alert>;
  return (
    <div className="space-y-4">
      <section className="card animate-rise">
        <h2 className="font-semibold">Customers on WhatsApp</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Customers bizinsights keeps a WhatsApp number for: those a workflow messaged, who wrote to you, or who agreed to marketing. Numbers are stored encrypted and shown masked.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <select className="input" aria-label="Consent" value={consent} onChange={(e) => setConsent(e.target.value)}>
            <option value="any">Everyone</option>
            <option value="marketing">Agreed to marketing</option>
            <option value="opted_out">Replied STOP</option>
          </select>
          <input className="input" type="tel" aria-label="Find a number" placeholder="Find a number: +61412345678" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
      </section>
      {list.error ? (
        <LoadError what="the customers" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
      ) : !list.rows ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : !list.rows.length ? (
        <EmptyState title="No customers here" body={phone ? "No customer with that number." : "Customers appear as workflows message them, as they write to you, and as they agree to marketing."} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-2 pr-3 font-medium">Customer</th>
                <th className="py-2 pr-3 font-medium">Consent</th>
                <th className="py-2 pr-3 font-medium">Orders</th>
                <th className="py-2 pr-3 font-medium">Last wrote</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.rows.map((c) => (
                <tr key={c.id}>
                  <td className="py-2 pr-3">
                    <button type="button" className="text-left text-accent underline-offset-2 hover:underline" onClick={() => setOpen(c.id)}>
                      {c.firstName ?? "Customer"}
                    </button>
                    <span className="block text-xs text-muted">{c.phone}</span>
                  </td>
                  <td className="py-2 pr-3">
                    <ConsentBadge c={c} />
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{c.ordersCount ?? 0}</td>
                  <td className="whitespace-nowrap py-2 pr-3 text-muted">{c.lastInboundAt ? fmtWhen(c.lastInboundAt, tz) : "—"}</td>
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
      {open && <ContactDrawer base={base} id={open} overview={overview} onClose={() => setOpen(null)} onChanged={() => void list.reload()} />}
    </div>
  );
}
