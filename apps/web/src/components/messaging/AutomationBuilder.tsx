"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, ChevronDown, CircleAlert, Info, Lock, MessageSquareText, RefreshCw, ShieldCheck, Sparkles, UserRound, Users, Wand2 } from "lucide-react";
import {
  AUTOMATION_STARTERS,
  AUTOMATION_STEPS,
  AUTOMATION_TRIGGER_CARDS,
  audienceWords,
  automationCapDefaults,
  automationTriggerCard,
  automationVariables,
  checkAutomationMessage,
  fixVariableAliases,
  RULE_CONDITION_LABEL,
  SENDER_NAME_MAX,
  SMS_VARIABLE_GROUP,
  SMS_VARIABLE_GROUPS,
  SMS_VARIABLE_INFO,
  smsAutomationSchema,
  smsSegments,
  TRIGGER_CONDITION_FIELDS,
  TRIGGER_INFO,
  TRIGGER_SOURCES,
  TRIGGER_SUBJECT,
  worstCaseSegments,
  type AutomationStep,
  type RuleConditionField,
  type SmsAudience,
  type SmsAudienceKind,
  type SmsAutomationInput,
  type SmsTrigger,
  type SmsVariable,
} from "@app/shared/sms";
import { ConfirmDialog, Skeleton, useToast } from "@/components/AppUi";
import { useApp } from "@/components/AppContext";
import { LoadError } from "@/components/LoadError";
import { Badge, type Tone } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { AudienceCount, CustomerPicker, SegmentPicker, useAudienceEstimate } from "./AutomationAudience";
import { ReviewStep, TestStep } from "./AutomationReview";
import { ActivateDialog, AUTOMATION_STATUS, consentWords, previewText, quietWords, timingWords, TriggerIcon } from "./AutomationUi";
import { fmtHour, fmtWhen, smsError, useSms } from "./MessagingUi";
import { PhonePreview, type PreviewSender } from "./PhonePreview";
import { OP_LABEL, OPS, VALUE_INPUT } from "./RuleEditor";
import type { AutomationChecks, AutomationsResponse, AutomationView, SmsSegment, SmsSetupState, TriggerCapability, TriggersResponse } from "./types";

// ---------------------------------------------------------------------------
// Create SMS Automation: five steps (when, who, the message, a test, review and activate) beside a
// phone showing the text as a customer gets it. The store's one-time setup (sender, verification,
// limits, permissions) isn't asked for here: the review lists only what's still missing, with where
// to fix it. Every check is also the API's (apps/api/src/routes/smsAutomations.ts, @app/shared/sms);
// nothing is sent by saving, and an automation is "on" only when the API says its rule is active.
// ---------------------------------------------------------------------------

const STEP_LABEL: Record<AutomationStep, string> = { trigger: "When", audience: "Who", message: "Message", test: "Test", review: "Review & activate" };
const STEP_INDEX = Object.fromEntries(AUTOMATION_STEPS.map((s, i) => [s, i])) as Record<AutomationStep, number>;
const [WHEN, WHO, MESSAGE, TEST, REVIEW] = [0, 1, 2, 3, 4] as const;

type Unit = "minutes" | "hours" | "days";
const UNIT_MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };

interface CondDraft {
  field: RuleConditionField;
  op: string;
  value: string;
}

interface Draft {
  name: string;
  /** The name follows the trigger until the merchant types one. */
  nameTouched: boolean;
  trigger: SmsTrigger | null;
  body: string;
  discountCode: string;
  timing: "now" | "delay";
  delay: string;
  unit: Unit;
  filter: "all" | "conditions";
  conditions: CondDraft[];
  quietStart: number;
  quietEnd: number;
  useCustomerTimezone: boolean;
  /** Empty: the trigger's default cap. */
  maxPerCustomer: string;
  capDays: string;
  dryRun: boolean;
  priority: number;
  inactiveDays: string;
  vipMinOrders: string;
  vipMinSpent: string;
  /** Who: the event's customer, only those in a segment, or chosen customers. "Customer joins a segment" always names its segment. */
  audienceKind: SmsAudienceKind;
  segmentId: string;
  contactIds: string[];
}

const defaultName = (t: SmsTrigger) => `${automationTriggerCard(t).label} SMS`;

function delayParts(minutes: number): { delay: string; unit: Unit } {
  if (minutes && minutes % 1440 === 0) return { delay: String(minutes / 1440), unit: "days" };
  if (minutes && minutes % 60 === 0) return { delay: String(minutes / 60), unit: "hours" };
  return { delay: String(minutes || 30), unit: "minutes" };
}

/** A new automation: the store's quiet hours (9 pm to 9 am without them), the trigger's first ready-made message and suggested wait. */
function blank(trigger: SmsTrigger | null, quiet: [number, number]): Draft {
  const wait = trigger ? TRIGGER_INFO[trigger].defaultDelay : 0;
  return {
    name: trigger ? defaultName(trigger) : "",
    nameTouched: false,
    trigger,
    body: trigger ? (AUTOMATION_STARTERS[trigger][0]?.body ?? "") : "",
    discountCode: "",
    timing: wait ? "delay" : "now",
    ...delayParts(wait),
    filter: "all",
    conditions: [],
    quietStart: quiet[0],
    quietEnd: quiet[1],
    useCustomerTimezone: true,
    maxPerCustomer: "",
    capDays: "",
    dryRun: false,
    priority: 50,
    inactiveDays: trigger === "customer_inactive" ? "90" : "",
    vipMinOrders: trigger === "customer_vip" ? "5" : "",
    vipMinSpent: "",
    audienceKind: trigger === "customer_segment" ? "segment" : "trigger",
    segmentId: "",
    contactIds: [],
  };
}

function fromConfig(c: SmsAutomationInput): Draft {
  const caps = automationCapDefaults(c.trigger);
  return {
    name: c.name,
    nameTouched: true,
    trigger: c.trigger,
    body: c.body,
    discountCode: c.discountCode ?? "",
    timing: c.delayMinutes ? "delay" : "now",
    ...delayParts(c.delayMinutes),
    filter: c.conditions.length ? "conditions" : "all",
    conditions: c.conditions.map((x) => ({ field: x.field, op: x.op, value: Array.isArray(x.value) ? x.value.join(", ") : String(x.value) })),
    quietStart: c.quietStart,
    quietEnd: c.quietEnd,
    useCustomerTimezone: c.useCustomerTimezone,
    maxPerCustomer: c.maxPerCustomer && c.maxPerCustomer !== caps.maxPerCustomer ? String(c.maxPerCustomer) : "",
    capDays: c.capDays && c.capDays !== caps.capDays ? String(c.capDays) : "",
    dryRun: c.dryRun,
    priority: c.priority,
    inactiveDays: c.inactiveDays ? String(c.inactiveDays) : "",
    vipMinOrders: c.vipMinOrders ? String(c.vipMinOrders) : "",
    vipMinSpent: c.vipMinSpent ? String(c.vipMinSpent) : "",
    audienceKind: c.audience.kind,
    segmentId: c.audience.kind === "segment" ? c.audience.segmentId : "",
    contactIds: c.audience.kind === "customers" ? c.audience.contactIds : [],
  };
}

const num = (s: string) => (s.trim() === "" ? Number.NaN : Number(s));
const optional = (s: string) => (s.trim() === "" ? null : Number(s));

/** Who, as the API takes it (an unfinished choice stays unfinished, so the schema says what's missing). */
function audienceOf(d: Draft): SmsAudience {
  if (d.trigger === "customer_segment" || d.audienceKind === "segment") return { kind: "segment", segmentId: d.segmentId };
  if (d.audienceKind === "customers") return { kind: "customers", contactIds: d.contactIds };
  return { kind: "trigger" };
}

/** The draft as the API takes it. */
function toInput(d: Draft) {
  return {
    name: d.name.trim(),
    trigger: d.trigger,
    body: d.body,
    discountCode: d.discountCode.trim() || null,
    delayMinutes: d.timing === "now" ? 0 : Math.round(num(d.delay) * UNIT_MINUTES[d.unit]),
    conditions:
      d.filter === "all"
        ? []
        : d.conditions.map((c) => ({
            field: c.field,
            op: c.op,
            value:
              VALUE_INPUT[c.field].kind === "number"
                ? num(c.value)
                : VALUE_INPUT[c.field].kind === "list"
                  ? c.value
                      .split(/[\s,]+/)
                      .map((x) => x.trim().toUpperCase())
                      .filter(Boolean)
                  : c.value,
          })),
    quietStart: d.quietStart,
    quietEnd: d.quietEnd,
    useCustomerTimezone: d.useCustomerTimezone,
    maxPerCustomer: optional(d.maxPerCustomer),
    capDays: optional(d.capDays),
    priority: d.priority,
    dryRun: d.dryRun,
    inactiveDays: d.trigger === "customer_inactive" ? optional(d.inactiveDays) : null,
    vipMinOrders: d.trigger === "customer_vip" ? optional(d.vipMinOrders) : null,
    vipMinSpent: d.trigger === "customer_vip" ? optional(d.vipMinSpent) : null,
    audience: audienceOf(d),
  };
}

const PATH_LABEL: Record<string, string> = {
  name: "Name",
  trigger: "Trigger",
  conditions: "Condition",
  delayMinutes: "Delay",
  discountCode: "Discount code",
  maxPerCustomer: "Texts per customer",
  capDays: "Days",
  inactiveDays: "Days without an order",
  vipMinOrders: "VIP",
  vipMinSpent: "VIP spend",
  audience: "Recipients",
};
/** Which step each of the schema's complaints belongs to. */
const PROBLEM_STEP: Record<string, number> = { Name: WHEN, Trigger: WHEN, Delay: WHEN, "Days without an order": WHEN, VIP: WHEN, "VIP spend": WHEN, "Texts per customer": WHEN, Days: WHEN, Recipients: WHO, Condition: WHO, "Discount code": MESSAGE };

/** The schema's complaints in the form's words, with the step each belongs to. */
function settingsProblems(d: Draft): Array<{ step: number; text: string }> {
  if (!d.trigger) return [{ step: WHEN, text: "Choose when it's sent." }];
  const r = smsAutomationSchema.safeParse(toInput(d));
  if (r.success) return [];
  return r.error.issues.map((i) => {
    const [head, index] = i.path;
    const where = head === "conditions" && typeof index === "number" ? `Condition ${index + 1}` : (PATH_LABEL[String(head)] ?? String(head));
    const isSegment = head === "audience" && (d.trigger === "customer_segment" || d.audienceKind === "segment");
    const msg =
      isSegment && d.trigger === "customer_segment"
        ? "choose the segment customers join"
        : isSegment
          ? "choose a segment"
          : head === "audience" && d.audienceKind === "customers"
            ? "choose at least one customer"
            : i.code === "invalid_type" && i.expected === "number"
              ? "enter a number"
              : i.code === "too_big" && head === "delayMinutes"
                ? "at most 30 days"
                : i.message;
    const step = d.trigger === "customer_segment" && head === "audience" ? WHEN : (PROBLEM_STEP[where.startsWith("Condition") ? "Condition" : where] ?? WHEN);
    return { step, text: `${where}: ${msg}` };
  });
}

/** What a trigger card says about whether Shopify sends it for this store. */
const TRIGGER_STATE: Record<TriggerCapability["state"], { tone: Tone; label: string }> = {
  ready: { tone: "good", label: "Available" },
  needs_permission: { tone: "warn", label: "Needs permission" },
  unchecked: { tone: "neutral", label: "Not checked yet" },
  not_subscribed: { tone: "danger", label: "Shopify refused" },
  not_sent: { tone: "neutral", label: "Not available for your store" },
  unknown_app: { tone: "warn", label: "Can't confirm" },
  unavailable: { tone: "neutral", label: "Not available" },
};
const selectable = (c: TriggerCapability | undefined) => !!c && c.state !== "unavailable" && c.state !== "not_sent";
const AWAITING_GRANT = "insights:awaiting-scope-grant";

function StepHeader({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
  return (
    <header className="space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-accent">
        Step {n} of {AUTOMATION_STEPS.length}
      </p>
      <h2 className="text-xl font-semibold">{title}</h2>
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

/** The steps across the top: done, current or to come; a step can be opened once the ones before it are complete. */
function Progress({ step, reachable, onGo }: { step: number; reachable: number; onGo: (i: number) => void }) {
  return (
    <nav aria-label="Automation steps">
      <div className="h-1.5 rounded-full bg-bg" aria-hidden>
        <div className="h-1.5 rounded-full bg-accent transition-all" style={{ width: `${((step + 1) / AUTOMATION_STEPS.length) * 100}%` }} />
      </div>
      <ol className="mt-2 grid grid-cols-5 gap-1">
        {AUTOMATION_STEPS.map((s, i) => {
          const current = i === step;
          const done = i < step;
          return (
            <li key={s}>
              <button
                type="button"
                onClick={() => onGo(i)}
                disabled={i > reachable}
                aria-current={current ? "step" : undefined}
                className={`flex w-full flex-col items-center gap-1 rounded-lg px-1 py-2 text-center text-[11px] transition disabled:cursor-not-allowed disabled:opacity-50 sm:text-xs ${current ? "bg-accent/10 font-semibold text-text" : "text-muted hover:bg-bg hover:text-text"}`}
              >
                <span aria-hidden className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${done ? "bg-good text-white" : current ? "bg-accent text-accent-ink" : "border border-border bg-surface"}`}>
                  {done ? <Check className="h-4 w-4" strokeWidth={3} /> : i + 1}
                </span>
                <span className="leading-tight">
                  {STEP_LABEL[s]}
                  <span className="sr-only">{done ? " (done)" : current ? " (current step)" : ""}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** A big choice card (a radio), with what the choice needs under it once chosen. */
function Choice({ name, checked, disabled, onChange, icon, title, help, children }: { name: string; checked: boolean; disabled?: boolean; onChange: () => void; icon?: ReactNode; title: string; help: string; children?: ReactNode }) {
  return (
    <div className={`rounded-xl border-2 p-3 transition ${checked ? "border-accent bg-accent/5" : "border-border hover:border-accent/50"} ${disabled ? "opacity-50" : ""}`}>
      <label className={`flex gap-3 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
        <input type="radio" name={name} className="mt-1 accent-[var(--accent)]" checked={checked} disabled={disabled} onChange={onChange} />
        {icon && (
          <span aria-hidden className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${checked ? "bg-accent text-accent-ink" : "bg-accent/10 text-accent"}`}>
            {icon}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{title}</span>
          <span className="block text-sm text-muted">{help}</span>
        </span>
      </label>
      {children && <div className="mt-3 sm:pl-[4.25rem]">{children}</div>}
    </div>
  );
}

export function AutomationBuilder() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { workspace } = useApp();
  const { base, manage, store, contact } = useSms();
  const [id, setId] = useState<string | null>(params.get("id"));
  const triggers = useApi<TriggersResponse>(base ? `${base}/automations/triggers` : null);
  const setup = useApi<SmsSetupState>(base ? `${base}/setup` : null);
  const list = useApi<AutomationsResponse>(base ? `${base}/automations` : null);
  const existing = useApi<{ automation: AutomationView }>(base && id ? `${base}/automations/${id}` : null);
  const segments = useApi<{ segments: SmsSegment[] }>(base ? `${base}/segments` : null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<AutomationView | null>(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ text: string; fix?: { label: string; href: string } | null } | null>(null);
  const [tried, setTried] = useState(false);
  const [moreTriggers, setMoreTriggers] = useState(false);
  const [personalize, setPersonalize] = useState(false);
  const [confirm, setConfirm] = useState<"activate" | "pause" | null>(null);
  const [checksKey, setChecksKey] = useState(0);
  const checks = useApi<AutomationChecks>(base && id && step === REVIEW ? `${base}/automations/${id}/checks?v=${checksKey}` : null);
  const verified = useRef(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  // The draft, once: an existing automation's settings (opened on its review, or the ?step= a fix
  // link names), else a new one (?trigger= picks its trigger).
  useEffect(() => {
    if (draft || !setup.data) return;
    const asked = params.get("step");
    if (id) {
      if (!existing.data) return;
      setSaved(existing.data.automation);
      const c = existing.data.automation.config;
      setDraft(c ? fromConfig(c) : { ...blank(null, [21, 9]), name: existing.data.automation.name, nameTouched: true });
      setStep(c ? (asked && asked in STEP_INDEX ? STEP_INDEX[asked as AutomationStep] : REVIEW) : WHEN);
      return;
    }
    const quiet: [number, number] = setup.data.sender ? [setup.data.sender.quietStart, setup.data.sender.quietEnd] : [21, 9];
    const t = params.get("trigger");
    setDraft(blank(t && t in TRIGGER_INFO && TRIGGER_INFO[t as SmsTrigger].available ? (t as SmsTrigger) : null, quiet));
  }, [draft, id, existing.data, setup.data, params]);

  // Per-store triggers not asked about yet: ask Shopify once (managers only: it subscribes the store). After a
  // permission grant in Shopify, the store's scopes are read again first.
  useEffect(() => {
    if (!manage || !base || !store || verified.current || !triggers.data) return;
    if (!triggers.data.triggers.some((t) => t.state === "unchecked")) return;
    verified.current = true;
    void (async () => {
      try {
        if (window.sessionStorage.getItem(AWAITING_GRANT) === store.id) {
          window.sessionStorage.removeItem(AWAITING_GRANT);
          await api(`/workspaces/${workspace.id}/stores/${store.id}/scopes/refresh`, { method: "POST", body: {} }).catch(() => undefined);
        }
      } catch {
        // Blocked storage: the scopes webhook still updates them.
      }
      try {
        triggers.setData(await api<TriggersResponse>(`${base}/automations/triggers/verify`, { method: "POST", body: {} }));
      } catch {
        // The card keeps saying "Not checked yet", with its own button.
      }
    })();
  }, [manage, base, store, workspace.id, triggers]);

  const business = setup.data?.businessName?.trim() || setup.data?.defaultBusinessName || store?.name || "your store";
  const capOf = (t: SmsTrigger | null) => (t ? triggers.data?.triggers.find((c) => c.trigger === t) : undefined);

  const senderPreview: PreviewSender = useMemo(() => {
    const s = setup.data;
    if (s?.sender?.identityCheck === "verified" && s.sender.identityLabel) return { kind: s.sender.senderType === "sender_id" ? "name" : "number", label: s.sender.identityLabel, approved: true };
    if (s && s.senderName.support === "none") return { kind: "number", label: "Phone number", approved: false };
    return { kind: "name", label: s?.senderName.name || business.slice(0, SENDER_NAME_MAX) || "Your name", approved: false };
  }, [setup.data, business]);

  const audience = draft ? audienceOf(draft) : null;
  const { estimate, loading: estimating } = useAudienceEstimate(base, draft?.trigger ?? null, step === WHO || step === REVIEW ? audience : null);

  const error = triggers.error ?? setup.error ?? existing.error ?? list.error;
  if (error && (!triggers.data || !setup.data)) return <LoadError what="the automation builder" error={error} onRetry={() => void Promise.all([triggers.reload(), setup.reload(), existing.reload(), list.reload()])} />;
  if (id && existing.error) return <LoadError what="the automation" error={existing.error} onRetry={() => void existing.reload()} busy={existing.loading} />;
  if (!draft || !triggers.data || !setup.data || !base) return <Skeleton lines={8} />;

  const d = draft;
  const set = (patch: Partial<Draft>) => setDraft({ ...d, ...patch });
  const trigger = d.trigger;
  const cap = capOf(trigger);
  const issues = trigger ? checkAutomationMessage(d.body, trigger, d.discountCode) : [];
  const messageErrors = issues.filter((i) => i.level === "error");
  const settings = settingsProblems(d);
  const settingsAt = (s: number) => settings.filter((p) => p.step === s);
  // A saved automation whose trigger Shopify no longer sends can still be edited (not switched on).
  const valid = [!!trigger && (selectable(cap) || !!id) && !!d.name.trim() && !settingsAt(WHEN).length, !settingsAt(WHO).length, !!trigger && !messageErrors.length && !settingsAt(MESSAGE).length, true, true];
  const firstInvalid = valid.findIndex((v) => !v);
  const reachable = firstInvalid === -1 ? REVIEW : Math.min(REVIEW, firstInvalid);
  const readOnly = !manage;
  const mode = list.data?.mode ?? setup.data.mode;
  const problems = list.data?.problems ?? [];
  const readiness = list.data?.readiness ?? null;
  const text = trigger ? previewText(d.body, trigger, business) : "";
  // Compared as the API takes them (one key order, defaults as null).
  const dirty = !saved?.config || JSON.stringify(toInput(fromConfig(saved.config))) !== JSON.stringify(toInput(d));
  const segmentName = (sid: string) => segments.data?.segments.find((s) => s.id === sid)?.name ?? null;
  const marketing = !!trigger && TRIGGER_INFO[trigger].category === "marketing";
  const daily = !!trigger && !!TRIGGER_SOURCES[trigger]?.daily;

  const go = async (i: number) => {
    // The test and the review use the saved automation: save the latest first.
    if (i >= TEST && manage && dirty && valid.slice(0, TEST).every(Boolean)) {
      if (!(await save(true))) return;
    }
    setStep(i);
    setProblem(null);
    setTried(false);
    if (i === REVIEW) setChecksKey((k) => k + 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /** Save (create or update); the API's answer is what's shown from then on. */
  const save = async (quiet = false): Promise<AutomationView | null> => {
    setBusy("save");
    setProblem(null);
    try {
      const body = toInput(d);
      const r = id ? await api<{ automation: AutomationView }>(`${base}/automations/${id}`, { method: "PUT", body }) : await api<{ automation: AutomationView }>(`${base}/automations`, { method: "POST", body });
      setSaved(r.automation);
      if (!id) {
        setId(r.automation.id);
        router.replace(`/messaging/automations/edit?id=${r.automation.id}`);
      }
      void list.reload();
      setChecksKey((k) => k + 1);
      if (!quiet) toast("success", r.automation.status === "active" ? "Saved. Your changes go live when you put them live." : "Saved as a draft. Nothing is sent until you activate it.");
      return r.automation;
    } catch (e) {
      setProblem({ text: smsError(e, "save the automation") });
      return null;
    } finally {
      setBusy(null);
    }
  };

  const next = async () => {
    setTried(true);
    if (!valid[step]) return;
    await go(step + 1);
  };

  const changeTrigger = (t: SmsTrigger) => {
    if (t === trigger) return;
    const fresh = blank(t, [d.quietStart, d.quietEnd]);
    // A message written for another trigger rarely fits: start from this one's, unless it's the merchant's own and still fits.
    const own = d.body.trim() && !Object.values(AUTOMATION_STARTERS).some((starters) => starters.some((s) => s.body === d.body));
    const keepBody = own && !checkAutomationMessage(d.body, t, d.discountCode).some((i) => i.level === "error" && i.code !== "discount_code");
    // Who carries over where it still means something: a segment or chosen customers (not into or out of "joins a segment").
    const keepAudience = t !== "customer_segment" && trigger !== "customer_segment";
    setDraft({
      ...fresh,
      name: d.nameTouched ? d.name : fresh.name,
      nameTouched: d.nameTouched,
      body: keepBody ? d.body : fresh.body,
      quietStart: d.quietStart,
      quietEnd: d.quietEnd,
      useCustomerTimezone: d.useCustomerTimezone,
      dryRun: d.dryRun,
      priority: d.priority,
      ...(keepAudience ? { audienceKind: d.audienceKind, segmentId: d.segmentId, contactIds: d.contactIds } : {}),
    });
  };

  const insert = (v: SmsVariable) => {
    const el = editorRef.current;
    const token = `{{${v}}}`;
    const start = el?.selectionStart ?? d.body.length;
    const end = el?.selectionEnd ?? d.body.length;
    set({ body: d.body.slice(0, start) + token + d.body.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const askPermission = async (scope: string) => {
    setBusy("scope");
    setProblem(null);
    try {
      const r = await api<{ url: string | null; alreadyGranted?: boolean }>(`/workspaces/${workspace.id}/stores/${store!.id}/scopes/request`, { method: "POST", body: { scopes: [scope] } });
      if (r.url) {
        try {
          window.sessionStorage.setItem(AWAITING_GRANT, store!.id);
        } catch {
          // Blocked storage: the scopes webhook still updates them.
        }
        window.location.assign(r.url);
        return;
      }
      triggers.setData(await api<TriggersResponse>(`${base}/automations/triggers/verify`, { method: "POST", body: {} }));
    } catch (e) {
      setProblem({ text: smsError(e, "ask Shopify for permission") });
    } finally {
      setBusy(null);
    }
  };

  const checkShopify = async () => {
    setBusy("verify");
    setProblem(null);
    try {
      triggers.setData(await api<TriggersResponse>(`${base}/automations/triggers/verify`, { method: "POST", body: {} }));
      toast("success", "Checked with Shopify.");
    } catch (e) {
      setProblem({ text: smsError(e, "check with Shopify") });
    } finally {
      setBusy(null);
    }
  };

  const activate = async () => {
    setBusy("activate");
    setProblem(null);
    try {
      let current = saved;
      if (dirty || !current) current = await save(true);
      if (!current) return;
      setBusy("activate");
      const r = await api<{ automation: AutomationView }>(`${base}/automations/${current.id}/activate`, { method: "POST", body: { confirm: true } });
      setSaved(r.automation);
      void list.reload();
      setChecksKey((k) => k + 1);
      toast("success", mode === "live" ? "It's on: it runs every time this happens." : "It's on. While your account is being verified, its texts are recorded in Message History, not sent.");
    } catch (e) {
      const fix = checks.data?.checks.find((c) => !c.ok && c.blocking)?.fix ?? null;
      setProblem({ text: smsError(e, "activate the automation"), fix });
      setChecksKey((k) => k + 1);
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const pause = async () => {
    if (!saved) return;
    setBusy("pause");
    setProblem(null);
    try {
      const r = await api<{ automation: AutomationView }>(`${base}/automations/${saved.id}/pause`, { method: "POST", body: {} });
      setSaved(r.automation);
      void list.reload();
      setChecksKey((k) => k + 1);
      toast("success", "Paused. Its texts still waiting were cancelled.");
    } catch (e) {
      setProblem({ text: smsError(e, "pause the automation") });
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const mains = AUTOMATION_TRIGGER_CARDS.filter((c) => c.main);
  const extras = AUTOMATION_TRIGGER_CARDS.filter((c) => !c.main);
  const card = trigger ? automationTriggerCard(trigger) : null;
  const on = saved?.status === "active";
  const segmentsInfo = smsSegments(text);
  const worst = worstCaseSegments(d.body);
  const variables = trigger ? automationVariables(trigger) : [];
  const audienceText = trigger && audience ? audienceWords(trigger, audience, audience.kind === "segment" ? segmentName(audience.segmentId) : null) : "";
  const customersWord = (n: number) => `${n} customer${n === 1 ? "" : "s"}`;
  const recipientsText = !estimate
    ? null
    : estimate.customers === null
      ? "1 customer per event"
      : estimate.perEvent
        ? `1 customer per event, if they're one of the ${customersWord(estimate.customers)} who qualify now`
        : `${customersWord(estimate.customers)} qualify today`;

  const triggerCard = (c: (typeof AUTOMATION_TRIGGER_CARDS)[number]) => {
    const capability = triggers.data!.triggers.find((x) => x.key === c.key);
    const state = capability ? TRIGGER_STATE[capability.state] : TRIGGER_STATE.unavailable;
    const chosen = c.trigger !== null && c.trigger === trigger;
    const can = selectable(capability) && !readOnly;
    return (
      <li key={c.key}>
        <button
          type="button"
          role="radio"
          aria-checked={chosen}
          disabled={!can}
          onClick={() => c.trigger && changeTrigger(c.trigger)}
          className={`flex h-full w-full flex-col gap-2 rounded-xl border-2 p-3 text-left transition disabled:cursor-not-allowed ${chosen ? "border-accent bg-accent/5" : "border-border hover:border-accent/50"} ${!selectable(capability) ? "opacity-60" : ""}`}
        >
          <span className="flex items-start gap-3">
            <span aria-hidden className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${chosen ? "bg-accent text-accent-ink" : "bg-accent/10 text-accent"}`}>
              <TriggerIcon trigger={c.trigger} card={c.key} className="h-[18px] w-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5 font-semibold">
                {c.label}
                {c.trigger && TRIGGER_INFO[c.trigger].category === "marketing" && <Badge tone="neutral">Marketing</Badge>}
              </span>
              <span className="mt-0.5 block text-sm text-muted">{c.description}</span>
            </span>
            {chosen && <Check aria-hidden className="h-5 w-5 shrink-0 text-accent" strokeWidth={3} />}
          </span>
          <span className="flex flex-wrap items-center gap-1.5 text-xs">
            {!c.instead && <Badge tone={state.tone}>{state.label}</Badge>}
            {capability?.state === "ready" && capability.lastEventAt && <span className="text-muted">Last event from Shopify {fmtWhen(capability.lastEventAt, store?.timezone)}</span>}
          </span>
        </button>
        {c.instead && (
          <p className="mt-1 px-1 text-xs">
            <Link className="font-medium text-accent underline" href={c.instead.href}>
              {c.instead.label}
            </Link>
          </p>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-4">
      <section className="card animate-rise space-y-4" aria-labelledby="builder-h">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 id="builder-h" className="flex flex-wrap items-center gap-2 text-lg font-semibold">
              <MessageSquareText aria-hidden className="h-5 w-5 text-accent" /> {id ? (saved?.name ?? "Edit automation") : "Create SMS Automation"}
              {saved && <Badge tone={AUTOMATION_STATUS[saved.status].tone}>{AUTOMATION_STATUS[saved.status].label}</Badge>}
              {saved?.pendingChanges && <Badge tone="warn">Changes not live</Badge>}
            </h1>
            <p className="mt-1 text-sm text-muted">Choose what happened, who gets the text and what it says, send yourself a test, then activate it. Nothing is sent until you do.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/messaging/automations" className="btn-secondary inline-flex items-center gap-1.5">
              <ArrowLeft aria-hidden className="h-4 w-4" /> All automations
            </Link>
            {manage && step < REVIEW && (
              <button type="button" className="btn-secondary" disabled={!!busy || !valid[WHEN] || !valid[WHO] || !valid[MESSAGE]} title={!valid[MESSAGE] ? "Fix the message first" : undefined} onClick={() => void save()}>
                {busy === "save" ? "Saving…" : "Save draft"}
              </button>
            )}
          </div>
        </div>
        <Progress step={step} reachable={reachable} onGo={(i) => void go(i)} />
      </section>

      {readOnly && (
        <Alert kind="info">
          <Lock aria-hidden className="mr-1 inline h-4 w-4" /> Only owners and admins can change automations. You can look through each step.
        </Alert>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="card animate-rise min-w-0 space-y-5">
          {problem && (
            <Alert onDismiss={() => setProblem(null)}>
              {problem.text}
              {problem.fix && manage && (
                <Link className="ml-2 font-medium underline" href={problem.fix.href}>
                  {problem.fix.label}
                </Link>
              )}
            </Alert>
          )}

          {step === WHEN && (
            <>
              <StepHeader n={1} title="When should this message be sent?">
                Choose what happens in your store that sends the text. Only events Shopify really sends bizinsights for your store can be chosen.
              </StepHeader>
              <ul role="radiogroup" aria-label="Trigger" className="grid gap-3 sm:grid-cols-2">
                {mains.map(triggerCard)}
              </ul>
              <div>
                <button type="button" className="inline-flex items-center gap-1 text-sm font-medium text-accent" aria-expanded={moreTriggers || (!!card && !card.main)} onClick={() => setMoreTriggers(!moreTriggers)}>
                  <ChevronDown aria-hidden className={`h-4 w-4 transition ${moreTriggers || (card && !card.main) ? "rotate-180" : ""}`} /> More triggers
                </button>
                {(moreTriggers || (card && !card.main)) && (
                  <ul role="radiogroup" aria-label="More triggers" className="mt-3 grid gap-3 sm:grid-cols-2">
                    {extras.map(triggerCard)}
                  </ul>
                )}
              </div>

              {triggers.data.triggers.some((c) => (c.state === "unavailable" || c.state === "not_sent") && c.reason) && (
                <details className="text-sm text-muted">
                  <summary className="cursor-pointer">Why some triggers can&apos;t be chosen</summary>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {triggers.data.triggers
                      .filter((c) => (c.state === "unavailable" || c.state === "not_sent") && c.reason)
                      .map((c) => (
                        <li key={c.key}>
                          <strong>{AUTOMATION_TRIGGER_CARDS.find((x) => x.key === c.key)?.label}</strong>: {c.reason}
                        </li>
                      ))}
                  </ul>
                </details>
              )}

              {card && cap && trigger && (
                <div className="space-y-4 rounded-xl border border-border p-4">
                  {cap.state === "ready" ? (
                    <p className="flex gap-2 text-sm">
                      <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-good" />
                      <span>
                        Shopify sends bizinsights this event for your store
                        {cap.checkedAt ? ` (confirmed with Shopify ${fmtWhen(cap.checkedAt, store?.timezone)})` : ""}.{" "}
                        {cap.lastEventAt ? `The last one arrived ${fmtWhen(cap.lastEventAt, store?.timezone)}.` : daily ? "It's checked once a day." : "None has arrived in the last 90 days yet."}
                      </span>
                    </p>
                  ) : (
                    <p className="flex gap-2 text-sm text-warn">
                      <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{cap.reason} It can be saved as a draft, but not activated until this is fixed.</span>
                    </p>
                  )}
                  {manage && cap.state === "needs_permission" && cap.scope && (
                    <button type="button" className="btn-primary" disabled={!!busy} onClick={() => void askPermission(cap.scope!)}>
                      {busy === "scope" ? "Opening Shopify…" : "Give permission in Shopify"}
                    </button>
                  )}
                  {manage && (cap.state === "unchecked" || cap.state === "not_subscribed") && (
                    <button type="button" className="btn-secondary inline-flex items-center gap-1.5" disabled={!!busy} onClick={() => void checkShopify()}>
                      <RefreshCw aria-hidden className="h-4 w-4" /> {busy === "verify" ? "Checking with Shopify…" : "Check with Shopify"}
                    </button>
                  )}
                  {card.note && <p className="text-sm text-muted">{card.note}</p>}
                  {trigger === "customer_inactive" && (
                    <div className="max-w-xs">
                      <label className="label" htmlFor="auto-inactive">
                        Days without an order
                      </label>
                      <input id="auto-inactive" className="input" type="number" min={14} max={1095} value={d.inactiveDays} disabled={readOnly} onChange={(e) => set({ inactiveDays: e.target.value })} />
                    </div>
                  )}
                  {trigger === "customer_vip" && (
                    <div className="grid max-w-md gap-3 sm:grid-cols-2">
                      <div>
                        <label className="label" htmlFor="auto-vip-orders">
                          At least this many orders
                        </label>
                        <input id="auto-vip-orders" className="input" type="number" min={2} value={d.vipMinOrders} disabled={readOnly} onChange={(e) => set({ vipMinOrders: e.target.value })} />
                      </div>
                      <div>
                        <label className="label" htmlFor="auto-vip-spent">
                          Or spent at least
                        </label>
                        <input id="auto-vip-spent" className="input" type="number" min={1} step="0.01" value={d.vipMinSpent} disabled={readOnly} onChange={(e) => set({ vipMinSpent: e.target.value })} />
                      </div>
                    </div>
                  )}
                  {trigger === "customer_segment" && <SegmentPicker base={base} value={d.segmentId} disabled={readOnly} manage={manage} id="auto-join-segment" onChange={(segmentId) => set({ segmentId })} />}

                  {!daily && (
                    <fieldset className="space-y-2" disabled={readOnly}>
                      <legend className="label">Send it</legend>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Choice name="auto-timing" checked={d.timing === "now"} onChange={() => set({ timing: "now" })} title="Immediately" help="As soon as Shopify tells bizinsights." />
                        <Choice name="auto-timing" checked={d.timing === "delay"} onChange={() => set({ timing: "delay" })} title="After a delay" help="Wait a while first (up to 30 days)." />
                      </div>
                      {d.timing === "delay" && (
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          <label className="sr-only" htmlFor="auto-delay">
                            How long to wait
                          </label>
                          <input id="auto-delay" className="input w-28" type="number" min={1} value={d.delay} onChange={(e) => set({ delay: e.target.value })} />
                          <label className="sr-only" htmlFor="auto-unit">
                            Minutes, hours or days
                          </label>
                          <select id="auto-unit" className="input w-32" value={d.unit} onChange={(e) => set({ unit: e.target.value as Unit })}>
                            <option value="minutes">minutes</option>
                            <option value="hours">hours</option>
                            <option value="days">days</option>
                          </select>
                          <span className="text-sm text-muted">after it happens{trigger === "checkout_abandoned" ? " (the customer's last change at checkout)" : ""}.</span>
                        </div>
                      )}
                    </fieldset>
                  )}

                  <div className="max-w-md">
                    <label className="label" htmlFor="auto-name">
                      Automation name
                    </label>
                    <input id="auto-name" className="input" maxLength={80} value={d.name} disabled={readOnly} onChange={(e) => set({ name: e.target.value, nameTouched: true })} />
                    <p className="mt-1 text-xs text-muted">Only you and your team see it.</p>
                  </div>

                  <details className="rounded-xl border border-border p-4">
                    <summary className="cursor-pointer text-sm font-semibold">More timing options (optional)</summary>
                    <fieldset className="mt-4 space-y-4" disabled={readOnly}>
                      <p className="text-sm text-muted">{quietWords(d, store?.timezone)}. A text due then waits until they end.</p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <p className="label">Quiet hours</p>
                          <div className="flex flex-wrap items-center gap-2 text-sm">
                            <label className="sr-only" htmlFor="auto-qs">
                              Quiet from
                            </label>
                            <select id="auto-qs" className="input w-28" value={d.quietStart} onChange={(e) => set({ quietStart: Number(e.target.value) })}>
                              {Array.from({ length: 24 }, (_, h) => (
                                <option key={h} value={h}>
                                  {fmtHour(h)}
                                </option>
                              ))}
                            </select>
                            to
                            <label className="sr-only" htmlFor="auto-qe">
                              Quiet until
                            </label>
                            <select id="auto-qe" className="input w-28" value={d.quietEnd} onChange={(e) => set({ quietEnd: Number(e.target.value) })}>
                              {Array.from({ length: 24 }, (_, h) => (
                                <option key={h} value={h}>
                                  {fmtHour(h)}
                                </option>
                              ))}
                            </select>
                          </div>
                          <p className="mt-1 text-xs text-muted">The same hour twice: no quiet hours.</p>
                        </div>
                        <label className="flex items-start gap-2 text-sm sm:mt-7">
                          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={d.useCustomerTimezone} onChange={(e) => set({ useCustomerTimezone: e.target.checked })} />
                          <span>
                            Use the customer&apos;s time zone
                            <span className="block text-xs text-muted">Where their country has one time zone; otherwise your store&apos;s ({store?.timezone ?? "store time"}).</span>
                          </span>
                        </label>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        At most
                        <label className="sr-only" htmlFor="auto-max">
                          Texts per customer
                        </label>
                        <input id="auto-max" className="input w-20" type="number" min={1} max={100} placeholder={String(automationCapDefaults(trigger).maxPerCustomer)} value={d.maxPerCustomer} onChange={(e) => set({ maxPerCustomer: e.target.value })} />
                        text(s) from this automation per customer every
                        <label className="sr-only" htmlFor="auto-cap">
                          Days
                        </label>
                        <input id="auto-cap" className="input w-20" type="number" min={1} max={365} placeholder={String(automationCapDefaults(trigger).capDays)} value={d.capDays} onChange={(e) => set({ capDays: e.target.value })} />
                        day(s).
                      </div>
                      <label className="flex items-start gap-2 text-sm">
                        <input type="checkbox" role="switch" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={d.dryRun} onChange={(e) => set({ dryRun: e.target.checked })} />
                        <span>
                          Practice run
                          <span className="block text-xs text-muted">Record in Message History what it would send, and send nothing.</span>
                        </span>
                      </label>
                    </fieldset>
                  </details>
                </div>
              )}
              {triggers.data.contactsSeen === 0 && (
                <Hint>
                  No customer mobile number has reached bizinsights from this store yet. On a live store, Shopify shares customers&apos; phone numbers with bizinsights only once its access to protected
                  customer data is approved; until then automations record &ldquo;No mobile number&rdquo; instead of texting.
                </Hint>
              )}
              {tried && !valid[WHEN] && <Alert>{!trigger ? "Choose when it's sent." : !d.name.trim() ? "Give the automation a name." : (settingsAt(WHEN)[0]?.text ?? "Choose a trigger that's available for your store.")}</Alert>}
            </>
          )}

          {step === WHO && trigger && (
            <>
              <StepHeader n={2} title="Who should get this SMS?">
                {trigger === "customer_segment" ? "Customers who join the segment you chose in step 1." : "The text goes to the one customer each event is about. Narrow that down if you like."}
              </StepHeader>
              {trigger === "customer_segment" ? (
                <div className="rounded-xl border border-border p-4 text-sm">
                  <p className="font-medium">{audienceText}</p>
                  <button type="button" className="mt-1 text-accent underline-offset-2 hover:underline" onClick={() => void go(WHEN)}>
                    Change the segment
                  </button>
                </div>
              ) : (
                <fieldset className="space-y-2" disabled={readOnly}>
                  <legend className="sr-only">Recipients</legend>
                  <Choice name="auto-audience" checked={d.audienceKind === "trigger"} onChange={() => set({ audienceKind: "trigger" })} icon={<UserRound className="h-[18px] w-[18px]" />} title={TRIGGER_SUBJECT[trigger]} help="Customer who triggered the event: everyone it happens to." />
                  <Choice name="auto-audience" checked={d.audienceKind === "segment"} onChange={() => set({ audienceKind: "segment" })} icon={<Users className="h-[18px] w-[18px]" />} title="Customer segment" help="Only if the customer is in one of your saved segments, such as VIP customers.">
                    {d.audienceKind === "segment" && <SegmentPicker base={base} value={d.segmentId} disabled={readOnly} manage={manage} onChange={(segmentId) => set({ segmentId })} />}
                  </Choice>
                  <Choice name="auto-audience" checked={d.audienceKind === "customers"} onChange={() => set({ audienceKind: "customers" })} icon={<Wand2 className="h-[18px] w-[18px]" />} title="Specific customers" help="Only for customers you pick by name (up to 50).">
                    {d.audienceKind === "customers" && <CustomerPicker base={base} value={d.contactIds} disabled={readOnly} contact={contact} onChange={(contactIds) => set({ contactIds })} />}
                  </Choice>
                </fieldset>
              )}
              <AudienceCount estimate={estimate} loading={estimating} marketing={marketing} daily={daily} />

              {TRIGGER_CONDITION_FIELDS[trigger].length > 0 && (
                <details className="rounded-xl border border-border p-4" open={d.filter === "conditions"}>
                  <summary className="cursor-pointer text-sm font-semibold">Only when… (optional conditions)</summary>
                  <fieldset className="mt-3 space-y-2" disabled={readOnly}>
                    <legend className="sr-only">Conditions</legend>
                    <p className="text-sm text-muted">For example orders over 100, or customers in one country. All of them must hold.</p>
                    <ul className="space-y-2">
                      {d.conditions.map((c, i) => {
                        const input = VALUE_INPUT[c.field];
                        const setCond = (x: CondDraft) => set({ conditions: d.conditions.map((y, j) => (j === i ? x : y)) });
                        return (
                          <li key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(5rem,1fr)_auto]">
                            <select aria-label={`Condition ${i + 1}: what`} className="input" value={c.field} onChange={(e) => setCond({ field: e.target.value as RuleConditionField, op: OPS[e.target.value as RuleConditionField][0]!, value: "" })}>
                              {TRIGGER_CONDITION_FIELDS[trigger].map((f) => (
                                <option key={f} value={f}>
                                  {RULE_CONDITION_LABEL[f]}
                                </option>
                              ))}
                            </select>
                            <select aria-label={`Condition ${i + 1}: comparison`} className="input" value={c.op} onChange={(e) => setCond({ ...c, op: e.target.value })}>
                              {OPS[c.field].map((o) => (
                                <option key={o} value={o}>
                                  {OP_LABEL[o] ?? o}
                                </option>
                              ))}
                            </select>
                            <input aria-label={`Condition ${i + 1}: value`} className="input" type={input.kind === "number" ? "number" : "text"} step={input.step} min={input.kind === "number" ? 0 : undefined} placeholder={input.placeholder} value={c.value} onChange={(e) => setCond({ ...c, value: e.target.value })} />
                            <button type="button" className="btn-secondary h-9 px-3 text-xs" aria-label={`Remove condition ${i + 1}`} onClick={() => set({ conditions: d.conditions.filter((_, j) => j !== i), ...(d.conditions.length === 1 ? { filter: "all" as const } : {}) })}>
                              Remove
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    {d.conditions.length < 10 && (
                      <button
                        type="button"
                        className="text-sm text-accent underline-offset-2 hover:underline"
                        onClick={() => {
                          const field = TRIGGER_CONDITION_FIELDS[trigger][0]!;
                          set({ filter: "conditions", conditions: [...d.conditions, { field, op: OPS[field][0]!, value: "" }] });
                        }}
                      >
                        + Add a condition
                      </button>
                    )}
                    <p className="text-xs text-muted">Countries are two-letter codes separated by commas. A fact the event doesn&apos;t have makes its condition fail, never pass.</p>
                  </fieldset>
                </details>
              )}

              <div className="space-y-2 rounded-xl border border-border p-4 text-sm">
                <p className="flex gap-2">
                  <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-good" />
                  <span>
                    <strong>Only customers who may get it.</strong> {consentWords(trigger)} Checked when it happens and again right before the text goes.
                  </span>
                </p>
                <p className="flex gap-2">
                  <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-good" />
                  <span>
                    <strong>No duplicates.</strong> Each event texts a customer once, however often Shopify reports it.
                  </span>
                </p>
              </div>
              {tried && settingsAt(WHO).length > 0 && (
                <Alert>
                  <ul className="list-disc space-y-0.5 pl-4">
                    {settingsAt(WHO).map((p) => (
                      <li key={p.text}>{p.text}</li>
                    ))}
                  </ul>
                </Alert>
              )}
            </>
          )}

          {step === MESSAGE && trigger && (
            <>
              <StepHeader n={3} title="Write your message">
                What should the customer read? Add their name or order details with Personalize: each customer sees their own.
              </StepHeader>

              {AUTOMATION_STARTERS[trigger].length > 0 && (
                <div>
                  <p className="label flex items-center gap-1.5">
                    <Sparkles aria-hidden className="h-4 w-4 text-accent" /> Ready-made messages
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {AUTOMATION_STARTERS[trigger].map((s) => (
                      <button key={s.name} type="button" disabled={readOnly} aria-pressed={d.body === s.body} className={`rounded-full border px-3 py-1.5 text-sm transition ${d.body === s.body ? "border-accent bg-accent/10" : "border-border hover:border-accent"}`} onClick={() => set({ body: s.body })}>
                        {s.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <div className="flex flex-wrap items-end justify-between gap-2">
                  <label className="label mb-0" htmlFor="auto-message">
                    Message
                  </label>
                  <button type="button" className="btn-secondary inline-flex h-8 items-center gap-1.5 px-3 text-xs" aria-expanded={personalize} aria-controls="auto-personalize" disabled={readOnly} onClick={() => setPersonalize(!personalize)}>
                    <Wand2 aria-hidden className="h-3.5 w-3.5" /> Personalize
                  </button>
                </div>
                {personalize && (
                  <div id="auto-personalize" className="space-y-2 rounded-xl border border-border bg-bg/50 p-3" role="group" aria-label="Insert a detail">
                    <p className="text-xs text-muted">Click a detail to put it where your cursor is. Only details a &ldquo;{automationTriggerCard(trigger).label.toLowerCase()}&rdquo; event has are listed.</p>
                    {SMS_VARIABLE_GROUPS.map((g) => {
                      const vs = variables.filter((v) => SMS_VARIABLE_GROUP[v] === g);
                      if (!vs.length) return null;
                      return (
                        <div key={g} className="flex flex-wrap items-center gap-1.5">
                          <span className="w-16 shrink-0 text-xs font-semibold text-muted">{g}</span>
                          {vs.map((v) => (
                            <button key={v} type="button" className="rounded-full border border-border bg-surface px-2.5 py-1 text-xs transition hover:border-accent hover:bg-accent/5" title={SMS_VARIABLE_INFO[v].description} onClick={() => insert(v)}>
                              {SMS_VARIABLE_INFO[v].label} <span className="font-mono text-[10px] text-muted">{`{{${v}}}`}</span>
                            </button>
                          ))}
                        </div>
                      );
                    })}
                    {!TRIGGER_INFO[trigger].variables.includes("tracking_url") && <p className="text-xs text-muted">The tracking link is there only for shipped and delivered texts.</p>}
                  </div>
                )}
                <textarea
                  id="auto-message"
                  ref={editorRef}
                  className="input min-h-[9rem] text-base leading-relaxed"
                  maxLength={1000}
                  value={d.body}
                  disabled={readOnly}
                  aria-invalid={messageErrors.length > 0}
                  aria-describedby="auto-message-count auto-message-issues"
                  onChange={(e) => set({ body: e.target.value })}
                />
                <p id="auto-message-count" className="flex flex-wrap gap-x-4 text-xs tabular-nums text-muted" aria-live="polite">
                  <span>Characters: {segmentsInfo.characters}</span>
                  <span>
                    Estimated SMS segments: {segmentsInfo.segments}
                    {worst.segments > segmentsInfo.segments ? ` (up to ${worst.segments} with long names or links)` : ""}
                  </span>
                </p>
                {segmentsInfo.segments > 1 && (
                  <p className="flex gap-1.5 rounded-lg border border-warn/40 bg-warn/5 p-2.5 text-sm" role="status">
                    <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
                    <span>
                      This message is sent as {segmentsInfo.segments} SMS parts, and each part is charged{segmentsInfo.encoding === "UCS2" ? " (special characters make each part hold 70 characters instead of 160)" : ""}. Shorten it to fit in one.
                    </span>
                  </p>
                )}
                <div id="auto-message-issues" className="space-y-1 text-sm" aria-live="polite">
                  {fixVariableAliases(d.body) !== d.body && (
                    <p className="text-warn">
                      Some details are written differently from how bizinsights names them.{" "}
                      <button type="button" className="font-medium underline" disabled={readOnly} onClick={() => set({ body: fixVariableAliases(d.body) })}>
                        Fix them
                      </button>
                    </p>
                  )}
                  {issues.map((i) => (
                    <p key={i.code} className={`flex gap-1.5 ${i.level === "error" ? "text-danger" : "text-muted"}`}>
                      {i.level === "error" && <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />}
                      {i.message}
                      {i.code === "no_opt_out" && !readOnly && (
                        <button type="button" className="ml-1 font-medium underline" onClick={() => set({ body: `${d.body.trimEnd()} Opt out: {{opt_out_url}}` })}>
                          Add it
                        </button>
                      )}
                    </p>
                  ))}
                </div>
              </div>
              {d.body.includes("{{discount_code}}") && marketing && (
                <div className="max-w-xs">
                  <label className="label" htmlFor="auto-code">
                    Discount code
                  </label>
                  <input id="auto-code" className="input font-mono uppercase" maxLength={30} value={d.discountCode} disabled={readOnly} onChange={(e) => set({ discountCode: e.target.value.replace(/[^A-Za-z0-9_-]/g, "") })} />
                  <p className="mt-1 text-xs text-muted">Create the code in Shopify first: bizinsights only puts it in the text.</p>
                </div>
              )}
              {tried && messageErrors.length > 0 && <Alert>Fix the message first: {messageErrors[0]!.message}</Alert>}
              {tried && !messageErrors.length && settingsAt(MESSAGE).length > 0 && <Alert>{settingsAt(MESSAGE)[0]!.text}</Alert>}
            </>
          )}

          {step === TEST && trigger && (
            <>
              <StepHeader n={4} title="Send a test">
                See exactly what customers get, on your own phone. You can skip this and test later.
              </StepHeader>
              <TestStep automationId={saved?.id ?? null} setup={setup.data} readiness={readiness} base={base} manage={manage} dirty={dirty} onSetup={setup.setData} />
            </>
          )}

          {step === REVIEW && trigger && (
            <>
              <StepHeader n={5} title="Review and activate">
                Click any part to change it. When it checks out, activate it: it runs by itself from then on.
              </StepHeader>
              <ReviewStep
                name={d.name}
                trigger={trigger}
                audience={audienceText}
                recipients={recipientsText}
                sender={senderPreview.approved ? senderPreview.label : "your SMS sender"}
                message={text}
                timing={settings.length ? "Not finished" : daily ? "Checked once a day" : timingWords(toInput(d) as SmsAutomationInput)}
                saved={saved}
                dirty={dirty}
                checks={checks.data}
                checksLoading={checks.loading}
                manage={manage}
                busy={busy}
                onGo={(i) => void go(i)}
                onTest={() => void go(TEST)}
                onActivate={() => setConfirm("activate")}
                onPause={() => setConfirm("pause")}
                onSave={() => void save()}
              />
            </>
          )}

          {step < REVIEW && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
              <button type="button" className="btn-secondary" disabled={step === 0 || !!busy} onClick={() => void go(step - 1)}>
                ← Back
              </button>
              <button type="button" className="btn-primary" disabled={!!busy} onClick={() => void next()}>
                {busy === "save" ? "Saving…" : step === MESSAGE && manage ? "Save and continue" : step === TEST ? "Continue to review" : "Continue"}
              </button>
            </div>
          )}
        </section>

        <aside className="space-y-3 lg:sticky lg:top-4" aria-label="Preview">
          <PhonePreview sender={senderPreview} text={text} segments={segmentsInfo} worstParts={worst.segments} />
          {trigger && (
            <div className="card space-y-1.5 text-xs text-muted">
              <p className="flex items-center gap-1.5 font-medium text-text">
                <TriggerIcon trigger={trigger} className="h-4 w-4 text-accent" /> {automationTriggerCard(trigger).label}
              </p>
              <p>{audienceText}</p>
              <p>{settings.length ? "Timing not finished" : daily ? "Checked once a day" : timingWords(toInput(d) as SmsAutomationInput)}</p>
              <p>Shown with a sample customer, Sarah, and her order #1042.</p>
            </div>
          )}
        </aside>
      </div>

      <ActivateDialog
        open={confirm === "activate"}
        name={d.name}
        trigger={trigger}
        body={d.body}
        business={business}
        mode={mode}
        problems={problems}
        republish={on}
        busy={busy === "activate"}
        onConfirm={() => void activate()}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog open={confirm === "pause"} title={`Pause "${d.name}"?`} confirmLabel="Pause" busy={busy === "pause"} onConfirm={() => void pause()} onCancel={() => setConfirm(null)}>
        <p>It stops at once, and its texts still waiting to go are cancelled. Switch it back on any time.</p>
      </ConfirmDialog>
    </div>
  );
}
