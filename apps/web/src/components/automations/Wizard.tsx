"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { CHANNEL_INFO, HUB_TRIGGER_INFO, isHubChannel, isHubTrigger, type HubChannel, type HubTrigger, type MessageCategory } from "@app/shared/automations";
import { AUTOMATION_STARTERS, TRIGGER_INFO, type SmsTrigger } from "@app/shared/sms";
import { PageHeader, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/api";
import { ChannelCards } from "./Channels";
import { CHANNEL_NAME, fmtWhen, HubTriggerIconView, hubError, useHub } from "./HubUi";
import { EmailEditor, emailIssues, SmsEditor, smsIssues, type EmailDraft, type SmsDraft } from "./MessageEditors";
import { Review } from "./Review";
import type { HubAutomation, HubTriggerState, OverviewResponse } from "./types";

// ---------------------------------------------------------------------------
// Create (or edit) an automation in four steps: 1 connect a channel, 2 choose a trigger the
// channel really receives for this store, 3 write and check the message, 4 review, test and turn
// on. Saving at step 3 writes the channel's own rule and message (nothing is sent by saving);
// turning on at step 4 asks first. ?channel=&id= edits one; ?trigger= starts from a trigger.
// ---------------------------------------------------------------------------

const STEPS = ["Connect", "Trigger", "Message", "Review and turn on"] as const;

const emptySms = (): SmsDraft => ({ name: "", body: "", delayMinutes: 0, discountCode: "", dryRun: false, inactiveDays: null, vipMinOrders: null, vipMinSpent: null, rest: {} });
const emptyEmail = (): EmailDraft => ({ name: "", senderIdentityId: "", subject: "", text: "", delayMinutes: 0, customEvent: "", category: "transactional", onceEveryHours: 0 });

/** A saved automation's settings, back in the editor's shape. */
function draftsOf(a: HubAutomation): { sms?: SmsDraft; email?: EmailDraft } {
  const c = a.config ?? {};
  if (a.channel === "sms") {
    const { name, body, delayMinutes, discountCode, dryRun, inactiveDays, vipMinOrders, vipMinSpent, trigger: _t, ...rest } = c as Record<string, unknown>;
    return {
      sms: {
        name: String(name ?? a.name),
        body: String(body ?? a.body ?? ""),
        delayMinutes: Number(delayMinutes ?? 0),
        discountCode: typeof discountCode === "string" ? discountCode : "",
        dryRun: dryRun === true,
        inactiveDays: typeof inactiveDays === "number" ? inactiveDays : null,
        vipMinOrders: typeof vipMinOrders === "number" ? vipMinOrders : null,
        vipMinSpent: typeof vipMinSpent === "number" ? vipMinSpent : null,
        rest,
      },
    };
  }
  const f = c.frequency as { type?: string; windowHours?: number } | undefined;
  return {
    email: {
      name: String(c.name ?? a.name),
      senderIdentityId: String(c.senderIdentityId ?? ""),
      subject: String(c.subject ?? a.subject ?? ""),
      text: String(c.text ?? a.body ?? ""),
      delayMinutes: Number(c.delayMinutes ?? 0),
      customEvent: typeof c.customEvent === "string" ? c.customEvent : "",
      category: (c.category as MessageCategory) ?? "transactional",
      onceEveryHours: f?.type === "once_per_recipient" ? (f.windowHours ?? 0) : 0,
    },
  };
}

export function AutomationWizard() {
  const params = useSearchParams();
  const { path, store } = useHub();
  const editChannel = params.get("channel");
  const editId = params.get("id");
  const editing = !!editId && !!editChannel && isHubChannel(editChannel);
  const overview = useApi<OverviewResponse>(path(""));
  const triggers = useApi<{ triggers: HubTriggerState[] }>(path("/triggers"));
  const existing = useApi<{ automation: HubAutomation }>(editing ? path(`/items/${editChannel}/${editId}`) : null);

  const [step, setStep] = useState(1);
  const [channel, setChannel] = useState<HubChannel | null>(editing ? (editChannel as HubChannel) : null);
  const startTrigger = params.get("trigger");
  const [trigger, setTrigger] = useState<HubTrigger | null>(startTrigger && isHubTrigger(startTrigger) ? startTrigger : null);
  const [sms, setSms] = useState<SmsDraft>(emptySms);
  const [email, setEmail] = useState<EmailDraft>(emptyEmail);
  const [saved, setSaved] = useState<HubAutomation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [moreTriggers, setMoreTriggers] = useState(false);

  // Editing: the saved automation fills the steps once, and the setup opens at its message.
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    const a = existing.data?.automation;
    if (!a || filled) return;
    setFilled(true);
    setChannel(a.channel);
    setTrigger(a.trigger);
    const d = draftsOf(a);
    if (d.sms) setSms(d.sms);
    if (d.email) setEmail(d.email);
    setSaved(a);
    setStep(3);
  }, [existing.data, filled]);

  if ((overview.error && !overview.data) || (triggers.error && !triggers.data) || (existing.error && !existing.data)) {
    return <LoadError what={existing.error ? "this automation" : "the setup"} error={overview.error ?? triggers.error ?? existing.error} onRetry={() => void Promise.all([overview.reload(), triggers.reload(), existing.reload()])} busy={overview.loading} />;
  }
  if (!overview.data || !triggers.data || (editing && !filled)) return <Skeleton lines={8} />;
  const { connections, permissions } = overview.data;
  const connection = channel ? connections.find((c) => c.channel === channel) : undefined;
  if (!permissions.manage.sms && !permissions.manage.email) {
    return <Alert kind="info">Only owners and admins can create and change automations. You can see them under Automations.</Alert>;
  }

  const smsTrigger = trigger ? (HUB_TRIGGER_INFO[trigger].sms as SmsTrigger | null) : null;
  const triggerState = trigger && channel ? triggers.data.triggers.find((t) => t.key === trigger)?.channels[channel] : undefined;
  const business = store?.name ?? "Your store";
  const smsSenderAccount = connections.find((c) => c.channel === "sms")?.accounts[0];

  // What each step needs before the next one.
  const channelOk = !!channel && !!connection && connection.allowed && permissions.manage[channel] && connection.state !== "unavailable" && connection.state !== "elsewhere" && (channel !== "email" || connection.accounts.some((a) => a.canSend));
  const triggerOk = !!trigger && !!triggerState && triggerState.state !== "unavailable" && (trigger !== "external_event" || /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/.test(email.customEvent));
  const messageErrors = channel === "sms" && smsTrigger ? smsIssues(sms, smsTrigger).filter((i) => i.level === "error") : channel === "email" && trigger ? emailIssues(email, trigger).filter((i) => i.level === "error") : [];
  const messageOk = !!(channel === "sms" ? sms.name.trim() && sms.body.trim() : email.name.trim() && email.senderIdentityId) && messageErrors.length === 0;
  const reachable = (n: number) => n === 1 || (n === 2 && channelOk) || (n === 3 && channelOk && triggerOk) || (n === 4 && !!saved);

  const pickTrigger = (t: HubTrigger) => {
    setTrigger(t);
    const s = HUB_TRIGGER_INFO[t].sms;
    if (channel === "sms" && s && !sms.body) {
      const first = AUTOMATION_STARTERS[s][0];
      setSms((d) => ({ ...d, name: d.name || HUB_TRIGGER_INFO[t].label, body: first?.body ?? "" }));
    }
    if (channel === "email") {
      setEmail((d) => ({ ...d, name: d.name || HUB_TRIGGER_INFO[t].label, category: t === "checkout_abandoned" ? "marketing" : t === "external_event" ? d.category : "transactional" }));
    }
  };

  const verifyTriggers = async () => {
    setBusy("verify");
    setProblem(null);
    try {
      const r = await api<{ triggers: HubTriggerState[] }>(path("/triggers/verify"), { method: "POST", body: {} });
      triggers.setData({ triggers: r.triggers });
    } catch (e) {
      setProblem(hubError(e, "check with Shopify"));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!channel || !trigger) return;
    setBusy("save");
    setProblem(null);
    try {
      const body =
        channel === "sms"
          ? {
              ...sms.rest,
              name: sms.name.trim(),
              trigger: smsTrigger,
              body: sms.body,
              delayMinutes: sms.delayMinutes,
              discountCode: sms.discountCode.trim() || null,
              dryRun: sms.dryRun,
              inactiveDays: sms.inactiveDays,
              vipMinOrders: sms.vipMinOrders,
              vipMinSpent: sms.vipMinSpent,
            }
          : {
              name: email.name.trim(),
              trigger,
              customEvent: trigger === "external_event" ? email.customEvent : null,
              category: email.category,
              storeId: store?.id ?? null,
              senderIdentityId: email.senderIdentityId,
              subject: email.subject,
              text: email.text,
              delayMinutes: email.delayMinutes,
              frequency: email.onceEveryHours ? { type: "once_per_recipient", windowHours: email.onceEveryHours } : { type: "once_per_event" },
            };
      const id = saved?.channel === channel ? saved.id : null;
      const r = await api<{ automation: HubAutomation }>(path(id ? `/items/${channel}/${id}` : `/items/${channel}`), { method: id ? "PUT" : "POST", body });
      setSaved(r.automation);
      setStep(4);
    } catch (e) {
      setProblem(e instanceof ApiError && e.code === "validation" ? "Some settings aren't valid: check the highlighted fields." : hubError(e, "save the automation"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={editing ? `Edit "${saved?.name ?? ""}"` : "Create an automation"}
        sub="Four steps. Nothing is sent until you turn it on at the end, and you can test it on yourself first."
        actions={
          <Link href="/automations" className="btn-secondary">
            Back to automations
          </Link>
        }
      />

      <ol className="card flex flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const done = n < step;
          return (
            <li key={label}>
              <button
                type="button"
                className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm ${n === step ? "bg-accent text-white" : done ? "bg-accent/10 text-accent" : "text-muted"}`}
                aria-current={n === step ? "step" : undefined}
                disabled={!reachable(n) || n === step || (editing && n < 3)}
                onClick={() => setStep(n)}
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-full border border-current text-xs">{done ? <Check aria-hidden className="h-3 w-3" /> : n}</span>
                {label}
              </button>
            </li>
          );
        })}
      </ol>

      {problem && <Alert onDismiss={() => setProblem(null)}>{problem}</Alert>}

      {step === 1 && (
        <section className="space-y-3" aria-labelledby="s1">
          <h2 id="s1" className="font-semibold">
            1. Choose the channel and connect it
          </h2>
          <ChannelCards
            connections={connections}
            permissions={permissions}
            onChanged={() => overview.reload()}
            selected={channel}
            onSelect={(c) => {
              setChannel(c);
              setTrigger(null);
            }}
          />
          {channel === "email" && connection && !connection.accounts.some((a) => a.canSend) && <Alert kind="info">Connect a mailbox that can send (and verify its address) to write an email automation.</Alert>}
          {channel === "sms" && connection?.state === "not_connected" && <Alert kind="info">SMS isn&apos;t connected yet. You can write the automation now; nothing is texted until SMS is connected and your sender is approved.</Alert>}
          <div className="flex justify-end">
            <button type="button" className="btn-primary inline-flex items-center gap-1.5" disabled={!channelOk} onClick={() => setStep(2)}>
              Continue <ChevronRight aria-hidden className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      {step === 2 && channel && (
        <section className="space-y-3" aria-labelledby="s2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="s2" className="font-semibold">
              2. Choose what starts it ({CHANNEL_NAME[channel]})
            </h2>
            {channel === "sms" && triggers.data.triggers.some((t) => t.channels.sms.state === "needs_setup" && !t.channels.sms.fix) && (
              <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={!!busy} onClick={() => void verifyTriggers()}>
                {busy === "verify" ? "Asking Shopify…" : "Check with Shopify"}
              </button>
            )}
          </div>
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Triggers">
            {triggers.data.triggers
              .filter((t) => t.main || moreTriggers || t.key === trigger)
              .map((t) => {
                const s = t.channels[channel];
                const usable = s.state !== "unavailable";
                const picked = trigger === t.key;
                return (
                  <li key={t.key}>
                    <button
                      type="button"
                      className={`card h-full w-full text-left transition ${picked ? "border-accent ring-2 ring-accent/30" : usable ? "hover:border-accent/60" : "opacity-70"}`}
                      aria-pressed={picked}
                      disabled={!usable}
                      onClick={() => pickTrigger(t.key)}
                    >
                      <span className="flex items-start gap-3">
                        <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                          <HubTriggerIconView icon={t.icon} />
                        </span>
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2 font-medium">
                            {t.label}
                            {s.state === "ready" ? <Badge tone="good">Available</Badge> : s.state === "needs_setup" ? <Badge tone="warn">One step needed</Badge> : <Badge tone="neutral">Not available</Badge>}
                            {s.category === "marketing" && <Badge tone="neutral">Marketing</Badge>}
                          </span>
                          <span className="mt-1 block text-sm text-muted">{t.description}</span>
                          {s.reason && <span className="mt-1 block text-xs text-muted">{s.reason}</span>}
                          {s.lastEventAt && <span className="mt-1 block text-xs text-muted">Last event received {fmtWhen(s.lastEventAt)}</span>}
                        </span>
                      </span>
                    </button>
                    {(s.fix || (!usable && t.instead)) && (
                      <p className="mt-1 px-1 text-xs">
                        <Link className="font-medium text-accent underline" href={(s.fix ?? t.instead)!.href}>
                          {(s.fix ?? t.instead)!.label}
                        </Link>
                      </p>
                    )}
                  </li>
                );
              })}
          </ul>
          {!moreTriggers && (
            <button type="button" className="text-sm font-medium text-accent underline-offset-2 hover:underline" onClick={() => setMoreTriggers(true)}>
              More triggers
            </button>
          )}
          {trigger === "external_event" && channel === "email" && (
            <div className="card max-w-lg space-y-2">
              <label className="label" htmlFor="custom-event">
                Your event&apos;s name
              </label>
              <input id="custom-event" className="input" placeholder="appointment.booked" value={email.customEvent} onChange={(e) => setEmail({ ...email, customEvent: e.target.value.trim().toLowerCase() })} />
              <p className="text-xs text-muted">Two to four lowercase words joined by dots. Your system sends it with an event API key; the same id sent twice counts once.</p>
            </div>
          )}
          <div className="flex justify-between">
            <button type="button" className="btn-secondary inline-flex items-center gap-1.5" onClick={() => setStep(1)}>
              <ChevronLeft aria-hidden className="h-4 w-4" /> Back
            </button>
            <button type="button" className="btn-primary inline-flex items-center gap-1.5" disabled={!triggerOk} onClick={() => setStep(3)}>
              Continue <ChevronRight aria-hidden className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      {step === 3 && channel && trigger && (
        <section className="space-y-3" aria-labelledby="s3">
          <h2 id="s3" className="font-semibold">
            3. Write the message ({CHANNEL_INFO[channel].label}, when: {HUB_TRIGGER_INFO[trigger].label})
          </h2>
          <div className="card">
            {channel === "sms" && smsTrigger ? (
              <SmsEditor
                trigger={smsTrigger}
                draft={sms}
                onChange={setSms}
                business={business}
                sender={smsSenderAccount ? { kind: "name", label: smsSenderAccount.label, approved: smsSenderAccount.status === "verified" } : { kind: "name", label: business, approved: false }}
              />
            ) : channel === "email" ? (
              <EmailEditor trigger={trigger} draft={email} onChange={setEmail} />
            ) : null}
          </div>
          {channel === "sms" && smsTrigger && TRIGGER_INFO[smsTrigger].category === "marketing" && <p className="text-xs text-muted">Marketing texts also need marketing switched on for your store and for bizinsights.</p>}
          <div className="flex justify-between">
            <button type="button" className="btn-secondary inline-flex items-center gap-1.5" disabled={editing} onClick={() => setStep(2)}>
              <ChevronLeft aria-hidden className="h-4 w-4" /> Back
            </button>
            <button type="button" className="btn-primary inline-flex items-center gap-1.5" disabled={!messageOk || !!busy} onClick={() => void save()}>
              {busy === "save" ? "Saving…" : "Save and continue"} <ChevronRight aria-hidden className="h-4 w-4" />
            </button>
          </div>
          {saved?.status === "active" && saved.channel === "email" && <p className="text-xs text-warn">This automation is on: saving changes what it sends straight away.</p>}
        </section>
      )}

      {step === 4 && saved && (
        <section className="space-y-3" aria-labelledby="s4">
          <h2 id="s4" className="font-semibold">
            4. Review, test and turn on
          </h2>
          <Review automation={saved} connection={connections.find((c) => c.channel === saved.channel)} onChanged={(a) => setSaved(a)} />
          <div className="flex justify-between">
            <button type="button" className="btn-secondary inline-flex items-center gap-1.5" onClick={() => setStep(3)}>
              <ChevronLeft aria-hidden className="h-4 w-4" /> Change the message
            </button>
            <Link href="/automations" className="btn-secondary">
              Done
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
