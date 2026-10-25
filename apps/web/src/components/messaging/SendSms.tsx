"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CONSENT_LABEL, previewSms, SMS_VARIABLE_INFO, templateVariables, type ConsentState, type SmsValues, type SmsVariable } from "@app/shared/sms";
import { ConfirmDialog, PageHeader, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Alert } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { countryName, fmtUsd, ModeBanner, sendable, smsError, SmsStatusBadge, TemplatePicker, TextBubble, useSms } from "./MessagingUi";
import type { Recipient, SmsMessage, SmsOverview, SmsTemplate, TestNumber } from "./types";

/** Values a merchant may fill in for a one-off text (the API's `values`); the rest come from the customer and the store. */
const MANUAL_VALUES = ["order_number", "order_total", "currency", "product_name", "tracking_url", "discount_code"] as const satisfies readonly SmsVariable[];
type ManualValue = (typeof MANUAL_VALUES)[number];

/** What happened to a text just sent, in plain words. */
function Outcome({ m, kind }: { m: SmsMessage; kind: "test" | "customer" }) {
  const dry = m.dryRun || m.status === "dry_run";
  const said = dry
    ? kind === "customer"
      ? "Recorded as a dry run: SMS is in test mode (or not switched on), so the customer wasn't texted. It is listed in Message History."
      : "Recorded as a dry run: nothing was sent."
    : m.status === "skipped" || m.status === "cancelled"
      ? `Not sent: ${m.reasonLabel ?? "it didn't pass the checks before sending"}.`
      : m.status === "opted_out"
        ? "Not sent: this number is on an opt-out list."
        : m.status === "failed"
          ? `AWS or the carrier refused it${m.providerExplanation ? `: ${m.providerExplanation}` : m.reasonLabel ? `: ${m.reasonLabel}` : "."}`
          : m.status === "uncertain"
            ? "The call to AWS broke off without an answer. It won't be sent again on its own: check your phone before trying again."
            : "AWS accepted it. The delivery report arrives in Message History when the carrier answers.";
  return (
    <div className="mt-4 rounded-lg border border-border bg-bg/50 p-3 text-sm" role="status">
      <p className="flex flex-wrap items-center gap-2">
        <SmsStatusBadge status={m.status} why={m.reasonLabel} />
        {m.to && <span className="text-muted">to {m.to}</span>}
        {m.segments ? <span className="text-muted">· {m.segments} part{m.segments === 1 ? "" : "s"}</span> : null}
        {m.priceUsd !== null ? <span className="text-muted">· {fmtUsd(m.priceUsd)}</span> : m.estimatedCostUsd !== null ? <span className="text-muted">· about {fmtUsd(m.estimatedCostUsd)} (estimate)</span> : null}
      </p>
      <p className="mt-1">{said}</p>
      <Link className="mt-1 inline-block text-xs text-accent underline-offset-2 hover:underline" href="/messaging/history">
        Open Message History
      </Link>
    </div>
  );
}

function SendTest({ base, templates }: { base: string; templates: SmsTemplate[] }) {
  const numbers = useApi<{ testNumbers: TestNumber[] }>(`${base}/test-numbers`);
  const [templateId, setTemplateId] = useState("");
  const [numberId, setNumberId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SmsMessage | null>(null);
  // Arriving from a template's "Send test" with ?template=<id>.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("template");
    if (t) setTemplateId(t);
  }, []);
  const verified = (numbers.data?.testNumbers ?? []).filter((n) => n.status === "verified");
  // One verified number: choose it.
  useEffect(() => {
    const only = (numbers.data?.testNumbers ?? []).filter((n) => n.status === "verified");
    if (only.length === 1) setNumberId((id) => id || only[0]!.id);
  }, [numbers.data]);
  const options = templates.filter((t) => t.status !== "archived");
  const chosen = options.find((t) => t.id === templateId);
  const send = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api<{ message: SmsMessage }>(`${base}/templates/${templateId}/test`, { method: "POST", body: { testNumberId: numberId } });
      setResult(r.message);
    } catch (e) {
      setError(smsError(e, "send the test"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card animate-rise" aria-labelledby="test-h">
      <h2 id="test-h" className="font-semibold">
        Send a test
      </h2>
      <p className="mt-1 text-sm text-muted">Text a template&apos;s latest version, approved or not, to one of your team&apos;s verified numbers, with sample values in its variables. Customers never get tests.</p>
      {numbers.error ? (
        <div className="mt-3">
          <LoadError what="your test numbers" error={numbers.error} onRetry={() => void numbers.reload()} busy={numbers.loading} />
        </div>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <TemplatePicker label="Template" templates={options} value={templateId} onChange={setTemplateId} empty={<Link className="text-accent underline" href="/messaging/templates">Write a template first.</Link>} />
          <div>
            <label className="label" htmlFor="test-number">
              Test number
            </label>
            <select id="test-number" className="input" value={numberId} onChange={(e) => setNumberId(e.target.value)} disabled={!verified.length}>
              <option value="">{numbers.data ? (verified.length ? "Choose a number…" : "No verified test number") : "Loading…"}</option>
              {verified.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.number} {n.country ? `(${countryName(n.country)})` : ""}
                </option>
              ))}
            </select>
            {numbers.data && !verified.length && (
              <p className="mt-1 text-xs text-muted">
                Add and verify one in{" "}
                <Link className="text-accent underline" href="/messaging/sender">
                  SMS Sender
                </Link>
                .
              </p>
            )}
          </div>
        </div>
      )}
      {chosen?.body && (
        <div className="mt-3">
          <p className="label">What the test says</p>
          <TextBubble>{previewSms(chosen.body)}</TextBubble>
        </div>
      )}
      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}
      <button type="button" className="btn-primary mt-4" disabled={busy || !templateId || !numberId} onClick={() => void send()}>
        {busy ? "Sending…" : "Send test"}
      </button>
      {result && <Outcome m={result} kind="test" />}
    </section>
  );
}

function SendToCustomer({ base, templates }: { base: string; templates: SmsTemplate[] }) {
  const [templateId, setTemplateId] = useState("");
  const [digits, setDigits] = useState("");
  const [query, setQuery] = useState("");
  const [contactId, setContactId] = useState("");
  const [values, setValues] = useState<Partial<Record<ManualValue, string>>>({});
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SmsMessage | null>(null);
  // Search as they type, once they stop.
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(digits), 300);
    return () => window.clearTimeout(t);
  }, [digits]);
  const recipients = useApi<{ recipients: Recipient[] }>(`${base}/recipients${query ? `?q=${encodeURIComponent(query)}` : ""}`);
  const options = templates.filter(sendable);
  const t = options.find((x) => x.id === templateId);
  const body = t?.approvedBody ?? "";
  const used = useMemo(() => templateVariables(body).used, [body]);
  const fields = MANUAL_VALUES.filter((v) => used.includes(v));
  const contact = recipients.data?.recipients.find((r) => r.id === contactId);
  const preview = body ? previewSms(body, Object.fromEntries(Object.entries(values).filter(([, v]) => v)) as SmsValues) : "";
  const send = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api<{ message: SmsMessage }>(`${base}/send`, {
        method: "POST",
        body: { templateId, contactId, values: Object.fromEntries(fields.filter((f) => values[f]?.trim()).map((f) => [f, values[f]!.trim()])) },
      });
      setResult(r.message);
      setConfirm(false);
    } catch (e) {
      setError(smsError(e, "send the text"));
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card animate-rise" aria-labelledby="one-h">
      <h2 id="one-h" className="font-semibold">
        Send to a customer
      </h2>
      <p className="mt-1 text-sm text-muted">
        One approved template to one customer, now. The same checks as every other text apply first: consent (marketing texts need the customer&apos;s SMS marketing consent from Shopify), opt-outs,
        quiet hours, the daily limit per customer and your budget.
      </p>
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-3">
          <TemplatePicker
            label="Approved template"
            templates={options}
            value={templateId}
            onChange={(id) => {
              setTemplateId(id);
              setValues({});
            }}
            empty={
              <>
                No approved template yet.{" "}
                <Link className="text-accent underline" href="/messaging/templates">
                  Message Templates
                </Link>
              </>
            }
          />
          <div>
            <label className="label" htmlFor="rcpt-q">
              Find the customer by the last 3 digits of their number
            </label>
            <input id="rcpt-q" className="input" inputMode="numeric" maxLength={4} placeholder="e.g. 678" value={digits} onChange={(e) => setDigits(e.target.value.replace(/\D/g, ""))} />
          </div>
          {recipients.error ? (
            <LoadError what="the customers" error={recipients.error} onRetry={() => void recipients.reload()} busy={recipients.loading} />
          ) : !recipients.data ? (
            <div className="skeleton h-24" />
          ) : !recipients.data.recipients.length ? (
            <p className="text-sm text-muted">{query ? "No customer's number ends in those digits." : "No customers with a mobile number yet. They appear as Shopify orders and checkouts arrive."}</p>
          ) : (
            <fieldset className="min-w-0">
              <legend className="label">Customer</legend>
              <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {recipients.data.recipients.map((r) => (
                  <li key={r.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-bg">
                      <input type="radio" name="sms-recipient" className="accent-[var(--accent)]" aria-label={`${r.number}, ${countryName(r.country)}`} checked={contactId === r.id} onChange={() => setContactId(r.id)} />
                      <span className="font-mono">{r.number}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted">
                        {countryName(r.country)} · {CONSENT_LABEL[r.consent as ConsentState] ?? r.consent} · {r.orders} order{r.orders === 1 ? "" : "s"}
                        {r.suppressedMarketing ? " · opted out of marketing" : ""}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted">Customers who opted out of every text aren&apos;t listed.</p>
            </fieldset>
          )}
        </div>
        <div className="min-w-0 space-y-3">
          {fields.length > 0 && (
            <fieldset className="grid min-w-0 gap-3 sm:grid-cols-2">
              <legend className="label">Values for this text</legend>
              {fields.map((f) => (
                <div key={f}>
                  <label className="text-xs text-muted" htmlFor={`v-${f}`}>
                    {SMS_VARIABLE_INFO[f].label}
                  </label>
                  <input
                    id={`v-${f}`}
                    className="input"
                    maxLength={SMS_VARIABLE_INFO[f].maxLength}
                    placeholder={SMS_VARIABLE_INFO[f].sample}
                    value={values[f] ?? ""}
                    onChange={(e) => setValues({ ...values, [f]: e.target.value })}
                  />
                  <p className="mt-0.5 text-[11px] text-muted">{SMS_VARIABLE_INFO[f].description}</p>
                </div>
              ))}
            </fieldset>
          )}
          {body && (
            <div>
              <p className="label">Preview</p>
              <TextBubble>{preview}</TextBubble>
              <p className="mt-1 text-xs text-muted">The customer&apos;s first name and your store name are filled in when it&apos;s sent; empty values show samples here. A value that is missing or unusable stops the text.</p>
            </div>
          )}
        </div>
      </div>
      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}
      <button type="button" className="btn-primary mt-4" disabled={busy || !templateId || !contactId} onClick={() => setConfirm(true)}>
        Send text…
      </button>
      {result && <Outcome m={result} kind="customer" />}
      <ConfirmDialog open={confirm} title="Send this text now?" confirmLabel="Send" busy={busy} onCancel={() => setConfirm(false)} onConfirm={() => void send()}>
        <p>
          <strong>{t?.name}</strong> goes to <strong className="font-mono">{contact?.number}</strong> right away, unless a check stops it (consent, opt-out, quiet hours, budget).
        </p>
        <p>A text can&apos;t be called back once AWS accepts it.</p>
      </ConfirmDialog>
    </section>
  );
}

/** Send SMS: a test to the team's own phone, and one approved template to one customer. */
export function SendSms() {
  const { base, manage, contact } = useSms();
  const templates = useApi<{ templates: SmsTemplate[] }>(base ? `${base}/templates` : null);
  const overview = useApi<SmsOverview>(base);
  const error = templates.error ?? overview.error;
  if (error) return <LoadError what="Send SMS" error={error} onRetry={() => void Promise.all([templates.reload(), overview.reload()])} />;
  if (!base || !templates.data || !overview.data) return <Skeleton lines={5} />;
  return (
    <div className="space-y-4">
      <PageHeader title="Send SMS" sub="Try a template on your own phone, or send one approved text to one customer. Workflows and campaigns send the rest by themselves." />
      <ModeBanner mode={overview.data.mode} />
      {!manage ? (
        <div className="card text-sm text-muted">Only owners and admins can send texts. You can see what was sent in Message History.</div>
      ) : (
        <>
          <SendTest base={base} templates={templates.data.templates} />
          {contact ? (
            <SendToCustomer base={base} templates={templates.data.templates} />
          ) : (
            <div className="card text-sm text-muted">Sending to a customer needs &ldquo;View contact information&rdquo; in Team &amp; Access, since it shows their (masked) number.</div>
          )}
        </>
      )}
    </div>
  );
}
