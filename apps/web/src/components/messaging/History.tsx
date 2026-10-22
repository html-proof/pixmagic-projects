"use client";
import { useEffect, useMemo, useState } from "react";
import { DELIVERY_EXPLANATION, SMS_STATUS_LABEL, SMS_STATUSES, statusFromEvent, type SmsStatus } from "@app/shared/sms";
import { PageHeader } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Empty } from "@/components/dashboard/Primitives";
import { fmtMoney, useApi } from "@/lib/api";
import { COUNTRY_CHOICES, countryName, Drawer, fmtUsd, fmtWhen, purposeLabel, SmsStatusBadge, TextBubble, usePagedList, useSms } from "./MessagingUi";
import type { MessageEvent, SmsMessage, SmsTemplate } from "./types";

const PURPOSES = [
  ["", "Everything"],
  ["automation", "Automated workflows"],
  ["campaign", "Campaigns"],
  ["manual", "Sent from Send SMS"],
  ["test", "Test texts"],
] as const;

/** A text's cost: what AWS billed, or the estimate until AWS reports the price. */
function Cost({ m }: { m: SmsMessage }) {
  if (m.priceUsd !== null) return <span className="tabular-nums">{fmtUsd(m.priceUsd)}</span>;
  if (m.estimatedCostUsd !== null)
    return (
      <span className="tabular-nums text-muted" title="AWS hasn't reported the price yet">
        {fmtUsd(m.estimatedCostUsd)} <span className="text-[11px]">estimate</span>
      </span>
    );
  return <span className="text-muted">—</span>;
}

function MessageDetail({ base, id, templates, onClose }: { base: string; id: string; templates: Map<string, string>; onClose: () => void }) {
  const { store, contact } = useSms();
  const tz = store?.timezone;
  const { data, error, reload, loading } = useApi<{ message: SmsMessage; events: MessageEvent[] }>(`${base}/messages/${id}`);
  const m = data?.message;
  return (
    <Drawer title="Text details" sub={m ? `${purposeLabel(m.purpose, m.trigger)} · ${fmtWhen(m.createdAt, tz)}` : undefined} onClose={onClose}>
      {error ? (
        <LoadError what="this text" error={error} onRetry={() => void reload()} busy={loading} />
      ) : !m ? (
        <div className="space-y-2">
          <div className="skeleton h-6" />
          <div className="skeleton h-24" />
        </div>
      ) : (
        <>
          <section className="card space-y-2 p-4 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <SmsStatusBadge status={m.status} />
              {m.reasonLabel && <span className="text-muted">{m.reasonLabel}</span>}
            </p>
            {m.providerExplanation && <p>{m.providerExplanation}</p>}
            {m.errorCode && <p className="text-xs text-muted">Code from AWS: {m.errorCode}</p>}
            <dl className="grid grid-cols-2 gap-3 pt-2">
              <div>
                <dt className="text-xs text-muted">To</dt>
                <dd className="font-mono">{m.to ?? (contact ? "—" : "Hidden")}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Country</dt>
                <dd>{countryName(m.country)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Template</dt>
                <dd>{m.templateId ? `${templates.get(m.templateId) ?? "Template"}${m.templateVersion ? ` (version ${m.templateVersion})` : ""}` : "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Parts</dt>
                <dd>
                  {m.partsBilled ?? m.segments ?? "—"}
                  {m.partsBilled ? " billed" : ""}
                  {m.encoding ? ` · ${m.encoding === "GSM" ? "GSM-7" : "Unicode"}` : ""}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Cost</dt>
                <dd>
                  <Cost m={m} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Attempts</dt>
                <dd>{m.attempts}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Due</dt>
                <dd>{fmtWhen(m.sendAfter, tz)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Accepted by AWS</dt>
                <dd>{fmtWhen(m.acceptedAt, tz)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Final outcome</dt>
                <dd>{fmtWhen(m.finalAt, tz)}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs text-muted">AWS message ID</dt>
                <dd className="break-all font-mono text-xs">{m.providerMessageId ?? "—"}</dd>
              </div>
            </dl>
            {m.attributedOrderId && (
              <p className="border-t border-border pt-2 text-xs text-muted">
                An order followed this text{m.attributedRevenue !== null ? ` (${fmtMoney(m.attributedRevenue, m.attributedCurrency ?? store?.currency ?? "USD")})` : ""}. That shows it came after the text, not that the text caused it.
              </p>
            )}
          </section>
          <section>
            <h3 className="label">The text</h3>
            {m.text ? (
              <TextBubble>{m.text}</TextBubble>
            ) : (
              <p className="text-sm text-muted">{contact ? "Not kept: texts are kept for 30 days after their outcome." : "Hidden: seeing texts needs “View contact information” in Team & Access."}</p>
            )}
          </section>
          <section>
            <h3 className="label">Delivery reports from AWS</h3>
            {!data.events.length ? (
              <p className="text-sm text-muted">{m.dryRun || m.status === "dry_run" ? "None: this was a dry run, nothing was sent." : m.acceptedAt ? "None yet." : "None: AWS didn't receive this text."}</p>
            ) : (
              <ol className="relative space-y-3 border-l border-border pl-4">
                {data.events.map((e, i) => (
                  <li key={i} className="text-sm">
                    <span aria-hidden className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ${e.final ? "bg-accent" : "bg-border"}`} />
                    <p className="font-medium">
                      {e.status ? (DELIVERY_EXPLANATION[e.status.toUpperCase()] ?? SMS_STATUS_LABEL[statusFromEvent(e.status, e.final)]) : e.type}
                      {e.final ? <span className="ml-2 text-xs font-normal text-muted">final</span> : null}
                    </p>
                    <p className="text-xs text-muted">
                      {fmtWhen(e.at, tz)} · {e.type}
                      {e.status ? ` · ${e.status}` : ""}
                      {e.parts ? ` · ${e.parts} part${e.parts === 1 ? "" : "s"}` : ""}
                      {e.priceUsd !== null ? ` · ${fmtUsd(e.priceUsd + (e.carrierFeeUsd ?? 0))}` : ""}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </Drawer>
  );
}

/** Message History: every text bizinsights scheduled, sent or held back, and why. */
export function MessageHistory() {
  const { base, contact, store } = useSms();
  const tz = store?.timezone;
  const [statuses, setStatuses] = useState<string[]>([]);
  const [filters, setFilters] = useState({ purpose: "", country: "", from: "", to: "", q: "" });
  const [open, setOpen] = useState<string | null>(null);
  const templates = useApi<{ templates: SmsTemplate[] }>(base ? `${base}/templates?archived=1` : null);
  const names = useMemo(() => new Map((templates.data?.templates ?? []).map((t) => [t.id, t.name])), [templates.data]);

  // Arriving from the overview with ?status=failed.
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get("status");
    if (s) setStatuses(s.split(",").filter((x) => (SMS_STATUSES as readonly string[]).includes(x)));
  }, []);

  const query = new URLSearchParams(Object.entries({ ...filters, status: statuses.join(","), limit: "50" }).filter(([, v]) => v));
  const list = usePagedList<SmsMessage>(base ? `${base}/messages?${query}` : null, "messages", filters.q ? 300 : 0);
  const set = (k: keyof typeof filters) => (e: { target: { value: string } }) => setFilters({ ...filters, [k]: e.target.value });
  const toggle = (s: string) => setStatuses(statuses.includes(s) ? statuses.filter((x) => x !== s) : [...statuses, s]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Message History"
        sub={`Every text bizinsights scheduled, sent, held back or recorded as a dry run, with AWS's delivery reports. Times are in the store's time zone${tz ? ` (${tz})` : ""}. Customers' numbers are masked.`}
      />
      <section className="card" aria-label="Texts">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
          <details className="relative lg:col-span-1">
            <summary className="input flex cursor-pointer list-none items-center justify-between">
              <span className="truncate">{statuses.length ? `${statuses.length} status${statuses.length === 1 ? "" : "es"}` : "Any status"}</span>
              <span aria-hidden>▾</span>
            </summary>
            <fieldset className="absolute z-20 mt-1 w-64 rounded-lg border border-border bg-surface p-2 shadow-lg">
              <legend className="sr-only">Status</legend>
              {SMS_STATUSES.map((s) => (
                <label key={s} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-bg">
                  <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={statuses.includes(s)} onChange={() => toggle(s)} />
                  {SMS_STATUS_LABEL[s as SmsStatus]}
                </label>
              ))}
              {statuses.length > 0 && (
                <button type="button" className="mt-1 w-full text-left text-xs text-accent underline-offset-2 hover:underline" onClick={() => setStatuses([])}>
                  Any status
                </button>
              )}
            </fieldset>
          </details>
          <div>
            <label className="sr-only" htmlFor="h-purpose">Sent by</label>
            <select id="h-purpose" className="input" value={filters.purpose} onChange={set("purpose")}>
              {PURPOSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="sr-only" htmlFor="h-country">Country</label>
            <select id="h-country" className="input" value={filters.country} onChange={set("country")}>
              <option value="">Any country</option>
              {COUNTRY_CHOICES.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}
            </select>
          </div>
          <div>
            <label className="sr-only" htmlFor="h-from">From</label>
            <input id="h-from" className="input" type="date" value={filters.from} onChange={set("from")} title="From (store day)" />
          </div>
          <div>
            <label className="sr-only" htmlFor="h-to">To</label>
            <input id="h-to" className="input" type="date" value={filters.to} onChange={set("to")} title="To (store day)" />
          </div>
          <div>
            <label className="sr-only" htmlFor="h-q">Last 3 digits or AWS message ID</label>
            <input id="h-q" className="input" value={filters.q} onChange={set("q")} placeholder={contact ? "Last 3 digits or message ID" : "AWS message ID"} />
          </div>
        </div>
        {list.error && list.rows ? <p className="mt-3 text-sm text-danger">We couldn&apos;t load more texts. Try again.</p> : null}
        {list.error && !list.rows ? (
          <div className="mt-4">
            <LoadError what="the texts" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
          </div>
        ) : !list.rows ? (
          <div className="mt-4 space-y-2">
            {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-10" />)}
          </div>
        ) : !list.rows.length ? (
          <div className="mt-4">
            <Empty>No texts match.</Empty>
          </div>
        ) : (
          <div className={`relative mt-4 overflow-x-auto transition-opacity ${list.loading ? "opacity-60" : ""}`}>
            <table className="w-full min-w-[52rem] text-left text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Why</th>
                  {contact && <th className="py-2 pr-3 font-medium">To</th>}
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 text-right font-medium">Parts</th>
                  <th className="py-2 pr-3 text-right font-medium">Cost</th>
                  <th className="py-2 font-medium"><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {list.rows.map((m) => (
                  <tr key={m.id} className="align-top">
                    <td className="whitespace-nowrap py-2 pr-3 text-muted">{fmtWhen(m.createdAt, tz)}</td>
                    <td className="py-2 pr-3">
                      <span className="font-medium">{purposeLabel(m.purpose, m.trigger)}</span>
                      <span className="block text-xs text-muted">
                        {m.templateId ? (names.get(m.templateId) ?? "") : ""}
                        {m.country ? ` · ${countryName(m.country)}` : ""}
                        {m.attributedOrderId ? " · an order followed" : ""}
                      </span>
                    </td>
                    {contact && <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs">{m.to ?? "—"}</td>}
                    <td className="max-w-xs py-2 pr-3">
                      <SmsStatusBadge status={m.status} why={m.reasonLabel} />
                      {(m.providerExplanation || m.reasonLabel) && <span className="mt-0.5 block text-xs text-muted">{m.providerExplanation ?? m.reasonLabel}</span>}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{m.partsBilled ?? m.segments ?? "—"}</td>
                    <td className="whitespace-nowrap py-2 pr-3 text-right">
                      <Cost m={m} />
                    </td>
                    <td className="py-2 text-right">
                      <button type="button" className="btn-secondary h-7 px-2 text-xs" onClick={() => setOpen(m.id)} aria-label={`Details of the text from ${fmtWhen(m.createdAt, tz)}`}>
                        Details
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
        <p className="mt-3 text-xs text-muted">Costs are what AWS billed in US dollars; &ldquo;estimate&rdquo; marks texts AWS hasn&apos;t priced yet. Date filters are whole days in the store's time zone.</p>
      </section>
      {open && base && <MessageDetail base={base} id={open} templates={names} onClose={() => setOpen(null)} />}
    </div>
  );
}
