"use client";
import Link from "next/link";
import { useState } from "react";
import { CircleAlert, CircleCheck, Send } from "lucide-react";
import { CHANNEL_COST_NOTE, CHANNEL_INFO, HUB_STATUS_INFO } from "@app/shared/automations";
import { TRIGGER_INFO, type SmsTrigger } from "@app/shared/sms";
import { useToast } from "@/components/AppUi";
import { consentWords } from "@/components/messaging/AutomationUi";
import { Alert } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { AutomationStatusBadge, ConnectionBadge, delayWords, HubStatusBadge, hubError, useHub } from "./HubUi";
import type { ChannelConnection, HubAutomation, HubMessage, MessageDetail } from "./types";

// ---------------------------------------------------------------------------
// Step 4: what was saved, as the API has it, with everything that still stops it reaching anyone;
// a test to the team's own number or address, followed to its real outcome; and the switch, which
// asks first. Turning it on approves the message in the member's name (the API records who).
// ---------------------------------------------------------------------------

interface TestNumber {
  id: string;
  number: string;
  status: string;
}

const FINAL = new Set(["delivered", "undelivered", "failed", "not_sent", "test_only", "unknown"]);

export function Review({ automation, connection, onChanged }: { automation: HubAutomation; connection: ChannelConnection | undefined; onChanged: (a: HubAutomation) => void }) {
  const { path, ws, store, meEmail } = useHub();
  const toast = useToast();
  const sms = automation.channel === "sms";
  const testNumbers = useApi<{ testNumbers: TestNumber[] }>(sms && store ? `/workspaces/${ws}/stores/${store.id}/sms/test-numbers` : null);
  const verified = (testNumbers.data?.testNumbers ?? []).filter((t) => t.status === "verified");
  const [testNumberId, setTestNumberId] = useState("");
  const [test, setTest] = useState<HubMessage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [understood, setUnderstood] = useState(false);
  const smsTrigger = sms ? (automation.channelTrigger as SmsTrigger | null) : null;
  const blocking = (connection?.problems ?? []).filter((p) => !["test_mode", "marketing_platform_off", "marketing_off"].includes(p.code) || (automation.category === "marketing" && p.code !== "test_mode"));
  const testMode = sms && connection?.mode !== "live";

  const run = async (key: string, what: string, fn: () => Promise<void>) => {
    setBusy(key);
    setProblem(null);
    try {
      await fn();
    } catch (e) {
      setProblem(hubError(e, what));
    } finally {
      setBusy(null);
    }
  };

  const sendTest = () =>
    run("test", "send the test", async () => {
      const r = await api<{ message: HubMessage }>(path(`/items/${automation.channel}/${automation.id}/test`), { method: "POST", body: sms ? { testNumberId: testNumberId || verified[0]?.id, requestId: crypto.randomUUID() } : {} });
      setTest(r.message);
      toast("success", sms ? "Test text handed to AWS." : `Test email sent to ${meEmail}.`);
    });

  const checkTest = () =>
    run("check", "check the test", async () => {
      const r = await api<MessageDetail>(path(`/messages/${test!.channel}/${test!.id}`));
      setTest(r.message);
    });

  const turnOn = () =>
    run("on", "turn the automation on", async () => {
      const r = await api<{ automation: HubAutomation }>(path(`/items/${automation.channel}/${automation.id}/activate`), { method: "POST", body: { confirm: true } });
      onChanged(r.automation);
      toast("success", testMode ? "It's on. In test mode its texts are recorded, not sent." : "It's on.");
    });

  const on = automation.status === "active";
  const canTurnOn = automation.actions.includes("activate") || automation.actions.includes("resume") || (on && automation.pendingChanges);

  return (
    <div className="space-y-4">
      {problem && <Alert onDismiss={() => setProblem(null)}>{problem}</Alert>}
      <dl className="card grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted">Channel</dt>
        <dd className="flex flex-wrap items-center gap-2">
          {CHANNEL_INFO[automation.channel].label} {connection && <ConnectionBadge state={connection.state} />}
        </dd>
        <dt className="text-muted">Trigger</dt>
        <dd>{automation.triggerLabel}</dd>
        <dt className="text-muted">Message</dt>
        <dd className="whitespace-pre-line">
          {automation.subject && <span className="block font-medium">{automation.subject}</span>}
          {automation.body}
        </dd>
        <dt className="text-muted">When</dt>
        <dd>{delayWords(automation.delayMinutes)} after the trigger</dd>
        <dt className="text-muted">Who gets it</dt>
        <dd>
          {smsTrigger && TRIGGER_INFO[smsTrigger]
            ? consentWords(smsTrigger)
            : automation.category === "marketing"
              ? "Only customers who agreed to email marketing; unsubscribed addresses are skipped."
              : "The customer the event is about; suppressed addresses are skipped."}
        </dd>
        <dt className="text-muted">Cost</dt>
        <dd>{CHANNEL_COST_NOTE[automation.channel]}</dd>
        <dt className="text-muted">Status</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <AutomationStatusBadge status={automation.status} />
          {automation.pendingChanges && <span className="text-xs text-warn">Saved changes aren&apos;t live until you put them live.</span>}
          {automation.testMode && <span className="text-xs text-muted">Test mode: it records what it would send, and sends nothing.</span>}
        </dd>
      </dl>

      {(blocking.length > 0 || testMode) && (
        <Alert kind="info">
          <p className="font-medium">Before it can reach customers:</p>
          <ul className="mt-1 space-y-1">
            {testMode && <li>bizinsights&apos; SMS is in test mode: automatic texts are recorded in the history, not sent. Test texts still reach your verified numbers.</li>}
            {blocking.map((p) => (
              <li key={p.code}>
                {p.message}{" "}
                {p.fix && (
                  <Link className="font-medium underline" href={p.fix.href}>
                    {p.fix.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <section className="card space-y-3" aria-labelledby="test-h">
        <h3 id="test-h" className="font-semibold">
          Send yourself a test
        </h3>
        {sms ? (
          verified.length ? (
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="label" htmlFor="test-number">
                  Your verified number
                </label>
                <select id="test-number" className="input" value={testNumberId || verified[0]!.id} onChange={(e) => setTestNumberId(e.target.value)}>
                  {verified.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.number}
                    </option>
                  ))}
                </select>
              </div>
              <button type="button" className="btn-secondary inline-flex items-center gap-1.5" disabled={!!busy} onClick={() => void sendTest()}>
                <Send aria-hidden className="h-4 w-4" /> {busy === "test" ? "Sending…" : "Send test text"}
              </button>
            </div>
          ) : (
            <p className="text-sm text-muted">
              Tests go only to a number you&apos;ve verified with AWS.{" "}
              <Link className="font-medium text-accent underline" href="/messaging/setup?step=test">
                Add your number
              </Link>
            </p>
          )
        ) : (
          <button type="button" className="btn-secondary inline-flex items-center gap-1.5" disabled={!!busy} onClick={() => void sendTest()}>
            <Send aria-hidden className="h-4 w-4" /> {busy === "test" ? "Sending…" : `Send a test to ${meEmail}`}
          </button>
        )}
        {test && (
          <div className="rounded-xl border border-border px-3 py-2 text-sm" role="status">
            <p className="flex flex-wrap items-center gap-2">
              Test: <HubStatusBadge status={test.status} />
              {!FINAL.has(test.status) && (
                <button type="button" className="text-xs font-medium text-accent underline-offset-2 hover:underline" disabled={!!busy} onClick={() => void checkTest()}>
                  {busy === "check" ? "Checking…" : "Check again"}
                </button>
              )}
            </p>
            <p className="mt-1 text-xs text-muted">{test.reason ?? HUB_STATUS_INFO[test.status].help}</p>
          </div>
        )}
      </section>

      <section className="card space-y-3" aria-labelledby="activate-h">
        <h3 id="activate-h" className="font-semibold">
          {on && !automation.pendingChanges ? "It's on" : "Turn it on"}
        </h3>
        {on && !automation.pendingChanges ? (
          <p className="flex items-center gap-2 text-sm text-good">
            <CircleCheck aria-hidden className="h-4 w-4" /> Running. Follow its messages in the{" "}
            <Link className="font-medium underline" href={`/automations/history?automation=${automation.channel}:${encodeURIComponent(automation.id)}`}>
              message history
            </Link>
            .
          </p>
        ) : canTurnOn ? (
          <>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--accent)]" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
              <span>
                I understand that from now on, each time its trigger happens, this automation {sms ? "texts" : "emails"} the customer (if they may receive it), from {store?.name ?? "my business"}.
              </span>
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary" disabled={!understood || !!busy} onClick={() => void turnOn()}>
                {busy === "on" ? "Turning on…" : on ? "Put changes live" : "Turn on"}
              </button>
              <Link href="/automations" className="btn-secondary">
                Keep it off for now
              </Link>
            </div>
          </>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted">
            <CircleAlert aria-hidden className="h-4 w-4" /> Only owners and admins can turn automations on.
          </p>
        )}
      </section>
    </div>
  );
}
