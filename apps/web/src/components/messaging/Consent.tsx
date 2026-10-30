"use client";
import { useState } from "react";
import { CONSENT_LABEL, CONSENT_STATES, SUPPRESSION_LABEL, type ConsentState, type SuppressionReason } from "@app/shared/sms";
import { ConfirmDialog, PageHeader } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge, Empty, type Tone } from "@/components/dashboard/Primitives";
import { api, fmtNum, useApi } from "@/lib/api";
import { COUNTRY_CHOICES, countryName, Drawer, fmtWhen, usePagedList, useSms, useSmsAction } from "./MessagingUi";
import type { ContactDetail, SmsContact, Suppression } from "./types";

const CONSENT_TONE: Record<string, Tone> = { subscribed: "good", pending: "warn", unsubscribed: "neutral", not_subscribed: "neutral", redacted: "neutral", invalid: "danger", unknown: "neutral" };

const ConsentBadge = ({ state }: { state: string }) => <Badge tone={CONSENT_TONE[state] ?? "neutral"}>{CONSENT_LABEL[state as ConsentState] ?? state}</Badge>;

/** "opt_out_link" → "opt out link": sources as recorded, readable. */
const words = (s: string | null | undefined) => (s ? (SUPPRESSION_LABEL[s as SuppressionReason] ?? s.replace(/_/g, " ")) : "—");

const SCOPE_LABEL: Record<string, string> = { all: "Every text", marketing: "Marketing texts" };

/** Record that a customer asked to stop (by phone, by email…): their texts stop at once. */
function OptOutDialog({ contact, onClose }: { contact: { id: string; number: string }; onClose: (done: boolean) => void }) {
  const { base } = useSms();
  const { busy, run } = useSmsAction();
  const [scope, setScope] = useState<"all" | "marketing">("all");
  const [note, setNote] = useState("");
  return (
    <ConfirmDialog
      open
      title={`Record an opt-out for ${contact.number}?`}
      confirmLabel="Record opt-out"
      danger
      busy={!!busy}
      onCancel={() => onClose(false)}
      onConfirm={() =>
        void run("opt-out", "record the opt-out", async () => {
          await api(`${base}/contacts/${contact.id}/opt-out`, { method: "POST", body: { scope, note: note.trim() || null } });
          onClose(true);
          return "Recorded. No more texts of that kind go to this number.";
        })
      }
    >
      <p>It applies at once, and texts waiting to go are not sent.</p>
      <fieldset className="space-y-1 text-text">
        <legend className="sr-only">What to stop</legend>
        {(["all", "marketing"] as const).map((s) => (
          <label key={s} className="flex items-center gap-2">
            <input type="radio" name="optout-scope" className="accent-[var(--accent)]" checked={scope === s} onChange={() => setScope(s)} />
            {s === "all" ? "Every text, including order updates" : "Marketing texts only"}
          </label>
        ))}
      </fieldset>
      <label className="label text-text" htmlFor="optout-note">
        Note (optional)
      </label>
      <input id="optout-note" className="input text-text" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Asked by phone on 22 Oct" />
    </ConfirmDialog>
  );
}

function ContactPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { base, manage, store } = useSms();
  const { data, error, reload, loading } = useApi<ContactDetail>(`${base}/contacts/${id}`);
  const [optingOut, setOptingOut] = useState(false);
  const c = data?.contact;
  return (
    <Drawer title={c ? c.number : "Customer"} sub={c ? countryName(c.country) : undefined} onClose={onClose}>
      {error ? (
        <LoadError what="this customer" error={error} onRetry={() => void reload()} busy={loading} />
      ) : !c ? (
        <div className="skeleton h-32" />
      ) : (
        <>
          <section className="card space-y-2 p-4 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              SMS marketing: <ConsentBadge state={c.consent} />
            </p>
            <p>
              {c.suppressedAll ? "Opted out of every text." : c.suppressedMarketing ? "Opted out of marketing texts; order updates can still go." : "Not on the opt-out list."}
            </p>
            {manage && !c.suppressedAll && (
              <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setOptingOut(true)}>
                Record an opt-out…
              </button>
            )}
          </section>
          <section>
            <h3 className="label">Consent history</h3>
            {!data.history.length ? (
              <p className="text-sm text-muted">Nothing recorded yet.</p>
            ) : (
              <ol className="relative space-y-3 border-l border-border pl-4">
                {data.history.map((h, i) => (
                  <li key={i} className="text-sm">
                    <span aria-hidden className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-border" />
                    <p className="flex flex-wrap items-center gap-2">
                      <ConsentBadge state={h.state} />
                      {h.purpose && <span className="text-xs text-muted">{h.purpose}</span>}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {fmtWhen(h.effectiveAt ?? h.recordedAt, store?.timezone)} · from {words(h.source)}
                      {h.optInLevel ? ` · ${h.optInLevel.replace(/_/g, " ").toLowerCase()}` : ""}
                    </p>
                    {h.evidence !== null && h.evidence !== undefined && typeof h.evidence === "object" && Object.keys(h.evidence as object).length > 0 && (
                      <p className="mt-0.5 text-[11px] text-muted">
                        Evidence:{" "}
                        {Object.entries(h.evidence as Record<string, unknown>)
                          .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
                          .map(([k, v]) => `${k.replace(/([A-Z])/g, " $1").toLowerCase()} ${String(v)}`)
                          .join(" · ") || "recorded"}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
      {optingOut && c && (
        <OptOutDialog
          contact={c}
          onClose={(done) => {
            setOptingOut(false);
            if (done) {
              void reload();
              onChanged();
            }
          }}
        />
      )}
    </Drawer>
  );
}

function SuppressionList() {
  const { base, manage, store } = useSms();
  const list = usePagedList<Suppression>(base ? `${base}/suppressions?limit=50` : null, "suppressions");
  const { busy, run } = useSmsAction();
  const [lifting, setLifting] = useState<Suppression | null>(null);
  const [form, setForm] = useState({ number: "", country: "", scope: "all", note: "" });
  const add = () =>
    run("add", "add the number", async () => {
      await api(`${base}/suppressions`, { method: "POST", body: { number: form.number.trim(), country: form.country || null, scope: form.scope, note: form.note.trim() || null } });
      setForm({ ...form, number: "", note: "" });
      await list.reload();
      return "Added. No texts of that kind go to this number.";
    });
  return (
    <section className="card" aria-labelledby="sup-h">
      <h2 id="sup-h" className="font-semibold">
        Suppression list
      </h2>
      <p className="mt-1 text-sm text-muted">Numbers that get no texts (or no marketing texts) from this store, whatever their consent says. Only numbers your team added, or that can&apos;t receive texts, can be taken off.</p>
      {manage && (
        <form
          className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_10rem_10rem_1fr_auto] lg:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (form.number.trim().length >= 6) void add();
          }}
        >
          <div>
            <label className="text-xs text-muted" htmlFor="sup-number">Mobile number (with +country code)</label>
            <input id="sup-number" className="input" type="tel" autoComplete="off" placeholder="+61 412 345 678" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} />
          </div>
          <div>
            <label className="text-xs text-muted" htmlFor="sup-country">Country (if no +code)</label>
            <select id="sup-country" className="input" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}>
              <option value="">From the number</option>
              {COUNTRY_CHOICES.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted" htmlFor="sup-scope">Stop</label>
            <select id="sup-scope" className="input" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
              <option value="all">Every text</option>
              <option value="marketing">Marketing only</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-muted" htmlFor="sup-note">Note (optional)</label>
            <input id="sup-note" className="input" maxLength={200} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
          <button type="submit" className="btn-secondary" disabled={!!busy || form.number.trim().length < 6}>
            {busy === "add" ? "Adding…" : "Add number"}
          </button>
        </form>
      )}
      {list.error && !list.rows ? (
        <div className="mt-3">
          <LoadError what="the suppression list" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
        </div>
      ) : !list.rows ? (
        <div className="skeleton mt-3 h-20" />
      ) : !list.rows.length ? (
        <div className="mt-3">
          <Empty>No numbers on the list.</Empty>
        </div>
      ) : (
        <div className="relative mt-3 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-2 pr-3 font-medium">Number</th>
                <th className="py-2 pr-3 font-medium">Stops</th>
                <th className="py-2 pr-3 font-medium">Why</th>
                <th className="py-2 pr-3 font-medium">Added</th>
                {manage && <th className="py-2 font-medium"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.rows.map((s) => (
                <tr key={s.id} className="align-top">
                  <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs">{s.number}</td>
                  <td className="py-2 pr-3">{SCOPE_LABEL[s.scope] ?? s.scope}</td>
                  <td className="py-2 pr-3">
                    {s.reasonLabel}
                    {s.note && <span className="block text-xs text-muted">{s.note}</span>}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-muted">{fmtWhen(s.createdAt, store?.timezone)}</td>
                  {manage && (
                    <td className="py-2 text-right">
                      {s.liftable ? (
                        <button type="button" className="btn-secondary h-7 px-2 text-xs" disabled={!!busy} onClick={() => setLifting(s)} aria-label={`Lift the suppression of ${s.number}`}>
                          Lift
                        </button>
                      ) : (
                        <span className="text-xs text-muted" title="The customer asked to stop: only they can opt in again, through Shopify.">
                          Customer&apos;s choice
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.cursor && list.rows && (
        <button type="button" className="btn-secondary mt-3" disabled={list.loading} onClick={list.loadMore}>
          {list.loading ? "Loading…" : "Load more"}
        </button>
      )}
      <ConfirmDialog
        open={!!lifting}
        title={`Take ${lifting?.number ?? ""} off the list?`}
        confirmLabel="Take off the list"
        busy={!!busy}
        onCancel={() => setLifting(null)}
        onConfirm={() =>
          void run("lift", "lift the suppression", async () => {
            await api(`${base}/suppressions/${lifting!.id}`, { method: "DELETE" });
            setLifting(null);
            await list.reload();
            return "Taken off the list. Texts go to this number again when its consent allows.";
          })
        }
      >
        <p>Texts can reach this number again, but only those its consent allows: marketing texts still need the customer&apos;s SMS marketing consent from Shopify.</p>
      </ConfirmDialog>
    </section>
  );
}

/** Consent & Suppression: who agreed to what, as Shopify reports it, and who must not be texted. */
export function ConsentSuppression() {
  const { base, contact, store } = useSms();
  const [filters, setFilters] = useState({ consent: "", suppressed: false, q: "" });
  const [open, setOpen] = useState<string | null>(null);
  const counts = useApi<{ byConsent: Record<string, number> }>(base ? `${base}/contacts/count` : null);
  const query = new URLSearchParams(Object.entries({ consent: filters.consent, suppressed: filters.suppressed ? "1" : "", q: filters.q, limit: "50" }).filter(([, v]) => v));
  const list = usePagedList<SmsContact>(base && contact ? `${base}/contacts?${query}` : null, "contacts", filters.q ? 300 : 0);
  const total = Object.values(counts.data?.byConsent ?? {}).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Customer messaging permissions"
        sub="Each customer's SMS marketing consent as Shopify reports it, how it changed, and the numbers that must not be texted."
      />
      <section className="card text-sm" aria-labelledby="c-rules-h">
        <h2 id="c-rules-h" className="font-semibold">
          How consent works
        </h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
          <li>Marketing texts only go to customers subscribed to your SMS marketing in Shopify. Consent comes from Shopify (checkout, customer accounts, your own forms that save it there).</li>
          <li>A phone number on an order, or a past purchase, is never treated as consent.</li>
          <li>Opt-outs apply immediately: the opt-out link in marketing texts, a STOP reply, Shopify unsubscribing them, or one your team records here.</li>
          <li>Customers who opted out themselves can&apos;t be added back by your team. Only they can opt in again, through Shopify.</li>
        </ul>
      </section>

      {counts.data && total > 0 && (
        <section className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6" aria-label="Customers by consent">
          {CONSENT_STATES.filter((s) => counts.data!.byConsent[s]).map((s) => (
            <div key={s} className="rounded-lg border border-border bg-surface p-3">
              <p className="text-xs text-muted">{CONSENT_LABEL[s]}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{fmtNum(counts.data!.byConsent[s])}</p>
            </div>
          ))}
        </section>
      )}

      {!contact ? (
        <div className="card text-sm text-muted">Seeing customers&apos; numbers and consent needs &ldquo;View contact information&rdquo; in Settings → People &amp; access. Ask an owner or admin.</div>
      ) : (
        <>
          <section className="card" aria-labelledby="c-list-h">
            <h2 id="c-list-h" className="font-semibold">
              Customers
            </h2>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <div>
                <label className="text-xs text-muted" htmlFor="c-consent">Consent</label>
                <select id="c-consent" className="input" value={filters.consent} onChange={(e) => setFilters({ ...filters, consent: e.target.value })}>
                  <option value="">Any</option>
                  {CONSENT_STATES.map((s) => <option key={s} value={s}>{CONSENT_LABEL[s]}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-muted" htmlFor="c-q">Last 3 digits</label>
                <input id="c-q" className="input" inputMode="numeric" maxLength={4} value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value.replace(/\D/g, "") })} placeholder="e.g. 678" />
              </div>
              <label className="flex items-center gap-2 text-sm sm:mt-5">
                <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={filters.suppressed} onChange={(e) => setFilters({ ...filters, suppressed: e.target.checked })} />
                Only those who opted out
              </label>
            </div>
            {list.error && !list.rows ? (
              <div className="mt-3">
                <LoadError what="the customers" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
              </div>
            ) : !list.rows ? (
              <div className="mt-3 space-y-2">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-10" />)}</div>
            ) : !list.rows.length ? (
              <div className="mt-3">
                <Empty>{filters.consent || filters.q || filters.suppressed ? "No customers match." : "No customers with a mobile number yet. They appear as Shopify orders, checkouts and consent updates arrive."}</Empty>
              </div>
            ) : (
              <div className={`relative mt-3 overflow-x-auto transition-opacity ${list.loading ? "opacity-60" : ""}`}>
                <table className="w-full min-w-[48rem] text-left text-sm">
                  <thead className="text-xs text-muted">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Number</th>
                      <th className="py-2 pr-3 font-medium">Country</th>
                      <th className="py-2 pr-3 font-medium">SMS marketing</th>
                      <th className="py-2 pr-3 font-medium">Source</th>
                      <th className="py-2 pr-3 font-medium">Opt-outs</th>
                      <th className="py-2 pr-3 text-right font-medium">Orders</th>
                      <th className="py-2 font-medium"><span className="sr-only">Details</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {list.rows.map((r) => (
                      <tr key={r.id} className="align-top">
                        <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs">{r.number}</td>
                        <td className="py-2 pr-3">{countryName(r.country)}</td>
                        <td className="py-2 pr-3">
                          <ConsentBadge state={r.consent} />
                          {r.consentUpdatedAt && <span className="mt-0.5 block text-xs text-muted">{fmtWhen(r.consentUpdatedAt, store?.timezone)}</span>}
                        </td>
                        <td className="py-2 pr-3 text-xs text-muted">
                          {words(r.consentSource)}
                          {r.consentCollectedFrom && r.consentCollectedFrom.toLowerCase() !== (r.consentSource ?? "").toLowerCase() ? ` · ${r.consentCollectedFrom.replace(/_/g, " ").toLowerCase()}` : ""}
                        </td>
                        <td className="py-2 pr-3 text-xs">{r.suppressedAll ? "Every text" : r.suppressedMarketing ? "Marketing" : <span className="text-muted">—</span>}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(r.orders)}</td>
                        <td className="py-2 text-right">
                          <button type="button" className="btn-secondary h-7 px-2 text-xs" onClick={() => setOpen(r.id)} aria-label={`Consent history of ${r.number}`}>
                            History
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {list.cursor && list.rows && (
              <button type="button" className="btn-secondary mt-3" disabled={list.loading} onClick={list.loadMore}>
                {list.loading ? "Loading…" : "Load more"}
              </button>
            )}
          </section>
          <SuppressionList />
        </>
      )}
      {open && (
        <ContactPanel
          id={open}
          onClose={() => setOpen(null)}
          onChanged={() => {
            void list.reload();
            void counts.reload();
          }}
        />
      )}
    </div>
  );
}
