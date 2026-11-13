"use client";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, QrCode, ShieldCheck, Smartphone } from "lucide-react";
import { PROVIDER_INFO, WA_SETUP_STEPS, WA_SETUP_STEP_INFO, type WaProvider, type WaSetupStep } from "@app/shared/whatsapp";
import { Fact, FactList, SoftBox, StepCard, StepNumber } from "./MarketingKit";
import { Badge } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { AppTokenConnect } from "./AppTokenConnect";
import { CloudSignup } from "./CloudSignup";
import { SettingsForm } from "./SettingsForm";
import type { WaMessage, WaMessageEvent, WaOverview, WaPairing, WaTemplatesResponse } from "./types";
import { CONNECTION_TONE, MessageStatus, waError, waHref, WhatsappIcon, useWaAction } from "./WaUi";
import { WA_OFF } from "./waErrors";

// ---------------------------------------------------------------------------
// The four-step setup: 1 Connect (choose how), 2 Authorize (scan WhatsApp's own QR code, type the
// pairing code, or sign in with Meta), 3 Configure, 4 Test and activate. Every state shown comes from
// the API, which asks the provider: nothing here says "connected" before WhatsApp did. Each step is a
// numbered card, as the Stitch design numbers a form's parts (screens 15 and 19), and the ways to
// connect are drawn as its Channels screen (18) draws a channel: a name, its facts, one button.
// ---------------------------------------------------------------------------

export function Setup({ base, overview, reload }: { base: string; overview: WaOverview; reload: () => void }) {
  const firstOpen = overview.setup.current ?? "test";
  const [step, setStep] = useState<WaSetupStep>(firstOpen);
  const [provider, setProvider] = useState<WaProvider | null>(overview.connection && overview.connection.status !== "disconnected" ? overview.connection.provider : null);
  const done = overview.setup.done;
  const all = WA_SETUP_STEPS.every((s) => done[s]);
  const go = (s: WaSetupStep) => setStep(s);

  return (
    <div className="space-y-4">
      <ol className="home-card animate-rise grid gap-2 p-3 sm:grid-cols-4" aria-label="Setup steps">
        {WA_SETUP_STEPS.map((s, i) => {
          const active = s === step;
          return (
            <li key={s}>
              <button
                type="button"
                onClick={() => go(s)}
                aria-current={active ? "step" : undefined}
                className={`flex w-full items-start gap-3 rounded p-3 text-left text-sm transition outline-none focus-visible:ring-2 focus-visible:ring-accent ${active ? "bg-accent/10" : "hover:bg-home-soft"}`}
              >
                <StepNumber n={done[s] ? <Check size={14} strokeWidth={2.5} /> : i + 1} done={done[s]} />
                <span className="min-w-0">
                  <span className="font-semibold">
                    <span className="sr-only">{i + 1}. </span>
                    {WA_SETUP_STEP_INFO[s].label}
                  </span>
                  <span className="block text-xs text-muted">{WA_SETUP_STEP_INFO[s].help}</span>
                  <span className="sr-only">{done[s] ? "(done)" : "(not done)"}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {step === "connect" && <ConnectStep overview={overview} provider={provider} setProvider={setProvider} next={() => go("authorize")} />}
      {step === "authorize" && (
        <AuthorizeStep
          base={base}
          overview={overview}
          provider={provider}
          back={() => go("connect")}
          onConnected={() => {
            reload();
            go("configure");
          }}
        />
      )}
      {step === "configure" && (
        <StepCard id="wa-step-configure" n={3} title="Configure">
          <SettingsForm
            base={base}
            overview={overview}
            submitLabel="Save and continue"
            onSaved={() => {
              reload();
              go("test");
            }}
          />
        </StepCard>
      )}
      {step === "test" && (all ? <Complete overview={overview} /> : <TestStep base={base} overview={overview} reload={reload} />)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1
// ---------------------------------------------------------------------------

function ConnectStep({ overview, provider, setProvider, next }: { overview: WaOverview; provider: WaProvider | null; setProvider: (p: WaProvider) => void; next: () => void }) {
  const conn = overview.connection;
  const live = conn && conn.status !== "disconnected";
  const [understood, setUnderstood] = useState(false);
  const cloudReady = !!overview.cloudSignup;
  if (!overview.platform.evolution) {
    return (
      <StepCard id="wa-step-connect" n={1} title="Connect">
        <Alert kind="info">{WA_OFF} Nothing can be connected until it is back on, and nothing needs changing in your accounts.</Alert>
      </StepCard>
    );
  }
  if (live) {
    return (
      <StepCard id="wa-step-connect" n={1} title="Connect" aside={<Badge tone={CONNECTION_TONE[conn.status] ?? "neutral"}>{conn.statusLabel}</Badge>}>
        <p className="text-sm">
          This store connects with <strong>{PROVIDER_INFO[conn.provider].label}</strong>.
        </p>
        <p className="text-sm text-muted">To switch to the other way, disconnect first (Settings tab).</p>
        <div>
          <button type="button" className="btn-primary" onClick={next}>
            Continue
          </button>
        </div>
      </StepCard>
    );
  }
  const options: WaProvider[] = ["cloud_api", "qr"];
  return (
    <StepCard id="wa-step-connect" n={1} title="Choose how to connect">
      <p className="text-sm text-muted">Pick one. Read what each means first: they are different kinds of connection.</p>
      <div className="grid gap-3 lg:grid-cols-2">
        {options.map((p) => {
          const info = PROVIDER_INFO[p];
          const unavailable = p === "cloud_api" && !cloudReady;
          const chosen = provider === p;
          return (
            <label key={p} className={`flex min-w-0 cursor-pointer flex-col gap-3 rounded-lg border p-4 text-sm transition ${chosen ? "border-accent bg-accent/5" : "border-home-line hover:bg-home-soft/60"} ${unavailable ? "opacity-70" : ""}`}>
              <span className="flex items-start gap-3">
                <input type="radio" name="wa-provider" className="mt-1 accent-[var(--accent)]" checked={chosen} disabled={unavailable} onChange={() => setProvider(p)} />
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-base font-semibold">
                    {p === "cloud_api" ? <ShieldCheck size={17} aria-hidden className="shrink-0 text-accent" /> : <QrCode size={17} aria-hidden className="shrink-0 text-accent" />}
                    {info.label}
                  </span>
                  <span className="mt-1 block text-muted">{info.short}</span>
                </span>
              </span>
              <div className="sm:ml-7">
                <FactList>
                  {info.good.map((g) => (
                    <Fact key={g} icon={<Check className="text-accent" />}>
                      {g}
                    </Fact>
                  ))}
                </FactList>
              </div>
              <SoftBox className="sm:ml-7">
                <p className="text-[11px] font-semibold tracking-wider text-muted uppercase">Know before you choose</p>
                <ul className="mt-2 space-y-1.5 text-xs text-muted">
                  {info.limits.map((l) => (
                    <li key={l} className="flex gap-2">
                      <AlertTriangle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-warn" />
                      <span className="min-w-0">{l}</span>
                    </li>
                  ))}
                </ul>
              </SoftBox>
              {unavailable && (
                <p className="text-xs text-warn sm:ml-7">
                  Not available yet: bizinsights&apos; Meta app isn&apos;t set up for it
                  {overview.can.connect && overview.platform.cloudApi.missing.length ? ` (missing ${overview.platform.cloudApi.missing.join(", ")})` : ""}, and Meta must approve bizinsights as a Tech Provider before it can onboard businesses.
                </p>
              )}
            </label>
          );
        })}
      </div>
      {provider === "qr" && (
        <label className="flex items-start gap-2 rounded bg-home-soft p-3 text-sm">
          <input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
          <span>I understand this links my WhatsApp app the way WhatsApp Web does. It is not Meta&apos;s official business API, and WhatsApp may restrict a number that sends unwanted or bulk messages.</span>
        </label>
      )}
      {!overview.can.connect ? (
        <p className="text-sm text-muted">Only people who may manage integrations can connect WhatsApp.</p>
      ) : (
        <div>
          <button type="button" className="btn-primary" disabled={!provider || (provider === "qr" && !understood)} onClick={next}>
            Continue
          </button>
        </div>
      )}
    </StepCard>
  );
}

// ---------------------------------------------------------------------------
// Step 2
// ---------------------------------------------------------------------------

function AuthorizeStep({ base, overview, provider, back, onConnected }: { base: string; overview: WaOverview; provider: WaProvider | null; back: () => void; onConnected: () => void }) {
  const conn = overview.connection;
  if (conn && conn.status === "connected") {
    return (
      <StepCard id="wa-step-authorize" n={2} title="Authorize">
        <Alert kind="success">
          Connected{conn.phone ? ` as ${conn.phone}` : ""}
          {conn.profileName ? ` (${conn.profileName})` : ""}. WhatsApp confirmed the connection.
        </Alert>
        <div>
          <button type="button" className="btn-primary" onClick={onConnected}>
            Continue to settings
          </button>
        </div>
      </StepCard>
    );
  }
  if (!provider) {
    return (
      <StepCard id="wa-step-authorize" n={2} title="Authorize">
        <p className="text-sm text-muted">Choose how to connect first.</p>
        <div>
          <button type="button" className="btn-secondary" onClick={back}>
            Back to step 1
          </button>
        </div>
      </StepCard>
    );
  }
  if (!overview.can.connect) {
    return (
      <div className="home-card animate-rise p-5 sm:p-6">
        <p className="text-sm text-muted">Only people who may manage integrations can connect WhatsApp.</p>
      </div>
    );
  }
  if (provider === "cloud_api") {
    return (
      <StepCard id="wa-step-authorize" n={2} title="Sign in with Meta">
        <p className="text-sm text-muted">
          Meta&apos;s own window opens. Sign in with Facebook, pick or create your business portfolio and WhatsApp Business account, and add or pick the phone number. bizinsights then checks with Meta that it may send for you, and registers the number.
        </p>
        {overview.cloudSignup ? <CloudSignup base={base} signup={overview.cloudSignup} onConnected={onConnected} /> : <Alert kind="info">The Cloud API isn&apos;t available on bizinsights yet.</Alert>}
        {overview.cloudSignup && overview.tokenConnect && <AppTokenConnect base={base} onConnected={onConnected} />}
        <div>
          <button type="button" className="btn-secondary" onClick={back}>
            Back
          </button>
        </div>
      </StepCard>
    );
  }
  return <QrPairing base={base} overview={overview} back={back} onConnected={onConnected} />;
}

function QrPairing({ base, overview, back, onConnected }: { base: string; overview: WaOverview; back: () => void; onConnected: () => void }) {
  const id = useId();
  const { busy, run } = useWaAction();
  const [method, setMethod] = useState<"qr" | "code">(overview.connection?.pairingMethod ?? "qr");
  const [phone, setPhone] = useState("");
  const [pairing, setPairing] = useState<WaPairing | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const latest = useRef(0);
  const connectedOnce = useRef(false);

  const start = () =>
    run("start", "start connecting WhatsApp", async () => {
      const r = await api<{ pairing: WaPairing }>(`${base}/connection`, { method: "POST", body: { method, phone: method === "code" ? phone : null } });
      setPairing(r.pairing);
      setPollError(null);
    });

  const poll = useCallback(async () => {
    const request = ++latest.current;
    try {
      const r = await api<{ pairing: WaPairing }>(`${base}/connection/pairing`);
      if (request !== latest.current) return;
      setPairing(r.pairing);
      setPollError(null);
    } catch (e) {
      if (request === latest.current) setPollError(waError(e, "check the connection"));
    }
  }, [base]);

  // While pairing: ask every 3 seconds (each answer is the provider's current code or state).
  const pairingNow = pairing?.status === "pairing" || (!pairing && overview.connection?.status === "pairing");
  useEffect(() => {
    if (!pairingNow) return;
    void poll();
    const t = window.setInterval(() => void poll(), 3000);
    return () => window.clearInterval(t);
  }, [pairingNow, poll]);

  useEffect(() => {
    if (pairing?.status === "connected" && !connectedOnce.current) {
      connectedOnce.current = true;
      const t = window.setTimeout(onConnected, 1200);
      return () => window.clearTimeout(t);
    }
  }, [pairing?.status, onConnected]);

  const status = pairing?.status ?? overview.connection?.status ?? null;
  // Always on the page, so a screen reader announces what appears after the button that started it went.
  const announcement =
    status === "connected"
      ? "Linked: the phone is connected. Taking you to the settings."
      : status === "pairing" && pairing?.pairingCode
        ? `Pairing code ${pairing.pairingCode.split("").join(" ")}. Type it on the phone, under Linked devices.`
        : status === "pairing" && pairing?.qr
          ? "QR code shown. Scan it with the phone, under Linked devices."
          : "";
  return (
    <StepCard id="wa-step-authorize" n={2} title="Link your phone">
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {status === "connected" ? (
        <Alert kind="success">
          WhatsApp confirmed the link{pairing?.phone ? ` for ${pairing.phone}` : ""}
          {pairing?.profileName ? ` (${pairing.profileName})` : ""}. Taking you to the settings…
        </Alert>
      ) : status === "pairing" && pairing ? (
        <div className="grid items-start gap-6 md:grid-cols-[auto_1fr]">
          <div className="flex flex-col items-center gap-2">
            {pairing.qr ? (
              // A data URL from the provider: WhatsApp's own code, never one made here.
              <img src={pairing.qr} alt="QR code to link WhatsApp" width={264} height={264} className="h-auto max-w-full rounded-lg border border-home-line bg-white p-2" data-testid="wa-qr" />
            ) : pairing.pairingCode ? (
              <p className="rounded bg-home-soft px-5 py-4 font-mono text-2xl font-semibold tracking-[0.3em] sm:text-3xl" data-testid="wa-pairing-code">
                <span aria-hidden>{pairing.pairingCode}</span>
                <span className="sr-only">Pairing code {pairing.pairingCode.split("").join(" ")}</span>
              </p>
            ) : (
              <div className="skeleton aspect-square w-[264px] max-w-full rounded-lg" aria-label="Waiting for WhatsApp's code" />
            )}
            <p className="text-xs text-muted" aria-live="polite">
              {pairing.qrCount ? `Code ${pairing.qrCount} of 6: it changes about every 20 seconds.` : "Waiting for WhatsApp…"}
            </p>
          </div>
          <div className="space-y-3 text-sm">
            <p className="font-medium">On the phone with your business&apos;s WhatsApp:</p>
            <ol className="list-decimal space-y-1 pl-5 text-muted">
              <li>Open WhatsApp (or WhatsApp Business).</li>
              <li>Tap Settings (iPhone) or the ⋮ menu (Android), then Linked devices.</li>
              <li>Tap Link a device.</li>
              {pairing.pairingCode ? <li>Tap &quot;Link with phone number instead&quot; and type the code shown here.</li> : <li>Point the phone at this code.</li>}
            </ol>
            <p className="text-muted">The page changes by itself once WhatsApp confirms. The phone shows &quot;bizinsights&quot; under Linked devices; removing it there disconnects.</p>
            {pollError && (
              <p className="text-danger" role="alert">
                {pollError}
              </p>
            )}
          </div>
        </div>
      ) : (
        <>
          {(status === "failed" || status === "logged_out") && overview.connection?.reason && <Alert kind="info">{pairing?.reason ?? overview.connection.reason}</Alert>}
          <fieldset className="space-y-2">
            <legend className="label">How to link</legend>
            <label className={`flex items-start gap-2 rounded p-3 text-sm transition ${method === "qr" ? "bg-accent/10" : "bg-home-soft hover:bg-home-soft-hover"}`}>
              <input type="radio" name={`${id}-m`} className="mt-0.5 accent-[var(--accent)]" checked={method === "qr"} onChange={() => setMethod("qr")} />
              <QrCode size={16} aria-hidden className="mt-0.5 shrink-0 text-accent" /> <span className="min-w-0">Scan a QR code (this page on a computer, the phone in your hand)</span>
            </label>
            <label className={`flex items-start gap-2 rounded p-3 text-sm transition ${method === "code" ? "bg-accent/10" : "bg-home-soft hover:bg-home-soft-hover"}`}>
              <input type="radio" name={`${id}-m`} className="mt-0.5 accent-[var(--accent)]" checked={method === "code"} onChange={() => setMethod("code")} />
              <Smartphone size={16} aria-hidden className="mt-0.5 shrink-0 text-accent" /> <span className="min-w-0">Type a pairing code on the phone (when this page is on that phone)</span>
            </label>
          </fieldset>
          {method === "code" && (
            <div className="max-w-sm">
              <label className="label" htmlFor={`${id}-phone`}>
                The WhatsApp number on that phone
              </label>
              <input id={`${id}-phone`} className="input" inputMode="tel" autoComplete="tel" placeholder="+61 412 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <p className="mt-1 text-xs text-muted">With its country code. WhatsApp sends the code for this number.</p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary h-11 px-5" disabled={busy === "start" || (method === "code" && phone.trim().length < 8)} onClick={() => void start()} data-testid="wa-start-pairing">
              <WhatsappIcon size={20} /> {busy === "start" ? "Asking WhatsApp…" : status === "failed" || status === "logged_out" ? "Get a new code" : method === "qr" ? "Show QR code" : "Get pairing code"}
            </button>
            <button type="button" className="btn-secondary h-11" onClick={back}>
              Back
            </button>
          </div>
        </>
      )}
    </StepCard>
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
      <StepCard id="wa-step-test" n={4} title="Test and activate">
        <p className="text-sm text-muted">Connect WhatsApp first (step 2): the test goes out from your connected number.</p>
      </StepCard>
    );
  }
  const manage = overview.can.manage;
  return (
    <div className="space-y-4">
      <StepCard id="wa-step-verify" n="4a" title="Verify your own number">
        <p className="text-sm text-muted">
          Tests only ever go to a number you prove is yours: bizinsights sends it a 6-digit code over WhatsApp. The number your WhatsApp is linked with needs no code.
        </p>
        {s.testVerifiedAt ? (
          <Alert kind="success">
            Verified: {s.testPhone}. Tests go to this number.
            {s.testIsLinkedNumber && " It's the number your WhatsApp is linked with, so WhatsApp puts them in your chat with yourself (“Message yourself”), without a notification."}
          </Alert>
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
                    const r = await api<{ expiresAt: string | null; phone: string; linkedNumber?: boolean }>(`${base}/test-number`, { method: "POST", body: { phone } });
                    if (r.linkedNumber) {
                      reload();
                      return `${r.phone} is the number your WhatsApp is linked with: verified, no code needed.`;
                    }
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
      </StepCard>

      <StepCard id="wa-step-send-test" n="4b" title="Send a test message">
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
      </StepCard>
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
    <div className="space-y-1 rounded bg-home-soft p-3 text-sm" aria-live="polite">
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
      {m.message.status === "accepted" && <p className="text-xs text-muted">WhatsApp has the message; it reports sent, delivered and read as they happen.</p>}
      {m.message.errorDetail && <p className="text-xs text-danger">{m.message.errorDetail}</p>}
      {m.message.reasonLabel && m.message.status !== "accepted" && <p className="text-xs text-muted">{m.message.reasonLabel}</p>}
      {gaveUp && <p className="text-xs text-muted">No more reports in two minutes. The message history shows anything that comes later.</p>}
    </>
  );
}

function Complete({ overview }: { overview: WaOverview }) {
  return (
    <section aria-labelledby="wa-setup-done-h" className="home-card animate-rise space-y-3 p-5 sm:p-6">
      <h2 id="wa-setup-done-h" className="home-h2 flex items-center gap-2">
        <CheckCircle2 size={20} className="shrink-0 text-good" aria-hidden /> WhatsApp Automation is set up
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
    </section>
  );
}
