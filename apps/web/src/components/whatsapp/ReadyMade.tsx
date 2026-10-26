"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  renderWaText,
  waAutomationMessageIssues,
  waPresetStarter,
  WA_AUTOMATION_PRESETS,
  WA_TEXT_MAX,
  WA_TRIGGER_INFO,
  WA_VARIABLE_INFO,
  type WaAutomationIssue,
  type WaAutomationPreset,
  type WaPresetKey,
  type WaSendTo,
} from "@app/shared/whatsapp";
import { ConfirmDialog, Dialog, useToast } from "@/components/AppUi";
import { Badge } from "@/components/dashboard/Primitives";
import { plural } from "@/components/messaging/MessagingUi";
import { Alert } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { WaAutomation, WaOverview, WaQuickAutomationResult, WaTemplate, WaTriggerAvailability } from "./types";
import { AUTOMATION_STATUS, issuesOf, IssueList, useWaAction, WaBubble, waError, waHref, WaSwitch } from "./WaUi";

// ---------------------------------------------------------------------------
// Ready-made automations (docs/whatsapp.md, "Ready-made automations"): one card per trigger. Turning
// one on is one short dialog (the message, who gets it, exactly what will happen) and one button:
// POST /automations/quick makes its template and switches it on. Once it exists, the card is its
// On/Off switch and its "Sending to" switch; the builder stays for everything else.
// ---------------------------------------------------------------------------

/** The sentence a ready-made automation's dialog and its "Send to your customers?" confirmation say. */
function whatHappens(p: WaAutomationPreset, sendTo: WaSendTo, testPhone: string | null): string {
  if (sendTo === "me") {
    return `While you try it, every message it sends goes only to your own number (${testPhone ?? "your verified test number"}) instead of the customer, within your sending hours. Switch "Sending to" to your customers when you're happy with it.`;
  }
  return p.sentence;
}

/** Its On/Off switch and its "Sending to: your customers / only you" switch, on a card or a row of the list. */
export function AutomationSwitches({ base, automation: a, overview, sentence, onChanged }: { base: string; automation: WaAutomation; overview: WaOverview; sentence?: string; onChanged: () => void }) {
  // Its own radio group: the same automation's switches are on its card and in the list.
  const group = useId();
  const { busy, run } = useWaAction();
  const [refused, setRefused] = useState<WaAutomationIssue[]>([]);
  const [goLive, setGoLive] = useState(false);
  const on = a.status === "active";
  const testPhone = overview.settings.testPhone;

  const toggle = (next: boolean) =>
    run(`onoff:${a.id}`, next ? "switch the automation on" : "switch the automation off", async () => {
      setRefused([]);
      if (next) {
        try {
          await api(`${base}/automations/${a.id}/activate`, { method: "POST" });
        } catch (e) {
          setRefused(issuesOf(e));
          throw e;
        }
        onChanged();
        return a.testMode ? `"${a.name}" is on, sending only to your number.` : `"${a.name}" is on.`;
      }
      const r = await api<{ cancelled: number }>(`${base}/automations/${a.id}/pause`, { method: "POST" });
      onChanged();
      return r.cancelled ? `"${a.name}" is off. ${plural(r.cancelled, "waiting message")} cancelled.` : `"${a.name}" is off.`;
    });

  const sendTo = (testMode: boolean) =>
    run(`sendto:${a.id}`, "change who it sends to", async () => {
      const r = await api<{ cancelled: number }>(`${base}/automations/${a.id}/test-mode`, { method: "POST", body: { testMode } });
      setGoLive(false);
      onChanged();
      if (!testMode) return `"${a.name}" now sends to your customers.`;
      return `"${a.name}" now sends only to your number.${r.cancelled ? ` ${plural(r.cancelled, "message")} still waiting for customers cancelled.` : ""}`;
    });

  const pill = (active: boolean) =>
    `inline-flex cursor-pointer items-center rounded-full px-3 py-1 transition focus-within:ring-2 focus-within:ring-accent ${active ? "bg-accent/15 font-semibold text-text" : "text-muted hover:text-text"} ${busy ? "cursor-wait" : ""}`;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <WaSwitch checked={on} label={`${a.name}: ${on ? "on" : "off"}`} disabled={!!busy} onChange={(next) => void toggle(next)} testId="wa-onoff" />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted" id={group}>
            Sending to
          </span>
          <div role="radiogroup" aria-labelledby={group} className="inline-flex rounded-full border border-border p-0.5" data-testid="wa-sendto">
            <label className={pill(!a.testMode)}>
              <input type="radio" className="sr-only" name={group} checked={!a.testMode} disabled={!!busy} onChange={() => setGoLive(true)} />
              Your customers
            </label>
            <label className={pill(a.testMode)}>
              <input type="radio" className="sr-only" name={group} checked={a.testMode} disabled={!!busy} onChange={() => void sendTo(true)} />
              Only you{testPhone ? ` (${testPhone})` : ""}
            </label>
          </div>
        </div>
      </div>
      {refused.length > 0 && (
        <Alert kind="error" onDismiss={() => setRefused([])}>
          It can&apos;t be switched on yet:
          <IssueList issues={refused} className="mt-1" />
        </Alert>
      )}
      <ConfirmDialog
        open={goLive}
        title={`Send "${a.name}" to your customers?`}
        confirmLabel="Send to my customers"
        busy={busy === `sendto:${a.id}`}
        onCancel={() => setGoLive(false)}
        onConfirm={() => void sendTo(false)}
      >
        <p>{sentence ?? "From now on its messages go to your customers instead of your own number, within your sending hours."}</p>
        <p>Customers who replied STOP, or whose number isn&apos;t on WhatsApp, get nothing.</p>
        {!on && <p>It&apos;s off right now: switch it on to start sending.</p>}
      </ConfirmDialog>
    </div>
  );
}

export function ReadyMade({
  base,
  overview,
  automations,
  templates,
  samples,
  triggers,
  onChanged,
  onTurnedOn,
  onEdit,
}: {
  base: string;
  overview: WaOverview;
  automations: WaAutomation[];
  templates: WaTemplate[];
  samples: Record<string, string>;
  triggers: WaTriggerAvailability;
  onChanged: () => void;
  /** A Turn on's answer, so its automation and template show before the lists are fetched again. */
  onTurnedOn: (r: WaQuickAutomationResult) => void;
  onEdit: (a: WaAutomation) => void;
}) {
  const manage = overview.can.manage;
  const params = useSearchParams();
  const router = useRouter();
  const [opening, setOpening] = useState<WaAutomationPreset | null>(null);
  const [results, setResults] = useState<Partial<Record<WaPresetKey, WaQuickAutomationResult>>>({});
  // ?preset= (the Overview's "Turn on your first automation") opens that preset's dialog, once.
  const asked = params.get("preset");
  const [handled, setHandled] = useState<string | null>(null);
  if (asked && handled !== asked) {
    setHandled(asked);
    const p = WA_AUTOMATION_PRESETS.find((x) => x.key === asked);
    if (p && manage && triggers[p.trigger]?.available && !automations.some((a) => a.trigger === p.trigger)) setOpening(p);
  } else if (!asked && handled) {
    setHandled(null);
  }
  // Once it is handled and no dialog is open (closed, finished, or it couldn't open), ?preset= leaves
  // the address, as ?compose= does on Messages: back from the builder or after a refresh, the dialog
  // doesn't open again by itself.
  const presetDone = !!asked && handled === asked && !opening;
  useEffect(() => {
    if (presetDone) router.replace(waHref("automations"));
  }, [presetDone, router]);

  return (
    <section aria-labelledby="wa-ready-title" className="space-y-3">
      <div>
        <h3 id="wa-ready-title" className="text-base font-semibold">
          Ready-made automations
        </h3>
        <p className="mt-1 text-sm text-muted">Check the message, choose who gets it, and turn it on: one step each. They follow your sending hours and each customer&apos;s consent.</p>
      </div>
      <ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {WA_AUTOMATION_PRESETS.map((p) => {
          const mine = automations.filter((a) => a.trigger === p.trigger);
          return (
            <PresetCard
              key={p.key}
              base={base}
              preset={p}
              automation={mine[0] ?? null}
              more={mine.length - 1}
              template={mine[0] ? (templates.find((t) => t.id === mine[0]!.templateId) ?? null) : null}
              samples={samples}
              availability={triggers[p.trigger]}
              overview={overview}
              result={results[p.key] ?? null}
              onDismissResult={() => setResults((r) => ({ ...r, [p.key]: undefined }))}
              onTurnOn={() => setOpening(p)}
              onEdit={onEdit}
              onChanged={onChanged}
            />
          );
        })}
      </ul>
      {opening && (
        <TurnOnDialog
          key={opening.key}
          base={base}
          preset={opening}
          overview={overview}
          samples={samples}
          onClose={() => setOpening(null)}
          onDone={(r) => {
            setResults((x) => ({ ...x, [opening.key]: r }));
            setOpening(null);
            onTurnedOn(r);
            onChanged();
          }}
          onFailed={onChanged}
        />
      )}
    </section>
  );
}

function PresetCard({
  base,
  preset: p,
  automation: a,
  more,
  template,
  samples,
  availability,
  overview,
  result,
  onDismissResult,
  onTurnOn,
  onEdit,
  onChanged,
}: {
  base: string;
  preset: WaAutomationPreset;
  automation: WaAutomation | null;
  more: number;
  template: WaTemplate | null;
  samples: Record<string, string>;
  availability: { available: boolean; reason: string | null } | undefined;
  overview: WaOverview;
  result: WaQuickAutomationResult | null;
  onDismissResult: () => void;
  onTurnOn: () => void;
  onEdit: (a: WaAutomation) => void;
  onChanged: () => void;
}) {
  const id = useId();
  const manage = overview.can.manage;
  const marketing = WA_TRIGGER_INFO[p.trigger].category === "marketing";
  const unavailable = !availability?.available;
  const body = template?.body ?? waPresetStarter(p).body;
  const preview = useMemo(() => renderWaText(body, samples, { lenient: true }), [body, samples]);
  const st = a ? (AUTOMATION_STATUS[a.status] ?? { tone: "neutral" as const, label: a.status }) : null;
  // The Turn on result only while it still describes this card's automation: switched off, to "Only
  // you" and back, or deleted, it would contradict the card, so it goes.
  const live = !!result && !!a && a.id === result.automation.id && a.status === result.automation.status && a.testMode === result.automation.testMode;
  const shown = live ? result : null;
  useEffect(() => {
    if (result && !live) onDismissResult();
  }, [result, live, onDismissResult]);
  // Saved off, the result lists why (Shopify refusing new customers' events too, which the list's
  // check can't see): the card's own list would repeat it.
  const issues = shown && !shown.activated ? [] : (a?.issues ?? []);

  return (
    <li className={`card flex flex-col gap-3 ${a?.status === "active" ? "border-good/40" : ""} ${unavailable && !a ? "opacity-70" : ""}`} aria-labelledby={id} data-testid={`wa-preset-${p.key}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 id={id} className="font-semibold">
            {p.name}
          </h4>
          <p className="mt-0.5 text-xs text-muted">{p.when}</p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {marketing && <Badge tone="neutral">Marketing</Badge>}
          {st && <Badge tone={st.tone}>{st.label}</Badge>}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-bg p-3">
        <WaBubble>{preview}</WaBubble>
      </div>

      {shown && (
        <Alert kind={shown.activated ? "success" : "info"} onDismiss={onDismissResult}>
          {shown.activated ? (
            shown.automation.testMode ? "It's on, sending only to your number while you try it." : "It's on. Customers get it from the next time this happens."
          ) : shown.issues.length ? (
            <>
              Saved, switched off. It can be switched on once this is done:
              <IssueList issues={shown.issues} className="mt-1" />
            </>
          ) : (
            "Saved, switched off."
          )}
          {shown.notice && <span className="mt-1 block">{shown.notice}</span>}
        </Alert>
      )}

      {!a && unavailable && <p className="text-xs text-warn">{availability?.reason ?? "Your store can't use this trigger."}</p>}

      {!a && !unavailable && !manage && <p className="text-xs text-muted">Only the store&apos;s owners and admins can turn it on.</p>}

      {!a && manage && (
        <button type="button" className="btn-primary mt-auto self-start" disabled={unavailable} onClick={onTurnOn}>
          Turn on
        </button>
      )}

      {a && (
        <div className="mt-auto space-y-2">
          {a.stats && <p className="text-xs text-muted">Last 30 days: {plural(a.stats.queued, "message")} sent or waiting, {a.stats.skipped} skipped.</p>}
          {more > 0 && <p className="text-xs text-muted">{plural(more, "more automation")} also {more === 1 ? "sends" : "send"} for this: see Your automations below.</p>}
          <IssueList issues={issues} />
          {manage ? (
            <>
              <AutomationSwitches base={base} automation={a} overview={overview} sentence={whatHappens(p, "customers", null)} onChanged={onChanged} />
              <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => onEdit(a)}>
                Edit
              </button>
            </>
          ) : (
            a.testMode && <p className="text-xs text-muted">Sending only to the store&apos;s own number (test mode).</p>
          )}
        </div>
      )}
    </li>
  );
}

/** The one short dialog: the message, who gets it, exactly what will happen, and one button. */
function TurnOnDialog({
  base,
  preset: p,
  overview,
  samples,
  onClose,
  onDone,
  onFailed,
}: {
  base: string;
  preset: WaAutomationPreset;
  overview: WaOverview;
  samples: Record<string, string>;
  onClose: () => void;
  onDone: (r: WaQuickAutomationResult) => void;
  /** After a refusal or an error: the cards look again, in case it was saved anyway. */
  onFailed: () => void;
}) {
  const id = useId();
  const toast = useToast();
  const info = WA_TRIGGER_INFO[p.trigger];
  const s = overview.settings;
  const marketing = info.category === "marketing";
  const marketingOff = marketing && !s.marketingEnabled;
  const setupDone = !overview.setup.current;
  const [body, setBody] = useState(() => waPresetStarter(p).body);
  const [sendTo, setSendTo] = useState<WaSendTo>("customers");
  const [enableMarketing, setEnableMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const issues = useMemo(() => waAutomationMessageIssues(body, p.trigger), [body, p.trigger]);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const preview = useMemo(() => (body.trim() ? renderWaText(body, samples, { lenient: true }) : ""), [body, samples]);

  const insert = (v: string) => {
    const el = area.current;
    const token = `{{${v}}}`;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + token + body.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const submit = async () => {
    if (busy || errors.length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<WaQuickAutomationResult>(`${base}/automations/quick`, { method: "POST", body: { preset: p.key, body, sendTo, ...(marketingOff && enableMarketing ? { enableMarketing: true } : {}) } });
      if (r.activated) toast("success", sendTo === "me" ? `"${p.name}" is on, sending only to your number.` : `"${p.name}" is on.`);
      onDone(r);
    } catch (e) {
      // It may have been saved before it failed (or made in another tab): the cards look again.
      onFailed();
      if (e instanceof ApiError && e.code === "automation_exists") {
        // This trigger has its automation already: its card shows it, with its switches.
        toast("info", waError(e, "turn the automation on"));
        onClose();
        return;
      }
      setError(waError(e, "turn the automation on"));
      setBusy(false);
    }
  };

  return (
    <Dialog open title={`Turn on "${p.name}"`} onClose={() => !busy && onClose()}>
      <form
        noValidate
        className="space-y-4"
        data-testid="wa-quick-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="text-sm text-muted">
          {p.when}. {p.description}
        </p>

        <div>
          <label className="label" htmlFor={`${id}-body`}>
            The message
          </label>
          <textarea
            id={`${id}-body`}
            ref={area}
            className="input min-h-32 font-[inherit]"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            aria-invalid={errors.length > 0}
            aria-describedby={`${id}-count ${id}-issues`}
          />
          <p id={`${id}-count`} className={`mt-1 text-xs ${body.trim().length > WA_TEXT_MAX ? "text-danger" : "text-muted"}`}>
            {body.trim().length} / {WA_TEXT_MAX} characters
          </p>
          <div className="mt-2" role="group" aria-label="Insert a detail">
            <p className="text-xs text-muted">Insert a detail (each customer sees their own):</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {info.variables.map((v) => (
                <button key={v} type="button" className="rounded-full border border-border bg-surface px-2.5 py-1 text-xs transition hover:border-accent hover:bg-accent/5" title={`{{${v}}}`} onClick={() => insert(v)}>
                  {WA_VARIABLE_INFO[v].label}
                </button>
              ))}
            </div>
          </div>
          <div id={`${id}-issues`} className="mt-2 space-y-1 text-xs" aria-live="polite">
            {errors.map((i) => (
              <p key={i.message} className="text-danger">
                {i.message}
              </p>
            ))}
            {warnings.map((i) => (
              <p key={i.message} className="text-muted">
                {i.message}
              </p>
            ))}
          </div>
        </div>

        <div>
          <p className="label">How it looks, with sample values</p>
          <div className="rounded-xl border border-border bg-bg p-3">{preview ? <WaBubble>{preview}</WaBubble> : <p className="text-sm text-muted">Write the message to see it here.</p>}</div>
        </div>

        {marketing && (
          <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
            <p className="text-muted">This is a marketing message: it goes only to customers who agreed to marketing messages, and it must tell them how to stop (Reply STOP).</p>
            {marketingOff && (
              <>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={enableMarketing} onChange={(e) => setEnableMarketing(e.target.checked)} />
                  <span>
                    <span className="font-medium">Turn on marketing messages</span>
                    <span className="block text-xs text-muted">They&apos;re off in Settings, for the whole store. Each customer still needs to have agreed to them.</span>
                  </span>
                </label>
                {!enableMarketing && <p className="text-xs text-warn">Without it, &ldquo;{p.name}&rdquo; is saved switched off.</p>}
              </>
            )}
          </div>
        )}

        <fieldset>
          <legend className="label">Who gets it</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ["customers", "Send to my customers", "The customer the order, checkout or message is about."],
                ["me", "Only to me while I try it", s.testPhone ? `Your verified number, ${s.testPhone}.` : "Your verified test number (Setup, step 4)."],
              ] as const
            ).map(([value, label, help]) => (
              <label key={value} className={`flex cursor-pointer gap-2 rounded-lg border p-3 text-sm transition ${sendTo === value ? "border-accent bg-accent/10" : "border-border hover:bg-bg"}`}>
                <input type="radio" name={`${id}-sendto`} className="mt-1 accent-[var(--accent)]" checked={sendTo === value} onChange={() => setSendTo(value)} />
                <span className="min-w-0">
                  <span className="font-medium">{label}</span>
                  <span className="mt-0.5 block text-xs text-muted">{help}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="rounded-lg border border-border bg-bg p-3 text-sm" data-testid="wa-quick-what-happens">
          <p className="font-medium">{whatHappens(p, sendTo, s.testPhone)}</p>
          {sendTo === "customers" && !marketing && s.orderUpdates === "opt_in_only" && <p className="mt-1 text-xs text-muted">Only customers who agreed to WhatsApp messages get it (your choice in Settings).</p>}
          {sendTo === "customers" && <p className="mt-1 text-xs text-muted">Customers who replied STOP, or whose number isn&apos;t on WhatsApp, get nothing.</p>}
        </div>

        {!setupDone && <Alert kind="info">The setup isn&apos;t finished, so it&apos;s saved switched off. Switch it on from its card once the setup is done.</Alert>}
        {error && <Alert kind="error">{error}</Alert>}

        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy || errors.length > 0}>
            {busy ? "Turning on…" : setupDone ? "Turn on" : "Save it"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
