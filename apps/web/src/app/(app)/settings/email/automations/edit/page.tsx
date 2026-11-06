"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { isCustomEventType, type ConditionNode, type FrequencyPolicy, type RecipientSelection } from "@app/shared/email";
import { SoftBox, StepCard, StepNumber } from "@/components/automations/MarketingKit";
import { ConditionBuilder } from "@/components/email/ConditionBuilder";
import { choiceClass, EmailPreviewFrame, Note } from "@/components/email/EmailUi";
import { LoadError } from "@/components/LoadError";
import { Field } from "@/components/staff/ui";
import { Alert } from "@/components/ui";
import { PageHeader, Skeleton, useAction } from "@/components/AppUi";
import { api, ApiError, useApi } from "@/lib/api";
import { useEmail, type AccountsResponse, type CatalogResponse, type RenderedPreview, type RuleView, type TemplateView } from "@/lib/email";

interface Draft {
  name: string;
  description: string;
  eventType: string;
  storeId: string | null;
  conditions: ConditionNode | null;
  senderIdentityId: string;
  templateId: string;
  recipient: RecipientSelection;
  delayMinutes: number;
  frequency: FrequencyPolicy;
  maxAttempts: number;
}

interface DryRun {
  wouldSend: boolean;
  steps: Array<{ step: string; ok: boolean; detail: string }>;
  conditions: Array<{ field: string; op: string; actual: string; pass: boolean }>;
  preview: RenderedPreview | null;
}

const STEPS = ["Event", "Conditions", "Sender", "Template", "Timing", "Preview and test", "Turn on"] as const;
/** Each step's heading (its number is drawn in a disc and read out before it). */
const TITLES = ["When should it run?", "Only when… (optional)", "Send from", "Which email", "Timing and limits", "Preview and test", "Name it and turn it on"] as const;

export default function AutomationBuilderPage() {
  return (
    <Suspense fallback={<Skeleton lines={8} />}>
      <Builder />
    </Suspense>
  );
}

function Builder() {
  const id = useSearchParams().get("id");
  const router = useRouter();
  const { base, automate } = useEmail();
  const catalog = useApi<CatalogResponse>(`${base}/catalog`);
  const accounts = useApi<AccountsResponse>(`${base}/accounts`);
  const templates = useApi<{ templates: TemplateView[] }>(`${base}/templates`);
  const existing = useApi<{ automation: RuleView }>(id ? `${base}/automations/${id}` : null);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [delayUnit, setDelayUnit] = useState<1 | 60 | 1440>(1);
  const [dry, setDry] = useState<DryRun | null>(null);
  const [sample, setSample] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const { busy, run } = useAction();

  const senders = useMemo(
    () => (accounts.data?.accounts ?? []).flatMap((a) => a.senders.filter((s) => s.status === "verified").map((s) => ({ ...s, account: a }))),
    [accounts.data],
  );

  useEffect(() => {
    if (draft) return;
    if (id) {
      const r = existing.data?.automation;
      if (!r) return;
      setDraft({
        name: r.name,
        description: r.description ?? "",
        eventType: r.eventType,
        storeId: r.storeId,
        conditions: r.conditions,
        senderIdentityId: r.senderIdentityId,
        templateId: r.templateId,
        recipient: r.recipient ?? { type: "customer" },
        delayMinutes: r.delayMinutes,
        frequency: r.frequency ?? { type: "once_per_event" },
        maxAttempts: r.maxAttempts,
      });
      setDelayUnit(r.delayMinutes && r.delayMinutes % 1440 === 0 ? 1440 : r.delayMinutes && r.delayMinutes % 60 === 0 ? 60 : 1);
    } else if (catalog.data && accounts.data) {
      const def = senders.find((s) => s.isDefault) ?? senders[0];
      setDraft({
        name: "",
        description: "",
        eventType: catalog.data.events.find((e) => e.available)?.type ?? "appointment.booked",
        storeId: null,
        conditions: null,
        senderIdentityId: def?.id ?? "",
        templateId: "",
        recipient: { type: "customer" },
        delayMinutes: 0,
        frequency: { type: "once_per_event" },
        maxAttempts: 5,
      });
    }
  }, [id, existing.data, catalog.data, accounts.data, senders, draft]);

  const failed = [catalog, accounts, templates, ...(id ? [existing] : [])].find((x) => x.error && !x.data);
  if (failed) return <LoadError what="the automation builder" error={failed.error} onRetry={failed.reload} busy={failed.loading} />;
  if (!draft || !catalog.data || !accounts.data || !templates.data) return <Skeleton lines={8} />;
  if (!automate) return <Alert kind="info">Your role can view automations but not change them.</Alert>;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const ev = catalog.data.events.find((e) => e.type === draft.eventType);
  const custom = !ev;
  const fields = ev ? ev.fields : catalog.data.customEvents.fields;
  const usable = templates.data.templates.filter((t) => t.status !== "archived" && (t.eventType === null || t.eventType === draft.eventType));
  const chosenTemplate = templates.data.templates.find((t) => t.id === draft.templateId);
  const body = () => ({ ...draft, description: draft.description || null, name: draft.name || "Untitled automation" });

  async function dryRun() {
    setErr(null);
    let data: unknown;
    if (sample.trim()) {
      try {
        data = JSON.parse(sample);
      } catch {
        setErr("The example data isn't valid JSON.");
        return;
      }
    }
    await run("dry", "run the preview", async () => {
      setDry(await api<DryRun>(`${base}/automations/dry-run`, { method: "POST", body: { ...body(), ...(data ? { data } : {}) } }));
    });
  }

  async function save(enable: boolean) {
    setErr(null);
    if (!draft!.name.trim()) {
      setErr("Give the automation a name.");
      return;
    }
    await run("save", "save the automation", async () => {
      let ruleId = id;
      try {
        if (id) await api(`${base}/automations/${id}`, { method: "PATCH", body: body() });
        else ruleId = (await api<{ automation: RuleView }>(`${base}/automations`, { method: "POST", body: body() })).automation.id;
        if (enable) await api(`${base}/automations/${ruleId}/enable`, { method: "POST" });
      } catch (e) {
        if (e instanceof ApiError) setErr(e.message);
        throw e;
      }
      router.push("/settings/email/automations");
      return enable ? "Automation saved and turned on." : "Automation saved (off).";
    });
  }

  const canNext = [
    !!draft.eventType && (!custom || isCustomEventType(draft.eventType)),
    true,
    !!draft.senderIdentityId,
    !!draft.templateId,
    true,
    true,
    true,
  ][step];

  return (
    <div className="space-y-4">
      <PageHeader title={id ? "Edit automation" : "New automation"} sub="Seven short steps. Nothing is sent until you turn it on." actions={<Link className="btn-secondary" href="/settings/email/automations">All automations</Link>} />
      {/* The steps as the Stitch design numbers one automation's parts (screen 19): a disc each, the one open in green. */}
      <ol className="flex flex-wrap gap-1.5 text-xs" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => setStep(i)}
              aria-current={step === i ? "step" : undefined}
              className={`inline-flex items-center gap-2 rounded px-2.5 py-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent ${step === i ? "bg-accent/10 font-semibold text-accent" : i < step ? "text-text hover:bg-home-soft" : "text-muted hover:bg-home-soft"}`}
            >
              <StepNumber n={i + 1} done={i < step} />
              <span>
                <span className="sr-only">{i + 1}. </span>
                {s}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {err && <Alert>{err}</Alert>}
      <StepCard id="r-step" n={step + 1} title={TITLES[step]}>
        {step === 0 && (
          <>
            <div className="grid gap-2">
              {catalog.data.events.map((e) => (
                <label key={e.type} className={`${choiceClass(draft.eventType === e.type)} ${e.available ? "" : "opacity-60"}`}>
                  <input type="radio" name="event" disabled={!e.available} checked={draft.eventType === e.type} onChange={() => set("eventType", e.type)} />
                  <span>
                    <span className="block font-medium">{e.label}</span>
                    <span className="text-xs text-muted">{e.available ? e.description : "Connect a Shopify store to use this event."}</span>
                  </span>
                </label>
              ))}
              <label className={choiceClass(custom)}>
                <input type="radio" name="event" checked={custom} onChange={() => set("eventType", catalog.data!.customEvents.examples[0]!)} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">A custom event from your own systems</span>
                  <span className="text-xs text-muted">{catalog.data.customEvents.note}</span>
                  {custom && (
                    <input className="input mt-2" aria-label="Custom event name" value={draft.eventType} onChange={(e) => set("eventType", e.target.value.trim().toLowerCase())} placeholder={catalog.data.customEvents.examples.join(", ")} />
                  )}
                  {custom && !isCustomEventType(draft.eventType) && <span className="mt-1 block text-xs text-danger">Use two to four lowercase parts with dots, like appointment.booked.</span>}
                </span>
              </label>
            </div>
            {!custom && catalog.data.stores.length > 1 && (
              <Field label="Only for one store" htmlFor="r-store">
                <select id="r-store" className="input" value={draft.storeId ?? ""} onChange={(e) => set("storeId", e.target.value || null)}>
                  <option value="">Every connected store</option>
                  {catalog.data.stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </>
        )}
        {step === 1 && (
          <>
            <ConditionBuilder value={draft.conditions} onChange={(v) => set("conditions", v)} fields={fields} customEvent={custom} />
          </>
        )}
        {step === 2 && (
          <>
            {senders.length === 0 ? (
              <Alert kind="info">
                No verified sender yet. <Link className="underline" href="/settings/email/accounts?add=1">Connect an email account</Link> first.
              </Alert>
            ) : (
              <select aria-label="Sender" className="input" value={draft.senderIdentityId} onChange={(e) => set("senderIdentityId", e.target.value)}>
                <option value="">Choose a sender…</option>
                {senders.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.email}
                    {s.isDefault ? " (default)" : ""}
                    {s.account.canSend ? "" : " — account needs attention"}
                  </option>
                ))}
              </select>
            )}
            <Field label="Send to" htmlFor="r-to">
              <select id="r-to" className="input" value={draft.recipient.type} onChange={(e) => set("recipient", e.target.value === "fixed" ? { type: "fixed", address: "" } : { type: "customer" })}>
                <option value="customer">The customer in the event</option>
                <option value="fixed">A fixed address (for example your team)</option>
              </select>
            </Field>
            {draft.recipient.type === "fixed" && (
              <input aria-label="Fixed recipient" className="input" type="email" placeholder="team@yourbusiness.com" value={draft.recipient.address} onChange={(e) => set("recipient", { type: "fixed", address: e.target.value })} />
            )}
          </>
        )}
        {step === 3 && (
          <>
            {usable.length === 0 ? (
              <Alert kind="info">
                No template fits this event yet. <Link className="underline" href="/settings/email/templates/edit">Write one</Link>, then come back.
              </Alert>
            ) : (
              <div className="grid gap-2">
                {usable.map((t) => (
                  <label key={t.id} className={choiceClass(draft.templateId === t.id)}>
                    <input type="radio" name="template" checked={draft.templateId === t.id} onChange={() => set("templateId", t.id)} />
                    <span className="min-w-0">
                      <span className="block font-medium">
                        {t.name} {t.status === "draft" && <span className="text-xs text-warn">(draft: activate it before turning this on)</span>}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {t.category === "marketing" ? "Marketing · " : ""}
                        {t.subject}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            {chosenTemplate?.category === "marketing" && <Note>Marketing emails go only to customers who agreed to email marketing, and include an unsubscribe link.</Note>}
          </>
        )}
        {step === 4 && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Wait before sending" htmlFor="r-delay" hint="Up to 30 days.">
                <div className="flex gap-2">
                  <input id="r-delay" className="input" type="number" min={0} value={draft.delayMinutes / delayUnit} onChange={(e) => set("delayMinutes", Math.max(0, Math.round(Number(e.target.value) * delayUnit)))} />
                  <select aria-label="Unit" className="input w-auto" value={delayUnit} onChange={(e) => {
                    const unit = Number(e.target.value) as 1 | 60 | 1440;
                    set("delayMinutes", Math.round((draft.delayMinutes / delayUnit) * unit));
                    setDelayUnit(unit);
                  }}>
                    <option value={1}>minutes</option>
                    <option value={60}>hours</option>
                    <option value={1440}>days</option>
                  </select>
                </div>
              </Field>
              <Field label="How often per customer" htmlFor="r-freq">
                <select
                  id="r-freq"
                  className="input"
                  value={draft.frequency.type === "once_per_recipient" ? `once:${draft.frequency.windowHours}` : draft.frequency.type}
                  onChange={(e) => {
                    const v = e.target.value;
                    set("frequency", v === "once_per_event" ? { type: "once_per_event" } : { type: "once_per_recipient", windowHours: Number(v.split(":")[1]) });
                  }}
                >
                  <option value="once_per_event">Once for every event</option>
                  <option value="once:24">At most once a day</option>
                  <option value="once:168">At most once a week</option>
                  <option value="once:720">At most once a month</option>
                </select>
              </Field>
              <Field label="Tries if the provider fails temporarily" htmlFor="r-tries" hint="Retries back off from about a minute to an hour.">
                <input id="r-tries" className="input" type="number" min={1} max={8} value={draft.maxAttempts} onChange={(e) => set("maxAttempts", Math.min(8, Math.max(1, Number(e.target.value) || 1)))} />
              </Field>
            </div>
          </>
        )}
        {step === 5 && (
          <>
            <p className="text-sm text-muted">Runs the automation against example data, without sending anything. Change the example to try your conditions.</p>
            <textarea aria-label="Example data (JSON)" className="input min-h-[6rem] font-mono text-xs" placeholder='{"order": {"total": 150}}' value={sample} onChange={(e) => setSample(e.target.value)} />
            <button className="btn-primary" disabled={!!busy} onClick={dryRun}>
              {busy === "dry" ? "Running…" : "Run preview"}
            </button>
            {dry && (
              <div className="space-y-3">
                <Alert kind={dry.wouldSend ? "success" : "info"}>{dry.wouldSend ? "With this data, the email would be sent." : "With this data, nothing would be sent."}</Alert>
                {/* The checks before it would send, as the design's "Check and turn on" list (screen 19). */}
                <SoftBox>
                  <ul className="space-y-1.5" aria-label="Checks">
                    {dry.steps.map((s) => (
                      <li key={s.step} className="flex gap-2">
                        {s.ok ? <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-good" /> : <X aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-danger" />}
                        <span className={s.ok ? "" : "text-danger"}>
                          <span className="sr-only">{s.ok ? "Passed: " : "Failed: "}</span>
                          {s.detail}
                        </span>
                      </li>
                    ))}
                  </ul>
                </SoftBox>
                {dry.conditions.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted">Each condition</summary>
                    <ul className="mt-1 space-y-0.5">
                      {dry.conditions.map((c, i) => (
                        <li key={i}>
                          {c.pass ? "✓" : "✗"} {c.field} {c.op} → {c.actual}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {dry.preview && (
                  <>
                    <p className="text-sm">
                      <span className="text-muted">Subject:</span> {dry.preview.subject}
                    </p>
                    <EmailPreviewFrame html={dry.preview.html} height={320} />
                  </>
                )}
              </div>
            )}
          </>
        )}
        {step === 6 && (
          <>
            <Field label="Name" required htmlFor="r-name">
              <input id="r-name" className="input" maxLength={100} value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="Thank-you for paid orders" />
            </Field>
            <Field label="Description" htmlFor="r-desc">
              <input id="r-desc" className="input" maxLength={500} value={draft.description} onChange={(e) => set("description", e.target.value)} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary" disabled={!!busy} onClick={() => save(true)}>
                {busy === "save" ? "Saving…" : "Save and turn on"}
              </button>
              <button className="btn-secondary" disabled={!!busy} onClick={() => save(false)}>
                Save, keep it off
              </button>
            </div>
            <Note>It runs for events that happen after it is turned on. Every event sends at most one email per automation.</Note>
          </>
        )}
      </StepCard>
      <div className="flex justify-between">
        <button className="btn-secondary" disabled={step === 0} onClick={() => setStep(step - 1)}>
          Back
        </button>
        {step < STEPS.length - 1 && (
          <button className="btn-primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
            Next
          </button>
        )}
      </div>
    </div>
  );
}
