"use client";
import { useEffect, useState, type ReactNode } from "react";
import {
  missingForTrigger,
  RULE_CONDITION_FIELDS,
  RULE_CONDITION_LABEL,
  ruleCan,
  ruleConditionSchema,
  skipLabel,
  SMS_TRIGGERS,
  smsRuleSchema,
  templateVariables,
  TRIGGER_INFO,
  type RuleConditionField,
  type SmsRuleInput,
  type SmsTrigger,
} from "@app/shared/sms";
import { ConfirmDialog, Skeleton, useToast } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { api, fmtNum, useApi } from "@/lib/api";
import { actionLabel, fmtDelay, fmtHour, fmtWhen, RULE_STATUS, sendable, smsError, StatusPill, TemplatePicker, useSms, useSmsAction, whoLabel } from "./MessagingUi";
import type { DryRunResult, RuleDetail, SmsRule, SmsTemplate } from "./types";

// ---------------------------------------------------------------------------
// The WHEN / IF / WAIT / THEN builder. What a condition may compare is read from the shared schema
// (ruleConditionSchema); the whole rule is checked with smsRuleSchema before it is sent.
// ---------------------------------------------------------------------------

/** Each condition field's comparisons, as the shared schema allows them. */
const OPS = Object.fromEntries(ruleConditionSchema.options.map((o) => [o.shape.field.value, o.shape.op.options as readonly string[]])) as Record<RuleConditionField, readonly string[]>;

const OP_LABEL: Record<string, string> = { gte: "is at least", lte: "is at most", in: "is one of", not_in: "is not one of", contains: "contains", has: "has the tag", lacks: "doesn't have the tag" };

/** Which input each field needs (validation is the schema's). */
const VALUE_INPUT: Record<RuleConditionField, { kind: "number" | "list" | "text"; placeholder: string; step?: string }> = {
  order_total: { kind: "number", placeholder: "100", step: "0.01" },
  customer_spent: { kind: "number", placeholder: "500", step: "0.01" },
  customer_orders: { kind: "number", placeholder: "2", step: "1" },
  days_since_last_order: { kind: "number", placeholder: "90", step: "1" },
  country: { kind: "list", placeholder: "AU, NZ" },
  product: { kind: "text", placeholder: "Sweater" },
  tag: { kind: "text", placeholder: "wholesale" },
};

type Unit = "minutes" | "hours" | "days";
const UNIT_MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };

interface CondDraft {
  field: RuleConditionField;
  op: string;
  value: string;
}

interface Draft {
  name: string;
  trigger: SmsTrigger;
  conditions: CondDraft[];
  delay: string;
  unit: Unit;
  templateId: string;
  discountCode: string;
  quietStart: number;
  quietEnd: number;
  useCustomerTimezone: boolean;
  maxPerCustomer: string;
  capDays: string;
  priority: string;
  dryRun: boolean;
  inactiveDays: string;
  vipMinOrders: string;
  vipMinSpent: string;
}

/** A new rule: dry run on, one text per customer per 30 days, quiet 9 pm to 9 am. */
const blank = (): Draft => ({
  name: "",
  trigger: "fulfillment_created",
  conditions: [],
  delay: "0",
  unit: "minutes",
  templateId: "",
  discountCode: "",
  quietStart: 21,
  quietEnd: 9,
  useCustomerTimezone: true,
  maxPerCustomer: "1",
  capDays: "30",
  priority: "50",
  dryRun: true,
  inactiveDays: "",
  vipMinOrders: "",
  vipMinSpent: "",
});

function delayParts(minutes: number): { delay: string; unit: Unit } {
  if (minutes && minutes % 1440 === 0) return { delay: String(minutes / 1440), unit: "days" };
  if (minutes && minutes % 60 === 0) return { delay: String(minutes / 60), unit: "hours" };
  return { delay: String(minutes), unit: "minutes" };
}

function fromConfig(c: SmsRuleInput): Draft {
  return {
    name: c.name,
    trigger: c.trigger,
    conditions: c.conditions.map((x) => ({ field: x.field, op: x.op, value: Array.isArray(x.value) ? x.value.join(", ") : String(x.value) })),
    ...delayParts(c.delayMinutes),
    templateId: c.templateId,
    discountCode: c.discountCode ?? "",
    quietStart: c.quietStart,
    quietEnd: c.quietEnd,
    useCustomerTimezone: c.useCustomerTimezone,
    maxPerCustomer: String(c.maxPerCustomer),
    capDays: String(c.capDays),
    priority: String(c.priority),
    dryRun: c.dryRun,
    inactiveDays: c.inactiveDays ? String(c.inactiveDays) : "",
    vipMinOrders: c.vipMinOrders ? String(c.vipMinOrders) : "",
    vipMinSpent: c.vipMinSpent ? String(c.vipMinSpent) : "",
  };
}

const num = (s: string) => (s.trim() === "" ? Number.NaN : Number(s));
const optional = (s: string) => (s.trim() === "" ? null : Number(s));

/** The draft as the API takes it (numbers as numbers, lists as lists). */
function toInput(d: Draft) {
  return {
    name: d.name,
    trigger: d.trigger,
    conditions: d.conditions.map((c) => ({
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
    delayMinutes: Math.round(num(d.delay) * UNIT_MINUTES[d.unit]),
    templateId: d.templateId,
    discountCode: d.discountCode.trim() || null,
    quietStart: d.quietStart,
    quietEnd: d.quietEnd,
    useCustomerTimezone: d.useCustomerTimezone,
    maxPerCustomer: num(d.maxPerCustomer),
    capDays: num(d.capDays),
    priority: num(d.priority),
    dryRun: d.dryRun,
    inactiveDays: d.trigger === "customer_inactive" ? optional(d.inactiveDays) : null,
    vipMinOrders: d.trigger === "customer_vip" ? optional(d.vipMinOrders) : null,
    vipMinSpent: d.trigger === "customer_vip" ? optional(d.vipMinSpent) : null,
  };
}

const PATH_LABEL: Record<string, string> = {
  name: "Name",
  trigger: "When",
  conditions: "Condition",
  delayMinutes: "Wait",
  templateId: "Template",
  discountCode: "Discount code",
  quietStart: "Quiet hours",
  quietEnd: "Quiet hours",
  maxPerCustomer: "Most texts per customer",
  capDays: "Days",
  priority: "Priority",
  inactiveDays: "Days without an order",
  vipMinOrders: "VIP",
  vipMinSpent: "VIP spend",
};

/** The schema's complaints, said in the form's words. */
function problemsOf(d: Draft): string[] {
  const r = smsRuleSchema.safeParse(toInput(d));
  if (r.success) return [];
  return r.error.issues.map((i) => {
    const [head, index] = i.path;
    const where = head === "conditions" && typeof index === "number" ? `Condition ${index + 1}` : (PATH_LABEL[String(head)] ?? String(head));
    const msg = i.message === "Expected number, received nan" ? "enter a number" : i.message;
    return `${where}: ${msg}`;
  });
}

/** One saved rule version (from the history) in a line. */
function summary(s: unknown, templates: SmsTemplate[]): string | null {
  const r = smsRuleSchema.safeParse(s);
  if (!r.success) return null;
  const c = r.data;
  const tpl = templates.find((t) => t.id === c.templateId)?.name ?? "a template";
  return `When ${TRIGGER_INFO[c.trigger].label.toLowerCase()}${c.conditions.length ? `, if ${c.conditions.length} condition${c.conditions.length === 1 ? "" : "s"} hold` : ""}, wait ${fmtDelay(c.delayMinutes)}, send “${tpl}”${c.dryRun ? " (dry run)" : ""}`;
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function Box({ step, title, children }: { step: string; title: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 rounded-lg border border-border p-3">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">
        {step} · {title}
      </legend>
      <div className="space-y-3">{children}</div>
    </fieldset>
  );
}

/** Build or edit a workflow, move it through approval, and try it on recent orders. */
export function RuleEditor({ id: initialId, templates, onClose, onChanged }: { id: string | null; templates: SmsTemplate[]; onClose: () => void; onChanged: () => void }) {
  const { base, manage, meId, store } = useSms();
  const toast = useToast();
  const { busy, run } = useSmsAction();
  const [id, setId] = useState(initialId);
  const detail = useApi<RuleDetail>(base && id ? `${base}/rules/${id}` : null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [dry, setDry] = useState<DryRunResult | null>(null);
  const [disabling, setDisabling] = useState(false);

  useEffect(() => {
    if (!detail.data) return;
    const parsed = smsRuleSchema.safeParse(detail.data.rule.config);
    setDraft(parsed.success ? fromConfig(parsed.data) : { ...blank(), name: detail.data.rule.name });
  }, [detail.data]);

  if (!base) return null;
  if (id && detail.error) return <LoadError what="the workflow" error={detail.error} onRetry={() => void detail.reload()} busy={detail.loading} />;
  if (id && !detail.data) return <Skeleton lines={6} />;

  const rule: SmsRule | null = detail.data?.rule ?? null;
  const savedParsed = rule ? smsRuleSchema.safeParse(rule.config) : null;
  const saved = savedParsed?.success ? fromConfig(savedParsed.data) : null;
  const dirty = !saved || JSON.stringify(saved) !== JSON.stringify(draft);
  const info = TRIGGER_INFO[draft.trigger];
  const options = templates.filter((t) => sendable(t) && t.category === info.category);
  const chosen = templates.find((t) => t.id === draft.templateId);
  const chosenBody = chosen?.approvedBody ?? chosen?.body ?? "";
  const missing = chosenBody ? missingForTrigger(chosenBody, draft.trigger) : [];
  const needsCode = templateVariables(chosenBody).used.includes("discount_code");
  const problems = problemsOf(draft);
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setCond = (i: number, c: CondDraft) => set({ conditions: draft.conditions.map((x, j) => (j === i ? c : x)) });
  const editable = manage;

  const save = async () => {
    setTried(true);
    if (problems.length) return;
    setSaving(true);
    setError(null);
    try {
      const body = smsRuleSchema.parse(toInput(draft));
      if (id) {
        await api(`${base}/rules/${id}`, { method: "PUT", body });
        await detail.reload();
      } else {
        const r = await api<{ rule: SmsRule }>(`${base}/rules`, { method: "POST", body });
        setId(r.rule.id);
      }
      setDry(null);
      toast("success", rule?.activeVersion ? "Saved as a new version. The approved version keeps running until this one is approved." : "Saved as a draft. Submit it for approval when it's ready.");
      onChanged();
    } catch (e) {
      setError(smsError(e, "save the workflow"));
    } finally {
      setSaving(false);
    }
  };

  const act = (action: "submit" | "approve" | "reject" | "pause" | "resume" | "disable", done: string) =>
    run(action, `${action} the workflow`, async () => {
      await api(`${base}/rules/${id}/${action}`, { method: "POST", body: {} });
      await detail.reload();
      onChanged();
      return done;
    });

  const tryIt = () =>
    run("dry-run", "test the workflow", async () => {
      setDry(await api<DryRunResult>(`${base}/rules/${id}/dry-run`, { method: "POST", body: {} }));
    });

  return (
    <section className="card animate-rise border-accent/40" aria-labelledby="rule-h">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="rule-h" className="flex flex-wrap items-center gap-2 font-semibold">
            {rule ? rule.name : "New workflow"}
            {rule && <StatusPill map={RULE_STATUS} status={rule.status} />}
            {rule?.dryRun && <Badge tone="neutral">Dry run</Badge>}
          </h2>
          {rule && (
            <p className="mt-1 text-xs text-muted">
              Version {rule.version}
              {rule.activeVersion ? ` · version ${rule.activeVersion} approved${rule.activeVersion !== rule.version ? " and running until the latest is approved" : ""}` : " · not approved yet"}
              {rule.awaitingApproval ? " · waiting for approval" : ""}
              {rule.lastRunAt ? ` · last ran ${fmtWhen(rule.lastRunAt, store?.timezone)}` : ""}
            </p>
          )}
        </div>
        <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={onClose}>
          Close
        </button>
      </div>
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      {rule && !savedParsed?.success && <div className="mt-3"><Alert>This workflow&apos;s saved settings are no longer valid. Fill it in again and save.</Alert></div>}

      <div className="mt-4 space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
          <div>
            <label className="label" htmlFor="rule-name">Name</label>
            <input id="rule-name" className="input" maxLength={80} value={draft.name} disabled={!editable} onChange={(e) => set({ name: e.target.value })} placeholder="Shipping update" />
          </div>
          <div>
            <label className="label" htmlFor="rule-priority">Priority</label>
            <input id="rule-priority" className="input" type="number" min={1} max={100} value={draft.priority} disabled={!editable} onChange={(e) => set({ priority: e.target.value })} />
            <p className="mt-1 text-xs text-muted">1 runs first when two match.</p>
          </div>
        </div>

        <Box step="When" title="this happens in Shopify">
          <div>
            <label className="sr-only" htmlFor="rule-trigger">Event</label>
            <select
              id="rule-trigger"
              className="input"
              value={draft.trigger}
              disabled={!editable}
              onChange={(e) => {
                const trigger = e.target.value as SmsTrigger;
                const keep = templates.find((t) => t.id === draft.templateId)?.category === TRIGGER_INFO[trigger].category;
                set({ trigger, templateId: keep ? draft.templateId : "", ...(rule ? {} : delayParts(TRIGGER_INFO[trigger].defaultDelay)) });
              }}
            >
              {SMS_TRIGGERS.map((t) => (
                <option key={t} value={t} disabled={!TRIGGER_INFO[t].available}>
                  {TRIGGER_INFO[t].label}
                  {TRIGGER_INFO[t].category === "marketing" ? " (marketing)" : ""}
                  {TRIGGER_INFO[t].available ? "" : " (not available)"}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted">How bizinsights knows: {info.source}.</p>
            {SMS_TRIGGERS.some((t) => !TRIGGER_INFO[t].available) && (
              <details className="mt-1 text-xs text-muted">
                <summary className="cursor-pointer">Why some events aren&apos;t available</summary>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {SMS_TRIGGERS.filter((t) => !TRIGGER_INFO[t].available).map((t) => (
                    <li key={t}>
                      <strong>{TRIGGER_INFO[t].label}</strong>: {TRIGGER_INFO[t].unavailableReason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          {draft.trigger === "customer_inactive" && (
            <div className="max-w-xs">
              <label className="label" htmlFor="rule-inactive">Days without an order</label>
              <input id="rule-inactive" className="input" type="number" min={14} max={1095} value={draft.inactiveDays} disabled={!editable} onChange={(e) => set({ inactiveDays: e.target.value })} placeholder="90" />
            </div>
          )}
          {draft.trigger === "customer_vip" && (
            <div className="grid max-w-md gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="rule-vip-orders">At least this many orders</label>
                <input id="rule-vip-orders" className="input" type="number" min={2} value={draft.vipMinOrders} disabled={!editable} onChange={(e) => set({ vipMinOrders: e.target.value })} />
              </div>
              <div>
                <label className="label" htmlFor="rule-vip-spent">Or spent at least</label>
                <input id="rule-vip-spent" className="input" type="number" min={1} step="0.01" value={draft.vipMinSpent} disabled={!editable} onChange={(e) => set({ vipMinSpent: e.target.value })} />
              </div>
            </div>
          )}
        </Box>

        <Box step="If" title="all of these hold">
          {!draft.conditions.length && <p className="text-sm text-muted">Always: no conditions.</p>}
          <ul className="space-y-2">
            {draft.conditions.map((c, i) => {
              const input = VALUE_INPUT[c.field];
              return (
                <li key={i} className="grid gap-2 sm:grid-cols-[12rem_10rem_1fr_auto]">
                  <select
                    aria-label={`Condition ${i + 1}: what`}
                    className="input"
                    value={c.field}
                    disabled={!editable}
                    onChange={(e) => {
                      const field = e.target.value as RuleConditionField;
                      setCond(i, { field, op: OPS[field][0]!, value: "" });
                    }}
                  >
                    {RULE_CONDITION_FIELDS.map((f) => (
                      <option key={f} value={f}>{RULE_CONDITION_LABEL[f]}</option>
                    ))}
                  </select>
                  <select aria-label={`Condition ${i + 1}: comparison`} className="input" value={c.op} disabled={!editable} onChange={(e) => setCond(i, { ...c, op: e.target.value })}>
                    {OPS[c.field].map((o) => (
                      <option key={o} value={o}>{OP_LABEL[o] ?? o}</option>
                    ))}
                  </select>
                  <input
                    aria-label={`Condition ${i + 1}: value`}
                    className="input"
                    type={input.kind === "number" ? "number" : "text"}
                    step={input.step}
                    min={input.kind === "number" ? 0 : undefined}
                    placeholder={input.placeholder}
                    value={c.value}
                    disabled={!editable}
                    onChange={(e) => setCond(i, { ...c, value: e.target.value })}
                  />
                  {editable && (
                    <button type="button" className="btn-secondary h-9 px-3 text-xs" onClick={() => set({ conditions: draft.conditions.filter((_, j) => j !== i) })} aria-label={`Remove condition ${i + 1}`}>
                      Remove
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {editable && draft.conditions.length < 10 && (
            <button type="button" className="text-sm text-accent underline-offset-2 hover:underline" onClick={() => set({ conditions: [...draft.conditions, { field: "order_total", op: OPS.order_total[0]!, value: "" }] })}>
              + Add a condition
            </button>
          )}
          <p className="text-xs text-muted">Countries are two-letter codes separated by commas. A fact the event doesn&apos;t have (no country on the order, say) makes its condition fail, never pass.</p>
        </Box>

        <Box step="Wait" title="before sending">
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="rule-delay">Wait</label>
            <input id="rule-delay" className="input w-28" type="number" min={0} value={draft.delay} disabled={!editable} onChange={(e) => set({ delay: e.target.value })} />
            <label className="sr-only" htmlFor="rule-unit">Unit</label>
            <select id="rule-unit" className="input w-32" value={draft.unit} disabled={!editable} onChange={(e) => set({ unit: e.target.value as Unit })}>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
            <span className="text-sm text-muted">after the event{Number(draft.delay) === 0 ? " (right away)" : ""}. At most 30 days.</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="label">Quiet hours</p>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label className="sr-only" htmlFor="rule-qs">Quiet from</label>
                <select id="rule-qs" className="input w-28" value={draft.quietStart} disabled={!editable} onChange={(e) => set({ quietStart: Number(e.target.value) })}>
                  {HOURS.map((h) => <option key={h} value={h}>{fmtHour(h)}</option>)}
                </select>
                to
                <label className="sr-only" htmlFor="rule-qe">Quiet until</label>
                <select id="rule-qe" className="input w-28" value={draft.quietEnd} disabled={!editable} onChange={(e) => set({ quietEnd: Number(e.target.value) })}>
                  {HOURS.map((h) => <option key={h} value={h}>{fmtHour(h)}</option>)}
                </select>
              </div>
              <p className="mt-1 text-xs text-muted">{draft.quietStart === draft.quietEnd ? "No quiet hours." : "A text due in quiet hours waits until they end."}</p>
            </div>
            <label className="flex items-start gap-2 text-sm sm:mt-7">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={draft.useCustomerTimezone} disabled={!editable} onChange={(e) => set({ useCustomerTimezone: e.target.checked })} />
              <span>
                Use the customer&apos;s time zone
                <span className="block text-xs text-muted">Where their country has one time zone; otherwise the store&apos;s ({store?.timezone ?? "store time"}).</span>
              </span>
            </label>
          </div>
        </Box>

        <Box step="Then" title="send this text">
          <TemplatePicker
            label={`Approved ${info.category} template`}
            templates={options}
            value={options.some((t) => t.id === draft.templateId) ? draft.templateId : ""}
            onChange={(templateId) => set({ templateId })}
            disabled={!editable}
            empty={`No approved ${info.category} template yet. "${info.label}" texts need one${info.category === "marketing" ? " with the opt-out link" : ""}.`}
          />
          {draft.templateId && !options.some((t) => t.id === draft.templateId) && (
            <p className="text-xs text-warn">The template this workflow used is no longer approved for {info.category} texts. Choose another.</p>
          )}
          {missing.length > 0 && (
            <p className="text-sm text-warn">
              The template uses {missing.map((m) => `{{${m}}}`).join(", ")}, which &ldquo;{info.label}&rdquo; can&apos;t fill. It can&apos;t be approved like this.
            </p>
          )}
          {needsCode && (
            <div className="max-w-xs">
              <label className="label" htmlFor="rule-code">Discount code</label>
              <input id="rule-code" className="input font-mono uppercase" maxLength={30} value={draft.discountCode} disabled={!editable} onChange={(e) => set({ discountCode: e.target.value.replace(/[^A-Za-z0-9_-]/g, "") })} />
              <p className="mt-1 text-xs text-muted">Create it in Shopify first.</p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            At most
            <label className="sr-only" htmlFor="rule-max">Most texts per customer</label>
            <input id="rule-max" className="input w-20" type="number" min={1} max={100} value={draft.maxPerCustomer} disabled={!editable} onChange={(e) => set({ maxPerCustomer: e.target.value })} />
            text(s) from this workflow per customer every
            <label className="sr-only" htmlFor="rule-cap">Days</label>
            <input id="rule-cap" className="input w-20" type="number" min={1} max={365} value={draft.capDays} disabled={!editable} onChange={(e) => set({ capDays: e.target.value })} />
            days.
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" role="switch" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={draft.dryRun} disabled={!editable} onChange={(e) => set({ dryRun: e.target.checked })} />
            <span>
              Dry run
              <span className="block text-xs text-muted">Record in Message History what it would have sent, and send nothing. Turn it off only once the dry runs look right.</span>
            </span>
          </label>
        </Box>

        {tried && problems.length > 0 && (
          <Alert>
            <ul className="list-disc space-y-0.5 pl-4">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </Alert>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4">
        {editable && (
          <button type="button" className="btn-primary" disabled={saving || (!!rule && !dirty)} onClick={() => void save()}>
            {saving ? "Saving…" : rule ? "Save changes" : "Save draft"}
          </button>
        )}
        {editable && rule && dirty && saved && (
          <button type="button" className="btn-secondary" disabled={saving} onClick={() => setDraft(saved)}>
            Discard changes
          </button>
        )}
        {manage && rule && rule.unapprovedVersion && !rule.awaitingApproval && rule.status !== "disabled" && (
          <button type="button" className="btn-secondary" disabled={!!busy || dirty} title={dirty ? "Save your changes first" : undefined} onClick={() => void act("submit", "Sent for approval.")}>
            Submit for approval
          </button>
        )}
        {manage && rule?.awaitingApproval && (
          <>
            <button type="button" className="btn-primary" disabled={!!busy || dirty} onClick={() => void act("approve", rule.status === "paused" ? "Approved. The workflow stays paused until you resume it." : "Approved. The workflow runs this version from now on.")}>
              Approve
            </button>
            <button type="button" className="btn-secondary" disabled={!!busy || dirty} onClick={() => void act("reject", "Sent back.")}>
              Send back
            </button>
          </>
        )}
        {manage && rule && ruleCan(rule.status, "pause") && (
          <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void act("pause", "Paused. Its texts still waiting were cancelled.")}>
            Pause
          </button>
        )}
        {manage && rule && ruleCan(rule.status, "resume") && (
          <button type="button" className="btn-primary" disabled={!!busy} onClick={() => void act("resume", "Resumed.")}>
            Resume
          </button>
        )}
        {manage && rule && ruleCan(rule.status, "disable") && (
          <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => setDisabling(true)}>
            Disable…
          </button>
        )}
        {rule && (
          <button type="button" className="btn-secondary" disabled={!!busy || dirty} title={dirty ? "Save your changes first: the saved version is tested" : undefined} onClick={() => void tryIt()}>
            {busy === "dry-run" ? "Testing…" : "Test with recent orders"}
          </button>
        )}
      </div>

      {dry && (
        <div className="mt-4">
          <p className="text-sm">
            Of the last {fmtNum(dry.checked)} order{dry.checked === 1 ? "" : "s"}, <strong>{fmtNum(dry.wouldSend)}</strong> would get this text. Nothing was sent.
          </p>
          {dry.results.length > 0 && (
            <div className="relative mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    <th className="py-1 pr-3 text-left font-medium">Order</th>
                    <th className="py-1 pr-3 text-left font-medium">Result</th>
                    <th className="py-1 text-left font-medium">Why not</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {dry.results.map((r, i) => (
                    <tr key={i}>
                      <td className="py-1.5 pr-3">{r.subject}</td>
                      <td className="py-1.5 pr-3">{r.pass ? <Badge tone="good">Would send</Badge> : <Badge tone="neutral">Wouldn&apos;t send</Badge>}</td>
                      <td className="py-1.5 text-xs text-muted">{r.pass ? "" : r.reason === "conditions" ? "Its conditions don't hold" : skipLabel(r.reason)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!dry.checked && <p className="mt-1 text-xs text-muted">No orders with a mobile number yet.</p>}
        </div>
      )}

      {detail.data && detail.data.history.length > 0 && (
        <details className="mt-5 border-t border-border pt-4">
          <summary className="cursor-pointer text-sm font-semibold">Version history</summary>
          <ol className="mt-3 space-y-2 text-sm">
            {detail.data.history.map((h, i) => {
              const s = summary(h.snapshot, templates);
              return (
                <li key={i} className="rounded-lg border border-border p-2">
                  <p>
                    <span className="font-medium">{actionLabel(h.action)}</span>
                    {h.version ? ` · version ${h.version}` : ""} · {whoLabel(h.actorUserId, meId, h.actor)} · <span className="text-muted">{fmtWhen(h.at, store?.timezone)}</span>
                  </p>
                  {s && <p className="mt-0.5 text-xs text-muted">{s}</p>}
                </li>
              );
            })}
          </ol>
        </details>
      )}

      <ConfirmDialog
        open={disabling}
        title={`Disable "${rule?.name ?? ""}"?`}
        confirmLabel="Disable"
        danger
        busy={busy === "disable"}
        onCancel={() => setDisabling(false)}
        onConfirm={() => void act("disable", "Disabled. Its texts still waiting were cancelled.").then(() => setDisabling(false))}
      >
        <p>It stops at once and its texts still waiting are cancelled. To use it again, edit it: it goes back to draft and through approval.</p>
      </ConfirmDialog>
    </section>
  );
}

