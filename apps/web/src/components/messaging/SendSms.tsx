"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Clock, Megaphone, PackageCheck, Send, Users } from "lucide-react";
import {
  previewSms,
  SEND_VALUES_MANY,
  SEND_VALUES_ONE,
  SMS_SEND_MAX_RECIPIENTS,
  SMS_VARIABLE_INFO,
  smsSegments,
  templateVariables,
  worstCaseSegments,
  type SegmentInfo,
  type SmsCategory,
  type SmsStage,
  type SmsVariable,
  type TemplateIssue,
} from "@app/shared/sms";
import { ConfirmDialog, PageHeader, Skeleton } from "@/components/AppUi";
import { Badge, type Tone } from "@/components/dashboard/Primitives";
import { LoadError } from "@/components/LoadError";
import { Alert } from "@/components/ui";
import { StepCard } from "@/components/automations/MarketingKit";
import { api, useApi } from "@/lib/api";
import { PhonePreview, type PreviewSender } from "./PhonePreview";
import { countryName, fmtUsd, fmtWhen, ModeBanner, plural, sendable, smsError, SmsStatusBadge, TemplatePicker, TextBubble, useSms } from "./MessagingUi";
import type { SmsMessage, SmsMode, SmsOverview, SmsTemplate, TestNumber } from "./types";

// ---------------------------------------------------------------------------
// What the API answers (apps/api/src/routes/smsSends.ts, packages/core/src/sms/sends.ts)
// ---------------------------------------------------------------------------

interface SendCustomer {
  id: string;
  name: string | null;
  number: string;
  country: string | null;
  consentLabel: string;
  orders: number;
  canReceive: boolean;
  reasonLabel: string | null;
}

interface Blocker {
  code: string;
  message: string;
  fix: { label: string; href: string } | null;
}

interface SendPreview {
  mode: SmsMode;
  category: SmsCategory;
  text: string;
  characters: number;
  segments: SegmentInfo;
  worst: SegmentInfo;
  issues: TemplateIssue[];
  blockers: Blocker[];
  scheduledAt: string;
  recipients: {
    chosen: number;
    notFound: number;
    sending: number;
    quietHours: number;
    notSending: Array<{ reason: string; label: string | null; count: number }>;
  };
  cost: { estimatedUsd: number; unpricedRecipients: number };
  limit: { monthlyUsd: number; usedUsd: number; hardStop: boolean } | null;
}

interface SendSummary {
  id: string;
  templateName: string | null;
  category: string;
  createdAt: string;
  createdBy: string;
  scheduledAt: string;
  recipients: number;
  counts: Record<SmsStage, number>;
  waiting: number;
  done: boolean;
  practice: boolean;
  messages: Array<{ id: string; to: string | null; country: string | null; stage: SmsStage; stageLabel: string; reasonLabel: string | null; sendAfter: string }>;
}

/** Who the texts come from, as the phone preview shows it: the store's sender once AWS confirmed it. */
function senderOf(o: SmsOverview): PreviewSender {
  const s = o.sender;
  if (s?.identityLabel) return { kind: s.identityLabel.startsWith("+") ? "number" : "name", label: s.identityLabel, approved: s.identityCheck === "verified" };
  return { kind: "name", label: o.store.name || "Your business", approved: false };
}

const requestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

const STEPS = ["Choose customers", "Choose message", "Preview", "Send or schedule"] as const;
const KIND: Record<SmsCategory, { title: string; help: string }> = {
  transactional: { title: "A service message", help: "About an order or an appointment: it reaches customers your checkout told that updates come by text." },
  marketing: { title: "A marketing message", help: "An offer or news: only customers who agreed to SMS marketing in Shopify get it, with an opt-out link." },
};

const STAGE_TONE: Record<SmsStage, Tone> = {
  queued: "neutral",
  sending: "neutral",
  sent: "good",
  delivered: "good",
  failed: "danger",
  rejected: "danger",
  undeliverable: "danger",
  unknown: "warn",
  opted_out: "warn",
  not_sent: "neutral",
  cancelled: "neutral",
  practice: "neutral",
};
/** The order a send's figures are read in: how far it got, then how it ended. */
const STAGE_ORDER: SmsStage[] = ["queued", "sending", "sent", "delivered", "rejected", "undeliverable", "failed", "unknown", "opted_out", "not_sent", "cancelled", "practice"];

function StageCounts({ counts, labels }: { counts: Record<SmsStage, number>; labels: Partial<Record<SmsStage, string>> }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Where its texts are">
      {STAGE_ORDER.filter((s) => counts[s] > 0).map((s) => (
        <li key={s}>
          <Badge tone={STAGE_TONE[s]}>
            {labels[s] ?? s} · {counts[s]}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

const STAGE_WORDS: Record<SmsStage, string> = {
  queued: "Queued",
  sending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  rejected: "Rejected",
  undeliverable: "Undeliverable",
  unknown: "Unknown outcome",
  opted_out: "Opted out",
  not_sent: "Not sent",
  cancelled: "Cancelled",
  practice: "Practice run",
};

// ---------------------------------------------------------------------------
// One send, followed until every text has an outcome
// ---------------------------------------------------------------------------

function SendProgress({ base, sendId, initial, timeZone, onChanged }: { base: string; sendId: string; initial?: SendSummary; timeZone?: string; onChanged?: () => void }) {
  const [send, setSend] = useState<SendSummary | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await api<{ send: SendSummary }>(`${base}/sends/${sendId}`);
      setSend(r.send);
      setError(null);
    } catch (e) {
      setError(smsError(e, "load the send"));
    }
  }, [base, sendId]);
  useEffect(() => {
    if (!initial) void load();
  }, [initial, load]);
  // Follow it while texts wait or travel, and for a while after (delivery reports come later).
  const sentRecently = !!send && send.counts.sent > 0 && Date.now() - new Date(send.scheduledAt).getTime() < 10 * 60_000;
  const following = !!send && (!send.done || sentRecently);
  useEffect(() => {
    if (!following) return;
    const t = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(t);
  }, [following, load]);
  const cancel = async () => {
    setCancelling(true);
    try {
      const r = await api<{ send: SendSummary }>(`${base}/sends/${sendId}/cancel`, { method: "POST", body: {} });
      setSend(r.send);
      onChanged?.();
    } catch (e) {
      setError(smsError(e, "cancel the send"));
    } finally {
      setCancelling(false);
      setConfirm(false);
    }
  };
  if (!send) return error ? <Alert>{error}</Alert> : <div className="skeleton h-20" />;
  const scheduled = new Date(send.scheduledAt).getTime() > Date.now() + 60_000 && send.counts.queued > 0;
  return (
    <div className="space-y-3" data-testid="send-progress">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <strong>{send.templateName ?? "Message"}</strong>
        <span className="text-muted">
          to {plural(send.recipients, "customer")} · {scheduled ? `scheduled for ${fmtWhen(send.scheduledAt, timeZone)}` : `sent ${fmtWhen(send.createdAt, timeZone)}`} · by {send.createdBy}
        </span>
      </div>
      <StageCounts counts={send.counts} labels={STAGE_WORDS} />
      {send.practice && <p className="text-xs text-muted">Test mode: these texts were recorded, not sent to anyone.</p>}
      {following && <p className="text-xs text-muted">Updating as the SMS provider and the carriers report back…</p>}
      {error && <Alert>{error}</Alert>}
      {send.messages.length > 0 && (
        <ul className="max-h-64 divide-y divide-home-line overflow-y-auto rounded border border-home-line text-sm">
          {send.messages.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="font-mono">{m.to ?? "—"}</span>
              <span className="text-xs text-muted">{countryName(m.country)}</span>
              <span className="flex-1" />
              <span title={m.reasonLabel ?? undefined}>
                <Badge tone={STAGE_TONE[m.stage]}>{m.stageLabel}</Badge>
              </span>
              {m.reasonLabel && m.stage !== "delivered" && m.stage !== "sent" && <span className="basis-full text-xs text-muted">{m.reasonLabel}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Link className="btn-secondary" href="/messaging/history">
          Message History
        </Link>
        {send.counts.queued > 0 && (
          <button type="button" className="btn-secondary" onClick={() => setConfirm(true)} disabled={cancelling}>
            Cancel {plural(send.counts.queued, "waiting text")}
          </button>
        )}
      </div>
      <ConfirmDialog open={confirm} danger title="Cancel this send?" confirmLabel="Cancel the texts" busy={cancelling} onCancel={() => setConfirm(false)} onConfirm={() => void cancel()}>
        <p>The {plural(send.counts.queued, "text")} that haven&apos;t gone yet won&apos;t be sent. Texts already sent can&apos;t be called back.</p>
      </ConfirmDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The four steps, each on a numbered card as the Stitch design's screen 15 writes a new campaign
// (who, the message with its phone preview, the cost, when), with a yes asked before it goes.
// ---------------------------------------------------------------------------

/** Each step's heading on its numbered card, as the Stitch design's screen 15 numbers a new campaign's parts. */
const STEP_TITLE = ["Who gets it?", "What does it say?", "Check it", "When does it go?"] as const;

function Steps({ step, reachable, onGo }: { step: number; reachable: number; onGo: (i: number) => void }) {
  return (
    <nav aria-label="Send SMS steps" className="home-card animate-rise p-3 sm:p-4">
      <ol className="grid grid-cols-4 gap-1">
        {STEPS.map((s, i) => {
          const current = i === step;
          const done = i < step;
          return (
            <li key={s}>
              <button
                type="button"
                onClick={() => onGo(i)}
                disabled={i > reachable}
                aria-current={current ? "step" : undefined}
                className={`flex w-full flex-col items-center gap-1 rounded px-1 py-2 text-center text-[11px] transition outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 sm:text-xs ${current ? "bg-home-soft font-semibold text-text" : "text-muted hover:bg-home-soft hover:text-text"}`}
              >
                <span aria-hidden className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold tabular-nums ${done || current ? "bg-accent text-accent-ink" : "bg-home-tag text-text"}`}>
                  {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
                </span>
                <span className="leading-tight">{s}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function KindChoice({ value, onChange }: { value: SmsCategory; onChange: (k: SmsCategory) => void }) {
  return (
    <fieldset className="grid gap-2 sm:grid-cols-2">
      <legend className="label">What are you sending?</legend>
      {(["transactional", "marketing"] as const).map((k) => (
        <label key={k} className={`flex cursor-pointer gap-3 rounded-lg p-3 transition ${value === k ? "bg-accent/5 ring-2 ring-accent" : "bg-home-soft hover:bg-home-soft-hover"}`}>
          <input type="radio" name="send-kind" className="mt-1 accent-[var(--accent)]" checked={value === k} onChange={() => onChange(k)} />
          <span aria-hidden className={`flex h-9 w-9 shrink-0 items-center justify-center rounded ${value === k ? "bg-accent text-accent-ink" : "bg-surface text-accent"}`}>
            {k === "transactional" ? <PackageCheck className="h-5 w-5" /> : <Megaphone className="h-5 w-5" />}
          </span>
          <span className="min-w-0">
            <span className="block font-medium">{KIND[k].title}</span>
            <span className="block text-sm text-muted">{KIND[k].help}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function ChooseCustomers({ base, kind, chosen, setChosen }: { base: string; kind: SmsCategory; chosen: Map<string, SendCustomer>; setChosen: (m: Map<string, SendCustomer>) => void }) {
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setQ(typed.trim()), 300);
    return () => window.clearTimeout(t);
  }, [typed]);
  const list = useApi<{ customers: SendCustomer[]; more: boolean }>(`${base}/sends/customers?category=${kind}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  const shown = list.data?.customers ?? [];
  const full = chosen.size >= SMS_SEND_MAX_RECIPIENTS;
  const toggle = (c: SendCustomer) => {
    const next = new Map(chosen);
    if (next.has(c.id)) next.delete(c.id);
    else if (!full) next.set(c.id, c);
    setChosen(next);
  };
  const addAll = () => {
    const next = new Map(chosen);
    for (const c of shown) if (c.canReceive && next.size < SMS_SEND_MAX_RECIPIENTS) next.set(c.id, c);
    setChosen(next);
  };
  const can = shown.filter((c) => c.canReceive && !chosen.has(c.id)).length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[14rem] flex-1">
          <label className="label" htmlFor="send-q">
            Find customers by first name or the last digits of their number
          </label>
          <input id="send-q" className="input" placeholder="e.g. Sarah or 678" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </div>
        <button type="button" className="btn-secondary" onClick={addAll} disabled={!can || full}>
          Choose all {can || ""} shown who can get it
        </button>
      </div>
      <p className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
        <Users aria-hidden className="h-4 w-4 text-accent" />
        <strong data-testid="send-chosen">{plural(chosen.size, "customer")} chosen</strong>
        {chosen.size > 0 && (
          <button type="button" className="text-xs text-accent underline-offset-2 hover:underline" onClick={() => setChosen(new Map())}>
            Clear
          </button>
        )}
        {full && <span className="text-xs text-muted">That&apos;s the most for one send ({SMS_SEND_MAX_RECIPIENTS}): a bigger audience is a campaign.</span>}
      </p>
      {list.error ? (
        <LoadError what="your customers" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
      ) : !list.data ? (
        <div className="skeleton h-40" />
      ) : !shown.length ? (
        <p className="text-sm text-muted">{q ? "No customer matches that." : "No customers with a mobile number yet. They appear as Shopify orders and checkouts arrive."}</p>
      ) : (
        <ul className="max-h-80 divide-y divide-home-line overflow-y-auto rounded border border-home-line" aria-label="Customers">
          {shown.map((c) => {
            const on = chosen.has(c.id);
            return (
              <li key={c.id}>
                <label className={`flex items-center gap-3 px-3 py-2 text-sm ${c.canReceive ? "cursor-pointer hover:bg-home-soft" : "cursor-not-allowed opacity-60"}`}>
                  <input type="checkbox" className="accent-[var(--accent)]" checked={on} disabled={!c.canReceive || (!on && full)} onChange={() => toggle(c)} aria-label={`${c.name ?? "Customer"}, ${c.number}`} />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{c.name ?? "No name"}</span> <span className="font-mono text-muted">{c.number}</span>
                    <span className="block truncate text-xs text-muted">
                      {countryName(c.country)} · SMS marketing: {c.consentLabel.toLowerCase()} · {plural(c.orders, "order")}
                      {!c.canReceive && c.reasonLabel ? ` · Can't get it: ${c.reasonLabel.toLowerCase()}` : ""}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {list.data?.more && <p className="text-xs text-muted">Showing the 50 most recent: search to find others.</p>}
    </div>
  );
}

/** The details a message can carry, as buttons to insert them. */
function variablesFor(kind: SmsCategory, recipients: number): SmsVariable[] {
  const typed: readonly SmsVariable[] = recipients > 1 ? SEND_VALUES_MANY : SEND_VALUES_ONE;
  const base: SmsVariable[] = ["customer_name", "business_name", "date", ...typed];
  return kind === "marketing" ? [...base, "opt_out_url"] : base.filter((v) => v !== "discount_code");
}

function ChooseMessage({
  kind,
  templates,
  recipients,
  draft,
  setDraft,
}: {
  kind: SmsCategory;
  templates: SmsTemplate[];
  recipients: number;
  draft: Draft;
  setDraft: (d: Draft) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const saved = templates.filter((t) => sendable(t) && t.category === kind);
  const body = draft.mode === "saved" ? (saved.find((t) => t.id === draft.templateId)?.approvedBody ?? "") : draft.body;
  const used = templateVariables(body).used;
  const typed = (recipients > 1 ? SEND_VALUES_MANY : SEND_VALUES_ONE).filter((v) => used.includes(v));
  const seg = smsSegments(previewSms(body));
  const worst = worstCaseSegments(body);
  const insert = (v: SmsVariable) => {
    const el = ref.current;
    const token = `{{${v}}}`;
    const start = el?.selectionStart ?? draft.body.length;
    const end = el?.selectionEnd ?? draft.body.length;
    setDraft({ ...draft, body: draft.body.slice(0, start) + token + draft.body.slice(end) });
    window.setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <div className="space-y-4">
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">Saved or new message</legend>
        {(["saved", "new"] as const).map((m) => (
          <label key={m} className={`inline-flex h-9 cursor-pointer items-center gap-2 rounded px-3 text-[13px] font-medium transition ${draft.mode === m ? "bg-accent/5 ring-2 ring-accent" : "bg-home-soft hover:bg-home-soft-hover"}`}>
            <input type="radio" name="message-mode" className="accent-[var(--accent)]" checked={draft.mode === m} onChange={() => setDraft({ ...draft, mode: m })} />
            {m === "saved" ? "Use a saved message" : "Write a new message"}
          </label>
        ))}
      </fieldset>
      {draft.mode === "saved" ? (
        <TemplatePicker
          label={`Approved ${kind === "marketing" ? "marketing" : "service"} message`}
          templates={saved}
          value={draft.templateId}
          onChange={(id) => setDraft({ ...draft, templateId: id })}
          empty={<>None approved yet: write a new message instead.</>}
        />
      ) : (
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="send-name">
              Name (saved with your messages, to use again)
            </label>
            <input id="send-name" className="input" maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="send-body">
              Message
            </label>
            <textarea id="send-body" ref={ref} className="input min-h-[7rem]" maxLength={2000} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Personalize">
              {variablesFor(kind, recipients).map((v) => (
                <button key={v} type="button" className="rounded bg-home-tag px-2.5 py-1 text-xs font-medium transition outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent" onClick={() => insert(v)}>
                  + {SMS_VARIABLE_INFO[v].label}
                </button>
              ))}
            </div>
            {kind === "marketing" && !draft.body.includes("{{opt_out_url}}") && <p className="mt-1 text-xs text-muted">Marketing messages must carry the opt-out link: add it with + Opt-out link.</p>}
          </div>
        </div>
      )}
      {body && (
        <p className="text-sm tabular-nums" aria-live="polite">
          {seg.characters} characters · {plural(seg.segments, "SMS part")}
          {worst.segments > seg.segments ? ` (up to ${worst.segments} with long names or links)` : ""}
        </p>
      )}
      {Math.max(seg.segments, worst.segments) > 1 && (
        <Alert kind="info">
          This message is split into {Math.max(seg.segments, worst.segments)} SMS parts{seg.encoding === "UCS2" ? " (it has special characters, so each part holds 70)" : ""}. Each part is billed as one text.
        </Alert>
      )}
      {typed.length > 0 && (
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="label">Details for this message</legend>
          {typed.map((v) => (
            <div key={v}>
              <label className="text-xs text-muted" htmlFor={`sv-${v}`}>
                {SMS_VARIABLE_INFO[v].label}
              </label>
              <input id={`sv-${v}`} className="input" maxLength={SMS_VARIABLE_INFO[v].maxLength} placeholder={SMS_VARIABLE_INFO[v].sample} value={draft.values[v] ?? ""} onChange={(e) => setDraft({ ...draft, values: { ...draft.values, [v]: e.target.value } })} />
            </div>
          ))}
        </fieldset>
      )}
    </div>
  );
}

interface Draft {
  mode: "saved" | "new";
  templateId: string;
  name: string;
  body: string;
  values: Partial<Record<SmsVariable, string>>;
}

const newDraft = (): Draft => ({
  mode: "saved",
  templateId: "",
  name: `Message ${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date())}`,
  body: "",
  values: {},
});

/** A datetime-local value for now + `minutes`, in the browser's time. */
function localInput(minutes: number): string {
  const d = new Date(Date.now() + minutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function SendWizard({ base, templates, timeZone, sender, onSent }: { base: string; templates: SmsTemplate[]; timeZone?: string; sender: PreviewSender; onSent: () => void }) {
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<SmsCategory>("transactional");
  const [chosen, setChosen] = useState<Map<string, SendCustomer>>(new Map());
  const [draft, setDraft] = useState<Draft>(newDraft);
  const [preview, setPreview] = useState<SendPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [when, setWhen] = useState<"now" | "later">("now");
  const [at, setAt] = useState(() => localInput(60));
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<SendSummary | null>(null);
  // One per press of Send: a retried request finds the send already made.
  const pressId = useRef(requestId());

  const ids = useMemo(() => [...chosen.keys()], [chosen]);
  const message = draft.mode === "saved" ? { templateId: draft.templateId } : { message: { name: draft.name.trim(), category: kind, body: draft.body } };
  const values = Object.fromEntries(Object.entries(draft.values).filter(([, v]) => v?.trim()));
  const scheduledAt = when === "later" && at ? new Date(at).toISOString() : null;
  const messageReady = draft.mode === "saved" ? !!draft.templateId : !!draft.body.trim() && !!draft.name.trim();
  const reachable = !chosen.size ? 0 : !messageReady ? 1 : !preview ? 2 : 3;

  const loadPreview = async () => {
    setPreviewing(true);
    setError(null);
    try {
      setPreview(await api<SendPreview>(`${base}/sends/preview`, { method: "POST", body: { contactIds: ids, ...message, values, scheduledAt } }));
      setStep(2);
    } catch (e) {
      setError(smsError(e, "check the message"));
    } finally {
      setPreviewing(false);
    }
  };
  // Changing customers or the message invalidates the review.
  useEffect(() => setPreview(null), [chosen, draft, kind]);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ send: SendSummary }>(`${base}/sends`, { method: "POST", body: { requestId: pressId.current, contactIds: ids, ...message, values, scheduledAt } });
      setSent(r.send);
      pressId.current = requestId();
      onSent();
    } catch (e) {
      setError(smsError(e, "send the texts"));
      // A refusal is final for this press: the next one is a new request.
      pressId.current = requestId();
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  const restart = () => {
    setSent(null);
    setChosen(new Map());
    setDraft(newDraft());
    setPreview(null);
    setWhen("now");
    setStep(0);
  };

  if (sent) {
    return (
      <section className="home-card animate-rise space-y-3 p-5 sm:p-6" aria-labelledby="sent-h">
        <h2 id="sent-h" className="home-h2 flex items-center gap-2">
          <Check aria-hidden className="h-5 w-5 text-good" /> {sent.practice ? "Recorded in test mode" : new Date(sent.scheduledAt).getTime() > Date.now() + 60_000 ? "Send scheduled" : "Sending"}
        </h2>
        <SendProgress base={base} sendId={sent.id} initial={sent} timeZone={timeZone} onChanged={onSent} />
        <button type="button" className="btn-primary" onClick={restart}>
          Send another message
        </button>
      </section>
    );
  }

  const blocked = !!preview && (preview.blockers.length > 0 || preview.issues.some((i) => i.level === "error") || preview.recipients.sending === 0);
  return (
    <section className="space-y-4" aria-label="Send SMS">
      <Steps step={step} reachable={reachable} onGo={(i) => (i === 2 ? void loadPreview() : setStep(i))} />
      <StepCard id="send-step" n={step + 1} title={STEP_TITLE[step] ?? ""} aside={`Step ${step + 1} of ${STEPS.length}`}>
      {step === 0 && (
        <div className="space-y-4">
          <p className="text-sm text-muted">Choose up to {SMS_SEND_MAX_RECIPIENTS} customers. Each one is checked for consent and opt-outs now, and again right before their text goes.</p>
          <KindChoice value={kind} onChange={(k) => (setKind(k), setChosen(new Map()), setDraft({ ...draft, templateId: "" }))} />
          <ChooseCustomers base={base} kind={kind} chosen={chosen} setChosen={setChosen} />
        </div>
      )}
      {step === 1 && (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {KIND[kind].title} to {plural(chosen.size, "customer")}. Personal details are filled in for each customer.
          </p>
          <ChooseMessage kind={kind} templates={templates} recipients={chosen.size} draft={draft} setDraft={setDraft} />
        </div>
      )}
      {step === 2 && preview && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 space-y-3">
            <p className="text-sm text-muted">As {preview.recipients.sending ? "the first customer" : "a customer"} will read it.</p>
            {preview.blockers.map((b) => (
              <Alert key={b.code}>
                {b.message}{" "}
                {b.fix && (
                  <Link className="underline" href={b.fix.href}>
                    {b.fix.label}
                  </Link>
                )}
              </Alert>
            ))}
            {preview.issues.map((i) => (
              <Alert key={i.code} kind={i.level === "error" ? "error" : "info"}>
                {i.message}
              </Alert>
            ))}
            <ul className="space-y-1.5 rounded bg-home-soft px-4 py-3 text-sm">
              <li className="flex items-center gap-2 font-medium" data-testid="send-going">
                <Check aria-hidden className="h-4 w-4 text-good" /> {plural(preview.recipients.sending, "customer")} will get it
              </li>
              {preview.recipients.notSending.map((r) => (
                <li key={r.reason} className="flex items-start gap-2 text-muted">
                  <span aria-hidden>✕</span> {r.count} won&apos;t: {r.label?.toLowerCase()}
                </li>
              ))}
              {preview.recipients.notFound > 0 && <li className="text-muted">{preview.recipients.notFound} chosen customers aren&apos;t here any more.</li>}
              {preview.recipients.quietHours > 0 && (
                <li className="flex items-start gap-2 text-muted">
                  <Clock aria-hidden className="mt-0.5 h-4 w-4" /> {preview.recipients.quietHours} would get it in their quiet hours: their texts wait until those end.
                </li>
              )}
            </ul>
            <p className="rounded bg-home-soft px-4 py-3 text-sm text-muted">
              {preview.cost.estimatedUsd > 0 ? `About ${fmtUsd(preview.cost.estimatedUsd)} (estimated, US dollars)` : "No price is known yet for these countries"}
              {preview.cost.unpricedRecipients > 0 && preview.cost.estimatedUsd > 0 ? `, plus ${preview.cost.unpricedRecipients} texts without a known price` : ""}.
              {preview.limit ? ` This month: ${fmtUsd(preview.limit.usedUsd)} of your ${fmtUsd(preview.limit.monthlyUsd)} messaging limit used.` : ""}
            </p>
          </div>
          <PhonePreview sender={sender} text={preview.text} segments={preview.segments} worstParts={preview.worst.segments} />
        </div>
      )}
      {step === 3 && preview && (
        <div className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="sr-only">When</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="send-when" className="accent-[var(--accent)]" checked={when === "now"} onChange={() => setWhen("now")} /> Send now
            </label>
            <label className="flex flex-wrap items-center gap-2 text-sm">
              <input type="radio" name="send-when" className="accent-[var(--accent)]" checked={when === "later"} onChange={() => setWhen("later")} /> Schedule for
              <input type="datetime-local" className="input w-auto" aria-label="Date and time to send" value={at} min={localInput(5)} max={localInput(60 * 24 * 60)} onChange={(e) => (setWhen("later"), setAt(e.target.value))} />
            </label>
            <p className="text-xs text-muted">Times are your computer&apos;s. Quiet hours still apply in each customer&apos;s own time zone. You can cancel a scheduled send until its texts go.</p>
          </fieldset>
          <TextBubble>{preview.text}</TextBubble>
          <p className="rounded bg-home-soft px-4 py-3 text-sm">
            {KIND[preview.category].title} to <strong>{plural(preview.recipients.sending, "customer")}</strong>, {when === "now" ? "now" : `on ${fmtWhen(scheduledAt, timeZone)}`}.
          </p>
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap justify-between gap-2 border-t border-home-line pt-4">
        <button type="button" className="btn-secondary" disabled={step === 0} onClick={() => setStep(step - 1)}>
          Back
        </button>
        {step < 2 && (
          <button type="button" className="btn-primary" disabled={(step === 0 && !chosen.size) || (step === 1 && (!messageReady || previewing))} onClick={() => (step === 0 ? setStep(1) : void loadPreview())}>
            {step === 1 ? (previewing ? "Checking…" : "Preview message") : "Next"}
          </button>
        )}
        {step === 2 && (
          <button type="button" className="btn-primary" disabled={blocked} onClick={() => setStep(3)}>
            Next
          </button>
        )}
        {step === 3 && (
          <button type="button" className="btn-primary inline-flex items-center gap-2" disabled={busy || blocked || (when === "later" && !at)} onClick={() => setConfirm(true)}>
            <Send aria-hidden className="h-4 w-4" /> {when === "now" ? "Send SMS" : "Schedule SMS"}
          </button>
        )}
      </div>
      </StepCard>
      <ConfirmDialog
        open={confirm}
        title={when === "now" ? `Text ${plural(preview?.recipients.sending ?? 0, "customer")} now?` : "Schedule these texts?"}
        confirmLabel={when === "now" ? "Send" : "Schedule"}
        busy={busy}
        onCancel={() => setConfirm(false)}
        onConfirm={() => void send()}
      >
        <p>Each text goes only if the customer can still get it at that moment (consent, opt-outs, quiet hours, your monthly limit).</p>
        {draft.mode === "new" && <p>Your new message is saved and approved in your name.</p>}
        <p>A text can&apos;t be called back once it is sent.</p>
      </ConfirmDialog>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Earlier sends, and a test to the team's own phone
// ---------------------------------------------------------------------------

function RecentSends({ base, timeZone, version }: { base: string; timeZone?: string; version: number }) {
  const list = useApi<{ sends: SendSummary[] }>(`${base}/sends?v=${version}`);
  const [open, setOpen] = useState<string | null>(null);
  if (list.error) return <LoadError what="your sends" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />;
  if (!list.data) return <Skeleton lines={2} />;
  if (!list.data.sends.length) return null;
  return (
    <section className="home-card animate-rise p-5 sm:p-6" aria-labelledby="recent-h">
      <h2 id="recent-h" className="home-h2">
        Your sends
      </h2>
      <ul className="mt-3 divide-y divide-home-line">
        {list.data.sends.map((s) => (
          <li key={s.id} className="py-3">
            <button type="button" className="flex w-full flex-wrap items-center gap-2 rounded-sm text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>
              <strong>{s.templateName ?? "Message"}</strong>
              <span className="text-muted">
                {plural(s.recipients, "customer")} · {fmtWhen(new Date(s.scheduledAt) > new Date() ? s.scheduledAt : s.createdAt, timeZone)} · {s.createdBy}
              </span>
              <span className="flex-1" />
              <StageCounts counts={s.counts} labels={STAGE_WORDS} />
            </button>
            {open === s.id && (
              <div className="mt-3">
                <SendProgress base={base} sendId={s.id} timeZone={timeZone} onChanged={() => void list.reload()} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
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
      const r = await api<{ message: SmsMessage }>(`${base}/templates/${templateId}/test`, { method: "POST", body: { testNumberId: numberId, requestId: requestId() } });
      setResult(r.message);
    } catch (e) {
      setError(smsError(e, "send the test"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="home-card animate-rise p-5 sm:p-6" open={!!new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).get("template") || undefined}>
      <summary className="home-h2 cursor-pointer">Send yourself a test</summary>
      <p className="mt-1 text-sm text-muted">Text a message&apos;s latest version, approved or not, to one of your team&apos;s approved test recipients, with sample details. Customers never get tests.</p>
      {numbers.error ? (
        <div className="mt-3">
          <LoadError what="your test recipients" error={numbers.error} onRetry={() => void numbers.reload()} busy={numbers.loading} />
        </div>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <TemplatePicker label="Message to test" templates={options} value={templateId} onChange={setTemplateId} empty={<Link className="text-accent underline" href="/messaging/templates">Write a message first.</Link>} />
          <div>
            <label className="label" htmlFor="test-number">
              Test recipient
            </label>
            <select id="test-number" className="input" value={numberId} onChange={(e) => setNumberId(e.target.value)} disabled={!verified.length}>
              <option value="">{numbers.data ? (verified.length ? "Choose a number…" : "No approved test recipient") : "Loading…"}</option>
              {verified.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.number} {n.country ? `(${countryName(n.country)})` : ""}
                </option>
              ))}
            </select>
            {numbers.data && !verified.length && (
              <p className="mt-1 text-xs text-muted">
                Add one in{" "}
                <Link className="text-accent underline" href="/messaging/settings#test-recipients">
                  Settings
                </Link>
                .
              </p>
            )}
          </div>
        </div>
      )}
      {chosen?.body && (
        <div className="mt-3">
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
      {result && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm" role="status">
          <SmsStatusBadge status={result.status} label={result.statusLabel} /> {result.reasonLabel ?? (result.status === "accepted" ? "Sent: the delivery report shows in Message History when the carrier answers." : "")}
        </p>
      )}
    </details>
  );
}

/** Send SMS: choose customers, choose or write the message, check it, send now or schedule it; then follow it. */
export function SendSms() {
  const { base, manage, contact, store } = useSms();
  const templates = useApi<{ templates: SmsTemplate[] }>(base ? `${base}/templates` : null);
  const overview = useApi<SmsOverview>(base);
  const [version, setVersion] = useState(0);
  const error = templates.error ?? overview.error;
  if (error) return <LoadError what="Send SMS" error={error} onRetry={() => void Promise.all([templates.reload(), overview.reload()])} />;
  if (!base || !templates.data || !overview.data) return <Skeleton lines={5} />;
  const timeZone = store?.timezone;
  return (
    <div className="space-y-4">
      <PageHeader title="Send SMS" sub="Choose customers, choose or write a message, check it, then send it now or schedule it. Every text is checked for consent and opt-outs right before it goes." />
      <ModeBanner mode={overview.data.mode} />
      {overview.data.mode === "live" && overview.data.readiness.testMode && (
        <Alert kind="info">
          <strong>Your SMS account is still being verified.</strong> Until it is, texts only reach your approved test recipients: sending to customers opens once it is done.{" "}
          <Link className="underline" href="/messaging/settings">
            View setup requirements
          </Link>
        </Alert>
      )}
      {!manage ? (
        <div className="home-card p-5 text-sm text-muted">Only owners and admins can send texts. You can see what was sent in Message History.</div>
      ) : !contact ? (
        <div className="home-card p-5 text-sm text-muted">Sending to customers needs &ldquo;View contact information&rdquo; in Team &amp; Access, since it shows their (masked) numbers.</div>
      ) : (
        <>
          <SendWizard base={base} templates={templates.data.templates} timeZone={timeZone} sender={senderOf(overview.data)} onSent={() => setVersion((v) => v + 1)} />
          <RecentSends base={base} timeZone={timeZone} version={version} />
          <SendTest base={base} templates={templates.data.templates} />
        </>
      )}
    </div>
  );
}
