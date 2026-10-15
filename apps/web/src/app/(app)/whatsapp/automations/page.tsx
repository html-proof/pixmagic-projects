"use client";
import { useState } from "react";
import {
  AUTOMATION_TRIGGERS,
  CONDITION_FIELDS,
  KIND_INFO,
  NOTIFICATION_KINDS,
  TRIGGER_LABEL,
  type AutomationAction,
  type AutomationTrigger,
  type Condition,
  type ConditionField,
  type RuleConflict,
} from "@app/shared/whatsapp";
import { Badge, Empty } from "@/components/dashboard/Primitives";
import { fmtRelative } from "@/components/dashboard/format";
import { LoadError } from "@/components/LoadError";
import { Alert } from "@/components/ui";
import { actionError, api, useApi } from "@/lib/api";
import { TemplateMapper, useWa, type SettingsResponse } from "@/components/whatsapp/WhatsappUi";
import { PageHeader, Skeleton, useAction, useToast } from "@/components/AppUi";

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  conditions: Condition[];
  action: AutomationAction;
  valid: boolean;
  conflicts: RuleConflict[];
  last30Days: Record<string, number>;
  lastRunAt: string | null;
}

const FIELD: Record<ConditionField, { label: string; ops: Condition["op"][]; hint: string; values?: string[] }> = {
  order_value: { label: "Order value", ops: ["gte", "gt", "lte", "lt", "eq"], hint: "In the store's currency" },
  product: { label: "Product", ops: ["contains", "in", "not_in"], hint: "Product title words, or Shopify product ids (comma separated)" },
  order_status: { label: "Order status", ops: ["eq", "neq", "in"], hint: "placed, paid, processing, packed, shipped, in_transit, out_for_delivery, delivered…" },
  customer_segment: { label: "Customer", ops: ["eq", "neq"], hint: "", values: ["new", "returning"] },
  country: { label: "Country or region", ops: ["in", "not_in"], hint: "Two-letter country codes, comma separated (IN, AE)" },
  marketing_consent: { label: "WhatsApp marketing consent", ops: ["eq"], hint: "", values: ["true", "false"] },
  previous_message_status: { label: "Previous message for this order", ops: ["eq", "neq", "in"], hint: "", values: ["none", "scheduled", "sent", "delivered", "read", "failed", "skipped", "cancelled"] },
};
const OP_LABEL: Record<Condition["op"], string> = { eq: "is", neq: "is not", gt: "more than", gte: "at least", lt: "less than", lte: "at most", in: "is one of", not_in: "is none of", contains: "contains" };

const ACTIONS: Array<[AutomationAction["type"], string]> = [
  ["send_template", "Send an approved WhatsApp template"],
  ["schedule_reminder", "Send an approved template later (reminder)"],
  ["cancel_pending", "Cancel pending messages"],
  ["internal_notification", "Notify your team (in bizinsights)"],
  ["record_event", "Record an event in the audit log"],
];

function defaultAction(type: AutomationAction["type"]): AutomationAction {
  switch (type) {
    case "send_template":
      return { type, templateName: "", language: "en", mapping: { body: [], buttons: [], fixed: {} } };
    case "schedule_reminder":
      return { type, templateName: "", language: "en", mapping: { body: [], buttons: [], fixed: {} }, delayMinutes: 1440 };
    case "cancel_pending":
      return { type, kinds: ["review_request"] };
    case "internal_notification":
      return { type, message: "" };
    case "record_event":
      return { type, label: "" };
  }
}

function describe(a: AutomationAction): string {
  switch (a.type) {
    case "send_template":
      return `send "${a.templateName}"`;
    case "schedule_reminder":
      return `send "${a.templateName}" after ${a.delayMinutes} min`;
    case "cancel_pending":
      return `cancel pending ${a.kinds.map((k) => (k === "automation" ? "automation messages" : KIND_INFO[k as keyof typeof KIND_INFO]?.label ?? k)).join(", ")}`;
    case "internal_notification":
      return `notify the team: "${a.message}"`;
    case "record_event":
      return `record "${a.label}"`;
  }
}

const condText = (c: Condition) => `${FIELD[c.field].label} ${OP_LABEL[c.op]} ${Array.isArray(c.value) ? c.value.join(", ") : String(c.value)}`;

function Builder({ initial, templates, onDone }: { initial: Rule | null; templates: SettingsResponse["templates"]; onDone: (saved: boolean) => void }) {
  const { base } = useWa();
  const toast = useToast();
  const [name, setName] = useState(initial?.name ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [trigger, setTrigger] = useState<AutomationTrigger>(initial?.trigger ?? "order_delivered");
  const [conditions, setConditions] = useState<Condition[]>(initial?.conditions ?? []);
  const [action, setAction] = useState<AutomationAction>(initial?.action ?? defaultAction("send_template"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ conflicts: RuleConflict[] }>(initial ? `${base}/automations/${initial.id}` : `${base}/automations`, {
        method: initial ? "PATCH" : "POST",
        body: { name, enabled, trigger, conditions, action },
      });
      toast(r.conflicts.length ? "info" : "success", r.conflicts.length ? `Saved. Note: ${r.conflicts[0]!.message}` : "Saved.");
      onDone(true);
    } catch (e) {
      setError(actionError(e, "save the rule"));
    } finally {
      setBusy(false);
    }
  };
  const setCond = (i: number, c: Condition) => setConditions(conditions.map((x, j) => (j === i ? c : x)));
  return (
    <section className="card animate-rise border-accent/40" aria-labelledby="b-h">
      <h2 id="b-h" className="font-semibold">{initial ? "Edit rule" : "New rule"}</h2>
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      <div className="mt-3 space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div>
            <label className="label" htmlFor="r-name">Name</label>
            <input id="r-name" className="input" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Thank big spenders" />
          </div>
          <label className="flex items-center gap-2 text-sm sm:mt-7">
            <input type="checkbox" role="switch" className="h-4 w-4 accent-[var(--accent)]" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
          </label>
        </div>

        <div className="rounded-lg border border-border p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">1 · When</p>
          <label className="sr-only" htmlFor="r-trigger">Trigger</label>
          <select id="r-trigger" className="input mt-2" value={trigger} onChange={(e) => setTrigger(e.target.value as AutomationTrigger)}>
            {AUTOMATION_TRIGGERS.map((t) => <option key={t} value={t}>{TRIGGER_LABEL[t]}</option>)}
          </select>
        </div>

        <div className="rounded-lg border border-border p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">2 · Only if (all of these)</p>
          {!conditions.length && <p className="mt-2 text-sm text-muted">Always, no conditions.</p>}
          <ul className="mt-2 space-y-2">
            {conditions.map((c, i) => {
              const f = FIELD[c.field];
              return (
                <li key={i} className="grid gap-2 sm:grid-cols-[12rem_9rem_1fr_auto]">
                  <select aria-label="Field" className="input" value={c.field} onChange={(e) => { const field = e.target.value as ConditionField; setCond(i, { field, op: FIELD[field].ops[0]!, value: FIELD[field].values?.[0] ?? "" }); }}>
                    {CONDITION_FIELDS.map((x) => <option key={x} value={x}>{FIELD[x].label}</option>)}
                  </select>
                  <select aria-label="Comparison" className="input" value={c.op} onChange={(e) => setCond(i, { ...c, op: e.target.value as Condition["op"] })}>
                    {f.ops.map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
                  </select>
                  {f.values ? (
                    <select aria-label="Value" className="input" value={String(c.value)} onChange={(e) => setCond(i, { ...c, value: e.target.value })}>
                      {f.values.map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  ) : (
                    <input
                      aria-label="Value"
                      className="input"
                      placeholder={f.hint}
                      value={Array.isArray(c.value) ? c.value.join(", ") : String(c.value)}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const list = c.op === "in" || c.op === "not_in";
                        setCond(i, { ...c, value: c.field === "order_value" ? Number(raw) || 0 : list ? raw.split(",").map((x) => x.trim()).filter(Boolean) : raw });
                      }}
                    />
                  )}
                  <button type="button" className="btn-secondary h-9 px-3 text-xs" onClick={() => setConditions(conditions.filter((_, j) => j !== i))} aria-label="Remove condition">Remove</button>
                </li>
              );
            })}
          </ul>
          {conditions.length < 20 && (
            <button type="button" className="mt-2 text-sm text-accent underline-offset-2 hover:underline" onClick={() => setConditions([...conditions, { field: "order_value", op: "gte", value: 0 }])}>
              + Add a condition
            </button>
          )}
        </div>

        <div className="rounded-lg border border-border p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">3 · Then</p>
          <select aria-label="Action" className="input mt-2" value={action.type} onChange={(e) => setAction(defaultAction(e.target.value as AutomationAction["type"]))}>
            {ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <div className="mt-3">
            {(action.type === "send_template" || action.type === "schedule_reminder") && (
              <div className="space-y-3">
                {action.type === "schedule_reminder" && (
                  <label className="block text-sm">
                    After{" "}
                    <input className="input inline-block w-24" type="number" min={5} max={43200} value={action.delayMinutes} onChange={(e) => setAction({ ...action, delayMinutes: Number(e.target.value) || 5 })} /> minutes
                  </label>
                )}
                <TemplateMapper templates={templates} templateName={action.templateName || null} language={action.language} mapping={action.mapping} onChange={(n) => setAction({ ...action, templateName: n.templateName ?? "", language: n.language, mapping: n.mapping })} />
                <p className="text-xs text-muted">Consent is checked when it is sent, as for every message: marketing templates only reach customers who opted in.</p>
              </div>
            )}
            {action.type === "cancel_pending" && (
              <fieldset className="grid gap-1 sm:grid-cols-2">
                <legend className="sr-only">Messages to cancel</legend>
                {[...NOTIFICATION_KINDS, "automation" as const].map((k) => (
                  <label key={k} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={action.kinds.includes(k)} onChange={(e) => setAction({ ...action, kinds: e.target.checked ? [...action.kinds, k] : action.kinds.filter((x) => x !== k) })} />
                    {k === "automation" ? "Messages from automations" : KIND_INFO[k].label}
                  </label>
                ))}
              </fieldset>
            )}
            {action.type === "internal_notification" && (
              <input aria-label="Notification text" className="input" maxLength={300} value={action.message} onChange={(e) => setAction({ ...action, message: e.target.value })} placeholder="A big order needs a personal thank-you" />
            )}
            {action.type === "record_event" && <input aria-label="Event label" className="input" maxLength={100} value={action.label} onChange={(e) => setAction({ ...action, label: e.target.value })} placeholder="VIP order" />}
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="btn-primary" disabled={busy || !name} onClick={() => void save()}>{busy ? "Saving…" : "Save rule"}</button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => onDone(false)}>Cancel</button>
      </div>
    </section>
  );
}

interface TestResult {
  valid: boolean;
  error?: string;
  order: { orderName: string } | null;
  conditions?: Array<{ condition: Condition; pass: boolean }>;
  wouldRun?: boolean;
  action?: string;
  hasPhone?: boolean;
  testMessageId: string | null;
}

function Runs({ id }: { id: string }) {
  const { base } = useWa();
  const { data, error, reload } = useApi<{ runs: Array<{ id: string; trigger: string; subject: string; outcome: string; detail: string | null; at: string }> }>(`${base}/automations/${id}/runs`);
  if (error) return <div className="mt-2"><LoadError what="this rule's runs" error={error} onRetry={() => void reload()} /></div>;
  if (!data) return <div className="skeleton mt-2 h-10" />;
  if (!data.runs.length) return <p className="mt-2 text-xs text-muted">It hasn&apos;t run yet.</p>;
  return (
    <ul className="mt-2 max-h-56 divide-y divide-border overflow-y-auto rounded-lg border border-border text-xs">
      {data.runs.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
          <Badge tone={r.outcome === "done" ? "good" : r.outcome === "error" ? "danger" : "neutral"}>{r.outcome}</Badge>
          <span className="text-muted">{fmtRelative(r.at)}</span>
          <span className="font-mono">{r.subject.replace(/^order:/, "order ")}</span>
          <span className="min-w-0 flex-1 text-muted">{r.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export default function Automations() {
  const { base, manage } = useWa();
  const settings = useApi<SettingsResponse>(base ? `${base}/settings` : null);
  const { data, error, reload } = useApi<{ automations: Rule[] }>(base ? `${base}/automations` : null);
  const [editing, setEditing] = useState<Rule | "new" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [phone, setPhone] = useState("");
  const { busy, run } = useAction();
  const loadError = error ?? settings.error;
  if (loadError) return <LoadError what="your automation rules" error={loadError} onRetry={() => void Promise.all([reload(), settings.reload()])} />;
  if (!data || !settings.data) return <Skeleton lines={4} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Automation rules"
        sub="When something happens, if your conditions hold, do one thing. Each rule runs at most once per order, checkout or customer, and its actions never set off other rules, so rules can't loop or double-send."
        actions={manage && !editing ? <button type="button" className="btn-primary" onClick={() => setEditing("new")}>New rule</button> : undefined}
      />
      {editing && (
        <Builder
          initial={editing === "new" ? null : editing}
          templates={settings.data.templates}
          onDone={(saved) => {
            setEditing(null);
            if (saved) void reload();
          }}
        />
      )}
      {!data.automations.length && !editing ? (
        <Empty>No rules yet. Built-in order, delivery, cart and review messages are on their own pages; rules are for anything extra.</Empty>
      ) : (
        <ul className="space-y-3">
          {data.automations.map((r) => {
            const t = tests[r.id];
            return (
              <li key={r.id} className="card animate-rise">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-semibold">
                      {r.name} <Badge tone={r.enabled ? "good" : "neutral"}>{r.enabled ? "On" : "Off"}</Badge>
                      {!r.valid && <Badge tone="danger">Needs editing</Badge>}
                    </p>
                    <p className="mt-1 text-sm">
                      <span className="text-muted">When</span> {TRIGGER_LABEL[r.trigger]}
                      {r.conditions.length ? <><span className="text-muted"> · if </span>{r.conditions.map(condText).join(" and ")}</> : null}
                      <span className="text-muted"> · then </span>
                      {r.valid ? describe(r.action) : "—"}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Last 30 days: {r.last30Days.done ?? 0} done · {r.last30Days.skipped ?? 0} conditions not met{r.last30Days.error ? ` · ${r.last30Days.error} errors` : ""}
                      {r.lastRunAt ? ` · last ${fmtRelative(r.lastRunAt)}` : ""}
                    </p>
                    {r.conflicts.map((c, i) => <p key={i} className={`mt-1 text-xs ${c.severity === "block" ? "text-danger" : "text-warn"}`}>{c.message}</p>)}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {manage && (
                      <>
                        <label className="inline-flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            role="switch"
                            className="h-4 w-4 accent-[var(--accent)]"
                            checked={r.enabled}
                            disabled={!!busy}
                            onChange={() => void run(`t-${r.id}`, "change the rule", async () => {
                              await api(`${base}/automations/${r.id}`, { method: "PATCH", body: { enabled: !r.enabled } });
                              await reload();
                              return r.enabled ? "Turned off." : "Turned on.";
                            })}
                          />
                          <span className="sr-only">Enabled</span>
                        </label>
                        <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setEditing(r)}>Edit</button>
                        <button
                          type="button"
                          className="btn-secondary h-8 px-3 text-xs"
                          disabled={!!busy}
                          onClick={() => void run(`test-${r.id}`, "test the rule", async () => {
                            const res = await api<TestResult>(`${base}/automations/${r.id}/test`, { method: "POST", body: phone ? { phone } : {} });
                            setTests((x) => ({ ...x, [r.id]: res }));
                            return res.testMessageId ? `Test message queued to ${phone}.` : undefined;
                          })}
                        >
                          {busy === `test-${r.id}` ? "Testing…" : "Test"}
                        </button>
                        <button
                          type="button"
                          className="btn-secondary h-8 px-3 text-xs"
                          disabled={!!busy}
                          onClick={() => window.confirm(`Delete "${r.name}"? Messages it scheduled that haven't gone out are cancelled.`) && void run(`d-${r.id}`, "delete the rule", async () => {
                            await api(`${base}/automations/${r.id}`, { method: "DELETE" });
                            await reload();
                            return "Deleted.";
                          })}
                        >
                          Delete
                        </button>
                      </>
                    )}
                    <button type="button" className="text-sm text-accent underline-offset-2 hover:underline" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                      {open === r.id ? "Hide runs" : "Runs"}
                    </button>
                  </div>
                </div>
                {t && (
                  <div className="mt-3 rounded-lg border border-border bg-bg/50 p-3 text-sm" role="status">
                    {!t.valid ? (
                      <p className="text-danger">{t.error}</p>
                    ) : (
                      <>
                        <p className="font-medium">
                          Tested against {t.order ? `order ${t.order.orderName}` : "an example (no orders yet)"}: {t.wouldRun ? "it would run." : "its conditions aren't met."} Nothing was sent to the customer.
                        </p>
                        <ul className="mt-1 space-y-0.5 text-xs">
                          {t.conditions?.map((c, i) => <li key={i} className={c.pass ? "text-good" : "text-warn"}>{c.pass ? "✓" : "✗"} {condText(c.condition)}</li>)}
                        </ul>
                        <p className="mt-1 text-xs text-muted">Action: {t.action}{t.hasPhone === false ? " (this order has no WhatsApp number, so a send would be skipped)" : ""}</p>
                      </>
                    )}
                  </div>
                )}
                {open === r.id && <Runs id={r.id} />}
              </li>
            );
          })}
        </ul>
      )}
      {manage && data.automations.length > 0 && (
        <div className="card text-sm">
          <label className="label" htmlFor="rt-phone">Send test messages to (optional)</label>
          <input id="rt-phone" className="input max-w-xs" type="tel" placeholder="+91 98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <p className="mt-1 text-xs text-muted">With your own number here, &ldquo;Test&rdquo; on a rule that sends a template also sends it to you, with example values.</p>
        </div>
      )}
    </div>
  );
}
