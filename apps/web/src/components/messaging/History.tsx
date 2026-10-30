"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DELIVERY_EXPLANATION, skipFix, SMS_STATUS_LABEL, SMS_STATUSES, statusFromEvent, type SmsStatus } from "@app/shared/sms";
import Link from "next/link";
import { PageHeader } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Empty } from "@/components/dashboard/Primitives";
import { fmtMoney, useApi } from "@/lib/api";
import { COUNTRY_CHOICES, countryName, Drawer, fmtUsd, fmtWhen, purposeLabel, SmsStatusBadge, TextBubble, usePagedList, useSms } from "./MessagingUi";
import type { AutomationsResponse, MessageEvent, SmsMessage, SmsTemplate } from "./types";

// ---------------------------------------------------------------------------
// Message History: every text an automation, a campaign or a test asked for, sent or held back,
// and why, in words (the provider's own codes and ids only under Technical details, for owners and
// admins). Customers' first names, numbers (masked) and texts need "View contact information".
// ---------------------------------------------------------------------------

const PURPOSES = [
  ["", "Everything"],
  ["automation", "Automations"],
  ["campaign", "Campaigns"],
  ["manual", "Sent from Send SMS"],
  ["test", "Test messages"],
] as const;

/** A text's cost: what the provider billed, or the estimate until it reports the price. */
function Cost({ m }: { m: SmsMessage }) {
  if (m.priceUsd !== null) return <span className="tabular-nums">{fmtUsd(m.priceUsd)}</span>;
  if (m.estimatedCostUsd !== null)
    return (
      <span className="tabular-nums text-muted" title="Not priced yet">
        {fmtUsd(m.estimatedCostUsd)} <span className="text-[11px]">estimate</span>
      </span>
    );
  return <span className="text-muted">—</span>;
}

/** What sent it, by name: the automation or campaign, else why it went (a test, Send SMS). */
const sentBy = (m: SmsMessage) => m.automationName ?? m.campaignName ?? (m.purpose === "automation" ? "A deleted automation" : purposeLabel(m.purpose, m.trigger));
/** Its outcome in words: the carrier's report, else why it wasn't sent. */
const outcomeOf = (m: SmsMessage) => m.providerExplanation ?? m.reasonLabel ?? (m.status === "delivered" ? "The phone confirmed delivery." : null);

function Row({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2" : undefined}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function MessageDetail({ base, id, templates, onClose }: { base: string; id: string; templates: Map<string, string>; onClose: () => void }) {
  const { store, contact, manage } = useSms();
  const tz = store?.timezone;
  const { data, error, reload, loading } = useApi<{ message: SmsMessage; events: MessageEvent[] }>(`${base}/messages/${id}`);
  const m = data?.message;
  const fix = m ? skipFix(m.reason) : null;
  return (
    <Drawer title="Message details" sub={m ? `${sentBy(m)} · ${fmtWhen(m.createdAt, tz)}` : undefined} onClose={onClose}>
      {error ? (
        <LoadError what="this message" error={error} onRetry={() => void reload()} busy={loading} />
      ) : !m ? (
        <div className="space-y-2">
          <div className="skeleton h-6" />
          <div className="skeleton h-24" />
        </div>
      ) : (
        <>
          <section className="card space-y-2 p-4 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <SmsStatusBadge status={m.status} label={m.statusLabel} />
              {outcomeOf(m) && <span className="text-muted">{outcomeOf(m)}</span>}
            </p>
            {fix && manage && (
              <p>
                <Link className="font-medium text-accent underline" href={fix.href}>
                  {fix.label}
                </Link>
              </p>
            )}
          </section>
          <section>
            <h3 className="label">Message content</h3>
            {m.text ? (
              <TextBubble>{m.text}</TextBubble>
            ) : (
              <p className="text-sm text-muted">{contact ? "Not kept: texts are kept for 30 days after their outcome." : "Hidden: seeing texts needs “View contact information” in Team & Access."}</p>
            )}
          </section>
          <section className="card p-4 text-sm">
            <dl className="grid grid-cols-2 gap-3">
              <Row label="Recipient">{m.customerName ? `${m.customerName}${m.to ? ` · ${m.to}` : ""}` : (m.to ?? (contact ? "—" : "Hidden"))}</Row>
              <Row label="Country">{countryName(m.country)}</Row>
              <Row label={m.campaignId ? "Campaign" : m.purpose === "automation" ? "Automation" : "Sent by"}>{sentBy(m)}</Row>
              <Row label="Trigger">{m.purpose === "automation" ? purposeLabel(m.purpose, m.trigger) : "—"}</Row>
              <Row label="Delivery status">{m.statusLabel ?? SMS_STATUS_LABEL[m.status] ?? m.status}</Row>
              <Row label="Failure reason">{m.status === "failed" || m.status === "skipped" || m.status === "opted_out" || m.status === "cancelled" ? (outcomeOf(m) ?? "—") : "—"}</Row>
              <Row label="Created">{fmtWhen(m.createdAt, tz)}</Row>
              <Row label="Final outcome">{fmtWhen(m.finalAt, tz)}</Row>
              <Row label="Message ID" wide>
                <span className="break-all font-mono text-xs">{m.id}</span>
              </Row>
            </dl>
            {m.attributedOrderId && (
              <p className="mt-3 border-t border-border pt-2 text-xs text-muted">
                An order followed this text{m.attributedRevenue !== null ? ` (${fmtMoney(m.attributedRevenue, m.attributedCurrency ?? store?.currency ?? "USD")})` : ""}. That shows it came after the text, not that the text caused it.
              </p>
            )}
          </section>
          {manage && (
            <details className="card p-4 text-sm">
              <summary className="cursor-pointer font-medium">Technical details</summary>
              <dl className="mt-3 grid grid-cols-2 gap-3">
                <Row label="Provider status">{m.providerStatus ?? "—"}</Row>
                <Row label="Provider error code">{m.errorCode ?? "—"}</Row>
                <Row label="Provider message ID" wide>
                  <span className="break-all font-mono text-xs">{m.providerMessageId ?? "—"}</span>
                </Row>
                <Row label="Template">{m.templateId ? `${templates.get(m.templateId) ?? "Template"}${m.templateVersion ? ` (version ${m.templateVersion})` : ""}` : "—"}</Row>
                <Row label="Parts">
                  {m.partsBilled ?? m.segments ?? "—"}
                  {m.partsBilled ? " billed" : ""}
                  {m.encoding ? ` · ${m.encoding === "GSM" ? "GSM-7" : "Unicode"}` : ""}
                </Row>
                <Row label="Cost">
                  <Cost m={m} />
                </Row>
                <Row label="Attempts">{m.attempts}</Row>
                <Row label="Due">{fmtWhen(m.sendAfter, tz)}</Row>
                <Row label="Accepted by the provider">{fmtWhen(m.acceptedAt, tz)}</Row>
              </dl>
              <h4 className="label mt-4">Delivery reports</h4>
              {!data.events.length ? (
                <p className="text-sm text-muted">{m.dryRun || m.status === "dry_run" ? "None: it was recorded, not sent." : m.acceptedAt ? "None yet." : "None: the provider never received this text."}</p>
              ) : (
                <ol className="relative space-y-3 border-l border-border pl-4">
                  {data.events.map((e, i) => (
                    <li key={i}>
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
            </details>
          )}
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
  const [filters, setFilters] = useState({ purpose: "", ruleId: "", country: "", from: "", to: "", q: "" });
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const templates = useApi<{ templates: SmsTemplate[] }>(base ? `${base}/templates?archived=1` : null);
  const automations = useApi<AutomationsResponse>(base ? `${base}/automations` : null);
  const names = useMemo(() => new Map((templates.data?.templates ?? []).map((t) => [t.id, t.name])), [templates.data]);

  // Arriving from the overview with ?status=failed, or from an automation's "View history" with ?ruleId=.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const s = q.get("status");
    if (s) setStatuses(s.split(",").filter((x) => (SMS_STATUSES as readonly string[]).includes(x)));
    const rule = q.get("ruleId");
    if (rule) setFilters((f) => ({ ...f, ruleId: rule, purpose: "automation" }));
    setReady(true);
  }, []);

  const query = new URLSearchParams(Object.entries({ ...filters, status: statuses.join(","), limit: "50" }).filter(([, v]) => v));
  const list = usePagedList<SmsMessage>(base && ready ? `${base}/messages?${query}` : null, "messages", filters.q ? 300 : 0);
  const set = (k: keyof typeof filters) => (e: { target: { value: string } }) => setFilters({ ...filters, [k]: e.target.value });
  const toggle = (s: string) => setStatuses(statuses.includes(s) ? statuses.filter((x) => x !== s) : [...statuses, s]);
  const ruleName = automations.data?.automations.find((a) => a.id === filters.ruleId)?.name;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Message History"
        sub={`Every text bizinsights sent, held back or recorded, and how it ended. Times are in the store's time zone${tz ? ` (${tz})` : ""}. Customers' numbers are masked.`}
      />
      <section className="card" aria-label="Messages">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          <details className="relative">
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
            <select id="h-purpose" className="input" value={filters.purpose} onChange={(e) => setFilters({ ...filters, purpose: e.target.value, ruleId: e.target.value === "automation" ? filters.ruleId : "" })}>
              {PURPOSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="sr-only" htmlFor="h-rule">Automation</label>
            <select id="h-rule" className="input" value={filters.ruleId} onChange={(e) => setFilters({ ...filters, ruleId: e.target.value, purpose: e.target.value ? "automation" : filters.purpose })}>
              <option value="">Any automation</option>
              {filters.ruleId && !ruleName && <option value={filters.ruleId}>This automation</option>}
              {(automations.data?.automations ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
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
            <label className="sr-only" htmlFor="h-q">Last 3 digits or message ID</label>
            <input id="h-q" className="input" value={filters.q} onChange={set("q")} placeholder={contact ? "Last 3 digits or message ID" : "Message ID"} />
          </div>
        </div>
        {filters.ruleId && (
          <p className="mt-3 text-sm">
            Showing <strong>{ruleName ?? "this automation"}</strong>&apos;s messages.{" "}
            <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => setFilters({ ...filters, ruleId: "", purpose: "" })}>
              Show all
            </button>
          </p>
        )}
        {list.error && list.rows ? <p className="mt-3 text-sm text-danger">We couldn&apos;t load more messages. Try again.</p> : null}
        {list.error && !list.rows ? (
          <div className="mt-4">
            <LoadError what="the messages" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
          </div>
        ) : !list.rows ? (
          <div className="mt-4 space-y-2">
            {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-10" />)}
          </div>
        ) : !list.rows.length ? (
          <div className="mt-4">
            <Empty>No messages match.</Empty>
          </div>
        ) : (
          <div className={`relative mt-4 overflow-x-auto transition-opacity ${list.loading ? "opacity-60" : ""}`}>
            <table className="w-full min-w-[56rem] text-left text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="py-2 pr-3 font-medium">Customer</th>
                  <th className="py-2 pr-3 font-medium">Message</th>
                  <th className="py-2 pr-3 font-medium">Automation</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Sent</th>
                  <th className="py-2 pr-3 font-medium">Delivery</th>
                  <th className="py-2 font-medium"><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {list.rows.map((m) => (
                  <tr key={m.id} className="cursor-pointer align-top hover:bg-bg/60" onClick={() => setOpen(m.id)}>
                    <td className="py-2 pr-3">
                      <span className="font-medium">{m.customerName ?? (m.purpose === "test" ? "Your test phone" : contact ? "Customer" : "Hidden")}</span>
                      {m.to && <span className="block font-mono text-xs text-muted">{m.to}</span>}
                    </td>
                    <td className="max-w-[16rem] py-2 pr-3">
                      <span className="line-clamp-2">{m.text ?? (m.templateId ? (names.get(m.templateId) ?? "—") : "—")}</span>
                    </td>
                    <td className="py-2 pr-3">
                      <span>{sentBy(m)}</span>
                      {m.purpose === "automation" && <span className="block text-xs text-muted">{purposeLabel(m.purpose, m.trigger)}</span>}
                    </td>
                    <td className="py-2 pr-3">
                      <SmsStatusBadge status={m.status} why={m.reasonLabel} label={m.statusLabel} />
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3 text-muted">{fmtWhen(m.acceptedAt ?? m.createdAt, tz)}</td>
                    <td className="max-w-xs py-2 pr-3 text-xs text-muted">{outcomeOf(m) ?? "—"}</td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        className="btn-secondary h-7 px-2 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpen(m.id);
                        }}
                        aria-label={`Details of the message from ${fmtWhen(m.createdAt, tz)}`}
                      >
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
        <p className="mt-3 text-xs text-muted">&ldquo;Delivered&rdquo; only when the phone confirmed it. Date filters are whole days in the store&apos;s time zone.</p>
      </section>
      {open && base && <MessageDetail base={base} id={open} templates={names} onClose={() => setOpen(null)} />}
    </div>
  );
}
