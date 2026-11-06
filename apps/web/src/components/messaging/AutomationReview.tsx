"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowRight, Check, ChevronDown, CircleAlert, Clock, MessageSquareText, Pencil, Power, Send, Users, Zap } from "lucide-react";
import { callingCode, normalizePhone, PHONE_COUNTRIES } from "@app/shared/messaging";
import { automationTriggerCard, type SmsTrigger } from "@app/shared/sms";
import { useToast } from "@/components/AppUi";
import { Badge } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { api } from "@/lib/api";
import { AUTOMATION_STATUS } from "./AutomationUi";
import { countryName, fmtWhen, smsError, SmsStatusBadge, useSms } from "./MessagingUi";
import type { AutomationChecks, AutomationView, MessagingReadiness, SmsMessage, SmsSetupState } from "./types";

// ---------------------------------------------------------------------------
// The builder's last two steps: a test text to one of the team's own approved numbers (followed to
// its outcome), and the review, which shows the automation as a flow of WHEN → WHO → SEND →
// MESSAGE → TIMING → STATUS (each block opens its step), and beside it the Stitch design's "Check
// and turn on" panel (screen 19): the API's checks in words with where to fix each one, and the
// button that activates it. The checks are the API's (readiness.ts): the button is offered only
// when activation would be accepted.
// ---------------------------------------------------------------------------

const LIVE = new Set(["scheduled", "sending", "accepted", "pending"]);
/** Checks about the platform's own account and provider: nothing for the store to fix, only to read about. */
const PLATFORM_CHECKS = new Set(["provider", "account"]);
/** A fresh id for one press of a button (the API returns the same text for a repeat of it). */
const requestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

/** A test text's outcome as the step says it: sent, on its way, or not sent and why (never the provider's code). */
export function testResult(m: SmsMessage): { ok: boolean | null; title: string; detail: string | null } {
  switch (m.status) {
    case "scheduled":
    case "sending":
      return { ok: null, title: "Sending…", detail: null };
    case "accepted":
    case "pending":
      return { ok: true, title: "✓ Test message sent", detail: "On its way: waiting for the phone to confirm delivery." };
    case "delivered":
      return { ok: true, title: "✓ Test message sent", detail: "Delivered: the phone confirmed it arrived." };
    case "carrier_accepted":
      return { ok: true, title: "✓ Test message sent", detail: "The carrier accepted it. This network doesn't confirm delivery to the phone: check your phone." };
    case "unknown":
    case "uncertain":
      return { ok: null, title: "Test message sent, outcome unknown", detail: "The carrier never said whether it arrived. Check your phone before sending another." };
    default:
      return { ok: false, title: "⚠ Test message could not be sent", detail: m.providerExplanation ?? m.reasonLabel ?? null };
  }
}

/** Step 4: the saved message, with the sample customer's details, to an approved test recipient. */
export function TestStep({
  automationId,
  setup,
  readiness,
  base,
  manage,
  dirty,
  onSetup,
}: {
  automationId: string | null;
  setup: SmsSetupState;
  readiness: MessagingReadiness | null;
  base: string;
  manage: boolean;
  dirty: boolean;
  onSetup: (s: SmsSetupState) => void;
}) {
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
  // Followed to a final outcome (or 3 minutes): the provider accepting it isn't the phone getting it.
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
  const result = message ? testResult(message) : null;

  return (
    <div className="space-y-4">
      {readiness?.testMode && (
        <Alert kind="info">
          Your SMS account is still being verified. Test messages can be sent to approved numbers until verification is complete.{" "}
          <Link className="font-medium underline" href="/messaging/settings">
            View setup requirements
          </Link>
        </Alert>
      )}
      {!manage ? (
        <p className="text-sm text-muted">Only owners and admins can send test messages.</p>
      ) : !automationId ? (
        <p className="text-sm text-muted">Finish the message first: the saved message is what&apos;s tested.</p>
      ) : (
        <div className="space-y-3 rounded bg-home-soft p-4">
          <p className="font-medium">Send a test message</p>
          <p className="text-sm text-muted">Your message, with a sample customer&apos;s details, to your own phone. It never goes to a customer.</p>
          {!senderReady && (
            <p className="flex flex-wrap items-center gap-x-2 text-sm text-warn">
              <CircleAlert aria-hidden className="h-4 w-4" />
              Test messages need an approved SMS sender.
              <Link className="font-medium underline" href="/messaging/setup?step=sender">
                Fix this
              </Link>
            </p>
          )}
          {problem && <Alert onDismiss={() => setProblem(null)}>{problem}</Alert>}
          {verified.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="label">Test recipient</legend>
              {verified.map((t) => (
                <label key={t.id} className={`flex cursor-pointer items-center gap-3 rounded bg-surface p-2.5 text-sm ${numberId === t.id ? "ring-2 ring-accent" : ""}`}>
                  <input type="radio" name="auto-test-number" className="accent-[var(--accent)]" checked={numberId === t.id} onChange={() => setNumberId(t.id)} />
                  <span className="font-mono">{t.number}</span>
                  <Badge tone="good">Approved</Badge>
                </label>
              ))}
            </fieldset>
          )}
          {pending.map((t) => (
            <div key={t.id} className="flex flex-wrap items-end gap-2 rounded bg-surface p-2.5">
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-mono">{t.number}</p>
                <p className="text-xs text-muted">Enter the code we texted to this number to approve it.</p>
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
                    toast("success", "Number approved.");
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
                  toast("success", "We're texting you a code.");
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
                  {verified.length ? "Another test phone number" : "Test phone number"}
                </label>
                <input id="auto-test-number" className="input" type="tel" inputMode="tel" autoComplete="tel-national" placeholder="0412 345 678" value={number} aria-invalid={!!number && !normalized} onChange={(e) => setNumber(e.target.value)} />
              </div>
              <button type="submit" className="btn-secondary" disabled={!!busy || !normalized || setup.mode === "off"}>
                {busy === "add" ? "Texting a code…" : "Text me a code"}
              </button>
            </form>
          )}
          <p className="text-xs text-muted">New test numbers are approved with a code we text to them, so tests only ever reach your own phones.</p>
          <button
            type="button"
            className="btn-primary inline-flex items-center gap-1.5"
            disabled={!!busy || !numberId || !senderReady || dirty || wait > 0 || setup.mode === "off"}
            title={dirty ? "Save your changes first: the saved message is what's tested" : undefined}
            onClick={() =>
              void act("send", "send the test", async () => {
                // One id per press: a retried request gets the same text back instead of a second one.
                const r = await api<{ message: SmsMessage }>(`${base}/automations/${automationId}/test`, { method: "POST", body: { testNumberId: numberId, requestId: requestId() } });
                setMessage(r.message);
                setWaitUntil(Date.now() + 30_000);
              })
            }
          >
            <Send aria-hidden className="h-4 w-4" /> {busy === "send" ? "Sending…" : wait > 0 ? `Send again in ${wait} s` : "Send Test"}
          </button>
          {message && result && (
            <div className={`rounded p-3 text-sm ${result.ok === false ? "bg-warn/10" : result.ok ? "bg-good/10" : "bg-surface"}`} role="status" aria-live="polite">
              <p className="flex flex-wrap items-center gap-2 font-semibold">
                {result.title} <SmsStatusBadge status={message.status} label={message.statusLabel} />
                {message.to && <span className="font-normal text-muted">to {message.to}</span>}
              </p>
              {result.detail && <p className="mt-1">{result.detail}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One block of the flow: what it says, and the step that changes it. */
function FlowBlock({ label, icon, children, onEdit, editLabel }: { label: string; icon: ReactNode; children: ReactNode; onEdit?: () => void; editLabel: string }) {
  const body = (
    <>
      <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-surface text-accent">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</span>
        <span className="block text-sm">{children}</span>
      </span>
      {onEdit && <Pencil aria-hidden className="h-4 w-4 shrink-0 text-muted transition group-hover:text-accent" />}
    </>
  );
  return onEdit ? (
    <button type="button" className="group flex w-full items-start gap-3 rounded bg-home-soft p-3 text-left transition outline-none hover:bg-home-soft-hover focus-visible:ring-2 focus-visible:ring-accent" aria-label={editLabel} onClick={onEdit}>
      {body}
    </button>
  ) : (
    <div className="flex w-full items-start gap-3 rounded bg-home-soft p-3">{body}</div>
  );
}

const Arrow = () => (
  <div aria-hidden className="flex justify-center py-0.5 text-muted">
    <ArrowDown className="h-4 w-4" />
  </div>
);

/** Step 5: the automation as a flow, its name, count and status (the checks and the switch are ReviewChecks, beside it). */
export function ReviewStep({
  name,
  trigger,
  audience,
  recipients,
  sender,
  message,
  timing,
  saved,
  checks,
  manage,
  busy,
  onGo,
}: {
  name: string;
  trigger: SmsTrigger;
  audience: string;
  recipients: string | null;
  sender: string;
  message: string;
  timing: string;
  saved: AutomationView | null;
  checks: AutomationChecks | null;
  manage: boolean;
  busy: string | null;
  onGo: (step: number) => void;
}) {
  const { store } = useSms();
  const on = saved?.status === "active";
  const status = saved ? AUTOMATION_STATUS[saved.status] : null;

  return (
    <div className="space-y-5">
      <dl className="grid gap-x-4 gap-y-2 border-b border-home-line pb-4 text-sm sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted">Automation name</dt>
        <dd className="flex flex-wrap items-center gap-2 font-medium">
          &ldquo;{name}&rdquo;
          <button type="button" className="text-xs font-normal text-accent underline-offset-2 hover:underline" onClick={() => onGo(0)}>
            Rename
          </button>
        </dd>
        <dt className="text-muted">Estimated recipients</dt>
        <dd>{recipients ?? "—"}</dd>
        <dt className="text-muted">Status</dt>
        <dd className="flex flex-wrap items-center gap-2">
          {status ? <Badge tone={status.tone}>{on ? "✓ Active" : status.label}</Badge> : <Badge tone="neutral">Not saved</Badge>}
          {saved?.pendingChanges && <Badge tone="warn">Changes not live</Badge>}
          {!on && checks && <span className="text-muted">{checks.canActivate ? "Ready to activate" : "Not ready yet"}</span>}
        </dd>
      </dl>

      <ol className="space-y-0" aria-label="How it works">
        <li>
          <FlowBlock label="When" icon={<Zap className="h-[18px] w-[18px]" />} onEdit={() => onGo(0)} editLabel="Edit when it's sent">
            {automationTriggerCard(trigger).label}
          </FlowBlock>
        </li>
        <Arrow />
        <li>
          <FlowBlock label="Who" icon={<Users className="h-[18px] w-[18px]" />} onEdit={() => onGo(1)} editLabel="Edit who gets it">
            {audience}
          </FlowBlock>
        </li>
        <Arrow />
        <li>
          <FlowBlock label="Send" icon={<Send className="h-[18px] w-[18px]" />} editLabel="SMS">
            SMS from {sender}
          </FlowBlock>
        </li>
        <Arrow />
        <li>
          <FlowBlock label="Message" icon={<MessageSquareText className="h-[18px] w-[18px]" />} onEdit={() => onGo(2)} editLabel="Edit the message">
            <span className="whitespace-pre-wrap">&ldquo;{message}&rdquo;</span>
          </FlowBlock>
        </li>
        <Arrow />
        <li>
          <FlowBlock label="Timing" icon={<Clock className="h-[18px] w-[18px]" />} onEdit={() => onGo(0)} editLabel="Edit the timing">
            {timing}
          </FlowBlock>
        </li>
        <Arrow />
        <li>
          <FlowBlock label="Status" icon={<Power className="h-[18px] w-[18px]" />} editLabel="Status">
            {on ? "Active: it runs every time this happens" : saved?.status === "paused" ? "Paused" : "Off until you activate it"}
          </FlowBlock>
        </li>
      </ol>

      {saved && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted" aria-live="polite">
          {saved.lastResult ? (
            <>
              Last text {fmtWhen(saved.lastResult.at, store?.timezone)}: <SmsStatusBadge status={saved.lastResult.status} why={saved.lastResult.reasonLabel} />
              {saved.lastResult.reasonLabel && <span>{saved.lastResult.reasonLabel}</span>}
            </>
          ) : saved.lastRunAt ? (
            `Last ran ${fmtWhen(saved.lastRunAt, store?.timezone)}`
          ) : on ? (
            "Hasn't run yet: it runs the next time this happens."
          ) : null}
        </p>
      )}

      {manage && (
        <div className="flex flex-wrap items-center gap-2 border-t border-home-line pt-4">
          <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => onGo(3)}>
            ← Back
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Beside the review, as the Stitch design's screen 19 puts its last step: the API's checks in
 * words with where to fix each one, then a test and the button that turns it on (asked first).
 */
export function ReviewChecks({
  saved,
  dirty,
  checks,
  checksLoading,
  manage,
  busy,
  onTest,
  onActivate,
  onPause,
  onSave,
}: {
  saved: AutomationView | null;
  dirty: boolean;
  checks: AutomationChecks | null;
  checksLoading: boolean;
  manage: boolean;
  busy: string | null;
  onTest: () => void;
  onActivate: () => void;
  onPause: () => void;
  onSave: () => void;
}) {
  const [showPassed, setShowPassed] = useState(false);
  const on = saved?.status === "active";
  const failing = (checks?.checks ?? []).filter((c) => !c.ok);
  const passed = (checks?.checks ?? []).filter((c) => c.ok);
  const blocking = failing.filter((c) => c.blocking);
  const canActivate = manage && !!saved && !!checks?.canActivate && !checksLoading;
  const republish = on && (saved?.pendingChanges || dirty);

  return (
    <section aria-labelledby="checks-h" className="home-card animate-rise space-y-4 p-5" data-testid="review-checks">
      <h2 id="checks-h" className="home-h2">
        Check and turn on
      </h2>
      <div className="space-y-2">
        {dirty ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-warn">
            <CircleAlert aria-hidden className="h-4 w-4" /> Your latest changes aren&apos;t saved yet.
            {manage && (
              <button type="button" className="font-medium underline" disabled={!!busy} onClick={onSave}>
                Save now
              </button>
            )}
          </p>
        ) : !checks ? (
          checksLoading ? (
            <div className="skeleton h-16" />
          ) : (
            <p className="text-sm text-muted">Save the automation to check it.</p>
          )
        ) : (
          <>
            {failing.length > 0 ? (
              <ul className="space-y-2" aria-label="Needs attention">
                {failing.map((c) => (
                  <li key={c.key} className={`flex flex-wrap items-start gap-x-3 gap-y-1 rounded p-3 text-sm ${c.blocking ? "bg-warn/10" : "bg-home-soft"}`}>
                    <CircleAlert aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 ${c.blocking ? "text-warn" : "text-muted"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{c.label}</span>
                      <span className="block text-muted">{c.message}</span>
                    </span>
                    {c.fix && manage && (
                      <Link className="inline-flex h-8 items-center gap-1 rounded-sm text-[13px] font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent" href={c.fix.href} aria-label={`${PLATFORM_CHECKS.has(c.key) ? c.fix.label : "Fix this"}: ${c.label}`}>
                        {PLATFORM_CHECKS.has(c.key) ? c.fix.label : "Fix this"} <ArrowRight aria-hidden className="h-3.5 w-3.5" />
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-2 text-sm text-good">
                <Check aria-hidden className="h-4 w-4" strokeWidth={3} /> Everything checks out.
              </p>
            )}
            {passed.length > 0 && (
              <div>
                <button type="button" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text" aria-expanded={showPassed} onClick={() => setShowPassed(!showPassed)}>
                  <ChevronDown aria-hidden className={`h-4 w-4 transition ${showPassed ? "rotate-180" : ""}`} /> {passed.length} check{passed.length === 1 ? "" : "s"} passed
                </button>
                {showPassed && (
                  <ul className="mt-2 space-y-1.5 text-sm" aria-label="Passed checks">
                    {passed.map((c) => (
                      <li key={c.key} className="flex gap-2">
                        <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-good" />
                        <span>
                          <span className="font-medium">{c.label}.</span> <span className="text-muted">{c.message}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {blocking.length > 0 && !on && <p className="text-xs text-muted">Fix what&apos;s marked above, then come back here to activate it. Your automation is saved as a draft meanwhile.</p>}
          </>
        )}
      </div>

      {manage && (
        <div className="flex flex-col gap-2 border-t border-home-line pt-4 [&>button]:w-full">
          <button type="button" className="btn-secondary inline-flex items-center gap-1.5" disabled={!!busy || !saved} onClick={onTest}>
            <Send aria-hidden className="h-4 w-4" /> Send Test
          </button>
          {on && !republish ? (
            <button type="button" className="btn-secondary" disabled={!!busy} onClick={onPause}>
              {busy === "pause" ? "Pausing…" : "Pause automation"}
            </button>
          ) : (
            <>
              {on && (
                <button type="button" className="btn-secondary" disabled={!!busy} onClick={onPause}>
                  Pause
                </button>
              )}
              <button type="button" className="btn-primary inline-flex items-center gap-1.5" disabled={!!busy || (!canActivate && !dirty) || (dirty && !saved)} onClick={onActivate} title={!canActivate && !dirty ? "Fix what's marked first" : undefined}>
                <Power aria-hidden className="h-4 w-4" /> {busy === "activate" ? "Activating…" : republish ? "Put changes live" : saved?.status === "paused" ? "Resume automation" : "Activate Automation"}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
