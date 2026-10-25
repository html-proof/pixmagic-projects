"use client";
import Link from "next/link";
import { useState } from "react";
import {
  describeWaCondition,
  renderWaText,
  waConditionFields,
  WA_AUTOMATION_PRESETS,
  WA_CONDITION_LABEL,
  WA_DEFAULT_REPLY_COOLDOWN,
  WA_DEFAULT_SEND_WINDOW,
  WA_MESSAGE_LABEL,
  WA_MAX_DELAY_MINUTES,
  WA_RECIPIENT_LABEL,
  WA_RECIPIENTS,
  WA_STARTER_TEMPLATES,
  WA_TRIGGER_INFO,
  WA_TRIGGERS,
  type WaCondition,
  type WaConditionField,
  type WaRecipient,
  type WaTrigger,
} from "@app/shared/whatsapp";
import { ConfirmDialog, Skeleton } from "@/components/AppUi";
import { Badge } from "@/components/dashboard/Primitives";
import { LoadError } from "@/components/LoadError";
import { Alert, EmptyState } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { CountryPicker, Drawer, fmtDelay, fmtHour, fmtWhen, plural } from "@/components/messaging/MessagingUi";
import type { WaAutomation, WaAutomationRun, WaOverview, WaTemplate, WaTemplatesResponse, WaTriggerAvailability } from "./types";
import { AUTOMATION_STATUS, MessageStatus, problemsOf, useWaAction, WaBubble, waError, waHref } from "./WaUi";

// ---------------------------------------------------------------------------
// Automations (docs/whatsapp.md, "Automations"): the list, a five-step builder (trigger, conditions,
// message, recipient and timing, review) and each automation's runs. Nothing is switched on except
// by pressing Activate; a new automation starts in test mode (only the store's verified number).
// ---------------------------------------------------------------------------

type DelayUnit = "minutes" | "hours" | "days";

interface Draft {
  name: string;
  description: string;
  trigger: WaTrigger | "";
  conditions: WaCondition[];
  templateId: string;
  recipient: WaRecipient;
  delayValue: string;
  delayUnit: DelayUnit;
  ownWindow: boolean;
  windowStart: number;
  windowEnd: number;
  testMode: boolean;
  cooldownMinutes: number;
}

const UNIT_MINUTES: Record<DelayUnit, number> = { minutes: 1, hours: 60, days: 1440 };

function splitDelay(minutes: number): { value: string; unit: DelayUnit } {
  if (minutes && minutes % 1440 === 0) return { value: String(minutes / 1440), unit: "days" };
  if (minutes && minutes % 60 === 0) return { value: String(minutes / 60), unit: "hours" };
  return { value: String(minutes), unit: "minutes" };
}

function draftOf(a: WaAutomation | null): Draft {
  if (!a) {
    return {
      name: "",
      description: "",
      trigger: "",
      conditions: [],
      templateId: "",
      recipient: "customer",
      delayValue: "0",
      delayUnit: "minutes",
      ownWindow: false,
      windowStart: WA_DEFAULT_SEND_WINDOW.start,
      windowEnd: WA_DEFAULT_SEND_WINDOW.end,
      testMode: true,
      cooldownMinutes: WA_DEFAULT_REPLY_COOLDOWN,
    };
  }
  const d = splitDelay(a.delayMinutes);
  return {
    name: a.name,
    description: a.description ?? "",
    trigger: a.trigger,
    conditions: a.conditions,
    templateId: a.templateId,
    recipient: a.recipient,
    delayValue: d.value,
    delayUnit: d.unit,
    ownWindow: !!a.sendWindow,
    windowStart: a.sendWindow?.start ?? WA_DEFAULT_SEND_WINDOW.start,
    windowEnd: a.sendWindow?.end ?? WA_DEFAULT_SEND_WINDOW.end,
    testMode: a.testMode,
    cooldownMinutes: a.cooldownMinutes ?? WA_DEFAULT_REPLY_COOLDOWN,
  };
}

const delayMinutesOf = (d: Draft) => Math.round(Number(d.delayValue || "0") * UNIT_MINUTES[d.delayUnit]);

/** The draft as the API takes it (waAutomationSchema). */
function bodyOf(d: Draft) {
  return {
    name: d.name.trim(),
    description: d.description.trim() || null,
    trigger: d.trigger,
    conditions: d.conditions,
    templateId: d.templateId,
    recipient: d.trigger === "message_received" ? "customer" : d.recipient,
    delayMinutes: delayMinutesOf(d),
    sendWindow: d.ownWindow ? { start: d.windowStart, end: d.windowEnd } : null,
    testMode: d.testMode,
    cooldownMinutes: d.trigger === "message_received" ? d.cooldownMinutes : null,
  };
}

/** What a draft still lacks before it can be saved, in words (the API checks again). */
function draftProblems(d: Draft): string[] {
  const out: string[] = [];
  if (!d.trigger) out.push("Choose what starts it.");
  if (!d.templateId) out.push("Pick a message template.");
  if (!d.name.trim()) out.push("Name the automation.");
  const delay = delayMinutesOf(d);
  if (!Number.isFinite(delay) || delay < 0 || delay > WA_MAX_DELAY_MINUTES) out.push("The wait must be between 0 and 30 days.");
  if (d.ownWindow && d.windowStart === d.windowEnd) out.push("The sending hours can't start and end at the same hour.");
  return out;
}

const STEPS = ["trigger", "conditions", "message", "timing", "review"] as const;
type Step = (typeof STEPS)[number];
const STEP_LABEL: Record<Step, string> = { trigger: "Trigger", conditions: "Conditions", message: "Message", timing: "Recipient & timing", review: "Review" };

const COOLDOWNS: Array<[number, string]> = [
  [60, "1 hour"],
  [240, "4 hours"],
  [720, "12 hours"],
  [1440, "1 day"],
  [4320, "3 days"],
  [10080, "7 days"],
];

/** A blank condition of a field, ready to edit. */
function blankCondition(field: WaConditionField): WaCondition {
  switch (field) {
    case "order_total":
      return { field, op: "gte", value: 50 };
    case "country":
      return { field, op: "in", value: ["AU"] };
    case "product":
      return { field, op: "contains", value: "" };
    case "customer_type":
      return { field, op: "is", value: "new" };
    case "order_tag":
      return { field, op: "has", value: "" };
    case "message_text":
      return { field, op: "contains", value: "" };
  }
}

const hours = Array.from({ length: 24 }, (_, h) => h);

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

export function Automations({ base, overview, reload }: { base: string; overview: WaOverview; reload: () => void }) {
  const list = useApi<{ automations: WaAutomation[]; triggers: WaTriggerAvailability }>(`${base}/automations`);
  const templates = useApi<WaTemplatesResponse>(`${base}/templates`);
  const [editing, setEditing] = useState<{ automation: WaAutomation | null; draft: Draft } | null>(null);
  const [detail, setDetail] = useState<WaAutomation | null>(null);
  const [deleting, setDeleting] = useState<WaAutomation | null>(null);
  const [tested, setTested] = useState<{ name: string; messageId: string } | null>(null);
  const [refused, setRefused] = useState<{ id: string; problems: string[] } | null>(null);
  const { busy, run } = useWaAction();
  const manage = overview.can.manage;
  const triggers = list.data?.triggers ?? overview.triggers;
  const tz = overview.store.timezone;

  if (list.error && !list.data) return <LoadError what="automations" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />;
  if (!list.data || !templates.data) return <Skeleton lines={5} />;
  const all = list.data.automations;
  const tpls = templates.data.templates;
  const refresh = () => {
    void list.reload();
    reload();
  };

  if (editing) {
    return (
      <Builder
        base={base}
        overview={overview}
        automation={editing.automation}
        initial={editing.draft}
        templates={tpls}
        samples={templates.data.samples as Record<string, string>}
        triggers={triggers}
        onDone={(saved) => {
          setEditing(null);
          refresh();
          if (saved) setDetail(saved);
        }}
      />
    );
  }

  const activate = (a: WaAutomation) =>
    run(`activate:${a.id}`, "switch the automation on", async () => {
      setRefused(null);
      try {
        await api(`${base}/automations/${a.id}/activate`, { method: "POST" });
      } catch (e) {
        const problems = problemsOf(e);
        if (problems.length) setRefused({ id: a.id, problems });
        throw e;
      }
      refresh();
      return a.testMode ? `"${a.name}" is on, in test mode: its messages go only to your verified test number.` : `"${a.name}" is on.`;
    });

  const presetDraft = (key: string): Draft => {
    const p = WA_AUTOMATION_PRESETS.find((x) => x.key === key)!;
    const starter = WA_STARTER_TEMPLATES.find((s) => s.key === p.template);
    const tpl = starter ? tpls.find((t) => t.name === starter.name) : undefined;
    const d = splitDelay(p.delayMinutes);
    return { ...draftOf(null), name: p.name, description: p.description, trigger: p.trigger, templateId: tpl?.id ?? "", delayValue: d.value, delayUnit: d.unit };
  };

  return (
    <div className="space-y-4">
      <div className="card animate-rise">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Automations</h2>
            <p className="mt-1 text-sm text-muted">
              An automation sends a message when something happens in your store: a trigger, optional conditions, a template, then who gets it and when. Each one runs at most once per order,
              checkout or customer, so a repeated event never sends twice.
            </p>
          </div>
          {manage && (
            <button type="button" className="btn-primary" onClick={() => setEditing({ automation: null, draft: draftOf(null) })}>
              New automation
            </button>
          )}
        </div>
        {overview.settings.automationPausedAt && (
          <div className="mt-3">
            <Alert kind="info">All automation is paused (Settings). Automations record what happened but send nothing until you resume.</Alert>
          </div>
        )}
      </div>

      {tested && (
        <Alert kind="success" onDismiss={() => setTested(null)}>
          A test of &ldquo;{tested.name}&rdquo; is on its way to your verified test number (message {tested.messageId}).{" "}
          <Link className="underline" href={waHref("messages")}>
            Follow it in Message history
          </Link>
          .
        </Alert>
      )}

      {manage && (
        <div className="card">
          <h3 className="text-sm font-semibold">Start from a ready-made automation</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {WA_AUTOMATION_PRESETS.map((p) => {
              const starter = WA_STARTER_TEMPLATES.find((s) => s.key === p.template);
              const tpl = starter ? tpls.find((t) => t.name === starter.name) : undefined;
              const avail = triggers[p.trigger];
              return (
                <div key={p.key} className="rounded-lg border border-border p-3">
                  <p className="text-sm font-medium">{p.name}</p>
                  <p className="mt-1 text-xs text-muted">{p.description}</p>
                  <p className="mt-1 text-xs text-muted">
                    When: {WA_TRIGGER_INFO[p.trigger].label.toLowerCase()} · {fmtDelay(p.delayMinutes)}
                  </p>
                  {!avail?.available && <p className="mt-1 text-xs text-warn">{avail?.reason}</p>}
                  {!tpl && starter && (
                    <p className="mt-1 text-xs text-muted">
                      Uses the template &ldquo;{starter.name}&rdquo;: create it on the{" "}
                      <Link className="underline" href={waHref("templates")}>
                        Templates tab
                      </Link>{" "}
                      first (start from its ready-made text).
                    </p>
                  )}
                  <button type="button" className="btn-secondary mt-2 h-8 px-3 text-xs" disabled={!avail?.available} onClick={() => setEditing({ automation: null, draft: presetDraft(p.key) })}>
                    Use this
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {all.length === 0 ? (
        <EmptyState title="No automations yet" body="Create one from a ready-made automation above, or build your own. It starts in test mode, so only your own verified number receives its messages until you say otherwise." />
      ) : (
        <ul className="space-y-3">
          {all.map((a) => {
            const st = AUTOMATION_STATUS[a.status] ?? { tone: "neutral" as const, label: a.status };
            const problems = a.problems ?? [];
            return (
              <li key={a.id} className="card">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" className="text-left font-medium hover:underline" onClick={() => setDetail(a)}>
                        {a.name}
                      </button>
                      <Badge tone={st.tone}>{st.label}</Badge>
                      {a.testMode && <Badge tone="warn">Test mode</Badge>}
                    </div>
                    <p className="mt-1 text-sm text-muted">
                      {a.triggerLabel}
                      {a.conditionLabels.length ? `, if ${a.conditionLabels.join(" and ").toLowerCase()}` : ""} · sends {fmtDelay(a.delayMinutes)}
                    </p>
                    {a.stats && (
                      <p className="mt-1 text-xs text-muted">
                        Last 30 days: {plural(a.stats.queued, "message")} queued, {plural(a.stats.skipped, "run")} that sent nothing
                        {a.lastRunAt ? ` · last ran ${fmtWhen(a.lastRunAt, tz)}` : ""}
                      </p>
                    )}
                    {problems.length > 0 && (
                      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-warn">
                        {problems.map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                    )}
                    {refused?.id === a.id && (
                      <div className="mt-2">
                        <Alert kind="error" onDismiss={() => setRefused(null)}>
                          It can&apos;t be switched on yet:
                          <ul className="mt-1 list-disc pl-5">
                            {refused.problems.map((p) => (
                              <li key={p}>{p}</li>
                            ))}
                          </ul>
                        </Alert>
                      </div>
                    )}
                  </div>
                  {manage && (
                    <div className="flex flex-wrap items-center gap-2">
                      {a.status === "active" ? (
                        <button
                          type="button"
                          className="btn-secondary h-8 px-3 text-xs"
                          disabled={!!busy}
                          onClick={() =>
                            void run(`pause:${a.id}`, "pause the automation", async () => {
                              const r = await api<{ cancelled: number }>(`${base}/automations/${a.id}/pause`, { method: "POST" });
                              refresh();
                              return r.cancelled ? `Paused. ${plural(r.cancelled, "waiting message")} cancelled.` : "Paused.";
                            })
                          }
                        >
                          {busy === `pause:${a.id}` ? "Pausing…" : "Pause"}
                        </button>
                      ) : (
                        <button type="button" className="btn-primary h-8 px-3 text-xs" disabled={!!busy} onClick={() => void activate(a)}>
                          {busy === `activate:${a.id}` ? "Switching on…" : "Activate"}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-secondary h-8 px-3 text-xs"
                        disabled={!!busy}
                        onClick={() =>
                          void run(`test:${a.id}`, "send a test", async () => {
                            const r = await api<{ messageId: string }>(`${base}/automations/${a.id}/test`, { method: "POST" });
                            setTested({ name: a.name, messageId: r.messageId });
                          })
                        }
                      >
                        {busy === `test:${a.id}` ? "Sending…" : "Test"}
                      </button>
                      <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setEditing({ automation: a, draft: draftOf(a) })}>
                        Edit
                      </button>
                      <button type="button" className="btn-danger h-8 px-3 text-xs" onClick={() => setDeleting(a)}>
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {detail && <RunsDrawer base={base} automation={detail} tz={tz} onClose={() => setDetail(null)} />}

      <ConfirmDialog
        open={!!deleting}
        title={`Delete "${deleting?.name ?? ""}"?`}
        confirmLabel="Delete automation"
        danger
        busy={busy === "delete"}
        onCancel={() => setDeleting(null)}
        onConfirm={() =>
          void run("delete", "delete the automation", async () => {
            await api(`${base}/automations/${deleting!.id}`, { method: "DELETE" });
            setDeleting(null);
            refresh();
            return "Automation deleted.";
          })
        }
      >
        <p>Its messages still waiting to send are cancelled, and its run history goes with it. Messages already sent stay in Message history.</p>
      </ConfirmDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

function Builder({
  base,
  overview,
  automation,
  initial,
  templates,
  samples,
  triggers,
  onDone,
}: {
  base: string;
  overview: WaOverview;
  automation: WaAutomation | null;
  initial: Draft;
  templates: WaTemplate[];
  samples: Record<string, string>;
  triggers: WaTriggerAvailability;
  onDone: (saved: WaAutomation | null) => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [step, setStep] = useState<Step>(initial.trigger ? "conditions" : "trigger");
  const [saved, setSaved] = useState<WaAutomation | null>(automation);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const { busy, run } = useWaAction();
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const info = d.trigger ? WA_TRIGGER_INFO[d.trigger] : null;
  const template = templates.find((t) => t.id === d.templateId) ?? null;
  const missingVars = template && info ? template.variables.filter((v) => v !== "store_name" && !(info.variables as string[]).includes(v)) : [];
  const local = draftProblems(d);
  const idx = STEPS.indexOf(step);

  const save = async () => {
    setError(null);
    setProblems([]);
    try {
      const r = saved
        ? await api<{ automation: WaAutomation }>(`${base}/automations/${saved.id}`, { method: "PUT", body: bodyOf(d) })
        : await api<{ automation: WaAutomation }>(`${base}/automations`, { method: "POST", body: bodyOf(d) });
      setSaved(r.automation);
      setProblems(r.automation.problems ?? []);
      return true;
    } catch (e) {
      setError(waError(e, "save the automation"));
      setProblems(problemsOf(e));
      return false;
    }
  };

  return (
    <div className="space-y-4">
      <div className="card animate-rise">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{automation ? `Edit "${automation.name}"` : "New automation"}</h2>
            <p className="mt-1 text-sm text-muted">Trigger → conditions → message → recipient and timing. Saving never switches it on: you do that with Activate.</p>
          </div>
          <button type="button" className="btn-secondary" onClick={() => onDone(null)}>
            Back to automations
          </button>
        </div>
        <ol className="mt-4 flex flex-wrap gap-2" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                aria-current={s === step ? "step" : undefined}
                disabled={!d.trigger && s !== "trigger"}
                onClick={() => setStep(s)}
                className={`rounded-full border px-3 py-1 text-xs transition ${s === step ? "border-accent bg-accent/10 font-semibold" : "border-border text-muted hover:text-text"}`}
              >
                {i + 1}. {STEP_LABEL[s]}
              </button>
            </li>
          ))}
        </ol>
      </div>

      <div className="card space-y-4">
        {step === "trigger" && (
          <fieldset>
            <legend className="label">What starts it</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {WA_TRIGGERS.map((t) => {
                const avail = triggers[t];
                const ti = WA_TRIGGER_INFO[t];
                const locked = !!automation && automation.trigger !== t;
                return (
                  <label
                    key={t}
                    className={`flex cursor-pointer gap-2 rounded-lg border p-3 text-sm transition ${d.trigger === t ? "border-accent bg-accent/10" : "border-border hover:bg-bg"} ${!avail?.available || locked ? "cursor-not-allowed opacity-60" : ""}`}
                  >
                    <input
                      type="radio"
                      name="trigger"
                      className="mt-1 accent-[var(--accent)]"
                      checked={d.trigger === t}
                      disabled={!avail?.available || locked}
                      onChange={() =>
                        set({
                          trigger: t,
                          conditions: d.conditions.filter((c) => waConditionFields(t).includes(c.field)),
                          delayValue: d.trigger ? d.delayValue : splitDelay(ti.defaultDelayMinutes).value,
                          delayUnit: d.trigger ? d.delayUnit : splitDelay(ti.defaultDelayMinutes).unit,
                        })
                      }
                    />
                    <span className="min-w-0">
                      <span className="font-medium">{ti.label}</span>
                      {ti.category === "marketing" && (
                        <span className="ml-2">
                          <Badge tone="neutral">Marketing</Badge>
                        </span>
                      )}
                      <span className="mt-0.5 block text-xs text-muted">{ti.description}</span>
                      {!avail?.available && <span className="mt-1 block text-xs text-warn">{avail?.reason}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
            {automation && <p className="mt-2 text-xs text-muted">An automation&apos;s trigger can&apos;t change: make a new one for another trigger.</p>}
          </fieldset>
        )}

        {step === "conditions" && d.trigger && <ConditionsStep trigger={d.trigger} conditions={d.conditions} onChange={(conditions) => set({ conditions })} />}

        {step === "message" && info && (
          <div className="space-y-3">
            <div>
              <label className="label" htmlFor="wa-auto-template">
                Message template
              </label>
              <select id="wa-auto-template" className="input" value={d.templateId} onChange={(e) => set({ templateId: e.target.value })}>
                <option value="">Choose a template…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id} disabled={!t.usable}>
                    {t.name} ({t.category === "marketing" ? "marketing" : "order and service update"}){t.usable ? "" : ` — ${t.unusableReason ?? "can't be used"}`}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted">
                {info.category === "marketing"
                  ? "This trigger sends marketing: pick a marketing template. It goes only to customers who agreed to marketing messages."
                  : "Order and service updates go to customers under the consent choice in Settings."}{" "}
                <Link className="underline" href={waHref("templates")}>
                  Write or edit templates
                </Link>
                .
              </p>
            </div>
            {template && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted">Preview with sample values</p>
                <WaBubble>{renderWaText(template.body, samples, { lenient: true })}</WaBubble>
                {info.category === "marketing" && template.category !== "marketing" && <Alert kind="error">This trigger sends marketing, but the template isn&apos;t a marketing one.</Alert>}
                {missingVars.length > 0 && (
                  <Alert kind="error">
                    The template uses {missingVars.map((v) => `{{${v}}}`).join(", ")}, which &ldquo;{info.label}&rdquo; doesn&apos;t provide: those messages would be skipped. Pick another template.
                  </Alert>
                )}
              </div>
            )}
            <div>
              <label className="label" htmlFor="wa-auto-name">
                Name
              </label>
              <input id="wa-auto-name" className="input" maxLength={80} value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Order confirmation" />
            </div>
            <div>
              <label className="label" htmlFor="wa-auto-desc">
                Description <span className="font-normal text-muted">(optional)</span>
              </label>
              <input id="wa-auto-desc" className="input" maxLength={300} value={d.description} onChange={(e) => set({ description: e.target.value })} />
            </div>
          </div>
        )}

        {step === "timing" && info && (
          <div className="space-y-4">
            {d.trigger === "message_received" ? (
              <p className="text-sm text-muted">The reply goes to the customer who wrote. Messages from numbers that aren&apos;t your customers are never answered.</p>
            ) : (
              <fieldset>
                <legend className="label">Who gets it</legend>
                <div className="space-y-2">
                  {WA_RECIPIENTS.map((r) => (
                    <label key={r} className="flex items-start gap-2 text-sm">
                      <input type="radio" name="recipient" className="mt-1 accent-[var(--accent)]" checked={d.recipient === r} onChange={() => set({ recipient: r })} />
                      {WA_RECIPIENT_LABEL[r]}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <div>
              <span className="label">Wait before sending</span>
              <div className="flex max-w-xs gap-2">
                <label className="sr-only" htmlFor="wa-auto-delay">
                  Wait
                </label>
                <input id="wa-auto-delay" className="input" inputMode="numeric" value={d.delayValue} onChange={(e) => set({ delayValue: e.target.value.replace(/[^\d]/g, "") })} />
                <label className="sr-only" htmlFor="wa-auto-unit">
                  Unit
                </label>
                <select id="wa-auto-unit" className="input" value={d.delayUnit} onChange={(e) => set({ delayUnit: e.target.value as DelayUnit })}>
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
              </div>
              <p className="mt-1 text-xs text-muted">Sends {fmtDelay(delayMinutesOf(d))} after the event (at most 30 days). Old events (over 2 days) never send.</p>
            </div>
            <div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-[var(--accent)]" checked={d.ownWindow} onChange={(e) => set({ ownWindow: e.target.checked })} />
                Its own sending hours (instead of the store&apos;s {fmtHour(overview.settings.sendWindow.start)}–{fmtHour(overview.settings.sendWindow.end % 24)})
              </label>
              {d.ownWindow && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <label htmlFor="wa-auto-from">From</label>
                  <select id="wa-auto-from" className="input w-auto" value={d.windowStart} onChange={(e) => set({ windowStart: Number(e.target.value) })}>
                    {hours.map((h) => (
                      <option key={h} value={h}>
                        {fmtHour(h)}
                      </option>
                    ))}
                  </select>
                  <label htmlFor="wa-auto-to">to</label>
                  <select id="wa-auto-to" className="input w-auto" value={d.windowEnd} onChange={(e) => set({ windowEnd: Number(e.target.value) })}>
                    {[...hours.slice(1), 24].map((h) => (
                      <option key={h} value={h}>
                        {h === 24 ? "midnight" : fmtHour(h)}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-muted">({overview.settings.timeZone})</span>
                </div>
              )}
              <p className="mt-1 text-xs text-muted">A message due outside its hours waits for the next opening.</p>
            </div>
            {d.trigger === "message_received" && (
              <div>
                <label className="label" htmlFor="wa-auto-cooldown">
                  Reply to the same customer at most once every
                </label>
                <select id="wa-auto-cooldown" className="input max-w-xs" value={d.cooldownMinutes} onChange={(e) => set({ cooldownMinutes: Number(e.target.value) })}>
                  {COOLDOWNS.map(([m, label]) => (
                    <option key={m} value={m}>
                      {label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted">So a conversation isn&apos;t answered over and over, and two automatic systems can&apos;t keep replying to each other.</p>
              </div>
            )}
          </div>
        )}

        {step === "review" && info && (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-bg p-3 text-sm">
              <p>
                <span className="font-medium">When</span> {info.label.toLowerCase()}
                {d.conditions.length ? `, if ${d.conditions.map((c) => describeWaCondition(c).toLowerCase()).join(" and ")}` : ""},
              </p>
              <p>
                <span className="font-medium">send</span> &ldquo;{template?.name ?? "no template chosen"}&rdquo; to{" "}
                {d.trigger === "message_received" ? "the customer who wrote" : WA_RECIPIENT_LABEL[d.recipient].toLowerCase()}
              </p>
              <p>
                <span className="font-medium">{fmtDelay(delayMinutesOf(d))}</span>
                {d.ownWindow ? `, between ${fmtHour(d.windowStart)} and ${d.windowEnd === 24 ? "midnight" : fmtHour(d.windowEnd)}` : ", within the store's sending hours"}.
              </p>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={d.testMode} onChange={(e) => set({ testMode: e.target.checked })} />
              <span>
                <span className="font-medium">Test mode</span>
                <span className="block text-xs text-muted">
                  Every message goes to your verified test number instead of the customer, so you see exactly what customers will get. Untick it only when you&apos;re happy with it.
                </span>
              </span>
            </label>
            {local.length > 0 && (
              <Alert kind="error">
                <ul className="list-disc pl-5">
                  {local.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {error && <Alert kind="error">{error}</Alert>}
            {saved && !error && (
              <Alert kind={problems.length ? "info" : "success"}>
                {problems.length ? (
                  <>
                    Saved. Before it can be switched on:
                    <ul className="mt-1 list-disc pl-5">
                      {problems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </>
                ) : saved.status === "active" ? (
                  "Saved. It's on."
                ) : (
                  "Saved. Nothing stops it from being switched on."
                )}
              </Alert>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary" disabled={!!busy || local.length > 0} onClick={() => void run("save", "save the automation", async () => void (await save()))}>
                {busy === "save" ? "Saving…" : saved ? "Save changes" : "Save as draft"}
              </button>
              {saved && saved.status !== "active" && !problems.length && !error && (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!!busy}
                  onClick={() =>
                    void run("activate", "switch the automation on", async () => {
                      try {
                        const r = await api<{ automation: WaAutomation }>(`${base}/automations/${saved.id}/activate`, { method: "POST" });
                        onDone(r.automation);
                      } catch (e) {
                        setProblems(problemsOf(e));
                        throw e;
                      }
                      return d.testMode ? "Switched on, in test mode." : "Switched on.";
                    })
                  }
                >
                  {busy === "activate" ? "Switching on…" : "Activate"}
                </button>
              )}
              {saved && (
                <button type="button" className="btn-secondary" onClick={() => onDone(saved)}>
                  Done
                </button>
              )}
            </div>
          </div>
        )}

        <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-3">
          <button type="button" className="btn-secondary" disabled={idx === 0} onClick={() => setStep(STEPS[idx - 1]!)}>
            Back
          </button>
          {step !== "review" && (
            <button type="button" className="btn-primary" disabled={(step === "trigger" && !d.trigger) || (step === "message" && !d.templateId)} onClick={() => setStep(STEPS[idx + 1]!)}>
              Next: {STEP_LABEL[STEPS[idx + 1]!]}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Step 2: conditions the event must meet (none: every event). */
function ConditionsStep({ trigger, conditions, onChange }: { trigger: WaTrigger; conditions: WaCondition[]; onChange: (next: WaCondition[]) => void }) {
  const fields = waConditionFields(trigger);
  const update = (i: number, c: WaCondition) => onChange(conditions.map((x, j) => (j === i ? c : x)));
  const remove = (i: number) => onChange(conditions.filter((_, j) => j !== i));
  return (
    <div className="space-y-3">
      <div>
        <p className="label">Only when…</p>
        <p className="text-xs text-muted">Optional. Every condition must match; with none, every &ldquo;{WA_TRIGGER_INFO[trigger].label.toLowerCase()}&rdquo; event sends.</p>
      </div>
      {conditions.map((c, i) => (
        <div key={i} className="rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">{WA_CONDITION_LABEL[c.field]}</p>
            <button type="button" className="text-xs text-muted underline hover:text-text" onClick={() => remove(i)}>
              Remove
            </button>
          </div>
          <div className="mt-2">
            <ConditionFields condition={c} onChange={(next) => update(i, next)} />
          </div>
        </div>
      ))}
      {conditions.length < 10 && (
        <div className="flex flex-wrap gap-2">
          {fields.map((f) => (
            <button key={f} type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => onChange([...conditions, blankCondition(f)])}>
              + {WA_CONDITION_LABEL[f]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ConditionFields({ condition: c, onChange }: { condition: WaCondition; onChange: (c: WaCondition) => void }) {
  switch (c.field) {
    case "order_total":
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select className="input w-auto" aria-label="Comparison" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as "gte" | "lte" })}>
            <option value="gte">at least</option>
            <option value="lte">at most</option>
          </select>
          <input className="input w-32" aria-label="Amount" inputMode="decimal" value={String(c.value)} onChange={(e) => onChange({ ...c, value: Number(e.target.value.replace(/[^\d.]/g, "")) || 0 })} />
          <span className="text-xs text-muted">in the order&apos;s currency</span>
        </div>
      );
    case "country":
      return (
        <div className="space-y-2">
          <select className="input w-auto" aria-label="Comparison" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as "in" | "not_in" })}>
            <option value="in">is one of</option>
            <option value="not_in">is not one of</option>
          </select>
          <CountryPicker label="Countries" value={c.value} onChange={(value) => onChange({ ...c, value: value.length ? value : c.value })} />
        </div>
      );
    case "product":
      return <input className="input" aria-label="Product name contains" placeholder="Part of a product's name" value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value })} maxLength={100} />;
    case "customer_type":
      return (
        <select className="input w-auto" aria-label="Customer" value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value as "new" | "returning" })}>
          <option value="new">First order</option>
          <option value="returning">Returning customer</option>
        </select>
      );
    case "order_tag":
      return <input className="input" aria-label="Order tag" placeholder="A tag on the order" value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value })} maxLength={60} />;
    case "message_text":
      return (
        <div className="flex flex-wrap items-center gap-2">
          <select className="input w-auto" aria-label="Comparison" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as "contains" | "equals" })}>
            <option value="contains">contains</option>
            <option value="equals">is exactly</option>
          </select>
          <input className="input flex-1" aria-label="Words" value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value })} maxLength={100} />
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function RunsDrawer({ base, automation, tz, onClose }: { base: string; automation: WaAutomation; tz: string; onClose: () => void }) {
  const r = useApi<{ automation: WaAutomation; runs: WaAutomationRun[] }>(`${base}/automations/${automation.id}`);
  const st = AUTOMATION_STATUS[automation.status] ?? { tone: "neutral" as const, label: automation.status };
  return (
    <Drawer title={automation.name} sub={automation.triggerLabel} onClose={onClose}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={st.tone}>{st.label}</Badge>
        {automation.testMode && <Badge tone="warn">Test mode</Badge>}
      </div>
      {automation.description && <p className="text-sm text-muted">{automation.description}</p>}
      <h3 className="text-sm font-semibold">Latest runs</h3>
      {r.error && !r.data && <LoadError what="the runs" error={r.error} onRetry={() => void r.reload()} busy={r.loading} />}
      {!r.data && !r.error && <Skeleton lines={4} />}
      {r.data && r.data.runs.length === 0 && <p className="text-sm text-muted">It hasn&apos;t run yet. It runs when its trigger happens while it is on.</p>}
      {r.data && r.data.runs.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {r.data.runs.map((run) => (
            <li key={run.id} className="space-y-1 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{run.subject ?? "Event"}</span>
                <span className="text-xs text-muted">{fmtWhen(run.at, tz)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {run.outcome === "queued" ? <Badge tone="good">Message queued</Badge> : <Badge tone="warn">Nothing sent</Badge>}
                {run.testMode && <Badge tone="warn">Test mode</Badge>}
                {run.messageStatus && <MessageStatus m={{ status: run.messageStatus, statusLabel: WA_MESSAGE_LABEL[run.messageStatus], reasonLabel: null, errorDetail: null, direction: "out" }} />}
              </div>
              {run.reasonLabel && run.outcome === "skipped" && <p className="text-xs text-muted">{run.reasonLabel}</p>}
              {run.detail && <p className="text-xs text-muted">{run.detail}</p>}
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
