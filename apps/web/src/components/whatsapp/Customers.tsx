"use client";
import Link from "next/link";
import { useId, useState } from "react";
import { WA_ORDER_UPDATE_INFO } from "@app/shared/whatsapp";
import { ConfirmDialog, Dialog, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge, Empty, type Tone } from "@/components/dashboard/Primitives";
import { api, useApi } from "@/lib/api";
import { COUNTRY_CHOICES, countryName, usePagedList } from "@/components/messaging/MessagingUi";
import type { WaContact, WaOverview, WaSuppression } from "./types";
import { fmtAgo, useWaAction, waHref } from "./WaUi";

// ---------------------------------------------------------------------------
// Customers: who agreed to what (docs/whatsapp.md, "Consent"), recording consent given another way,
// and the store's do-not-message list. Numbers are shown masked; a customer is found by their full
// number (the API matches it by its keyed hash, nothing is decrypted to search).
// ---------------------------------------------------------------------------

const MARKETING: Record<WaContact["marketing"], { tone: Tone; label: string }> = {
  opted_in: { tone: "good", label: "Agreed to marketing" },
  opted_out: { tone: "neutral", label: "Said no to marketing" },
  unknown: { tone: "neutral", label: "Marketing not asked" },
};

const SCOPE_LABEL: Record<string, string> = { all: "Every message", order_updates: "Order updates", marketing: "Marketing" };
const SUPPRESSION_SCOPE: Record<string, string> = { all: "Every message", marketing: "Marketing only" };
const SUPPRESSION_REASON: Record<string, string> = { stop_reply: "Replied STOP", merchant: "Added by your team", invalid_number: "Invalid number", redact: "Erased at the customer's request" };

export function Customers({ base, overview }: { base: string; overview: WaOverview }) {
  const [phone, setPhone] = useState("");
  const [search, setSearch] = useState("");
  const [consent, setConsent] = useState<"" | "opted_in" | "opted_out" | "unknown">("");
  const [recording, setRecording] = useState(false);
  const manage = overview.can.manage;

  if (!overview.can.contacts) {
    return (
      <div className="card animate-rise">
        <h2 className="text-base font-semibold">Customers</h2>
        <p className="mt-1 text-sm text-muted">You don&apos;t have permission to see customers&apos; contact details. Ask an owner or admin for &quot;View contact information&quot; in Team &amp; Access.</p>
      </div>
    );
  }

  const params = new URLSearchParams();
  if (search) params.set("phone", search);
  if (consent) params.set("consent", consent);
  const q = params.toString();
  const path = `${base}/contacts${q ? `?${q}` : ""}`;

  return (
    <div className="space-y-4">
      <div className="card animate-rise space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Customers and consent</h2>
            <p className="mt-1 text-sm text-muted">
              Order updates go out under your choice in Settings (now: {WA_ORDER_UPDATE_INFO[overview.settings.orderUpdates].label.toLowerCase()}); marketing only to customers who agreed to it. A customer who
              replies STOP gets nothing more until they reply START. Only messages from your store&apos;s customers are recorded: the rest of the phone&apos;s chats are never read.
            </p>
          </div>
          {manage && (
            <button type="button" className="btn-primary" onClick={() => setRecording(true)}>
              Record consent
            </button>
          )}
        </div>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(phone.trim());
          }}
        >
          <div className="min-w-0 flex-1 sm:max-w-xs">
            <label className="label" htmlFor="wa-cust-phone">
              Find a number
            </label>
            <input id="wa-cust-phone" className="input" inputMode="tel" placeholder="+61 412 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="wa-cust-consent">
              Marketing consent
            </label>
            <select id="wa-cust-consent" className="input" value={consent} onChange={(e) => setConsent(e.target.value as typeof consent)}>
              <option value="">Everyone</option>
              <option value="opted_in">Agreed to marketing</option>
              <option value="unknown">Not asked</option>
              <option value="opted_out">Opted out</option>
            </select>
          </div>
          <button type="submit" className="btn-secondary">
            Search
          </button>
          {(search || consent) && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setPhone("");
                setSearch("");
                setConsent("");
              }}
            >
              Clear
            </button>
          )}
        </form>
      </div>
      <ContactList path={path} filtered={!!(search || consent)} />
      <DoNotMessage base={base} manage={manage} />
      {recording && <RecordConsentDialog base={base} onClose={() => setRecording(false)} />}
    </div>
  );
}

function ContactList({ path, filtered }: { path: string; filtered: boolean }) {
  const { rows, cursor, loading, error, loadMore, reload } = usePagedList<WaContact>(path, "contacts");
  if (error) return <LoadError what="the customers" error={error} onRetry={() => void reload()} busy={loading} />;
  if (!rows) return <Skeleton lines={4} />;
  if (!rows.length)
    return (
      <div className="card">
        <Empty>{filtered ? "No customer matches. Search with the full number, including its country code." : "No customers yet: a customer appears here once a message is sent to them or their consent is recorded."}</Empty>
      </div>
    );
  return (
    <div className="card animate-rise space-y-3">
      <ul className="divide-y divide-border">
        {rows.map((c) => (
          <li key={c.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">
                  {c.phone}
                  {c.firstName && <span className="ml-2 font-normal text-muted">{c.firstName}</span>}
                </p>
                <p className="text-xs text-muted">
                  {c.country ? countryName(c.country) : "Country unknown"} · {c.ordersCount} order{c.ordersCount === 1 ? "" : "s"} · last message from them {fmtAgo(c.lastInboundAt)} · last sent {fmtAgo(c.lastOutboundAt)}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {c.optedOut ? <Badge tone="danger">Opted out of everything</Badge> : <Badge tone={MARKETING[c.marketing].tone}>{MARKETING[c.marketing].label}</Badge>}
                {!c.optedOut && c.optedIn && <Badge tone="good">Agreed to order updates</Badge>}
              </div>
            </div>
            {c.history.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted hover:text-text">Consent history</summary>
                <ol className="mt-2 space-y-1 border-l border-border pl-3">
                  {c.history.map((h, i) => (
                    <li key={i}>
                      <span className="font-medium">
                        {SCOPE_LABEL[h.scope] ?? h.scope}: {h.status === "opted_in" ? "agreed" : "opted out"}
                      </span>{" "}
                      <span className="text-muted">
                        · {h.sourceLabel} · {fmtAgo(h.at)}
                      </span>
                      {h.note && <span className="block text-muted">“{h.note}”</span>}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </li>
        ))}
      </ul>
      {cursor && (
        <button type="button" className="btn-secondary w-full" onClick={loadMore} disabled={loading}>
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

function CountrySelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">The number includes its country code (+…)</option>
      {COUNTRY_CHOICES.map((c) => (
        <option key={c} value={c}>
          {countryName(c)}
        </option>
      ))}
    </select>
  );
}

function RecordConsentDialog({ base, onClose }: { base: string; onClose: () => void }) {
  const id = useId();
  const { busy, run } = useWaAction();
  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState("");
  const [scope, setScope] = useState<"all" | "order_updates" | "marketing">("marketing");
  const [status, setStatus] = useState<"opted_in" | "opted_out">("opted_in");
  const [note, setNote] = useState("");
  return (
    <Dialog open title="Record consent" onClose={onClose}>
      <form
        noValidate
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || phone.trim().length < 6) return;
          void run("consent", "record the consent", async () => {
            await api(`${base}/contacts/consent`, { method: "POST", body: { phone: phone.trim(), country: country || null, scope, status, note: note.trim() || null } });
            onClose();
            return status === "opted_in" ? "Recorded: the customer agreed." : "Recorded: the customer opted out. Messages waiting for them are not sent.";
          });
        }}
      >
        <p className="text-sm text-muted">For consent given some other way: in your store, by email, on a form. It is recorded with your name and the note.</p>
        <div>
          <label className="label" htmlFor={`${id}-phone`}>
            Customer&apos;s WhatsApp number
          </label>
          <input id={`${id}-phone`} className="input" inputMode="tel" placeholder="+61 412 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-country`}>
            Country (for a number without +)
          </label>
          <CountrySelect id={`${id}-country`} value={country} onChange={setCountry} />
        </div>
        <fieldset>
          <legend className="label">For</legend>
          <div className="space-y-1 text-sm">
            {(["marketing", "order_updates", "all"] as const).map((s) => (
              <label key={s} className="flex items-center gap-2">
                <input type="radio" name={`${id}-scope`} className="accent-[var(--accent)]" checked={scope === s} onChange={() => setScope(s)} />
                {s === "all" ? "Every message from the store" : s === "order_updates" ? "Order updates" : "Marketing messages"}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="label">The customer</legend>
          <div className="space-y-1 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name={`${id}-status`} className="accent-[var(--accent)]" checked={status === "opted_in"} onChange={() => setStatus("opted_in")} />
              Agreed to receive them
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name={`${id}-status`} className="accent-[var(--accent)]" checked={status === "opted_out"} onChange={() => setStatus("opted_out")} />
              Asked not to receive them
            </label>
          </div>
        </fieldset>
        <div>
          <label className="label" htmlFor={`${id}-note`}>
            Note (optional)
          </label>
          <input id={`${id}-note`} className="input" maxLength={300} placeholder="Signed up at the counter on 22 Oct" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={!!busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!!busy || phone.trim().length < 6}>
            {busy ? "Recording…" : "Record consent"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function DoNotMessage({ base, manage }: { base: string; manage: boolean }) {
  const list = useApi<{ suppressions: WaSuppression[] }>(`${base}/suppressions`);
  const { busy, run } = useWaAction();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<WaSuppression | null>(null);
  return (
    <div className="card animate-rise space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Do not message</h2>
          <p className="mt-1 text-sm text-muted">Numbers your store never messages, or never sends marketing to. Customers who replied STOP are here until they reply START.</p>
        </div>
        {manage && (
          <button type="button" className="btn-secondary" onClick={() => setAdding(true)}>
            Add a number
          </button>
        )}
      </div>
      {list.error ? (
        <LoadError what="the do-not-message list" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
      ) : !list.data ? (
        <div className="skeleton h-16" />
      ) : !list.data.suppressions.length ? (
        <Empty>Nobody is on the list.</Empty>
      ) : (
        <ul className="divide-y divide-border">
          {list.data.suppressions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <div className="min-w-0">
                <p className="font-medium">{s.phone}</p>
                <p className="text-xs text-muted">
                  {SUPPRESSION_SCOPE[s.scope] ?? s.scope} · {SUPPRESSION_REASON[s.reason] ?? s.reason.replace(/_/g, " ")} · {fmtAgo(s.createdAt)}
                  {s.note ? ` · “${s.note}”` : ""}
                </p>
              </div>
              {manage && (
                <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setRemoving(s)} disabled={!!busy}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && <AddSuppressionDialog base={base} onClose={(done) => {
            setAdding(false);
            if (done) void list.reload();
          }} />}
      <ConfirmDialog
        open={!!removing}
        title={removing ? `Take ${removing.phone} off the list?` : ""}
        confirmLabel="Remove"
        busy={busy === "remove"}
        onCancel={() => setRemoving(null)}
        onConfirm={() =>
          void run("remove", "remove the number from the list", async () => {
            await api(`${base}/suppressions/${removing!.id}`, { method: "DELETE" });
            setRemoving(null);
            void list.reload();
            return "Removed from the list.";
          }).then((ok) => {
            if (!ok) setRemoving(null);
          })
        }
      >
        <p>Messages can go to this number again, under the store&apos;s consent rules. A customer who replied STOP can only be taken off by replying START.</p>
      </ConfirmDialog>
    </div>
  );
}

function AddSuppressionDialog({ base, onClose }: { base: string; onClose: (done: boolean) => void }) {
  const id = useId();
  const { busy, run } = useWaAction();
  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState("");
  const [scope, setScope] = useState<"all" | "marketing">("all");
  const [note, setNote] = useState("");
  return (
    <Dialog open title="Add to Do not message" onClose={() => onClose(false)}>
      <form
        noValidate
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || phone.trim().length < 6) return;
          void run("add", "add the number", async () => {
            await api(`${base}/suppressions`, { method: "POST", body: { phone: phone.trim(), country: country || null, scope, note: note.trim() || null } });
            onClose(true);
            return "Added. Messages waiting for this number are not sent.";
          });
        }}
      >
        <div>
          <label className="label" htmlFor={`${id}-phone`}>
            WhatsApp number
          </label>
          <input id={`${id}-phone`} className="input" inputMode="tel" placeholder="+61 412 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-country`}>
            Country (for a number without +)
          </label>
          <CountrySelect id={`${id}-country`} value={country} onChange={setCountry} />
        </div>
        <fieldset>
          <legend className="label">Never send</legend>
          <div className="space-y-1 text-sm">
            {(["all", "marketing"] as const).map((s) => (
              <label key={s} className="flex items-center gap-2">
                <input type="radio" name={`${id}-scope`} className="accent-[var(--accent)]" checked={scope === s} onChange={() => setScope(s)} />
                {s === "all" ? "Any message, order updates included" : "Marketing messages"}
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <label className="label" htmlFor={`${id}-note`}>
            Note (optional)
          </label>
          <input id={`${id}-note`} className="input" maxLength={300} placeholder="Asked by phone" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" className="btn-secondary" onClick={() => onClose(false)} disabled={!!busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!!busy || phone.trim().length < 6}>
            {busy ? "Adding…" : "Add to the list"}
          </button>
        </div>
      </form>
      <p className="mt-3 text-xs text-muted">
        To see what was sent to a number, search for it in <Link className="underline" href={waHref("messages")}>Messages</Link>.
      </p>
    </Dialog>
  );
}
