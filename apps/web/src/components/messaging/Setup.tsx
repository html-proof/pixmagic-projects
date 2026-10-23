"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, CircleAlert, Cloud, Info, Lock, MessageSquareText } from "lucide-react";
import { callingCode, normalizePhone, PHONE_COUNTRIES } from "@app/shared/whatsapp";
import {
  checkSenderName,
  checkTemplate,
  fixVariableAliases,
  missingForTrigger,
  ORDER_STATUS_WORD,
  previewSms,
  SENDER_ID_SUPPORT,
  SENDER_NAME_MAX,
  SETUP_DEFAULT_BUDGET_USD,
  SETUP_FIRST_MESSAGE,
  SETUP_STEPS,
  SETUP_VARIABLES,
  SMS_VARIABLE_INFO,
  smsSegments,
  suggestSenderName,
  TRIGGER_INFO,
  worstCaseSegments,
  type SetupStep,
  type SmsTransactionalBasis,
  type SmsTrigger,
  type SmsVariable,
} from "@app/shared/sms";
import { ConfirmDialog, Skeleton, useToast } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge, type Tone } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { COUNTRY_CHOICES, countryName, fmtHour, fmtWhen, ModeBanner, smsError, SmsStatusBadge, useSms } from "./MessagingUi";
import { PhonePreview, type PreviewSender } from "./PhonePreview";
import type { SmsMessage, SmsSetupState } from "./types";

// ---------------------------------------------------------------------------
// Set up SMS: five steps for a merchant who knows nothing about AWS (connect, sender name,
// message, test, automatic texts), next to a phone showing what customers will get. Every button
// is the API's (apps/api/src/routes/smsSetup.ts); nothing here claims more than the API says.
// ---------------------------------------------------------------------------

const STEP_LABEL: Record<SetupStep, string> = {
  connect: "Connect",
  sender: "Sender name",
  message: "Message",
  test: "Test SMS",
  automate: "Automatic SMS",
};

/** What a customer sees in the preview for each variable (the prompt's example: Sarah's order #1042). */
const PREVIEW_VALUES = { customer_name: "Sarah", order_number: "#1042", order_total: "89.95", product_name: "Linen Shirt" } as const;

export const SENDER_STATUS: Record<string, { tone: Tone; label: string; help: string }> = {
  draft: { tone: "neutral", label: "Not requested", help: "Request it when you're happy with the name. Nothing is sent to anyone until it is approved." },
  requested: {
    tone: "warn",
    label: "Requested",
    help: "bizinsights has your request and sets the name up with AWS, registering it where your customers' country requires that. Press Check status any time: it turns Approved only once AWS confirms it.",
  },
  pending: { tone: "warn", label: "Pending approval", help: "AWS has the name for you; the country's registration isn't approved yet. Texts can't use it until it is." },
  approved: { tone: "good", label: "Approved", help: "AWS confirms the name is set up for your store. Your texts use it." },
  needs_changes: { tone: "danger", label: "Needs changes", help: "The registration was sent back or closed. Contact bizinsights support to see what the regulator asked for." },
  unavailable: { tone: "danger", label: "Not available", help: "Another business already has this name. Choose a different one." },
};

const CONNECTION: Record<SmsSetupState["connection"]["status"], { tone: Tone; label: string }> = {
  not_connected: { tone: "neutral", label: "Not connected" },
  connected: { tone: "good", label: "Connected" },
  failed: { tone: "danger", label: "Connection failed" },
  disconnected: { tone: "neutral", label: "Not connected" },
};

const CONNECTION_ERROR: Record<string, { what: string; fix: string }> = {
  platform_off: { what: "SMS isn't switched on for bizinsights yet.", fix: "Nothing to fix on your side: bizinsights switches SMS on platform-wide. You can still prepare your sender name and messages." },
  not_configured: { what: "This bizinsights environment has no SMS provider.", fix: "Contact bizinsights support." },
  aws_unreachable: { what: "AWS didn't answer.", fix: "Usually brief. Try Connect again in a few minutes." },
};

const BASIS: Record<Exclude<SmsTransactionalBasis, "none">, { label: string; help: string }> = {
  checkout_notice: {
    label: "My checkout tells customers order updates come by text",
    help: "Customers who leave a mobile number at checkout get order updates. You confirm your checkout says so; bizinsights records who chose this and when.",
  },
  sms_consent: { label: "Only customers subscribed to my SMS in Shopify", help: "Only customers who ticked SMS marketing in Shopify get order updates." },
};

/** Suggested fixes for a test text that didn't arrive, by AWS's delivery status or bizinsights' reason. */
const TEST_FIX: Record<string, string> = {
  destination_not_verified: "In test mode AWS only texts numbers verified with a code: verify this number first.",
  sandbox_unverified: "In test mode AWS only texts numbers verified with a code: verify this number first.",
  invalid_number: "Check the number and its country.",
  INVALID: "Check the number and its country.",
  UNREACHABLE: "Make sure the phone is on and has signal, then try again in a few minutes.",
  CARRIER_UNREACHABLE: "The phone's network had a problem. Try again in a few minutes.",
  BLOCKED: "The phone blocks texts from this sender. Check the phone's blocked senders and spam filter.",
  CARRIER_BLOCKED: "The carrier blocked it. Carriers block unregistered sender names: check your sender name's approval in step 2.",
  SPAM: "The carrier treated it as spam. Avoid link shorteners and say who you are in the message.",
  UNROUTABLE: "AWS can't reach this country from your sender. Contact bizinsights support.",
  country_blocked: "AWS can't reach this country from your sender. Contact bizinsights support.",
  TTL_EXPIRED: "It couldn't be delivered in time. Try again later.",
  account_limit: "bizinsights' monthly SMS limit is reached. Contact bizinsights support.",
  aws_spend_limit: "AWS's monthly SMS limit is reached. Contact bizinsights support.",
  sender_not_ready: "Your sender isn't ready: finish step 2.",
  sender_not_found: "AWS doesn't have your sender any more: check step 2.",
  sender_not_allowed: "Your sender isn't set up for your store: check step 2.",
  over_max_price: "Texts to this country cost more than bizinsights allows per text. Contact bizinsights support.",
};

const LIVE = new Set(["scheduled", "sending", "accepted", "pending"]);

/** A fresh id for one press of a button (the API returns the same text for a repeat of it). */
const requestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

/** The countries the setup offers, by name: those AWS's sender-name rules are known for, and the usual ones. */
const SETUP_COUNTRIES = [...new Set([...COUNTRY_CHOICES, ...Object.keys(SENDER_ID_SUPPORT)])].sort((a, b) => countryName(a).localeCompare(countryName(b)));

function StepHeader({ n, title, question, children }: { n: number; title: string; question?: string; children?: ReactNode }) {
  return (
    <header className="space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-accent">
        Step {n} of {SETUP_STEPS.length}
      </p>
      <h2 className="text-xl font-semibold">{title}</h2>
      {question && <p className="text-base">{question}</p>}
      {children && <div className="text-sm text-muted">{children}</div>}
    </header>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 rounded-lg border border-border bg-bg/60 p-3 text-sm text-muted">
      <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
      <span>{children}</span>
    </p>
  );
}

/** The progress across the top: each step done, current or to do; any step can be opened. */
function Progress({ step, done, onGo }: { step: SetupStep; done: Record<SetupStep, boolean>; onGo: (s: SetupStep) => void }) {
  const count = SETUP_STEPS.filter((s) => done[s]).length;
  return (
    <nav aria-label="Setup steps" className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted">
        <span>
          {count} of {SETUP_STEPS.length} done
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-bg" aria-hidden>
        <div className="h-1.5 rounded-full bg-accent transition-all" style={{ width: `${(count / SETUP_STEPS.length) * 100}%` }} />
      </div>
      <ol className="grid grid-cols-5 gap-1">
        {SETUP_STEPS.map((s, i) => {
          const current = s === step;
          return (
            <li key={s}>
              <button
                type="button"
                onClick={() => onGo(s)}
                aria-current={current ? "step" : undefined}
                className={`flex w-full flex-col items-center gap-1 rounded-lg px-1 py-2 text-center text-[11px] transition sm:text-xs ${current ? "bg-accent/10 font-semibold text-text" : "text-muted hover:bg-bg hover:text-text"}`}
              >
                <span
                  aria-hidden
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${done[s] ? "bg-good text-white" : current ? "bg-accent text-accent-ink" : "border border-border bg-surface"}`}
                >
                  {done[s] ? <Check className="h-4 w-4" strokeWidth={3} /> : i + 1}
                </span>
                <span className="leading-tight">
                  {STEP_LABEL[s]}
                  <span className="sr-only">{done[s] ? " (done)" : current ? " (current step)" : ""}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The message editor: a big text box and a button per variable, inserted where the cursor is. */
function MessageEditor({ id, value, onChange, trigger, disabled }: { id: string; value: string; onChange: (v: string) => void; trigger: SmsTrigger; disabled: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const can = new Set<SmsVariable>([...TRIGGER_INFO[trigger].variables, "store_name", "business_name"]);
  const insert = (v: SmsVariable) => {
    const el = ref.current;
    const token = `{{${v}}}`;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const issues = checkTemplate({ category: "transactional", body: value });
  const missing = missingForTrigger(value, trigger);
  const fixed = fixVariableAliases(value);
  const worst = worstCaseSegments(value);
  return (
    <div className="space-y-2">
      <textarea
        id={id}
        ref={ref}
        className="input min-h-[8.5rem] text-base leading-relaxed"
        maxLength={1000}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={`${id}-vars ${id}-issues`}
      />
      <div id={`${id}-vars`} className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Insert a detail">
        <span className="text-xs text-muted">Insert:</span>
        {SETUP_VARIABLES.map((v) => {
          const ok = can.has(v);
          return (
            <button
              key={v}
              type="button"
              className="rounded-full border border-border px-2.5 py-1 text-xs transition hover:border-accent hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={disabled || !ok}
              title={ok ? SMS_VARIABLE_INFO[v].description : `Not in this message: ${TRIGGER_INFO[trigger].label} texts have no ${SMS_VARIABLE_INFO[v].label.toLowerCase()}.`}
              onClick={() => insert(v)}
            >
              {SMS_VARIABLE_INFO[v].label}
            </button>
          );
        })}
        <button type="button" className="rounded-full border border-dashed border-border px-2.5 py-1 text-xs opacity-50" disabled title="Shopify doesn't record appointments, so there is no appointment date to fill in.">
          Appointment date
        </button>
      </div>
      <div id={`${id}-issues`} className="space-y-1 text-xs" aria-live="polite">
        {fixed !== value && (
          <p className="text-warn">
            Some details are written differently from how bizinsights names them.{" "}
            <button type="button" className="font-medium underline" disabled={disabled} onClick={() => onChange(fixed)}>
              Fix them
            </button>
          </p>
        )}
        {issues
          .filter((i) => i.code !== "no_sender_name")
          .map((i) => (
            <p key={i.code} className={i.level === "error" ? "text-danger" : "text-muted"}>
              {i.message}
            </p>
          ))}
        {missing.length > 0 && (
          <p className="text-danger">
            {TRIGGER_INFO[trigger].label} texts have no {missing.map((m) => SMS_VARIABLE_INFO[m].label.toLowerCase()).join(" or ")}: take {missing.length === 1 ? "it" : "them"} out.
          </p>
        )}
        {value.trim() && worst.segments > 1 && <p className="text-muted">Long names can make this {worst.segments} SMS parts; each part is billed.</p>}
      </div>
    </div>
  );
}

/** The setup. `initialStep` comes from ?step= (SMS Settings links to a step). */
export function SmsSetup() {
  const { base, manage, store } = useSms();
  const router = useRouter();
  const toast = useToast();
  const path = base ? `${base}/setup` : null;
  const { data, error, reload, loading, setData } = useApi<SmsSetupState>(path);
  const [step, setStep] = useState<SetupStep | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Drafts, filled from the API once.
  const [business, setBusiness] = useState("");
  const [country, setCountry] = useState("");
  const [senderName, setSenderName] = useState("");
  const [message, setMessage] = useState("");
  const [budget, setBudget] = useState("");
  const [basis, setBasis] = useState<SmsTransactionalBasis>("none");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ kind: "automation"; trigger: SmsTrigger } | { kind: "master"; on: boolean } | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (!data || loaded.current) return;
    loaded.current = true;
    setBusiness(data.businessName ?? "");
    setCountry(data.senderName.country ?? "");
    setSenderName(data.senderName.name ?? "");
    setMessage(data.message);
    // No limit saved yet (or 0, which sends nothing): the field suggests one, saved only when the merchant saves it.
    setBudget(data.sending.monthlyBudgetUsd ? String(data.sending.monthlyBudgetUsd) : String(SETUP_DEFAULT_BUDGET_USD));
    setBasis(data.sending.transactionalBasis);
    const fromUrl = new URLSearchParams(window.location.search).get("step");
    setStep((SETUP_STEPS as readonly string[]).includes(fromUrl ?? "") ? (fromUrl as SetupStep) : data.step);
  }, [data]);

  const current: SetupStep = step ?? data?.step ?? "connect";
  const index = SETUP_STEPS.indexOf(current);
  const businessShown = business.trim() || data?.defaultBusinessName || "";
  const nameCheck = useMemo(() => checkSenderName(senderName, country || null), [senderName, country]);

  // What the phone shows: the message being edited (step 5: the automation open), with this store's names.
  const previewTrigger: SmsTrigger = current === "automate" && editing ? (editing as SmsTrigger) : "order_created";
  const previewBody = current === "automate" && editing ? (edits[editing] ?? data?.automations.find((a) => a.key === editing)?.body ?? "") : message;
  const previewText = previewSms(previewBody, { ...PREVIEW_VALUES, business_name: businessShown, store_name: data?.defaultBusinessName, order_status: ORDER_STATUS_WORD[previewTrigger] ?? "confirmed" });
  const sender: PreviewSender = useMemo(() => {
    if (data?.sender?.identityCheck === "verified" && data.sender.identityLabel) return { kind: data.sender.senderType === "sender_id" ? "name" : "number", label: data.sender.identityLabel, approved: true };
    if (data && nameCheck.support === "none") return { kind: "number", label: "Phone number", approved: false };
    return { kind: "name", label: senderName.trim() || businessShown.slice(0, SENDER_NAME_MAX) || "Your name", approved: false };
  }, [data, nameCheck.support, senderName, businessShown]);

  if (error) return <LoadError what="SMS setup" error={error} onRetry={() => void reload()} busy={loading} />;
  if (!data || !base) return <Skeleton lines={8} />;

  const draftBody = () => ({ step: current, businessName: business.trim() || null, senderName: senderName.trim() || null, country: country || null, message });

  /** One call to the API, its answer shown; a refusal in the API's words. */
  const run = async (key: string, what: string, fn: () => Promise<SmsSetupState | null | void>, done?: string) => {
    setBusy(key);
    setProblem(null);
    try {
      const next = await fn();
      if (next) setData(next);
      if (done) toast("success", done);
      return true;
    } catch (e) {
      setProblem(smsError(e, what));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const saveDraft = (extra: Record<string, unknown> = {}) => api<SmsSetupState>(`${base}/setup`, { method: "PUT", body: { ...draftBody(), ...extra } });
  const go = (s: SetupStep) => {
    setStep(s);
    setProblem(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (manage) void saveDraft({ step: s }).then(setData, () => undefined);
  };

  const next = async () => {
    const after = SETUP_STEPS[index + 1];
    if (!manage) return after && go(after);
    if (current === "message") {
      const ok = await run("next", "save the message", async () => (await api<{ setup: SmsSetupState }>(`${base}/setup/message`, { method: "POST", body: { body: message } })).setup, "Message saved.");
      if (!ok) return;
    } else if (current === "sender") {
      const ok = await run("next", "save", () => saveDraft());
      if (!ok) return;
    }
    if (after) go(after);
    else router.push("/messaging/settings");
  };

  const continueLater = () =>
    void run("later", "save your setup", () => saveDraft()).then((ok) => {
      if (ok) {
        toast("success", "Saved. Pick up where you left off from Set up SMS.");
        router.push("/messaging");
      }
    });

  const readOnly = !manage;
  const s = data.senderName;
  const statusInfo = SENDER_STATUS[s.status] ?? SENDER_STATUS.draft!;
  const nameDirty = (senderName.trim() || null) !== s.name || (country || null) !== (s.countryChosen ? s.country : null);
  const senderReady = data.sender?.identityCheck === "verified";

  return (
    <div className="space-y-4">
      <section className="card animate-rise space-y-4" aria-labelledby="setup-h">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 id="setup-h" className="flex items-center gap-2 text-lg font-semibold">
              <MessageSquareText aria-hidden className="h-5 w-5 text-accent" /> Set up SMS
            </h1>
            <p className="mt-1 text-sm text-muted">Text your customers order updates in five short steps. No AWS account, keys or technical setup needed.</p>
          </div>
          {manage && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void run("draft", "save the draft", () => saveDraft(), "Draft saved.")}>
                {busy === "draft" ? "Saving…" : "Save draft"}
              </button>
              <button type="button" className="btn-secondary" disabled={!!busy} onClick={continueLater}>
                Continue later
              </button>
            </div>
          )}
        </div>
        <Progress step={current} done={data.done} onGo={go} />
      </section>

      <ModeBanner mode={data.mode} />
      {readOnly && (
        <Alert kind="info">
          <Lock aria-hidden className="mr-1 inline h-4 w-4" /> Only owners and admins can change the SMS setup. You can look through each step.
        </Alert>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="card animate-rise min-w-0 space-y-5" aria-live="off">
          {problem && <Alert onDismiss={() => setProblem(null)}>{problem}</Alert>}

          {current === "connect" && (
            <>
              <StepHeader n={1} title="Connect your SMS provider" question="bizinsights sends your texts through Amazon Web Services' SMS service.">
                You don&apos;t need an AWS account, API keys or passwords: bizinsights connects with its own secure access, which never reaches your browser.
              </StepHeader>
              <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border p-4">
                <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <Cloud className="h-6 w-6" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">AWS End User Messaging SMS</p>
                  <p className="text-sm text-muted">
                    Amazon&apos;s SMS service, region {data.connection.region}
                    {data.connection.connectedAt ? ` · connected ${fmtWhen(data.connection.connectedAt, store?.timezone)}` : ""}
                  </p>
                </div>
                <Badge tone={CONNECTION[data.connection.status].tone}>{CONNECTION[data.connection.status].label}</Badge>
              </div>
              {data.connection.status === "failed" && data.connection.error && (
                <Alert>
                  <strong>{CONNECTION_ERROR[data.connection.error]?.what ?? "The connection failed."}</strong> {CONNECTION_ERROR[data.connection.error]?.fix ?? "Try again in a few minutes."}
                </Alert>
              )}
              {data.connection.status === "connected" && <Hint>Connected means AWS answered for bizinsights. Your own sender name comes next, and texts start only when you turn them on in step 5.</Hint>}
              {manage && (
                <button
                  type="button"
                  className={data.connection.status === "connected" ? "btn-secondary" : "btn-primary"}
                  disabled={!!busy}
                  onClick={() =>
                    void run(
                      "connect",
                      "connect",
                      async () => {
                        const r = await api<{ result: { connected: boolean }; setup: SmsSetupState }>(`${base}/setup/connect`, { method: "POST", body: {} });
                        if (r.result.connected) toast("success", "Connected to AWS End User Messaging SMS.");
                        return r.setup;
                      },
                    )
                  }
                >
                  {busy === "connect" ? "Connecting…" : data.connection.status === "connected" ? "Check connection again" : data.connection.status === "disconnected" ? "Reconnect" : "Connect"}
                </button>
              )}
            </>
          )}

          {current === "sender" && (
            <>
              <StepHeader n={2} title="Choose your sender name" question="What name should your customers see when they receive your SMS?" />
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="setup-business">
                    Business name
                  </label>
                  <input id="setup-business" className="input" maxLength={40} placeholder={data.defaultBusinessName} value={business} disabled={readOnly} onChange={(e) => setBusiness(e.target.value)} />
                  <p className="mt-1 text-xs text-muted">Used where your messages say who they&apos;re from. Empty: your store&apos;s name.</p>
                </div>
                <div>
                  <label className="label" htmlFor="setup-country">
                    Where are most of your customers?
                  </label>
                  <select id="setup-country" className="input" value={country} disabled={readOnly} onChange={(e) => setCountry(e.target.value)}>
                    <option value="">Choose a country…</option>
                    {SETUP_COUNTRIES.map((c) => (
                      <option key={c} value={c}>
                        {countryName(c)}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-muted">Each country has its own rules for sender names.</p>
                </div>
              </div>

              {nameCheck.support !== "none" ? (
                <div>
                  <label className="label" htmlFor="setup-sender">
                    Sender name
                  </label>
                  <div className="relative">
                    <input
                      id="setup-sender"
                      className="input h-14 pr-16 font-mono text-2xl tracking-wide"
                      maxLength={20}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="IKOREX"
                      value={senderName}
                      disabled={readOnly}
                      aria-invalid={!!senderName && nameCheck.problems.length > 0}
                      aria-describedby="setup-sender-help setup-sender-problems"
                      onChange={(e) => setSenderName(e.target.value)}
                    />
                    <span className={`pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm tabular-nums ${senderName.replace(/\s/g, "").length > SENDER_NAME_MAX ? "text-danger" : "text-muted"}`} aria-hidden>
                      {senderName.replace(/\s/g, "").length}/{SENDER_NAME_MAX}
                    </span>
                  </div>
                  <p id="setup-sender-help" className="mt-1 text-xs text-muted">
                    3 to 11 letters or numbers, no spaces (a hyphen is allowed inside). Examples:{" "}
                    {["IKOREX", "MYSHOP", "ACME"].map((x, i) => (
                      <span key={x}>
                        {i ? ", " : ""}
                        <code className="font-mono">{x}</code>
                      </span>
                    ))}
                    .
                    {!readOnly && suggestSenderName(businessShown) && suggestSenderName(businessShown) !== senderName && (
                      <>
                        {" "}
                        <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => setSenderName(suggestSenderName(businessShown))}>
                          Use {suggestSenderName(businessShown)}
                        </button>
                      </>
                    )}
                  </p>
                  <div id="setup-sender-problems" aria-live="polite">
                    {senderName && nameCheck.problems.length > 0 && (
                      <ul className="mt-2 space-y-0.5 text-sm text-danger">
                        {nameCheck.problems.map((p) => (
                          <li key={p} className="flex gap-1.5">
                            <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
                            {p}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ) : null}

              {country && (
                <div className="rounded-xl border border-border p-4 text-sm">
                  <dl className="grid gap-2 sm:grid-cols-[9rem_1fr]">
                    <dt className="text-muted">Customers see</dt>
                    <dd className="font-medium">{nameCheck.customerSees}</dd>
                    {nameCheck.support !== "none" && (
                      <>
                        <dt className="text-muted">For example</dt>
                        <dd>
                          <span className="font-mono">{nameCheck.name || "IKOREX"}</span>: {(previewText.split(/[.!?]/)[0] ?? "").trim() || "Your order has been confirmed"}
                        </dd>
                      </>
                    )}
                    <dt className="text-muted">What happens next</dt>
                    <dd>{nameCheck.next}</dd>
                  </dl>
                </div>
              )}
              <Hint>
                A sender name isn&apos;t always possible. Some countries only show names registered with a regulator, others show a phone number or a shared short code instead, and the length and
                characters allowed differ by country and by AWS. bizinsights never shows a name as approved until AWS confirms it.
              </Hint>

              {country && (
                <div className="space-y-3 rounded-xl border border-border p-4" aria-live="polite">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{nameCheck.support === "none" ? "Your sending number" : "Your sender name"}</p>
                    <Badge tone={nameDirty ? "neutral" : statusInfo.tone}>{nameDirty ? "Not saved" : statusInfo.label}</Badge>
                  </div>
                  <p className="text-sm text-muted">{nameDirty ? "Request it to save and send it for approval." : statusInfo.help}</p>
                  {!nameDirty && s.requestedAt && <p className="text-xs text-muted">Requested {fmtWhen(s.requestedAt, store?.timezone)}{s.checkedAt ? ` · last checked ${fmtWhen(s.checkedAt, store?.timezone)}` : ""}</p>}
                  {senderReady && data.sender && (
                    <p className="text-sm">
                      <Check aria-hidden className="mr-1 inline h-4 w-4 text-good" />
                      Texts now come from <strong>{data.sender.identityLabel}</strong>, approved by AWS.
                    </p>
                  )}
                  {manage && (
                    <div className="flex flex-wrap gap-2">
                      {(nameDirty || s.status === "draft" || s.status === "unavailable" || s.status === "needs_changes") && (
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={!!busy || (nameCheck.support !== "none" && nameCheck.problems.length > 0) || !country}
                          onClick={() =>
                            void run(
                              "request",
                              "send the request",
                              async () => {
                                await saveDraft();
                                return (await api<{ setup: SmsSetupState }>(`${base}/setup/sender/request`, { method: "POST", body: {} })).setup;
                              },
                              "Requested. bizinsights sets it up with AWS for you.",
                            )
                          }
                        >
                          {busy === "request" ? "Requesting…" : nameCheck.support === "none" ? "Request a sending number" : nameCheck.support === "registered" ? "Register sender name" : "Request sender name"}
                        </button>
                      )}
                      {!nameDirty && s.status !== "draft" && (
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={!!busy}
                          onClick={() =>
                            void run("check", "check with AWS", async () => {
                              const r = await api<{ result: { status: string }; setup: SmsSetupState }>(`${base}/setup/sender/check`, { method: "POST", body: {} });
                              toast(r.result.status === "approved" ? "success" : "info", `AWS check: ${SENDER_STATUS[r.result.status]?.label ?? r.result.status}.`);
                              return r.setup;
                            })
                          }
                        >
                          {busy === "check" ? "Checking with AWS…" : "Check status"}
                        </button>
                      )}
                      {s.sharedAvailable && !senderReady && (
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={!!busy}
                          onClick={() => void run("shared", "use the shared sender", async () => (await saveDraft(), api<SmsSetupState>(`${base}/setup/sender/shared`, { method: "POST", body: {} })), "You're using bizinsights' shared sender for now.")}
                        >
                          Use bizinsights&apos; shared sender for now
                        </button>
                      )}
                    </div>
                  )}
                  {country === "IN" && (
                    <p className="text-sm text-warn">
                      Texts to India need your own DLT registration with an Indian operator: set them up in <Link className="underline" href="/messaging/sender">Sender Configuration</Link>.
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {current === "message" && (
            <>
              <StepHeader n={3} title="Write your message" question="What message would you like your customers to receive?">
                This is your order confirmation. Click a detail to add it: each customer sees their own.
              </StepHeader>
              <div>
                <label className="label" htmlFor="setup-message">
                  Message
                </label>
                <MessageEditor id="setup-message" value={message} onChange={setMessage} trigger="order_created" disabled={readOnly} />
              </div>
              {!readOnly && message !== SETUP_FIRST_MESSAGE && (
                <button type="button" className="text-sm text-accent underline-offset-2 hover:underline" onClick={() => setMessage(SETUP_FIRST_MESSAGE)}>
                  Start again from the suggested message
                </button>
              )}
              <Hint>Messages go only to customers who may receive order updates, never to customers who opted out. Your other order updates are in step 5.</Hint>
            </>
          )}

          {current === "test" && <TestStep data={data} base={base} manage={manage} senderReady={senderReady} onChange={setData} onGoSender={() => go("sender")} />}

          {current === "automate" && (
            <>
              <StepHeader n={5} title="Turn on automatic SMS" question="Which updates should your customers get by text?">
                Choose the moments, check each message, and turn them on. You can change or stop them any time.
              </StepHeader>

              <div className="space-y-3 rounded-xl border border-border p-4">
                <p className="font-medium">Before anything is sent</p>
                <div className="space-y-4">
                  <div className="max-w-xs">
                    <label className="label" htmlFor="setup-budget">
                      Monthly spending limit (US$)
                    </label>
                    <input id="setup-budget" className="input" type="number" inputMode="decimal" min={0} max={100000} step="1" value={budget} disabled={readOnly} onChange={(e) => setBudget(e.target.value)} />
                    <p className="mt-1 text-xs text-muted">Texts stop for the month when it&apos;s reached. AWS charges per SMS part, in US dollars.</p>
                  </div>
                  <fieldset className="min-w-0" disabled={readOnly}>
                    <legend className="label">How did customers agree to order updates by text?</legend>
                    <div className="space-y-2">
                      {(Object.keys(BASIS) as Array<keyof typeof BASIS>).map((b) => (
                        <label key={b} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${basis === b ? "border-accent bg-accent/5" : "border-border"}`}>
                          <input type="radio" name="setup-basis" className="mt-0.5 accent-[var(--accent)]" checked={basis === b} onChange={() => setBasis(b)} />
                          <span>
                            <span className="font-medium">{BASIS[b].label}</span>
                            <span className="block text-xs text-muted">{BASIS[b].help}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </div>
                {manage && (
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={!!busy || !(Number(budget) >= 0) || budget.trim() === ""}
                    onClick={() => void run("sending", "save", () => saveDraft({ monthlyBudgetUsd: Number(budget), ...(basis !== "none" ? { transactionalBasis: basis } : {}) }), "Saved.")}
                  >
                    {busy === "sending" ? "Saving…" : "Save limit and consent"}
                  </button>
                )}
              </div>

              <ul className="space-y-3">
                {data.automations.map((a) => {
                  const open = editing === a.key;
                  const body = edits[a.key] ?? a.body;
                  const changed = body !== a.body;
                  return (
                    <li key={a.key} className={`rounded-xl border p-4 ${a.unavailable ? "border-dashed border-border opacity-70" : a.on ? "border-accent/50 bg-accent/5" : "border-border"}`}>
                      <div className="flex flex-wrap items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-2 font-medium">
                            {a.label}
                            {a.unavailable ? <Badge tone="neutral">Not available</Badge> : <Badge tone={a.on ? "good" : "neutral"}>{a.on ? "On" : "Off"}</Badge>}
                          </p>
                          <p className="text-sm text-muted">{a.unavailable ?? a.help}</p>
                        </div>
                        {!a.unavailable && a.trigger && (
                          <div className="flex items-center gap-2">
                            <button type="button" className="btn-secondary h-9 px-3 text-sm" aria-expanded={open} onClick={() => setEditing(open ? null : a.key)}>
                              {open ? "Close" : "Edit message"}
                            </button>
                            {manage && (
                              <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  role="switch"
                                  className="h-5 w-5 accent-[var(--accent)]"
                                  checked={a.on}
                                  disabled={!!busy}
                                  onChange={() => {
                                    if (a.on) void run(`auto:${a.key}`, "turn it off", async () => (await api<{ setup: SmsSetupState }>(`${base}/setup/automations/${a.trigger}`, { method: "PUT", body: { on: false } })).setup, `${a.label}: off.`);
                                    else setConfirming({ kind: "automation", trigger: a.trigger! });
                                  }}
                                />
                                <span className="sr-only">{a.label}</span>
                              </label>
                            )}
                          </div>
                        )}
                      </div>
                      {open && a.trigger && (
                        <div className="mt-3 space-y-2">
                          <label className="sr-only" htmlFor={`setup-auto-${a.key}`}>
                            Message for {a.label}
                          </label>
                          <MessageEditor id={`setup-auto-${a.key}`} value={body} onChange={(v) => setEdits({ ...edits, [a.key]: v })} trigger={a.trigger} disabled={readOnly} />
                          {manage && (
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                className="btn-primary h-9 px-3 text-sm"
                                disabled={!!busy || !changed}
                                onClick={() =>
                                  void run(
                                    `save:${a.key}`,
                                    "save the message",
                                    async () => {
                                      const r = await api<{ setup: SmsSetupState }>(`${base}/setup/automations/${a.trigger}`, { method: "PUT", body: { body, on: a.on } });
                                      setEdits((e) => {
                                        const { [a.key]: _, ...rest } = e;
                                        return rest;
                                      });
                                      return r.setup;
                                    },
                                    a.on ? "Saved. Customers get the new message from now on." : "Saved.",
                                  )
                                }
                              >
                                {busy === `save:${a.key}` ? "Saving…" : "Save message"}
                              </button>
                              {a.on && changed && <span className="text-xs text-warn">This one is on: saving changes what customers get from now on.</span>}
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
                <li className="rounded-xl border border-dashed border-border p-4 text-sm">
                  <p className="font-medium">Custom notifications</p>
                  <p className="text-muted">
                    Texts for other moments (a cancelled order, a refund, an abandoned checkout) are in{" "}
                    <Link className="text-accent underline-offset-2 hover:underline" href="/messaging/automations">
                      Automated Workflows
                    </Link>
                    , and a one-off text to one customer in{" "}
                    <Link className="text-accent underline-offset-2 hover:underline" href="/messaging/send">
                      Send SMS
                    </Link>
                    .
                  </p>
                </li>
              </ul>

              <MasterSwitch data={data} manage={manage} busy={busy} onToggle={(on) => setConfirming({ kind: "master", on })} />
            </>
          )}

          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
            <button type="button" className="btn-secondary" disabled={index === 0 || !!busy} onClick={() => go(SETUP_STEPS[index - 1]!)}>
              Back
            </button>
            <button type="button" className="btn-primary" disabled={!!busy || (current === "message" && manage && (checkTemplate({ category: "transactional", body: message }).some((i) => i.level === "error") || missingForTrigger(message, "order_created").length > 0))} onClick={() => void next()}>
              {busy === "next" ? "Saving…" : index === SETUP_STEPS.length - 1 ? "Finish" : "Continue"}
            </button>
          </footer>
        </section>

        <aside className="lg:sticky lg:top-4" aria-label="Phone preview">
          <PhonePreview sender={sender} text={previewText} segments={smsSegments(previewText)} worstParts={worstCaseSegments(previewBody).segments} price={data.price} />
        </aside>
      </div>

      <ConfirmDialog
        open={!!confirming}
        title={confirming?.kind === "automation" ? `Turn on "${data.automations.find((a) => a.trigger === confirming.trigger)?.label}"?` : confirming?.on ? "Enable automatic SMS?" : "Turn automatic SMS off?"}
        confirmLabel={confirming?.kind === "master" && !confirming.on ? "Turn off" : "Turn on"}
        danger={confirming?.kind === "master" && !confirming.on}
        busy={!!busy}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const c = confirming;
          if (!c) return;
          if (c.kind === "automation") {
            const a = data.automations.find((x) => x.trigger === c.trigger)!;
            void run(
              `auto:${a.key}`,
              "turn it on",
              async () => {
                const r = await api<{ setup: SmsSetupState }>(`${base}/setup/automations/${c.trigger}`, { method: "PUT", body: { on: true, confirm: true, ...(edits[a.key] !== undefined ? { body: edits[a.key] } : {}) } });
                setConfirming(null);
                return r.setup;
              },
              `${a.label}: on.`,
            );
          } else {
            void run(
              "master",
              c.on ? "turn automatic SMS on" : "turn automatic SMS off",
              async () => {
                const r = await api<SmsSetupState>(`${base}/setup/automatic`, { method: "POST", body: { on: c.on } });
                setConfirming(null);
                return r;
              },
              c.on ? "Automatic SMS is on." : "Automatic SMS is off. Texts that were waiting were cancelled.",
            ).then((ok) => {
              if (!ok) setConfirming(null);
            });
          }
        }}
      >
        {confirming?.kind === "automation" ? (
          <AutomationConfirm data={data} trigger={confirming.trigger} body={edits[data.automations.find((a) => a.trigger === confirming.trigger)?.key ?? ""]} business={businessShown} />
        ) : confirming?.kind === "master" ? (
          confirming.on ? (
            <p>
              Your automatic texts that are on start going to real customers as their orders happen
              {data.mode === "live" ? "." : ". bizinsights is in test mode for now, so they're recorded in Message History instead of sent until SMS goes live."}
            </p>
          ) : (
            <p>No more automatic texts go out. Texts waiting to go are cancelled, not kept for later.</p>
          )
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

/** What turning on one automatic text will do, said before it does it. */
function AutomationConfirm({ data, trigger, body, business }: { data: SmsSetupState; trigger: SmsTrigger; body?: string; business: string }) {
  const a = data.automations.find((x) => x.trigger === trigger)!;
  const text = previewSms(body ?? a.body, { ...PREVIEW_VALUES, business_name: business, order_status: ORDER_STATUS_WORD[trigger] ?? "" });
  const quiet = data.sender ? [data.sender.quietStart, data.sender.quietEnd] : [21, 9];
  return (
    <>
      <p>
        From now on, {a.help.replace(/^Sent when/, "when").replace(/\.$/, "")}, the customer gets this text:
      </p>
      <div className="whitespace-pre-wrap rounded-xl border border-border bg-bg px-3 py-2 text-text">{text}</div>
      <p>
        It goes to real customers who may receive order updates and haven&apos;t opted out
        {quiet[0] !== quiet[1] ? `; texts that would arrive between ${fmtHour(quiet[0]!)} and ${fmtHour(quiet[1]!)} wait until morning` : ""}. Turning it on approves this message in your name.
      </p>
      {data.mode !== "live" && <p className="text-warn">bizinsights is in test mode: no customer is texted yet. What would be sent is recorded in Message History.</p>}
      {data.mode === "live" && !data.sending.on && <p>Nothing goes out until Enable Automatic SMS is on.</p>}
    </>
  );
}

/** "Enable Automatic SMS": the store's sending switch, and what stands in its way. */
export function MasterSwitch({ data, manage, busy, onToggle }: { data: SmsSetupState; manage: boolean; busy: string | null; onToggle: (on: boolean) => void }) {
  const on = data.sending.on;
  const blockers = [
    data.connection.status !== "connected" ? "Connect SMS (step 1)." : null,
    data.sender?.identityCheck !== "verified" ? "Your sender needs AWS's approval (step 2)." : null,
    !((data.sending.monthlyBudgetUsd ?? 0) > 0) ? "Set a monthly spending limit above 0 and save it." : null,
    data.sending.transactionalBasis === "none" ? "Choose how customers agreed to order updates and save it." : null,
  ].filter((x): x is string => !!x);
  const anyOn = data.automations.some((a) => a.on);
  return (
    <div className={`rounded-xl border-2 p-4 ${on ? "border-good/60 bg-good/5" : "border-border"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-base font-semibold">
            Enable Automatic SMS <Badge tone={on ? "good" : "neutral"}>{on ? "On" : "Off"}</Badge>
          </p>
          <p className="text-sm text-muted">{on ? (anyOn ? "Your automatic texts that are on go out as orders happen." : "On, but none of the texts above is on yet.") : "Nothing is sent to customers while this is off."}</p>
        </div>
        {manage && (
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input type="checkbox" role="switch" className="h-6 w-6 accent-[var(--accent)]" checked={on} disabled={!!busy || (!on && blockers.length > 0)} onChange={() => onToggle(!on)} />
            <span className="sr-only">Enable Automatic SMS</span>
          </label>
        )}
      </div>
      {!on && blockers.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {blockers.map((b) => (
            <li key={b} className="flex gap-2 text-warn">
              <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              {b}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Step 4: a verified number of the team's own, and a test text to it, followed to its outcome. */
function TestStep({ data, base, manage, senderReady, onChange, onGoSender }: { data: SmsSetupState; base: string; manage: boolean; senderReady: boolean; onChange: (s: SmsSetupState) => void; onGoSender: () => void }) {
  const toast = useToast();
  const verified = data.testNumbers.filter((t) => t.status === "verified");
  const pending = data.testNumbers.filter((t) => t.status !== "verified");
  const [numberId, setNumberId] = useState(verified[0]?.id ?? "");
  const [country, setCountry] = useState(data.senderName.country && callingCode(data.senderName.country) ? data.senderName.country : "AU");
  const [number, setNumber] = useState("");
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState<SmsMessage | null>(data.lastTest);
  const [waitUntil, setWaitUntil] = useState(0);
  const [, tick] = useState(0);
  const normalized = normalizePhone(number, country);

  useEffect(() => {
    if (!numberId && verified[0]) setNumberId(verified[0].id);
  }, [numberId, verified]);
  // Follow the text until it has a final outcome (or 3 minutes pass): AWS's acceptance isn't delivery.
  useEffect(() => {
    if (!message || !LIVE.has(message.status)) return;
    const started = Date.now();
    const t = window.setInterval(async () => {
      if (Date.now() - started > 180_000) return window.clearInterval(t);
      try {
        const r = await api<{ message: SmsMessage }>(`${base}/messages/${message.id}`);
        setMessage(r.message);
        if (!LIVE.has(r.message.status)) window.clearInterval(t);
      } catch {
        // A blip: the next poll tries again.
      }
    }, 3000);
    return () => window.clearInterval(t);
  }, [message, base]);
  useEffect(() => {
    if (waitUntil <= Date.now()) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [waitUntil]);
  const wait = Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000));

  const refresh = async () => onChange(await api<SmsSetupState>(`${base}/setup`));
  const act = async (key: string, what: string, fn: () => Promise<void>) => {
    setBusy(key);
    setProblem(null);
    try {
      await fn();
    } catch (e) {
      setProblem(smsError(e, what));
    } finally {
      setBusy(null);
    }
  };

  const send = () =>
    act("send", "send the test", async () => {
      // One id per press: a retried request gets the same text back instead of a second one.
      const r = await api<{ message: SmsMessage }>(`${base}/templates/${data.templateId}/test`, { method: "POST", body: { testNumberId: numberId, requestId: requestId() } });
      setMessage(r.message);
      setWaitUntil(Date.now() + 30_000);
      await refresh();
    });

  const outcome = message ? testOutcome(message) : null;

  return (
    <>
      <StepHeader n={4} title="Send a test SMS" question="Check how your message arrives on your own phone." />
      {!senderReady && (
        <Alert kind="info">
          A test needs a sender approved by AWS.{" "}
          <button type="button" className="font-medium underline" onClick={onGoSender}>
            Go to step 2
          </button>
          . You can verify your number now.
        </Alert>
      )}
      {!data.templateId && <Alert kind="info">Save your message in step 3 first: the test sends that message.</Alert>}
      {problem && <Alert onDismiss={() => setProblem(null)}>{problem}</Alert>}

      {manage && (
        <div className="space-y-3 rounded-xl border border-border p-4">
          <p className="font-medium">1. Your mobile number</p>
          <p className="text-sm text-muted">AWS texts it a code first, so tests only ever go to a phone you have in your hand.</p>
          {verified.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="sr-only">Send the test to</legend>
              {verified.map((t) => (
                <label key={t.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm ${numberId === t.id ? "border-accent bg-accent/5" : "border-border"}`}>
                  <input type="radio" name="setup-test-number" className="accent-[var(--accent)]" checked={numberId === t.id} onChange={() => setNumberId(t.id)} />
                  <span className="font-mono">{t.number}</span>
                  <Badge tone="good">Verified</Badge>
                </label>
              ))}
            </fieldset>
          )}
          {pending.map((t) => (
            <div key={t.id} className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-mono">{t.number}</p>
                <p className="text-xs text-muted">Enter the code AWS texted to this number.</p>
              </div>
              <label className="sr-only" htmlFor={`setup-code-${t.id}`}>
                Code for {t.number}
              </label>
              <input
                id={`setup-code-${t.id}`}
                className="input h-11 w-32 text-center font-mono text-lg"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={10}
                placeholder="Code"
                value={codes[t.id] ?? ""}
                onChange={(e) => setCodes({ ...codes, [t.id]: e.target.value.replace(/\D/g, "") })}
              />
              <button
                type="button"
                className="btn-primary h-11"
                disabled={!!busy || (codes[t.id] ?? "").length < 4}
                onClick={() =>
                  void act(`verify:${t.id}`, "check the code", async () => {
                    await api(`${base}/test-numbers/${t.id}/verify`, { method: "POST", body: { code: codes[t.id] } });
                    setNumberId(t.id);
                    await refresh();
                    toast("success", "Number verified.");
                  })
                }
              >
                {busy === `verify:${t.id}` ? "Checking…" : "Confirm"}
              </button>
              <button
                type="button"
                className="btn-secondary h-11"
                disabled={!!busy}
                onClick={() => void act(`resend:${t.id}`, "send a new code", async () => void (await api(`${base}/test-numbers/${t.id}/resend`, { method: "POST", body: {} }), toast("success", "A new code is on its way.")))}
              >
                New code
              </button>
            </div>
          ))}
          {data.testNumbers.length < 5 && (
            <form
              className="flex flex-wrap items-end gap-2"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (!normalized) return setProblem("Enter a mobile number for the country you chose.");
                void act("add", "text a code", async () => {
                  await api(`${base}/test-numbers`, { method: "POST", body: { number: number.trim(), country } });
                  setNumber("");
                  await refresh();
                  toast("success", "AWS is texting you a code.");
                });
              }}
            >
              <div>
                <label className="label" htmlFor="setup-test-country">
                  Country code
                </label>
                <select id="setup-test-country" className="input h-11 w-44" value={country} onChange={(e) => setCountry(e.target.value)}>
                  {[...PHONE_COUNTRIES].sort((a, b) => countryName(a).localeCompare(countryName(b))).map((c) => (
                    <option key={c} value={c}>
                      {countryName(c)} (+{callingCode(c)})
                    </option>
                  ))}
                </select>
              </div>
              <div className="min-w-[12rem] flex-1">
                <label className="label" htmlFor="setup-test-number">
                  Mobile number
                </label>
                <input
                  id="setup-test-number"
                  className="input h-11 text-lg"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel-national"
                  placeholder="0412 345 678"
                  value={number}
                  aria-invalid={!!number && !normalized}
                  onChange={(e) => setNumber(e.target.value)}
                />
                {number && !normalized && <p className="mt-1 text-xs text-danger">That doesn&apos;t look like a mobile number in {countryName(country)}.</p>}
              </div>
              <button type="submit" className="btn-secondary h-11" disabled={!!busy || !normalized || data.mode === "off"}>
                {busy === "add" ? "Texting a code…" : "Text me a code"}
              </button>
            </form>
          )}
        </div>
      )}

      <div className="space-y-3 rounded-xl border border-border p-4">
        <p className="font-medium">2. Send the test</p>
        {manage && (
          <button type="button" className="btn-primary h-12 px-6 text-base" disabled={!!busy || !numberId || !senderReady || !data.templateId || wait > 0 || data.mode === "off"} onClick={() => void send()}>
            {busy === "send" ? "Sending…" : wait > 0 ? `Send again in ${wait} s` : "Send Test SMS"}
          </button>
        )}
        {message && outcome && (
          <div className="rounded-lg border border-border bg-bg/50 p-3 text-sm" role="status" aria-live="polite">
            <p className="flex flex-wrap items-center gap-2">
              <SmsStatusBadge status={message.status} why={message.reasonLabel} />
              {message.to && <span className="text-muted">to {message.to}</span>}
              <span className="text-muted">· {fmtWhen(message.createdAt)}</span>
            </p>
            <p className="mt-1 font-medium">{outcome.said}</p>
            {outcome.fix && <p className="mt-1 text-muted">What to do: {outcome.fix}</p>}
            {message.providerMessageId && <p className="mt-1 font-mono text-[11px] text-muted">AWS message ID {message.providerMessageId}</p>}
          </div>
        )}
      </div>
    </>
  );
}

/** A test text's state in plain words: AWS accepting it isn't the phone getting it. */
function testOutcome(m: SmsMessage): { said: string; fix: string | null } {
  const fix = TEST_FIX[m.providerStatus?.toUpperCase() ?? ""] ?? TEST_FIX[m.errorCode ?? ""] ?? TEST_FIX[m.reason ?? ""] ?? null;
  switch (m.status) {
    case "scheduled":
    case "sending":
      return { said: "Sending…", fix: null };
    case "accepted":
      return { said: "AWS accepted the text. Waiting for the carrier's delivery report: this doesn't yet mean it reached the phone.", fix: null };
    case "pending":
      return { said: "The carrier has it and is still delivering it.", fix: null };
    case "delivered":
      return { said: "Delivered: the phone confirmed it arrived.", fix: null };
    case "carrier_accepted":
      return { said: "The carrier accepted it. This network doesn't confirm delivery to the phone: check your phone.", fix: null };
    case "failed":
      return { said: `Not delivered${m.providerExplanation ? `: ${m.providerExplanation}` : m.reasonLabel ? `: ${m.reasonLabel}` : "."}`, fix: fix ?? "Try again in a few minutes. If it keeps failing, contact bizinsights support with the AWS message ID." };
    case "uncertain":
      return { said: "The call to AWS broke off without an answer. It isn't sent again on its own.", fix: "Check your phone before sending another." };
    case "unknown":
      return { said: "The carrier never said whether it arrived.", fix: "Check your phone." };
    case "opted_out":
      return { said: "Not sent: this number is on AWS's opt-out list for this sender.", fix: "Use another number, or contact bizinsights support to take it off the list." };
    default:
      return { said: m.reasonLabel ? `Not sent: ${m.reasonLabel}.` : "Not sent.", fix };
  }
}
