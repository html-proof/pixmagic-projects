"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ORDER_UPDATE_BASIS_INFO, type OrderUpdateBasis } from "@app/shared/whatsapp";
import { PHONE_COUNTRIES } from "@app/shared/messaging";
import { ConfirmDialog } from "@/components/AppUi";
import { Badge } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { api } from "@/lib/api";
import { countryName, fmtHour, fmtWhen } from "@/components/messaging/MessagingUi";
import { ConnectWhatsApp } from "./ConnectWhatsApp";
import { AutomationControl, HealthChecks } from "./Status";
import type { WaOverview, WaSettings } from "./types";
import { CONNECTION_TONE, Hint, useWaAction, waHref } from "./WaUi";

function Card({ id, title, explain, children }: { id: string; title: string; explain?: string; children: ReactNode }) {
  return (
    <section className="card animate-rise space-y-3" aria-labelledby={id}>
      <div>
        <h2 id={id} className="font-semibold">
          {title}
        </h2>
        {explain && <p className="mt-1 text-sm text-muted">{explain}</p>}
      </div>
      {children}
    </section>
  );
}

/** The connection, how customers agree, sending hours and limits, the test number, and the event key. */
export function Settings({ base, overview, reload }: { base: string; overview: WaOverview; reload: () => void }) {
  const { busy, run } = useWaAction();
  const s = overview.settings;
  const c = overview.connection;
  const can = overview.can;
  const tz = overview.store.timezone;
  const [basis, setBasis] = useState<OrderUpdateBasis>(s.orderUpdates);
  const [attest, setAttest] = useState(false);
  const [smsConsent, setSmsConsent] = useState(s.shopifySmsConsent);
  const [window_, setWindow] = useState(s.sendWindow);
  const [limit, setLimit] = useState(s.dailyLimit ? String(s.dailyLimit) : "");
  const [testPhone, setTestPhone] = useState("");
  const [testCountry, setTestCountry] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);
  const [pin, setPin] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<{ key: string; endpoint: string } | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [ev, setEv] = useState({ event: "", phone: "", firstName: "", at: "" });

  const put = (key: string, what: string, body: Partial<Record<string, unknown>>, done: string) =>
    run(key, what, async () => {
      await api<WaSettings>(`${base}/settings`, { method: "PUT", body });
      reload();
      return done;
    });

  const connected = !!c && c.status !== "disconnected";
  return (
    <div className="space-y-4">
      {connected && (
        <Card id="wa-conn-h" title="Connection" explain="Your WhatsApp Business account and number, as Meta last reported them.">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted">Status</dt>
              <dd>
                <Badge tone={CONNECTION_TONE[c!.status] ?? "neutral"}>{c!.statusLabel}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Number</dt>
              <dd>
                {c!.displayPhoneNumber ?? "—"} {c!.verifiedName ? `· ${c!.verifiedName}` : ""}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">WhatsApp Business account</dt>
              <dd>
                {c!.wabaName ?? "—"} <span className="text-xs text-muted">({c!.wabaId})</span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Meta business portfolio · phone number ID</dt>
              <dd className="font-mono text-xs">
                {c!.businessId ?? "—"} · {c!.phoneNumberId ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Display name review</dt>
              <dd>{c!.nameStatus ? c!.nameStatus.toLowerCase().replace(/_/g, " ") : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Last checked with Meta</dt>
              <dd>{fmtWhen(c!.lastCheckedAt, tz)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Last update from WhatsApp</dt>
              <dd>{fmtWhen(c!.lastWebhookAt, tz)}</dd>
            </div>
          </dl>
          {c!.statusDetail && <Alert kind="info">{c!.statusDetail}</Alert>}
          {(can.connect || can.pin) && (
            <div className="flex flex-wrap gap-2">
              {can.pin && c!.hasPin && (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy === "pin"}
                  onClick={() =>
                    void run("pin", "show the PIN", async () => {
                      const r = await api<{ pin: string }>(`${base}/pin`, { method: "POST", body: {} });
                      setPin(r.pin);
                    })
                  }
                >
                  Show the number&apos;s PIN
                </button>
              )}
              {can.connect && (
                <button type="button" className="btn-secondary text-danger" onClick={() => setDisconnecting(true)}>
                  Disconnect WhatsApp
                </button>
              )}
            </div>
          )}
          {pin && (
            <Alert kind="info" onDismiss={() => setPin(null)}>
              The number&apos;s two-step verification PIN is <strong className="font-mono tracking-widest">{pin}</strong>. You need it only to move the number to another provider. This was recorded in the
              audit log.
            </Alert>
          )}
          {can.connect && overview.platform.ready && (
            <div className="border-t border-border pt-3">
              <p className="mb-2 text-sm text-muted">
                Refresh bizinsights&apos; access (a permission was removed, or you want another number or account): go through Meta&apos;s window again. The same connection is updated; your history,
                templates and workflows stay.
              </p>
              <ConnectWhatsApp base={base} platform={overview.platform} label="Reconnect WhatsApp" onConnected={() => reload()} />
            </div>
          )}
        </Card>
      )}
      {connected && <HealthChecks data={overview} base={base} reload={reload} />}
      {connected && <AutomationControl data={overview} base={base} reload={reload} />}
      {connected && (
        <Card id="wa-records-h" title="Templates and opt-outs" explain="Where to manage what customers receive, and who asked not to.">
          <ul className="space-y-1 text-sm">
            <li>
              <Link className="text-accent underline-offset-2 hover:underline" href={waHref("templates")}>
                Message templates
              </Link>{" "}
              <span className="text-muted">· write, check with Meta and remove templates</span>
            </li>
            {can.contacts && (
              <li>
                <Link className="text-accent underline-offset-2 hover:underline" href={waHref("contacts")}>
                  Customers and their consent
                </Link>{" "}
                <span className="text-muted">· everyone who replied STOP is never messaged; record an opt-out given another way</span>
              </li>
            )}
          </ul>
        </Card>
      )}

      <Card id="wa-consent-h" title="How customers agree to order updates" explain="Meta requires customers to agree before a business messages them. Marketing always needs their own agreement; for order and service updates, choose how they agree.">
        <fieldset disabled={!can.manage} className="space-y-2">
          <legend className="sr-only">How customers agree to order updates</legend>
          {(["opt_in_only", "checkout_notice"] as const).map((b) => (
            <label key={b} className={`flex cursor-pointer gap-2 rounded-lg border p-3 text-sm ${basis === b ? "border-accent bg-accent/5" : "border-border"}`}>
              <input type="radio" name="wa-basis" checked={basis === b} onChange={() => setBasis(b)} />
              <span>
                <span className="font-medium">{ORDER_UPDATE_BASIS_INFO[b].label}</span>
                <span className="block text-xs text-muted">{ORDER_UPDATE_BASIS_INFO[b].help}</span>
              </span>
            </label>
          ))}
          {basis === "checkout_notice" && s.orderUpdates !== "checkout_notice" && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
              My checkout or terms tell customers they&apos;ll receive order updates on WhatsApp and that they can reply STOP to end them. (Recorded with your name.)
            </label>
          )}
        </fieldset>
        {s.orderUpdates === "unset" && <p className="text-sm text-warn">Not chosen yet: no order or service update is sent until you choose.</p>}
        {can.manage && (
          <button
            type="button"
            className="btn-primary"
            disabled={basis === s.orderUpdates || basis === "unset" || (basis === "checkout_notice" && !attest) || busy === "basis"}
            onClick={() => void put("basis", "save how customers agree", { orderUpdates: basis }, "Saved.")}
          >
            Save
          </button>
        )}
        <label className="flex items-start gap-2 border-t border-border pt-3 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={smsConsent}
            disabled={!can.manage || busy === "sms"}
            onChange={(e) => {
              setSmsConsent(e.target.checked);
              void put("sms", "save the consent setting", { shopifySmsConsent: e.target.checked }, e.target.checked ? "Shopify's text-message consent now counts for WhatsApp marketing too." : "Saved.");
            }}
          />
          <span>
            Shopify&apos;s text-message marketing consent also covers WhatsApp
            <Hint>Turn this on only if the consent box your customers tick in Shopify says they&apos;ll get offers by WhatsApp too. Customers who ticked it then count as agreeing to WhatsApp marketing.</Hint>
          </span>
        </label>
      </Card>

      <Card id="wa-hours-h" title="Sending hours and limits" explain="Marketing workflows wait for these hours (your store's time). A daily limit caps how many customers you start conversations with each day, beyond Meta's own limit.">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select className="input w-auto" aria-label="From" disabled={!can.manage} value={window_.start} onChange={(e) => setWindow({ ...window_, start: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_x, h) => (
              <option key={h} value={h}>
                {fmtHour(h)}
              </option>
            ))}
          </select>
          to
          <select className="input w-auto" aria-label="To" disabled={!can.manage} value={window_.end} onChange={(e) => setWindow({ ...window_, end: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_x, h) => (
              <option key={h} value={h}>
                {fmtHour(h)}
              </option>
            ))}
          </select>
          <span className="text-muted">({tz})</span>
        </div>
        <div className="max-w-xs">
          <label className="label" htmlFor="wa-limit">
            Daily limit (optional)
          </label>
          <input id="wa-limit" className="input" type="number" min={1} disabled={!can.manage} placeholder={c?.dailyConversationLimit ? `Meta's: ${c.dailyConversationLimit}` : "No limit of your own"} value={limit} onChange={(e) => setLimit(e.target.value)} />
        </div>
        {can.manage && (
          <button
            type="button"
            className="btn-primary"
            disabled={busy === "hours" || window_.start === window_.end}
            onClick={() => void put("hours", "save sending hours", { sendWindow: window_, dailyLimit: limit.trim() ? Math.max(1, Math.round(Number(limit))) : null }, "Saved.")}
          >
            Save
          </button>
        )}
      </Card>

      <Card id="wa-test-h" title="Your number for tests" explain="Test messages from templates, workflows and campaigns go only to this number, never to customers.">
        <p className="text-sm">{s.testPhone ? <>Now: <strong>{s.testPhone}</strong></> : "None yet."}</p>
        {can.manage && (
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="label" htmlFor="wa-test-phone">
                Your WhatsApp number
              </label>
              <input id="wa-test-phone" className="input w-56" type="tel" placeholder="+61412345678" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="wa-test-country">
                Country (if no +)
              </label>
              <select id="wa-test-country" className="input w-auto" value={testCountry} onChange={(e) => setTestCountry(e.target.value)}>
                <option value="">—</option>
                {PHONE_COUNTRIES.map((cc) => (
                  <option key={cc} value={cc}>
                    {countryName(cc)}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="btn-primary"
              disabled={testPhone.trim().length < 6 || busy === "test"}
              onClick={() => void put("test", "save your number", { testPhone: testPhone.trim(), ...(testCountry ? { testPhoneCountry: testCountry } : {}) }, "Saved. Tests go to this number.").then((ok) => ok && setTestPhone(""))}
            >
              Save
            </button>
            {s.testPhone && (
              <button type="button" className="btn-secondary" disabled={busy === "test-remove"} onClick={() => void put("test-remove", "remove your number", { testPhone: null }, "Removed.")}>
                Remove
              </button>
            )}
          </div>
        )}
      </Card>

      <Card id="wa-events-h" title="Events from your other tools" explain="Your booking system, forms or Zapier can start Custom event workflows (appointment reminders, service follow-ups) by sending events to bizinsights with your event key.">
        <p className="text-sm">{s.eventKey ? <>A key ending in <strong className="font-mono">…{s.eventKey.hint}</strong> is in use (made {fmtWhen(s.eventKey.createdAt, tz)}).</> : "No key yet."}</p>
        {newKey && (
          <Alert kind="success" onDismiss={() => setNewKey(null)}>
            <p>Copy this key now: it is shown only once.</p>
            <p className="mt-2 flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-bg px-2 py-1 font-mono text-xs">{newKey.key}</code>
              <button type="button" className="btn-secondary h-7 px-2 text-xs" onClick={() => void navigator.clipboard?.writeText(newKey.key)}>
                Copy
              </button>
            </p>
            <pre className="mt-2 overflow-x-auto whitespace-pre rounded bg-bg p-2 text-xs">{`curl -X POST ${newKey.endpoint} \\
  -H "Authorization: Bearer ${newKey.key}" \\
  -H "Content-Type: application/json" \\
  -d '{"event":"appointment_booked","eventId":"booking-123","phone":"+61412345678","firstName":"Priya","at":"2026-11-03T10:30:00+11:00","values":{"service":"Haircut"}}'`}</pre>
          </Alert>
        )}
        {can.manage && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={busy === "key"}
              onClick={() =>
                void run("key", "make a key", async () => {
                  const r = await api<{ key: string; endpoint: string }>(`${base}/settings/event-key`, { method: "POST", body: {} });
                  setNewKey(r);
                  reload();
                })
              }
            >
              {s.eventKey ? "Replace the key" : "Make a key"}
            </button>
            {s.eventKey && (
              <button type="button" className="btn-secondary text-danger" onClick={() => setRevoking(true)}>
                Turn the key off
              </button>
            )}
          </div>
        )}
        {can.manage && connected && (
          <form
            className="space-y-2 border-t border-border pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run("event", "send the test event", async () => {
                const r = await api<{ workflows: number; scheduled: number; skipped: number }>(`${base}/events`, {
                  method: "POST",
                  body: { event: ev.event, eventId: `test-${Date.now()}`, phone: ev.phone, ...(ev.firstName ? { firstName: ev.firstName } : {}), ...(ev.at ? { at: new Date(ev.at).toISOString() } : {}) },
                });
                return r.workflows ? `${r.workflows} workflow${r.workflows === 1 ? "" : "s"} ran: ${r.scheduled} message${r.scheduled === 1 ? "" : "s"} queued, ${r.skipped} not sent (see each workflow's history).` : "No switched-on workflow listens for that event name.";
              });
            }}
          >
            <p className="text-sm font-medium">Send a test event</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input className="input" aria-label="Event name" placeholder="Event name: appointment_booked" value={ev.event} onChange={(e) => setEv({ ...ev, event: e.target.value.replace(/[^a-z0-9_.-]/gi, "") })} />
              <input className="input" type="tel" aria-label="Customer's number" placeholder="Customer's number: +61412345678" value={ev.phone} onChange={(e) => setEv({ ...ev, phone: e.target.value })} />
              <input className="input" aria-label="First name (optional)" placeholder="First name (optional)" value={ev.firstName} onChange={(e) => setEv({ ...ev, firstName: e.target.value })} />
              <input className="input" type="datetime-local" aria-label="When the appointment is (optional)" value={ev.at} onChange={(e) => setEv({ ...ev, at: e.target.value })} />
            </div>
            <p className="text-xs text-muted">It runs your switched-on workflows for that event name, for real: use your own number.</p>
            <button type="submit" className="btn-secondary" disabled={!ev.event || ev.phone.trim().length < 6 || busy === "event"}>
              {busy === "event" ? "Sending…" : "Send test event"}
            </button>
          </form>
        )}
      </Card>

      <ConfirmDialog
        open={disconnecting}
        title="Disconnect WhatsApp?"
        confirmLabel="Disconnect"
        danger
        busy={busy === "disconnect"}
        onCancel={() => setDisconnecting(false)}
        onConfirm={() =>
          void run("disconnect", "disconnect WhatsApp", async () => {
            await api(base, { method: "DELETE" });
            setDisconnecting(false);
            reload();
            return "WhatsApp is disconnected.";
          })
        }
      >
        <p>bizinsights stops sending and deletes its access to your number. Messages waiting to go out and scheduled or running campaigns are cancelled. Your message history, templates and workflows are kept for when you connect again.</p>
        <p>Your number keeps working in WhatsApp. To also remove bizinsights from your business at Meta, open Meta Business Suite → Settings → Integrations (Connected apps) and remove it there.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={revoking}
        title="Turn the event key off?"
        confirmLabel="Turn it off"
        danger
        busy={busy === "revoke"}
        onCancel={() => setRevoking(false)}
        onConfirm={() =>
          void run("revoke", "turn the key off", async () => {
            await api(`${base}/settings/event-key`, { method: "DELETE" });
            setRevoking(false);
            reload();
            return "The key is off. Events sent with it are refused.";
          })
        }
      >
        <p>Your tools stop being able to send events until you make a new key and give it to them.</p>
      </ConfirmDialog>
    </div>
  );
}
