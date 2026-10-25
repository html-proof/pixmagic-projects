"use client";
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DEFAULT_REPLY_COOLDOWN_MINUTES,
  DEFAULT_SEND_WINDOW,
  describeCondition,
  REPLY_MAX_DELAY_MINUTES,
  REPLY_MAX_LENGTH,
  type ConditionField,
  type StarterTemplate,
  type TemplateMapping,
  type WorkflowCondition,
  type WorkflowTiming,
  type WorkflowTrigger,
} from "@app/shared/whatsapp";
import { Alert } from "@/components/ui";
import { api } from "@/lib/api";
import { CountryPicker, fmtDelay, fmtHour } from "@/components/messaging/MessagingUi";
import { fitMapping, MappingEditor } from "./MappingEditor";
import type { WaTemplate, WaTriggerOption, WaWorkflow, WaWorkflowsAnswer } from "./types";
import { ChatBubble, problemsOf, useWaAction, waError, waHref } from "./WaUi";

interface Form {
  name: string;
  trigger: WorkflowTrigger;
  eventName: string;
  conditions: WorkflowCondition[];
  template: { name: string; language: string } | null;
  mapping: TemplateMapping;
  headerMediaUrl: string;
  /** "Customer sends a message" workflows: the reply, and how often one customer may get it. */
  replyText: string;
  cooldown: number;
  timing: WorkflowTiming;
  window: { start: number; end: number } | null;
}

const HOURS = Array.from({ length: 24 }, (_x, h) => h);

function HourSelect({ label, value, onChange }: { label: string; value: number; onChange: (h: number) => void }) {
  return (
    <select className="input w-auto" aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {HOURS.map((h) => (
        <option key={h} value={h}>
          {fmtHour(h)}
        </option>
      ))}
    </select>
  );
}

/** Words typed with commas, as the condition keeps them. */
const splitWords = (s: string) =>
  s
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 20);

/** The words box keeps what is typed (commas, a trailing space) and saves the list as it changes. */
function WordsInput({ value, onChange }: { value: string[]; onChange: (words: string[]) => void }) {
  const [text, setText] = useState(value.join(", "));
  return (
    <input
      className="input w-72"
      aria-label="Words or phrases, separated by commas"
      placeholder="open, hours, delivery"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(splitWords(e.target.value));
      }}
    />
  );
}

const UNITS: Array<[string, number]> = [
  ["minutes", 1],
  ["hours", 60],
  ["days", 1440],
];
const unitOf = (minutes: number) => (minutes && minutes % 1440 === 0 ? 1440 : minutes && minutes % 60 === 0 ? 60 : 1);

function Step({ n, title, explain, children }: { n: number; title: string; explain: string; children: ReactNode }) {
  return (
    <section className="card animate-rise space-y-3" aria-labelledby={`wf-step-${n}`}>
      <div className="flex items-start gap-3">
        <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-sm font-semibold text-white">
          {n}
        </span>
        <div className="min-w-0">
          <h3 id={`wf-step-${n}`} className="font-semibold">
            {title}
          </h3>
          <p className="text-sm text-muted">{explain}</p>
        </div>
      </div>
      <div>{children}</div>
    </section>
  );
}

function newCondition(field: ConditionField): WorkflowCondition {
  switch (field) {
    case "order_total":
      return { field, op: "gte", value: 50 };
    case "country":
      return { field, op: "in", value: [] };
    case "product":
      return { field, op: "contains", value: "" };
    case "customer_type":
      return { field, op: "is", value: "new" };
    case "order_tag":
      return { field, op: "has", value: "" };
    case "payment_method":
      return { field, op: "contains", value: "cash on delivery" };
    case "message_text":
      return { field, op: "contains_any", value: ["hours"] };
    case "received_at":
      return { field, op: "outside_hours", value: { start: 9, end: 17 } };
  }
}

function ConditionRow({ c, onChange, onRemove }: { c: WorkflowCondition; onChange: (c: WorkflowCondition) => void; onRemove: () => void }) {
  let body: ReactNode = null;
  if (c.field === "order_total") {
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">Order total is</span>
        <select className="input w-auto" aria-label="At least or at most" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as "gte" | "lte" })}>
          <option value="gte">at least</option>
          <option value="lte">at most</option>
        </select>
        <input className="input w-28" type="number" min={0} step="0.01" aria-label="Amount" value={c.value} onChange={(e) => onChange({ ...c, value: Number(e.target.value) || 0 })} />
      </div>
    );
  } else if (c.field === "country") {
    body = (
      <div className="space-y-2">
        <select className="input w-auto" aria-label="Is or isn't" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as "in" | "not_in" })}>
          <option value="in">Customer&apos;s country is one of</option>
          <option value="not_in">Customer&apos;s country is not one of</option>
        </select>
        <CountryPicker label="Countries" value={c.value} onChange={(value) => onChange({ ...c, value })} />
      </div>
    );
  } else if (c.field === "customer_type") {
    body = (
      <select className="input w-auto" aria-label="Customer" value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value as "new" | "returning" })}>
        <option value="new">It&apos;s the customer&apos;s first order</option>
        <option value="returning">The customer has ordered before</option>
      </select>
    );
  } else if (c.field === "message_text") {
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">The message contains any of</span>
        <WordsInput value={c.value} onChange={(value) => onChange({ ...c, value: value.length ? value : c.value })} />
        <span className="text-xs text-muted">Any case; separate with commas.</span>
      </div>
    );
  } else if (c.field === "received_at") {
    body = (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select className="input w-auto" aria-label="Outside or within" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as "outside_hours" | "within_hours" })}>
          <option value="outside_hours">It arrives outside</option>
          <option value="within_hours">It arrives between</option>
        </select>
        <HourSelect label="From" value={c.value.start} onChange={(start) => onChange({ ...c, value: { ...c.value, start } })} />
        {c.op === "outside_hours" ? "to" : "and"}
        <HourSelect label="To" value={c.value.end} onChange={(end) => onChange({ ...c, value: { ...c.value, end } })} />
        <span className="text-xs text-muted">(your store&apos;s time)</span>
      </div>
    );
  } else if (c.field === "order_tag") {
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-auto" aria-label="Has or doesn't have" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as "has" | "lacks" })}>
          <option value="has">The order has the tag</option>
          <option value="lacks">The order doesn&apos;t have the tag</option>
        </select>
        <input className="input w-48" aria-label="Tag" maxLength={60} value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value })} />
      </div>
    );
  } else {
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">{c.field === "product" ? "A product's name contains" : "The payment method contains"}</span>
        <input className="input w-56" aria-label="Words" maxLength={c.field === "product" ? 100 : 60} value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value })} />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border p-3">
      <div className="min-w-0 flex-1">{body}</div>
      <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={onRemove}>
        Remove
      </button>
    </div>
  );
}

/** Build or edit a workflow in four steps, with what would stop it being switched on shown before saving. */
export function WorkflowBuilder({
  base,
  meta,
  templates,
  starters,
  editing,
  presetKey,
  onDone,
  onCancel,
}: {
  base: string;
  meta: WaWorkflowsAnswer;
  templates: WaTemplate[];
  starters: StarterTemplate[];
  editing: WaWorkflow | null;
  presetKey: string | null;
  onDone: (w: WaWorkflow) => void;
  onCancel: () => void;
}) {
  const preset = presetKey ? meta.presets.find((p) => p.key === presetKey) ?? null : null;
  const usable = templates.filter((t) => t.status !== "REJECTED" && t.status !== "DISABLED" && t.category !== "AUTHENTICATION");
  const initial = useMemo<Form>(() => {
    if (editing) {
      return {
        name: editing.name,
        trigger: editing.trigger,
        eventName: editing.eventName ?? "",
        conditions: editing.conditions,
        template: editing.template,
        mapping: editing.mapping,
        headerMediaUrl: editing.headerMediaUrl ?? "",
        replyText: editing.replyText ?? "",
        cooldown: editing.replyCooldownMinutes ?? DEFAULT_REPLY_COOLDOWN_MINUTES,
        timing: editing.timing,
        window: editing.sendWindow ?? null,
      };
    }
    const starter = preset?.starter ? starters.find((s) => s.key === preset.starter) : null;
    const t = starter ? usable.find((x) => x.name === starter.draft.name && x.language === starter.draft.language) ?? null : null;
    // A preset whose trigger this store can't use, or none: the first trigger that works here.
    const wanted = meta.triggers.find((x) => x.key === (preset?.trigger ?? "order_created"));
    const trig = (wanted?.available || preset ? wanted : null) ?? meta.triggers.find((x) => x.available) ?? meta.triggers[0]!;
    return {
      name: preset?.title ?? "",
      trigger: trig.key,
      eventName: preset?.eventName ?? "",
      conditions: preset?.conditions ?? [],
      template: t ? { name: t.name, language: t.language } : null,
      mapping: t ? (starter?.mapping && starter.mapping.body.length === t.shape.bodyVars ? starter.mapping : fitMapping(t, null, trig.variables.map((v) => v.key))) : { body: [], buttons: [] },
      headerMediaUrl: "",
      replyText: preset?.replyText ?? "",
      cooldown: preset?.replyCooldownMinutes ?? DEFAULT_REPLY_COOLDOWN_MINUTES,
      timing: preset?.timing ?? { mode: "after_trigger", minutes: 0 },
      window: trig.category === "MARKETING" && trig.sends === "template" ? DEFAULT_SEND_WINDOW : null,
    };
    // The form starts once; later changes are the person's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [f, setF] = useState<Form>(initial);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useWaAction();
  const trigger: WaTriggerOption = meta.triggers.find((t) => t.key === f.trigger)!;
  const reply = trigger.sends === "reply";
  const allowed = trigger.variables.map((v) => v.key);
  const template = f.template ? (templates.find((t) => t.name === f.template!.name && t.language === f.template!.language) ?? null) : null;
  const starterMissing = !editing && preset?.starter && !f.template && !reply ? starters.find((s) => s.key === preset.starter) : null;
  const unit = unitOf(f.timing.minutes);
  const cooldownUnit = unitOf(f.cooldown);
  const ready = reply ? !!f.replyText.trim() : !!f.template;

  const body = () => ({
    name: f.name,
    trigger: f.trigger,
    eventName: f.trigger === "custom_event" ? f.eventName : null,
    conditions: f.conditions,
    template: reply ? null : (f.template ?? { name: "", language: "en" }),
    mapping: reply ? { body: [], buttons: [] } : f.mapping,
    headerMediaUrl: reply ? null : f.headerMediaUrl.trim() || null,
    replyText: reply ? f.replyText : null,
    replyCooldownMinutes: reply ? f.cooldown : null,
    timing: f.timing,
    sendWindow: f.window,
  });

  // What would stop it being switched on, asked as the form settles.
  useEffect(() => {
    if (!ready) {
      setProblems(null);
      return;
    }
    let stale = false;
    const t = window.setTimeout(() => {
      api<{ problems: string[] }>(`${base}/workflows/check`, { method: "POST", body: body() })
        .then((r) => !stale && setProblems(r.problems))
        .catch(() => !stale && setProblems(null));
    }, 500);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
    // body() reads `f`, which is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f, base]);

  const save = (activate: boolean) =>
    run(activate ? "activate" : "save", activate ? "save and switch on the workflow" : "save the workflow", async () => {
      setError(null);
      try {
        const saved = editing
          ? await api<{ workflow: WaWorkflow }>(`${base}/workflows/${editing.id}`, { method: "PUT", body: body() })
          : await api<{ workflow: WaWorkflow }>(`${base}/workflows`, { method: "POST", body: body() });
        let w = saved.workflow;
        if (activate && w.status !== "active") w = (await api<{ workflow: WaWorkflow }>(`${base}/workflows/${w.id}/activate`, { method: "POST", body: {} })).workflow;
        onDone(w);
        return activate ? (reply ? `"${w.name}" is on. It answers customers who write to you from now on.` : `"${w.name}" is on. It runs for every new ${trigger.label.toLowerCase()} from now on.`) : `"${w.name}" saved.`;
      } catch (e) {
        const list = problemsOf(e);
        if (list.length) setProblems(list);
        setError(waError(e, "save the workflow"));
        throw e;
      }
    });

  return (
    <div className="space-y-4">
      <section className="card animate-rise">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">{editing ? `Edit "${editing.name}"` : "New workflow"}</h2>
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Back to workflows
          </button>
        </div>
        <div className="mt-3 max-w-md">
          <label className="label" htmlFor="wf-name">
            Name
          </label>
          <input id="wf-name" className="input" maxLength={80} placeholder="Order confirmation" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </div>
      </section>

      <Step n={1} title="When" explain="What starts this workflow. It runs once for each order, checkout, customer, event or message.">
        <div className="grid gap-2 sm:grid-cols-2">
          {meta.triggers.map((t) => {
            // A trigger this store can't use isn't offered, unless it is the one being edited.
            const off = !t.available && f.trigger !== t.key;
            return (
              <label key={t.key} className={`flex gap-2 rounded-lg border p-3 text-sm ${off ? "cursor-not-allowed opacity-70" : "cursor-pointer"} ${f.trigger === t.key ? "border-accent bg-accent/5" : "border-border"}`}>
                <input
                  type="radio"
                  name="wf-trigger"
                  checked={f.trigger === t.key}
                  disabled={off}
                  aria-describedby={!t.available ? `wf-trigger-why-${t.key}` : undefined}
                  onChange={() => {
                    const vars = t.variables.map((v) => v.key);
                    const toReply = t.sends === "reply";
                    setF({
                      ...f,
                      trigger: t.key,
                      conditions: f.conditions.filter((c) => t.conditionFields.some((x) => x.key === c.field)),
                      template: toReply ? null : f.template,
                      mapping: toReply ? { body: [], buttons: [] } : fitMapping(template, f.mapping, vars),
                      timing: t.key === "custom_event" ? f.timing : { mode: "after_trigger", minutes: toReply ? Math.min(f.timing.minutes, REPLY_MAX_DELAY_MINUTES) : f.timing.minutes },
                      window: toReply ? null : f.window,
                    });
                  }}
                />
                <span>
                  <span className="font-medium">{t.label}</span>
                  <span className="block text-xs text-muted">{t.when}</span>
                  {!t.available && t.reason && (
                    <span id={`wf-trigger-why-${t.key}`} className="mt-1 block text-xs text-warn">
                      Not available for your store: {t.reason}
                      {t.fix === "whatsapp_webhooks" && (
                        <>
                          {" "}
                          <Link className="underline" href={waHref("overview")}>
                            Go to the Overview
                          </Link>
                        </>
                      )}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
        {f.trigger === "custom_event" && (
          <div className="mt-3 max-w-md">
            <label className="label" htmlFor="wf-event">
              Event name
            </label>
            <input id="wf-event" className="input" maxLength={60} placeholder="appointment_booked" value={f.eventName} onChange={(e) => setF({ ...f, eventName: e.target.value.replace(/[^a-z0-9_.-]/gi, "") })} />
            <p className="mt-1 text-xs text-muted">Your booking tool sends events with this name (Settings has your event key and an example).</p>
          </div>
        )}
      </Step>

      <Step n={2} title="Only if (optional)" explain="Conditions that must all be true. Leave empty to run for every one.">
        {!trigger.conditionFields.length ? (
          <p className="text-sm text-muted">This trigger has no conditions to check.</p>
        ) : (
          <div className="space-y-2">
            {f.conditions.map((c, i) => (
              <ConditionRow key={i} c={c} onChange={(next) => setF({ ...f, conditions: f.conditions.map((x, j) => (j === i ? next : x)) })} onRemove={() => setF({ ...f, conditions: f.conditions.filter((_x, j) => j !== i) })} />
            ))}
            {f.conditions.length > 0 && <p className="text-xs text-muted">Runs only when: {f.conditions.map(describeCondition).join("; and ")}.</p>}
            {f.conditions.length < 10 && (
              <div className="flex flex-wrap gap-2">
                {trigger.conditionFields.map((c) => (
                  <button key={c.key} type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setF({ ...f, conditions: [...f.conditions, newCondition(c.key)] })}>
                    + {c.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Step>

      <Step
        n={3}
        title="Send"
        explain={reply ? "Your reply, as the customer will read it. WhatsApp allows replies without a template because the customer has just written." : "The approved template to send, and what fills its blanks for each customer."}
      >
        {reply ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <label className="label" htmlFor="wf-reply">
                Reply
              </label>
              <textarea id="wf-reply" className="input min-h-28" maxLength={REPLY_MAX_LENGTH} value={f.replyText} onChange={(e) => setF({ ...f, replyText: e.target.value })} placeholder="Thanks for your message! We'll reply within a few hours." />
              <p className="mt-1 text-xs text-muted">
                {f.replyText.length} / {REPLY_MAX_LENGTH} characters. Customers who replied STOP never get it; STOP and START themselves never start this workflow.
              </p>
            </div>
            <ChatBubble body={f.replyText} />
          </div>
        ) : !usable.length ? (
          <Alert kind="info">
            You don&apos;t have a template yet.{" "}
            <Link className="underline" href={waHref("templates")}>
              Write one
            </Link>{" "}
            and come back once Meta approves it.
          </Alert>
        ) : (
          <div className="space-y-3">
            <div className="max-w-md">
              <label className="label" htmlFor="wf-template">
                Template
              </label>
              <select
                id="wf-template"
                className="input"
                value={f.template ? `${f.template.name}|${f.template.language}` : ""}
                onChange={(e) => {
                  const t = usable.find((x) => `${x.name}|${x.language}` === e.target.value) ?? null;
                  setF({ ...f, template: t ? { name: t.name, language: t.language } : null, mapping: fitMapping(t, null, allowed) });
                }}
              >
                <option value="">Choose a template…</option>
                {usable.map((t) => (
                  <option key={t.id} value={`${t.name}|${t.language}`}>
                    {t.name} ({t.language}) · {t.category === "MARKETING" ? "Marketing" : "Updates"} · {t.statusLabel}
                  </option>
                ))}
              </select>
              {trigger.category === "MARKETING" && <p className="mt-1 text-xs text-muted">{trigger.label} messages are marketing: they only reach customers who agreed to WhatsApp marketing.</p>}
            </div>
            {starterMissing && (
              <Alert kind="info">
                This workflow is written for the &ldquo;{starterMissing.title}&rdquo; template, which isn&apos;t in your account yet.{" "}
                <Link className="underline" href={waHref("templates")}>
                  Write it from the starter
                </Link>
                , or choose another template.
              </Alert>
            )}
            {template && <MappingEditor template={template} mapping={f.mapping} onChange={(mapping) => setF({ ...f, mapping })} allowed={allowed} headerMediaUrl={f.headerMediaUrl} onHeaderMediaUrl={(headerMediaUrl) => setF({ ...f, headerMediaUrl })} />}
          </div>
        )}
      </Step>

      <Step n={4} title="Timing" explain={reply ? "When the reply goes, and how often one customer may get it." : "When the message goes, and the hours it may go out."}>
        <div className="space-y-3">
          {reply && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3">
              <span className="text-sm">Reply to the same customer at most once every</span>
              <input
                className="input w-20"
                type="number"
                min={0}
                aria-label="How often"
                value={f.cooldown / cooldownUnit}
                onChange={(e) => setF({ ...f, cooldown: Math.max(0, Math.round((Number(e.target.value) || 0) * cooldownUnit)) })}
              />
              <select className="input w-auto" aria-label="Unit" value={cooldownUnit} onChange={(e) => setF({ ...f, cooldown: Math.round((f.cooldown / cooldownUnit) * Number(e.target.value)) })}>
                {UNITS.map(([label, n]) => (
                  <option key={n} value={n}>
                    {label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-muted">{f.cooldown ? "so a conversation isn't answered over and over." : "0: every message gets the reply."}</span>
            </div>
          )}
          {f.trigger === "custom_event" && (
            <select className="input w-auto" aria-label="Relative to" value={f.timing.mode} onChange={(e) => setF({ ...f, timing: { ...f.timing, mode: e.target.value as WorkflowTiming["mode"] } })}>
              <option value="after_trigger">After the event arrives</option>
              <option value="before_event">Before the event&apos;s time (appointments)</option>
            </select>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">{f.timing.mode === "before_event" ? "Send" : "Wait"}</span>
            <input
              className="input w-24"
              type="number"
              min={0}
              aria-label="How long"
              value={f.timing.minutes / unit}
              onChange={(e) => setF({ ...f, timing: { ...f.timing, minutes: Math.max(0, Math.round((Number(e.target.value) || 0) * unit)) } })}
            />
            <select
              className="input w-auto"
              aria-label="Unit"
              value={unit}
              onChange={(e) => setF({ ...f, timing: { ...f.timing, minutes: Math.round((f.timing.minutes / unit) * Number(e.target.value)) } })}
            >
              {UNITS.map(([label, n]) => (
                <option key={n} value={n}>
                  {label}
                </option>
              ))}
            </select>
            <span className="text-sm text-muted">{f.timing.mode === "before_event" ? `before the event (${fmtDelay(f.timing.minutes)})` : f.timing.minutes ? `then send (${fmtDelay(f.timing.minutes)} after)` : "(sent right away)"}</span>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!f.window} onChange={(e) => setF({ ...f, window: e.target.checked ? DEFAULT_SEND_WINDOW : null })} />
            Only send between set hours (your store&apos;s time)
          </label>
          {f.window && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <select className="input w-auto" aria-label="From" value={f.window.start} onChange={(e) => setF({ ...f, window: { ...f.window!, start: Number(e.target.value) } })}>
                {Array.from({ length: 24 }, (_x, h) => (
                  <option key={h} value={h}>
                    {fmtHour(h)}
                  </option>
                ))}
              </select>
              to
              <select className="input w-auto" aria-label="To" value={f.window.end} onChange={(e) => setF({ ...f, window: { ...f.window!, end: Number(e.target.value) } })}>
                {Array.from({ length: 24 }, (_x, h) => (
                  <option key={h} value={h}>
                    {fmtHour(h)}
                  </option>
                ))}
              </select>
              <span className="text-xs text-muted">A message due outside these hours waits for the next start.</span>
            </div>
          )}
        </div>
      </Step>

      <section className="card animate-rise space-y-3" aria-labelledby="wf-review-h">
        <h3 id="wf-review-h" className="font-semibold">
          Review
        </h3>
        <p className="text-sm">
          When <strong>{trigger.label.toLowerCase()}</strong>
          {f.trigger === "custom_event" && f.eventName ? ` "${f.eventName}"` : ""}
          {f.conditions.length ? `, and ${f.conditions.map(describeCondition).join(" and ").toLowerCase()}` : ""}, send <strong>{reply ? "your reply" : (f.template?.name ?? "a template")}</strong>{" "}
          {f.timing.mode === "before_event" ? `${fmtDelay(f.timing.minutes)} before the event` : f.timing.minutes ? `${fmtDelay(f.timing.minutes)} later` : "right away"}
          {f.window ? `, between ${fmtHour(f.window.start)} and ${fmtHour(f.window.end)}` : ""}
          {reply && f.cooldown ? `, at most once every ${fmtDelay(f.cooldown)} to the same customer` : ""}. Every message is checked for the customer&apos;s consent right before it goes.
        </p>
        {problems && problems.length > 0 && (
          <Alert kind="info">
            <strong>Before it can be switched on:</strong>
            <ul className="mt-1 list-disc pl-5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            You can still save it as a draft.
          </Alert>
        )}
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" disabled={!f.name.trim() || !ready || !!busy || (problems?.length ?? 1) > 0} onClick={() => void save(true)}>
            {busy === "activate" ? "Switching on…" : editing?.status === "active" ? "Save" : "Save and switch on"}
          </button>
          {editing?.status !== "active" && (
            <button type="button" className="btn-secondary" disabled={!f.name.trim() || !ready || !!busy} onClick={() => void save(false)}>
              {busy === "save" ? "Saving…" : "Save as draft"}
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}
