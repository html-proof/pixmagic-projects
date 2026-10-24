"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, ChevronDown, CircleAlert, Clock, Info, Lock, MessageSquareText, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { callingCode, normalizePhone, PHONE_COUNTRIES } from "@app/shared/whatsapp";
import {
  AUTOMATION_STARTERS,
  AUTOMATION_STEPS,
  AUTOMATION_TRIGGER_CARDS,
  automationCapDefaults,
  automationTriggerCard,
  automationVariables,
  checkAutomationMessage,
  checkSenderName,
  fixVariableAliases,
  RULE_CONDITION_LABEL,
  SENDER_ID_SUPPORT,
  SENDER_NAME_MAX,
  SMS_VARIABLE_INFO,
  smsAutomationSchema,
  smsSegments,
  suggestSenderName,
  TRIGGER_CONDITION_FIELDS,
  TRIGGER_INFO,
  worstCaseSegments,
  type AutomationStep,
  type RuleConditionField,
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
import { ActivateDialog, AUTOMATION_STATUS, consentWords, previewText, problemsFor, quietWords, timingWords, TriggerIcon } from "./AutomationUi";
import { COUNTRY_CHOICES, countryName, fmtHour, fmtWhen, ModeBanner, smsError, SmsStatusBadge, useSms } from "./MessagingUi";
import { PhonePreview, type PreviewSender } from "./PhonePreview";
import { OP_LABEL, OPS, VALUE_INPUT } from "./RuleEditor";
import { SENDER_STATUS, testOutcome } from "./Setup";
import type { AutomationsResponse, AutomationView, SmsMessage, SmsSetupState, TriggerCapability, TriggersResponse } from "./types";

// ---------------------------------------------------------------------------
// The automation builder: four steps (trigger, message, timing, test and activate) beside a phone
// showing the text as a customer gets it. Every check here is also the API's
// (apps/api/src/routes/smsAutomations.ts, @app/shared/sms); nothing is sent by saving, and an
// automation is "on" only when the API says its rule is active.
// ---------------------------------------------------------------------------

const STEP_LABEL: Record<AutomationStep, string> = { trigger: "Trigger", message: "Message", timing: "Timing", activate: "Test & activate" };

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
}

const defaultName = (t: SmsTrigger) => `${automationTriggerCard(t).label} text`;

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
  };
}

const num = (s: string) => (s.trim() === "" ? Number.NaN : Number(s));
const optional = (s: string) => (s.trim() === "" ? null : Number(s));

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
};

/** The schema's complaints in the form's words. */
function settingsProblems(d: Draft): string[] {
  if (!d.trigger) return ["Choose a trigger."];
  const r = smsAutomationSchema.safeParse(toInput(d));
  if (r.success) return [];
  return r.error.issues.map((i) => {
    const [head, index] = i.path;
    const where = head === "conditions" && typeof index === "number" ? `Condition ${index + 1}` : (PATH_LABEL[String(head)] ?? String(head));
    const msg = i.code === "invalid_type" && i.expected === "number" ? "enter a number" : i.code === "too_big" && head === "delayMinutes" ? "at most 30 days" : i.message;
    return `${where}: ${msg}`;
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

/** The duplicate rule in words: "Each event once; at most 10 texts per customer a day." */
const capWords = (max: number, days: number) => `Each event texts a customer once; at most ${max} ${max === 1 ? "text" : "texts"} per customer ${days === 1 ? "a day" : `every ${days} days`}.`;

/** A fresh id for one press of a button (the API returns the same text for a repeat of it). */
const requestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
const LIVE = new Set(["scheduled", "sending", "accepted", "pending"]);
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

/** The four steps across the top: done, current or to come; a step can be opened once the ones before it are complete. */
function Progress({ step, reachable, onGo }: { step: number; reachable: number; onGo: (i: number) => void }) {
  return (
    <nav aria-label="Automation steps">
      <div className="h-1.5 rounded-full bg-bg" aria-hidden>
        <div className="h-1.5 rounded-full bg-accent transition-all" style={{ width: `${((step + 1) / AUTOMATION_STEPS.length) * 100}%` }} />
      </div>
      <ol className="mt-2 grid grid-cols-4 gap-1">
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

export function AutomationBuilder() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { workspace } = useApp();
  const { base, manage, store } = useSms();
  const [id, setId] = useState<string | null>(params.get("id"));
  const triggers = useApi<TriggersResponse>(base ? `${base}/automations/triggers` : null);
  const setup = useApi<SmsSetupState>(base ? `${base}/setup` : null);
  const list = useApi<AutomationsResponse>(base ? `${base}/automations` : null);
  const existing = useApi<{ automation: AutomationView }>(base && id ? `${base}/automations/${id}` : null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<AutomationView | null>(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [moreTriggers, setMoreTriggers] = useState(false);
  const [confirm, setConfirm] = useState<"activate" | "pause" | null>(null);
  const verified = useRef(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  // The draft, once: an existing automation's settings, else a new one (?trigger= picks its trigger).
  useEffect(() => {
    if (draft || !setup.data) return;
    if (id) {
      if (!existing.data) return;
      setSaved(existing.data.automation);
      const c = existing.data.automation.config;
      setDraft(c ? fromConfig(c) : { ...blank(null, [21, 9]), name: existing.data.automation.name, nameTouched: true });
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
  // A saved automation whose trigger Shopify no longer sends can still be edited (not switched on).
  const valid = [!!trigger && (selectable(cap) || !!id) && !!d.name.trim() && !settings.some((p) => /^(Trigger|Name|Days without|VIP)/.test(p)), !!trigger && !messageErrors.length, !settings.length, true];
  const reachable = valid.findIndex((v) => !v) === -1 ? 3 : Math.min(3, valid.findIndex((v) => !v));
  const readOnly = !manage;
  const problems = list.data?.problems ?? [];
  const mode = list.data?.mode ?? setup.data.mode;
  const text = trigger ? previewText(d.body, trigger, business) : "";
  // Compared as the API takes them (one key order, defaults as null).
  const dirty = !saved?.config || JSON.stringify(toInput(fromConfig(saved.config))) !== JSON.stringify(toInput(d));

  const go = (i: number) => {
    setStep(i);
    setProblem(null);
    setTried(false);
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
      if (!quiet) toast("success", r.automation.status === "active" ? "Saved. Your changes go live when you put them live in step 4." : "Saved as a draft. Nothing is sent until you turn it on.");
      return r.automation;
    } catch (e) {
      setProblem(smsError(e, "save the automation"));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const next = async () => {
    setTried(true);
    if (!valid[step]) return;
    if (step === 2 && manage && (dirty || !saved)) {
      if (!(await save(true))) return;
    }
    go(step + 1);
  };

  const changeTrigger = (t: SmsTrigger) => {
    if (t === trigger) return;
    const fresh = blank(t, [d.quietStart, d.quietEnd]);
    // A message written for another trigger rarely fits: start from this one's, unless it's the merchant's own and still fits.
    const own = d.body.trim() && !Object.values(AUTOMATION_STARTERS).some((list) => list.some((s) => s.body === d.body));
    const keepBody = own && !checkAutomationMessage(d.body, t, d.discountCode).some((i) => i.level === "error" && i.code !== "discount_code");
    setDraft({ ...fresh, name: d.nameTouched ? d.name : fresh.name, nameTouched: d.nameTouched, body: keepBody ? d.body : fresh.body, quietStart: d.quietStart, quietEnd: d.quietEnd, useCustomerTimezone: d.useCustomerTimezone, dryRun: d.dryRun, priority: d.priority });
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
      setProblem(smsError(e, "ask Shopify for permission"));
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
      setProblem(smsError(e, "check with Shopify"));
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
      const r = await api<{ automation: AutomationView }>(`${base}/automations/${current.id}/activate`, { method: "POST", body: { confirm: true } });
      setSaved(r.automation);
      void list.reload();
      toast("success", mode === "live" ? "It's on." : "It's on. In test mode its texts are recorded, not sent.");
    } catch (e) {
      setProblem(smsError(e, "turn the automation on"));
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
      toast("success", "Paused. Its texts still waiting were cancelled.");
    } catch (e) {
      setProblem(smsError(e, "pause the automation"));
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const mains = AUTOMATION_TRIGGER_CARDS.filter((c) => c.main);
  const extras = AUTOMATION_TRIGGER_CARDS.filter((c) => !c.main);
  const card = trigger ? automationTriggerCard(trigger) : null;
  const on = saved?.status === "active";
  const segments = smsSegments(text);
  const worst = worstCaseSegments(d.body);

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
              <TriggerIcon trigger={c.trigger} className="h-[18px] w-[18px]" />
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
            <Badge tone={state.tone}>{state.label}</Badge>
            {capability?.state === "ready" && capability.lastEventAt && <span className="text-muted">Last event from Shopify {fmtWhen(capability.lastEventAt, store?.timezone)}</span>}
          </span>
        </button>
      </li>
    );
  };

  return (
    <div className="space-y-4">
      <section className="card animate-rise space-y-4" aria-labelledby="builder-h">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 id="builder-h" className="flex flex-wrap items-center gap-2 text-lg font-semibold">
              <MessageSquareText aria-hidden className="h-5 w-5 text-accent" /> {id ? `Edit automation` : "Create automation"}
              {saved && <Badge tone={AUTOMATION_STATUS[saved.status].tone}>{AUTOMATION_STATUS[saved.status].label}</Badge>}
              {saved?.pendingChanges && <Badge tone="warn">Changes not live</Badge>}
            </h1>
            <p className="mt-1 text-sm text-muted">Choose what starts it, write the text, set when it goes, then test it and switch it on. Nothing is sent until you do.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/messaging/automations" className="btn-secondary inline-flex items-center gap-1.5">
              <ArrowLeft aria-hidden className="h-4 w-4" /> All automations
            </Link>
            {manage && step < 3 && (
              <button type="button" className="btn-secondary" disabled={!!busy || !valid[0] || !valid[1] || !valid[2]} title={!valid[1] ? "Fix the message first" : undefined} onClick={() => void save()}>
                {busy === "save" ? "Saving…" : "Save draft"}
              </button>
            )}
          </div>
        </div>
        <Progress step={step} reachable={reachable} onGo={go} />
      </section>

      <ModeBanner mode={mode} />
      {readOnly && (
        <Alert kind="info">
          <Lock aria-hidden className="mr-1 inline h-4 w-4" /> Only owners and admins can change automations. You can look through each step.
        </Alert>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="card animate-rise min-w-0 space-y-5">
          {problem && <Alert onDismiss={() => setProblem(null)}>{problem}</Alert>}

          {step === 0 && (
            <>
              <StepHeader n={1} title="Choose a trigger">
                What should send the text? Only events Shopify really sends bizinsights for your store can be chosen.
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

              {triggers.data.triggers
                .filter((c) => c.state === "unavailable" || c.state === "not_sent")
                .some((c) => mains.some((m) => m.key === c.key)) && (
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

              {card && cap && (
                <div className="space-y-3 rounded-xl border border-border p-4">
                  {cap.state === "ready" ? (
                    <p className="flex gap-2 text-sm">
                      <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-good" />
                      <span>
                        Shopify sends bizinsights this event for your store
                        {cap.checkedAt ? ` (confirmed with Shopify ${fmtWhen(cap.checkedAt, store?.timezone)})` : ""}.{" "}
                        {cap.lastEventAt ? `The last one arrived ${fmtWhen(cap.lastEventAt, store?.timezone)}.` : "None has arrived in the last 90 days yet."}
                      </span>
                    </p>
                  ) : (
                    <p className="flex gap-2 text-sm text-warn">
                      <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{cap.reason} It can be saved as a draft, but not switched on until this is fixed.</span>
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
                  <div className="max-w-md">
                    <label className="label" htmlFor="auto-name">
                      Automation name
                    </label>
                    <input id="auto-name" className="input" maxLength={80} value={d.name} disabled={readOnly} onChange={(e) => set({ name: e.target.value, nameTouched: true })} />
                    <p className="mt-1 text-xs text-muted">Only you and your team see it.</p>
                  </div>
                </div>
              )}
              {triggers.data.contactsSeen === 0 && (
                <Hint>
                  No customer mobile number has reached bizinsights from this store yet. On a live store, Shopify shares customers&apos; phone numbers with bizinsights only once its access to protected
                  customer data is approved; until then automations record &ldquo;No mobile number&rdquo; instead of texting.
                </Hint>
              )}
              {tried && !valid[0] && <Alert>{!trigger ? "Choose a trigger." : !d.name.trim() ? "Give the automation a name." : (settings[0] ?? "Choose a trigger that's available for your store.")}</Alert>}
            </>
          )}

          {step === 1 && trigger && (
            <>
              <StepHeader n={2} title="Create the message">
                What should the customer read? Click a detail to add it: each customer sees their own.
              </StepHeader>
              <SenderPanel setup={setup.data} base={base} manage={manage} business={business} onChange={setup.setData} />

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
                <label className="label" htmlFor="auto-message">
                  Message
                </label>
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
                <p id="auto-message-count" className="text-xs tabular-nums text-muted" aria-live="polite">
                  {segments.characters} character{segments.characters === 1 ? "" : "s"} · {segments.segments} SMS part{segments.segments === 1 ? "" : "s"} in the preview
                  {worst.segments > segments.segments ? `, up to ${worst.segments} with long names or links` : ""}
                </p>
                <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Insert a detail">
                  <span className="text-xs text-muted">Insert:</span>
                  {automationVariables(trigger).map((v) => (
                    <button key={v} type="button" className="rounded-full border border-border px-2.5 py-1 text-xs transition hover:border-accent hover:bg-accent/5" disabled={readOnly} title={SMS_VARIABLE_INFO[v].description} onClick={() => insert(v)}>
                      {SMS_VARIABLE_INFO[v].label}
                    </button>
                  ))}
                </div>
                {!TRIGGER_INFO[trigger].variables.includes("tracking_url") && <p className="text-xs text-muted">The tracking link is there only for shipped and delivered texts.</p>}
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
              {d.body.includes("{{discount_code}}") && TRIGGER_INFO[trigger].category === "marketing" && (
                <div className="max-w-xs">
                  <label className="label" htmlFor="auto-code">
                    Discount code
                  </label>
                  <input id="auto-code" className="input font-mono uppercase" maxLength={30} value={d.discountCode} disabled={readOnly} onChange={(e) => set({ discountCode: e.target.value.replace(/[^A-Za-z0-9_-]/g, "") })} />
                  <p className="mt-1 text-xs text-muted">Create the code in Shopify first: bizinsights only puts it in the text.</p>
                </div>
              )}
              {tried && messageErrors.length > 0 && <Alert>Fix the message first: {messageErrors[0]!.message}</Alert>}
            </>
          )}

          {step === 2 && trigger && (
            <>
              <StepHeader n={3} title="Set the timing">
                When should it go, and to whom? The usual choices are already set; change them only if you need to.
              </StepHeader>
              <fieldset className="space-y-2" disabled={readOnly}>
                <legend className="label">When</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      ["now", "Send immediately", "As soon as Shopify tells bizinsights."],
                      ["delay", "Send after a delay", "Wait a while first (up to 30 days)."],
                    ] as const
                  ).map(([v, label, help]) => (
                    <label key={v} className={`flex cursor-pointer gap-3 rounded-xl border-2 p-3 ${d.timing === v ? "border-accent bg-accent/5" : "border-border"}`}>
                      <input type="radio" name="auto-timing" className="mt-1 accent-[var(--accent)]" checked={d.timing === v} onChange={() => set({ timing: v })} />
                      <span>
                        <span className="block font-medium">{label}</span>
                        <span className="block text-sm text-muted">{help}</span>
                      </span>
                    </label>
                  ))}
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
                    <span className="text-sm text-muted">after the event{trigger === "checkout_abandoned" ? " (the customer's last change at checkout)" : ""}.</span>
                  </div>
                )}
              </fieldset>

              <fieldset className="space-y-2" disabled={readOnly}>
                <legend className="label">Who</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      ["all", "Everyone it applies to", "Every customer the trigger is about."],
                      ["conditions", "Only when conditions match", "For example orders over 100, or one country."],
                    ] as const
                  ).map(([v, label, help]) => (
                    <label key={v} className={`flex cursor-pointer gap-3 rounded-xl border-2 p-3 ${d.filter === v ? "border-accent bg-accent/5" : "border-border"} ${v === "conditions" && !TRIGGER_CONDITION_FIELDS[trigger].length ? "opacity-50" : ""}`}>
                      <input
                        type="radio"
                        name="auto-filter"
                        className="mt-1 accent-[var(--accent)]"
                        checked={d.filter === v}
                        disabled={v === "conditions" && !TRIGGER_CONDITION_FIELDS[trigger].length}
                        onChange={() => {
                          const field = TRIGGER_CONDITION_FIELDS[trigger][0];
                          set({ filter: v, conditions: v === "conditions" && !d.conditions.length && field ? [{ field, op: OPS[field][0]!, value: "" }] : d.conditions });
                        }}
                      />
                      <span>
                        <span className="block font-medium">{label}</span>
                        <span className="block text-sm text-muted">{help}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {d.filter === "conditions" && (
                  <div className="space-y-2 pt-1">
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
                          set({ conditions: [...d.conditions, { field, op: OPS[field][0]!, value: "" }] });
                        }}
                      >
                        + Add a condition
                      </button>
                    )}
                    <p className="text-xs text-muted">All of them must hold. Countries are two-letter codes separated by commas. A fact the event doesn&apos;t have makes its condition fail, never pass.</p>
                  </div>
                )}
              </fieldset>

              <div className="space-y-2 rounded-xl border border-border p-4 text-sm">
                <p className="flex gap-2">
                  <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-good" />
                  <span>
                    <strong>Consent.</strong> {consentWords(trigger)} Checked when the event arrives and again right before the text goes.
                  </span>
                </p>
                <p className="flex gap-2">
                  <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-good" />
                  <span>
                    <strong>No duplicates.</strong> Each event texts a customer once, however often Shopify reports it, and the same message reaches a customer once per order even when two automations match.
                  </span>
                </p>
                <p className="flex gap-2">
                  <Clock aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                  <span>
                    <strong>Quiet hours.</strong> {quietWords(d, store?.timezone)}. A text due then waits until they end.
                  </span>
                </p>
              </div>

              <details className="rounded-xl border border-border p-4">
                <summary className="cursor-pointer text-sm font-semibold">Advanced settings (optional)</summary>
                <fieldset className="mt-4 space-y-4" disabled={readOnly}>
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
              {tried && settings.length > 0 && (
                <Alert>
                  <ul className="list-disc space-y-0.5 pl-4">
                    {settings.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </Alert>
              )}
            </>
          )}

          {step === 3 && trigger && (
            <ActivateStep
              draft={d}
              saved={saved}
              dirty={dirty}
              capability={cap}
              business={business}
              problems={problems}
              setup={setup.data}
              base={base}
              manage={manage}
              busy={busy}
              onSetup={setup.setData}
              onSave={() => void save()}
              onToggle={() => setConfirm(on ? "pause" : "activate")}
              onPublish={() => setConfirm("activate")}
            />
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
            <button type="button" className="btn-secondary" disabled={step === 0 || !!busy} onClick={() => go(step - 1)}>
              Back
            </button>
            {step < 3 ? (
              <button type="button" className="btn-primary" disabled={!!busy} onClick={() => void next()}>
                {busy === "save" ? "Saving…" : step === 2 ? (manage ? "Save and continue" : "Continue") : "Continue"}
              </button>
            ) : (
              <Link href="/messaging/automations" className="btn-primary">
                Done
              </Link>
            )}
          </div>
        </section>

        <aside className="space-y-3 lg:sticky lg:top-4" aria-label="Preview">
          <PhonePreview sender={senderPreview} text={text} segments={segments} worstParts={worst.segments} />
          {trigger && (
            <div className="card space-y-1.5 text-xs text-muted">
              <p className="flex items-center gap-1.5 font-medium text-text">
                <TriggerIcon trigger={trigger} className="h-4 w-4 text-accent" /> {automationTriggerCard(trigger).label}
              </p>
              <p>{settings.length ? "Timing not finished" : timingWords(toInput(d) as SmsAutomationInput)}</p>
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

/** Step 2's sender: approved, asked for, or to choose; the name is the store's, the same for all its texts. */
function SenderPanel({ setup, base, manage, business, onChange }: { setup: SmsSetupState; base: string; manage: boolean; business: string; onChange: (s: SmsSetupState) => void }) {
  const toast = useToast();
  const s = setup.senderName;
  const [country, setCountry] = useState(s.country ?? "");
  const [name, setName] = useState(s.name ?? suggestSenderName(business));
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const check = checkSenderName(name, country || null);
  const approved = setup.sender?.identityCheck === "verified";
  const status = SENDER_STATUS[s.status] ?? SENDER_STATUS.draft!;
  const dirty = (name.trim() || null) !== s.name || (country || null) !== (s.countryChosen ? s.country : null);
  const countries = [...new Set([...COUNTRY_CHOICES, ...Object.keys(SENDER_ID_SUPPORT)])].sort((a, b) => countryName(a).localeCompare(countryName(b)));

  const run = async (key: string, what: string, fn: () => Promise<SmsSetupState>, done?: string) => {
    setBusy(key);
    setProblem(null);
    try {
      onChange(await fn());
      if (done) toast("success", done);
    } catch (e) {
      setProblem(smsError(e, what));
    } finally {
      setBusy(null);
    }
  };
  const saveName = () => api<SmsSetupState>(`${base}/setup`, { method: "PUT", body: { senderName: name.trim() || null, country: country || null } });

  if (approved && setup.sender) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-4 text-sm">
        <ShieldCheck aria-hidden className="h-5 w-5 text-good" />
        <p className="min-w-0 flex-1">
          Texts come from <strong className="font-mono">{setup.sender.identityLabel}</strong>, approved by AWS. Your sender is the same for all your texts.
        </p>
        <Badge tone="good">Approved</Badge>
        <Link href="/messaging/setup?step=sender" className="text-accent underline-offset-2 hover:underline">
          Change
        </Link>
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">Sender name</p>
        <Badge tone={dirty ? "neutral" : status.tone}>{dirty ? "Not saved" : status.label}</Badge>
      </div>
      <p className="text-sm text-muted">What customers see the text as coming from. It&apos;s the same for all your texts, and AWS has to approve it (some countries also need it registered) before any text uses it.</p>
      {problem && <Alert onDismiss={() => setProblem(null)}>{problem}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="auto-sender-country">
            Where are most of your customers?
          </label>
          <select id="auto-sender-country" className="input" value={country} disabled={!manage} onChange={(e) => setCountry(e.target.value)}>
            <option value="">Choose a country…</option>
            {countries.map((c) => (
              <option key={c} value={c}>
                {countryName(c)}
              </option>
            ))}
          </select>
        </div>
        {check.support !== "none" && (
          <div>
            <label className="label" htmlFor="auto-sender-name">
              Sender name
            </label>
            <input id="auto-sender-name" className="input font-mono uppercase tracking-wide" maxLength={20} autoComplete="off" spellCheck={false} value={name} disabled={!manage} aria-invalid={!!name && check.problems.length > 0} onChange={(e) => setName(e.target.value)} />
          </div>
        )}
      </div>
      {name && check.problems.length > 0 && check.support !== "none" && (
        <ul className="space-y-0.5 text-sm text-danger" aria-live="polite">
          {check.problems.map((p) => (
            <li key={p} className="flex gap-1.5">
              <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              {p}
            </li>
          ))}
        </ul>
      )}
      {country && (
        <p className="text-sm text-muted">
          Customers in {countryName(country)} see: <span className="font-medium text-text">{check.customerSees}</span>. {check.next}
        </p>
      )}
      {!dirty && s.status !== "draft" && <p className="text-xs text-muted">{status.help}</p>}
      {manage && (
        <div className="flex flex-wrap gap-2">
          {(dirty || s.status === "draft" || s.status === "unavailable" || s.status === "needs_changes") && (
            <button
              type="button"
              className="btn-secondary"
              disabled={!!busy || !country || (check.support !== "none" && check.problems.length > 0) || country === "IN"}
              onClick={() =>
                void run(
                  "request",
                  "send the request",
                  async () => {
                    await saveName();
                    return (await api<{ setup: SmsSetupState }>(`${base}/setup/sender/request`, { method: "POST", body: {} })).setup;
                  },
                  "Requested. bizinsights sets it up with AWS for you.",
                )
              }
            >
              {busy === "request" ? "Requesting…" : check.support === "none" ? "Request a sending number" : check.support === "registered" ? "Register sender name" : "Request sender name"}
            </button>
          )}
          {!dirty && s.status !== "draft" && (
            <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void run("check", "check with AWS", async () => (await api<{ setup: SmsSetupState }>(`${base}/setup/sender/check`, { method: "POST", body: {} })).setup)}>
              {busy === "check" ? "Checking with AWS…" : "Check status"}
            </button>
          )}
          {s.sharedAvailable && (
            <button
              type="button"
              className="btn-secondary"
              disabled={!!busy || !country}
              onClick={() => void run("shared", "use the shared sender", async () => (await saveName(), api<SmsSetupState>(`${base}/setup/sender/shared`, { method: "POST", body: {} })), "You're using bizinsights' shared sender for now.")}
            >
              Use bizinsights&apos; shared sender for now
            </button>
          )}
        </div>
      )}
      {country === "IN" && (
        <p className="text-sm text-warn">
          Texts to India need your own DLT registration: set it up in{" "}
          <Link className="underline" href="/messaging/sender">
            Sender Configuration
          </Link>
          .
        </p>
      )}
    </div>
  );
}

/** Step 4: the summary, what still stops it, a test text to a verified number, and the switch. */
function ActivateStep({
  draft: d,
  saved,
  dirty,
  capability,
  business,
  problems,
  setup,
  base,
  manage,
  busy,
  onSetup,
  onSave,
  onToggle,
  onPublish,
}: {
  draft: Draft;
  saved: AutomationView | null;
  dirty: boolean;
  capability: TriggerCapability | undefined;
  business: string;
  problems: AutomationsResponse["problems"];
  setup: SmsSetupState;
  base: string;
  manage: boolean;
  busy: string | null;
  onSetup: (s: SmsSetupState) => void;
  onSave: () => void;
  /** The switch: on asks to activate, off asks to pause. */
  onToggle: () => void;
  /** "Put changes live" on a running automation. */
  onPublish: () => void;
}) {
  const { store } = useSms();
  const trigger = d.trigger!;
  const input = toInput(d) as SmsAutomationInput;
  const on = saved?.status === "active";
  const blocking = problemsFor(problems, TRIGGER_INFO[trigger].category);
  const triggerOk = capability?.state === "ready";
  const messageOk = !checkAutomationMessage(d.body, trigger, d.discountCode).some((i) => i.level === "error");
  const checks: Array<{ key: string; ok: boolean; text: string }> = [
    { key: "trigger", ok: triggerOk, text: triggerOk ? "Shopify sends this trigger for your store." : (capability?.reason ?? "Shopify doesn't send this trigger for your store.") },
    { key: "message", ok: messageOk, text: messageOk ? "The message fits its trigger." : "The message has a problem: fix it in step 2." },
    { key: "saved", ok: !!saved && !dirty, text: saved && !dirty ? "Saved." : "Your latest changes aren't saved yet." },
  ];
  // Switching on saves the latest changes first, so only the trigger and the message must be right.
  const canActivate = manage && triggerOk && messageOk;

  return (
    <>
      <StepHeader n={4} title="Test and activate">
        Check the summary, send yourself a test, then switch it on.
      </StepHeader>

      <dl className="divide-y divide-border rounded-xl border border-border text-sm">
        {(
          [
            ["Trigger", <span key="t" className="inline-flex items-center gap-1.5"><TriggerIcon trigger={trigger} className="h-4 w-4 text-accent" /> {automationTriggerCard(trigger).label}</span>],
            ["Message", <span key="m" className="whitespace-pre-wrap">{previewText(d.body, trigger, business)}</span>],
            ["Timing", timingWords(input)],
            ["Quiet hours", quietWords(input, store?.timezone)],
            ["Who gets it", consentWords(trigger)],
            ["Duplicates", `${capWords(input.maxPerCustomer ?? automationCapDefaults(trigger).maxPerCustomer, input.capDays ?? automationCapDefaults(trigger).capDays)}${d.dryRun ? " Practice run: nothing is sent." : ""}`],
          ] as Array<[string, ReactNode]>
        ).map(([k, v]) => (
          <div key={k} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[8rem_1fr]">
            <dt className="text-muted">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>

      <ul className="space-y-1.5 text-sm" aria-label="Checks">
        {checks.map((c) => (
          <li key={c.key} className={`flex gap-2 ${c.ok ? "" : "text-warn"}`}>
            {c.ok ? <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-good" /> : <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />}
            {c.text}
            {!c.ok && c.key === "saved" && manage && (
              <button type="button" className="font-medium underline" disabled={!!busy} onClick={onSave}>
                Save now
              </button>
            )}
          </li>
        ))}
      </ul>

      {blocking.length > 0 && (
        <div className="rounded-xl border border-warn/40 bg-warn/5 p-4 text-sm">
          <p className="font-medium">Before texts reach customers:</p>
          <ul className="mt-1 space-y-1">
            {blocking.map((p) => (
              <li key={p.code} className="flex flex-wrap items-baseline gap-x-2">
                <span>{p.message}</span>
                {p.fix && (
                  <Link className="font-medium text-accent underline" href={p.fix.href}>
                    {p.fix.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">You can switch the automation on now: it starts texting once these are sorted.</p>
        </div>
      )}

      {manage && saved && <TestPanel automationId={saved.id} setup={setup} base={base} disabled={dirty} onSetup={onSetup} />}

      <div className={`rounded-xl border-2 p-4 ${on ? "border-good/60 bg-good/5" : "border-border"}`}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-base font-semibold">
              Automation {saved ? <Badge tone={AUTOMATION_STATUS[saved.status].tone}>{AUTOMATION_STATUS[saved.status].label}</Badge> : <Badge tone="neutral">Not saved</Badge>}
              {saved?.pendingChanges && <Badge tone="warn">Changes not live</Badge>}
            </p>
            <p className="text-sm text-muted">
              {on
                ? saved?.pendingChanges || dirty
                  ? "It's running the version you switched on. Put your changes live to run them instead."
                  : `It runs every time: ${automationTriggerCard(trigger).label.toLowerCase()}.`
                : "Off: nothing is sent."}
            </p>
          </div>
          {manage && (
            <label className="inline-flex cursor-pointer items-center gap-2">
              <input type="checkbox" role="switch" className="h-6 w-6 accent-[var(--accent)]" aria-label="Automation on" checked={on} disabled={!!busy || (!on && !canActivate)} onChange={onToggle} />
            </label>
          )}
        </div>
        {manage && on && (saved?.pendingChanges || dirty) && (
          <div className="mt-3">
            <button type="button" className="btn-primary" disabled={!!busy || !canActivate} onClick={onPublish}>
              {busy === "activate" ? "Working…" : "Put changes live"}
            </button>
          </div>
        )}
        {saved && (
          <p className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3 text-xs text-muted" aria-live="polite">
            {saved.lastResult ? (
              <>
                Last text {fmtWhen(saved.lastResult.at, store?.timezone)}: <SmsStatusBadge status={saved.lastResult.status} why={saved.lastResult.reasonLabel} />
                {saved.lastResult.reasonLabel && <span>{saved.lastResult.reasonLabel}</span>}
              </>
            ) : saved.lastRunAt ? (
              `Last ran ${fmtWhen(saved.lastRunAt, store?.timezone)}`
            ) : on ? (
              "Hasn't run yet: it runs the next time the trigger happens."
            ) : (
              "Hasn't run yet."
            )}
          </p>
        )}
      </div>
    </>
  );
}

/** A verified number of the team's own, and the saved message texted to it, followed to its outcome. */
function TestPanel({ automationId, setup, base, disabled, onSetup }: { automationId: string; setup: SmsSetupState; base: string; disabled: boolean; onSetup: (s: SmsSetupState) => void }) {
  const toast = useToast();
  const verified = setup.testNumbers.filter((t) => t.status === "verified");
  const pending = setup.testNumbers.filter((t) => t.status !== "verified");
  const [numberId, setNumberId] = useState(verified[0]?.id ?? "");
  const [country, setCountry] = useState(setup.senderName.country && callingCode(setup.senderName.country) ? setup.senderName.country : "AU");
  const [number, setNumber] = useState("");
  const [code, setCode] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState<SmsMessage | null>(null);
  const [waitUntil, setWaitUntil] = useState(0);
  const [, tick] = useState(0);
  const normalized = normalizePhone(number, country);
  const senderReady = setup.sender?.identityCheck === "verified";

  useEffect(() => {
    if (!numberId && verified[0]) setNumberId(verified[0].id);
  }, [numberId, verified]);
  // Follow the text to a final outcome (or 3 minutes): AWS accepting it isn't the phone getting it.
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

  const refresh = async () => onSetup(await api<SmsSetupState>(`${base}/setup`));
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
  const outcome = message ? testOutcome(message) : null;

  return (
    <div className="space-y-3 rounded-xl border border-border p-4">
      <p className="font-medium">Send a test SMS</p>
      <p className="text-sm text-muted">The saved message, with the sample customer&apos;s details, to a mobile number you&apos;ve verified. It never goes to a customer.</p>
      {!senderReady && (
        <p className="text-sm text-warn">
          A test needs a sender approved by AWS (step 2). You can verify your number meanwhile.
        </p>
      )}
      {problem && <Alert onDismiss={() => setProblem(null)}>{problem}</Alert>}
      {verified.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="sr-only">Send the test to</legend>
          {verified.map((t) => (
            <label key={t.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-2.5 text-sm ${numberId === t.id ? "border-accent bg-accent/5" : "border-border"}`}>
              <input type="radio" name="auto-test-number" className="accent-[var(--accent)]" checked={numberId === t.id} onChange={() => setNumberId(t.id)} />
              <span className="font-mono">{t.number}</span>
              <Badge tone="good">Verified</Badge>
            </label>
          ))}
        </fieldset>
      )}
      {pending.map((t) => (
        <div key={t.id} className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-2.5">
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-mono">{t.number}</p>
            <p className="text-xs text-muted">Enter the code AWS texted to this number.</p>
          </div>
          <label className="sr-only" htmlFor={`auto-code-${t.id}`}>
            Code for {t.number}
          </label>
          <input id={`auto-code-${t.id}`} className="input w-28 text-center font-mono" inputMode="numeric" autoComplete="one-time-code" maxLength={10} placeholder="Code" value={code[t.id] ?? ""} onChange={(e) => setCode({ ...code, [t.id]: e.target.value.replace(/\D/g, "") })} />
          <button
            type="button"
            className="btn-primary"
            disabled={!!busy || (code[t.id] ?? "").length < 4}
            onClick={() =>
              void act(`verify:${t.id}`, "check the code", async () => {
                await api(`${base}/test-numbers/${t.id}/verify`, { method: "POST", body: { code: code[t.id] } });
                setNumberId(t.id);
                await refresh();
                toast("success", "Number verified.");
              })
            }
          >
            {busy === `verify:${t.id}` ? "Checking…" : "Confirm"}
          </button>
        </div>
      ))}
      {setup.testNumbers.length < 5 && (
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
            <label className="label" htmlFor="auto-test-country">
              Country code
            </label>
            <select id="auto-test-country" className="input w-44" value={country} onChange={(e) => setCountry(e.target.value)}>
              {[...PHONE_COUNTRIES]
                .sort((a, b) => countryName(a).localeCompare(countryName(b)))
                .map((c) => (
                  <option key={c} value={c}>
                    {countryName(c)} (+{callingCode(c)})
                  </option>
                ))}
            </select>
          </div>
          <div className="min-w-[10rem] flex-1">
            <label className="label" htmlFor="auto-test-number">
              {verified.length ? "Another mobile number" : "Your mobile number"}
            </label>
            <input id="auto-test-number" className="input" type="tel" inputMode="tel" autoComplete="tel-national" placeholder="0412 345 678" value={number} aria-invalid={!!number && !normalized} onChange={(e) => setNumber(e.target.value)} />
          </div>
          <button type="submit" className="btn-secondary" disabled={!!busy || !normalized || setup.mode === "off"}>
            {busy === "add" ? "Texting a code…" : "Text me a code"}
          </button>
        </form>
      )}
      <button
        type="button"
        className="btn-primary"
        disabled={!!busy || !numberId || !senderReady || disabled || wait > 0 || setup.mode === "off"}
        title={disabled ? "Save your changes first: the saved message is what's tested" : undefined}
        onClick={() =>
          void act("send", "send the test", async () => {
            // One id per press: a retried request gets the same text back instead of a second one.
            const r = await api<{ message: SmsMessage }>(`${base}/automations/${automationId}/test`, { method: "POST", body: { testNumberId: numberId, requestId: requestId() } });
            setMessage(r.message);
            setWaitUntil(Date.now() + 30_000);
          })
        }
      >
        {busy === "send" ? "Sending…" : wait > 0 ? `Send again in ${wait} s` : "Send test SMS"}
      </button>
      {message && outcome && (
        <div className="rounded-lg border border-border bg-bg/50 p-3 text-sm" role="status" aria-live="polite">
          <p className="flex flex-wrap items-center gap-2">
            <SmsStatusBadge status={message.status} why={message.reasonLabel} />
            {message.to && <span className="text-muted">to {message.to}</span>}
          </p>
          <p className="mt-1 font-medium">{outcome.said}</p>
          {outcome.fix && <p className="mt-1 text-muted">What to do: {outcome.fix}</p>}
        </div>
      )}
    </div>
  );
}
