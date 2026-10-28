"use client";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle2, Circle, ShieldCheck } from "lucide-react";
import { PROVIDER_INFO, WA_SETUP_STEPS, WA_SETUP_STEP_INFO, type WaSetupStep } from "@app/shared/whatsapp";
import { Badge } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { CloudSignup } from "./CloudSignup";
import { SettingsForm } from "./SettingsForm";
import type { WaMessage, WaMessageEvent, WaOverview, WaTemplatesResponse } from "./types";
import { CONNECTION_TONE, MessageStatus, waHref, useWaAction } from "./WaUi";

// ---------------------------------------------------------------------------
// The four-step setup: 1 Connect (Meta's Embedded Signup, the one way to connect), 2 Authorize (what
// bizinsights then checked with Meta), 3 Configure, 4 Test and activate. Every state shown comes from
// the API, which asks Meta: nothing here says "connected" before Meta did.
// ---------------------------------------------------------------------------

export function Setup({ base, overview, reload }: { base: string; overview: WaOverview; reload: () => void }) {
  const firstOpen = overview.setup.current ?? "test";
  const [step, setStep] = useState<WaSetupStep>(firstOpen);
  const done = overview.setup.done;
  const all = WA_SETUP_STEPS.every((s) => done[s]);
  const go = (s: WaSetupStep) => setStep(s);

  return (
    <div className="space-y-4">
      <ol className="card grid gap-2 sm:grid-cols-4" aria-label="Setup steps">
        {WA_SETUP_STEPS.map((s, i) => {
          const active = s === step;
          return (
            <li key={s}>
              <button
                type="button"
                onClick={() => go(s)}
                aria-current={active ? "step" : undefined}
                className={`flex w-full items-start gap-2 rounded-lg border p-3 text-left text-sm transition ${active ? "border-accent bg-accent/5" : "border-border hover:bg-bg"}`}
              >
                {done[s] ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-good" aria-hidden /> : <Circle size={18} className="mt-0.5 shrink-0 text-muted" aria-hidden />}
                <span>
                  <span className="font-semibold">
                    {i + 1}. {WA_SETUP_STEP_INFO[s].label}
                  </span>
                  <span className="block text-xs text-muted">{WA_SETUP_STEP_INFO[s].help}</span>
                  <span className="sr-only">{done[s] ? "(done)" : "(not done)"}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {step === "connect" && (
        <ConnectStep
          base={base}
          overview={overview}
          onConnected={() => {
            reload();
            go("authorize");
          }}
        />
      )}
      {step === "authorize" && (
        <AuthorizeStep
          overview={overview}
          back={() => go("connect")}
          onConnected={() => {
            reload();
            go("configure");
          }}
        />
      )}
      {step === "configure" && (
        <div className="card space-y-4">
          <h2 className="text-base font-semibold">3. Configure</h2>
          <SettingsForm
            base={base}
            overview={overview}
            submitLabel="Save and continue"
            onSaved={() => {
              reload();
              go("test");
            }}
          />
        </div>
      )}
      {step === "test" && (all ? <Complete overview={overview} /> : <TestStep base={base} overview={overview} reload={reload} />)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Meta's Embedded Signup, the one way to connect
// ---------------------------------------------------------------------------

function ConnectStep({ base, overview, onConnected }: { base: string; overview: WaOverview; onConnected: () => void }) {
  const conn = overview.connection;
  const live = conn && conn.status !== "disconnected" ? conn : null;
  const info = PROVIDER_INFO.cloud_api;
  const missing = overview.platform.cloudApi.missing;
  return (
    <div className="card space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <ShieldCheck size={18} aria-hidden /> 1. Connect WhatsApp Business
        </h2>
        <p className="mt-1 text-sm text-muted">
          {info.short} You sign in with Facebook in Meta&apos;s own window and pick your business, its WhatsApp Business account and the number; bizinsights never sees your Facebook password.
        </p>
      </div>
      {conn?.reasonCode === "qr_linking_retired" && (
        <Alert kind="info">
          <span className="font-medium">QR-code linking was retired.</span> {conn.reason}
        </Alert>
      )}
      {live?.status === "connected" ? (
        <>
          <p className="text-sm">
            Connected{live.phone ? ` as ${live.phone}` : ""}
            {live.profileName ? ` (${live.profileName})` : ""} through {info.label}. <Badge tone={CONNECTION_TONE[live.status] ?? "neutral"}>{live.statusLabel}</Badge>
          </p>
          <p className="text-sm text-muted">To use another number, disconnect first (Settings tab).</p>
          <button type="button" className="btn-primary" onClick={onConnected}>
            Continue
          </button>
        </>
      ) : (
        <>
          {live?.reason && <Alert kind="info">{live.reason}</Alert>}
          <div className="grid gap-3 lg:grid-cols-2">
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
              {info.good.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
            <div className="rounded-lg border border-border bg-bg p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Know before you connect</p>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-muted">
                {info.limits.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </div>
          </div>
          {!overview.can.connect ? (
            <p className="text-sm text-muted">Only people who may manage integrations can connect WhatsApp.</p>
          ) : !overview.cloudSignup ? (
            <Alert kind="info">
              Connecting WhatsApp isn&apos;t available on bizinsights yet: its Meta app isn&apos;t set up{missing.length ? ` (missing ${missing.join(", ")})` : ""}. Nothing is connected and nothing is sent. bizinsights&apos; administrator sets these up; nothing
              needs changing in your accounts.
            </Alert>
          ) : (
            <CloudSignup base={base} signup={overview.cloudSignup} onConnected={onConnected} />
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: what Meta confirmed
// ---------------------------------------------------------------------------

function AuthorizeStep({ overview, back, onConnected }: { overview: WaOverview; back: () => void; onConnected: () => void }) {
  const conn = overview.connection;
  if (conn && conn.status === "connected") {
    return (
      <div className="card space-y-3">
        <h2 className="text-base font-semibold">2. Authorize</h2>
        <Alert kind="success">
          Meta confirmed that bizinsights may send for {conn.phone ?? "your number"}
          {conn.profileName ? ` (${conn.profileName})` : ""}: both WhatsApp permissions for your account, the number in it, its webhooks and its registration.
        </Alert>
        <button type="button" className="btn-primary" onClick={onConnected}>
          Continue to settings
        </button>
      </div>
    );
  }
  return (
    <div className="card space-y-3">
      <h2 className="text-base font-semibold">2. Authorize</h2>
      <p className="text-sm text-muted">This step is done once Meta confirms what you allowed in its window. Connect WhatsApp Business in step 1 first.</p>
      <button type="button" className="btn-secondary" onClick={back}>
        Back to step 1
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4
// ---------------------------------------------------------------------------

function TestStep({ base, overview, reload }: { base: string; overview: WaOverview; reload: () => void }) {
  const id = useId();
  const s = overview.settings;
  const connected = overview.connection?.status === "connected";
  const { busy, run } = useWaAction();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sentCode, setSentCode] = useState<string | null>(s.testCodeExpiresAt);
  const templates = useApi<WaTemplatesResponse>(connected && s.testVerifiedAt ? `${base}/templates` : null);
  const [templateId, setTemplateId] = useState("");
  const [messageId, setMessageId] = useState<string | null>(null);

  if (!connected) {
    return (
      <div className="card space-y-2">
        <h2 className="text-base font-semibold">4. Test and activate</h2>
        <p className="text-sm text-muted">Connect WhatsApp first (step 2): the test goes out from your connected number.</p>
      </div>
    );
  }
  const manage = overview.can.manage;
  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <h2 className="text-base font-semibold">4a. Verify your own number</h2>
        <p className="text-sm text-muted">
          Tests only ever go to a number you prove is yours: bizinsights sends it a 6-digit code from your WhatsApp Business number{overview.connection?.phone ? ` (${overview.connection.phone})` : ""}. Meta delivers it only to a phone that
          wrote to your business number in the last 24 hours, so first send that number any WhatsApp message from your phone.
        </p>
        {s.testVerifiedAt ? (
          <Alert kind="success">Verified: {s.testPhone}. Tests go to this number.</Alert>
        ) : !manage ? (
          <p className="text-sm text-muted">Only the store&apos;s owners and admins can verify a test number.</p>
        ) : (
          <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor={`${id}-tp`}>
                Your WhatsApp number
              </label>
              <input id={`${id}-tp`} className="input" inputMode="tel" placeholder="+61 412 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <button
                type="button"
                className="btn-secondary mt-2"
                disabled={busy === "code" || phone.trim().length < 8}
                onClick={() =>
                  void run("code", "send the code", async () => {
                    const r = await api<{ expiresAt: string | null; phone: string }>(`${base}/test-number`, { method: "POST", body: { phone } });
                    setSentCode(r.expiresAt);
                    return `Code sent to ${r.phone} on WhatsApp.`;
                  })
                }
              >
                {busy === "code" ? "Sending…" : sentCode ? "Send a new code" : "Send code"}
              </button>
            </div>
            {sentCode && (
              <div>
                <label className="label" htmlFor={`${id}-code`}>
                  The code from WhatsApp
                </label>
                <input id={`${id}-code`} className="input font-mono tracking-widest" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
                <button
                  type="button"
                  className="btn-primary mt-2"
                  disabled={busy === "verify" || code.length !== 6}
                  onClick={() =>
                    void run("verify", "check the code", async () => {
                      await api(`${base}/test-number/verify`, { method: "POST", body: { code } });
                      reload();
                      return "Number verified.";
                    })
                  }
                >
                  {busy === "verify" ? "Checking…" : "Verify"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card space-y-3">
        <h2 className="text-base font-semibold">4b. Send a test message</h2>
        {!s.testVerifiedAt ? (
          <p className="text-sm text-muted">Verify your number first.</p>
        ) : (
          <>
            <div className="max-w-md">
              <label className="label" htmlFor={`${id}-tpl`}>
                Message
              </label>
              <select id={`${id}-tpl`} className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={!manage}>
                <option value="">A short test text</option>
                {(templates.data?.templates ?? [])
                  .filter((t) => t.usable)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      Template: {t.name} (sample values)
                    </option>
                  ))}
              </select>
            </div>
            {manage && (
              <button
                type="button"
                className="btn-primary"
                disabled={busy === "test"}
                onClick={() =>
                  void run("test", "send the test message", async () => {
                    const r = await api<{ messageId: string }>(`${base}/test-message`, { method: "POST", body: { templateId: templateId || null } });
                    setMessageId(r.messageId);
                  })
                }
              >
                {busy === "test" ? "Sending…" : "Send test to my number"}
              </button>
            )}
            {messageId && <LiveStatus base={base} messageId={messageId} onReached={reload} />}
            {s.testPassedAt && <Alert kind="success">WhatsApp reported a test message as sent. Setup is complete.</Alert>}
          </>
        )}
      </div>
    </div>
  );
}

/** One message's real status, asked every 3 seconds for two minutes (or until it is final). */
export function LiveStatus({ base, messageId, onReached }: { base: string; messageId: string; onReached?: () => void }) {
  const [m, setM] = useState<{ message: WaMessage; events: WaMessageEvent[] } | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const reached = useRef(false);
  useEffect(() => {
    let stop = false;
    const started = Date.now();
    const tick = async () => {
      try {
        const r = await api<{ message: WaMessage; events: WaMessageEvent[] }>(`${base}/messages/${messageId}`);
        if (stop) return;
        setM(r);
        const st = r.message.status;
        if (!reached.current && (st === "sent" || st === "delivered" || st === "read")) {
          reached.current = true;
          onReached?.();
        }
        if (st === "read" || st === "failed" || st === "skipped" || st === "cancelled") return;
      } catch {
        /* the next tick tries again */
      }
      if (Date.now() - started > 120_000) setGaveUp(true);
      else window.setTimeout(() => void tick(), 3000);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [base, messageId, onReached]);
  // One live region from "Queued" on, so the first real status (even a final one) is announced.
  return (
    <div className="space-y-1 rounded-lg border border-border bg-bg p-3 text-sm" aria-live="polite">
      {!m ? <p className="text-muted">Queued…</p> : <LiveStatusDetails m={m} gaveUp={gaveUp} />}
    </div>
  );
}

function LiveStatusDetails({ m, gaveUp }: { m: { message: WaMessage; events: WaMessageEvent[] }; gaveUp: boolean }) {
  return (
    <>
      <p className="flex items-center gap-2">
        Status: <MessageStatus m={m.message} />
      </p>
      <ul className="text-xs text-muted">
        {m.events.map((e) => (
          <li key={`${e.status}-${e.at}`}>
            {e.status} {e.providerStatus ? `(${e.providerStatus})` : ""} · {new Date(e.at).toLocaleTimeString()}
          </li>
        ))}
      </ul>
      {m.message.status === "accepted" && <p className="text-xs text-muted">Meta has the message; it reports sent, delivered and read as they happen.</p>}
      {m.message.errorDetail && <p className="text-xs text-danger">{m.message.errorDetail}</p>}
      {m.message.reasonLabel && m.message.status !== "accepted" && <p className="text-xs text-muted">{m.message.reasonLabel}</p>}
      {gaveUp && <p className="text-xs text-muted">No more reports in two minutes. The message history shows anything that comes later.</p>}
    </>
  );
}

function Complete({ overview }: { overview: WaOverview }) {
  return (
    <div className="card space-y-3">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <CheckCircle2 size={20} className="text-good" aria-hidden /> WhatsApp Automation is set up
      </h2>
      <p className="text-sm text-muted">
        Connected{overview.connection?.phone ? ` as ${overview.connection.phone}` : ""}, configured, and WhatsApp reported your test message sent. New automations start in test mode: they send only to your number until you switch test mode off.
      </p>
      <div className="flex flex-wrap gap-2">
        <Link href={waHref("automations", { new: "1" })} className="btn-primary">
          Create an automation
        </Link>
        <Link href={waHref("messages", { compose: "1" })} className="btn-secondary">
          Send a message
        </Link>
        <Link href={waHref("templates")} className="btn-secondary">
          Write templates
        </Link>
      </div>
    </div>
  );
}
