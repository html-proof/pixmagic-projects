"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Badge } from "@/components/dashboard/primitives";
import { fmtRelative } from "@/components/dashboard/format";
import { LoadError } from "@/components/LoadError";
import { Alert } from "@/components/ui";
import { actionError, api, useApi } from "@/lib/api";
import { ConfirmDialog, PageHeader, Skeleton, useAction, useToast, useWa, WhatsappIcon } from "@/components/whatsapp/common";
import { connectionStatus, quality, tier, type Overview } from "@/components/whatsapp/types";

// ---------------------------------------------------------------------------
// Meta's Embedded Signup (Facebook Login for Business, WhatsApp variation). The browser opens
// Meta's flow; Meta posts the chosen account and number ids to this window and hands back a
// code that lives 30 seconds, which the server exchanges for the business's token at once.
// No token ever reaches this page.
// ---------------------------------------------------------------------------

interface FbLoginResponse {
  authResponse?: { code?: string } | null;
  status?: string;
}
interface FbSdk {
  init(opts: Record<string, unknown>): void;
  login(cb: (r: FbLoginResponse) => void, opts: Record<string, unknown>): void;
}
declare global {
  interface Window {
    FB?: FbSdk;
    fbAsyncInit?: () => void;
  }
}

function loadFacebookSdk(appId: string, version: string): Promise<FbSdk> {
  return new Promise((resolve, reject) => {
    if (window.FB) return resolve(window.FB);
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB!);
    };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    s.async = true;
    s.defer = true;
    s.crossOrigin = "anonymous";
    s.onerror = () => reject(new Error("Meta's sign-in couldn't load. Check that nothing (an ad blocker) is blocking connect.facebook.net."));
    document.body.appendChild(s);
  });
}

function EmbeddedSignup({ platform, onConnected }: { platform: Overview["platform"]; onConnected: () => void }) {
  const { base } = useWa();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const session = useRef<{ waba_id?: string; phone_number_id?: string; business_id?: string } | null>(null);
  const code = useRef<string | null>(null);
  const done = useRef(false);

  const finish = useCallback(async () => {
    if (done.current || !code.current || !session.current?.waba_id || !session.current.phone_number_id) return;
    done.current = true;
    try {
      await api(`${base}/embedded`, {
        method: "POST",
        body: { code: code.current, wabaId: session.current.waba_id, phoneNumberId: session.current.phone_number_id, businessId: session.current.business_id },
      });
      toast("success", "WhatsApp is connected.");
      onConnected();
    } catch (e) {
      toast("error", actionError(e, "finish connecting"));
    } finally {
      setBusy(false);
    }
  }, [base, toast, onConnected]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      let host = "";
      try {
        host = new URL(event.origin).hostname;
      } catch {
        return;
      }
      if (!/(^|\.)facebook\.com$/.test(host)) return;
      let data: { type?: string; event?: string; data?: Record<string, string> };
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (data?.type !== "WA_EMBEDDED_SIGNUP") return;
      if (data.event?.startsWith("FINISH")) {
        session.current = data.data ?? null;
        if (!data.data?.phone_number_id) {
          toast("error", "Meta's sign-up finished without a phone number. Add a number to the account, then connect again.");
          setBusy(false);
          return;
        }
        void finish();
      } else if (data.event === "CANCEL") {
        setBusy(false);
        if (data.data?.error_message) toast("error", `Meta reported a problem: ${data.data.error_message}`);
      } else if (data.event === "ERROR") {
        setBusy(false);
        toast("error", `Meta reported a problem: ${data.data?.error_message ?? "unknown error"}`);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [finish, toast]);

  const start = async () => {
    if (!platform.appId || !platform.configId) return;
    setBusy(true);
    done.current = false;
    code.current = null;
    session.current = null;
    try {
      const FB = await loadFacebookSdk(platform.appId, platform.version ?? "v25.0");
      FB.login(
        (r) => {
          if (r.authResponse?.code) {
            code.current = r.authResponse.code;
            void finish();
          } else {
            setBusy(false);
          }
        },
        { config_id: platform.configId, response_type: "code", override_default_response_type: true, extras: { setup: {} } },
      );
    } catch (e) {
      setBusy(false);
      toast("error", (e as Error).message);
    }
  };

  return (
    <button type="button" className="inline-flex h-11 items-center gap-2 rounded-lg bg-[#25D366] px-5 text-sm font-semibold text-[#0b3d20] shadow-sm transition hover:brightness-95 disabled:opacity-60" onClick={() => void start()} disabled={busy} data-testid="wa-connect">
      <WhatsappIcon size={20} /> {busy ? "Waiting for Meta…" : "Connect WhatsApp Business"}
    </button>
  );
}

function ManualConnect({ onConnected, reconnect }: { onConnected: () => void; reconnect: boolean }) {
  const { base } = useWa();
  const toast = useToast();
  const [form, setForm] = useState({ wabaId: "", phoneNumberId: "", accessToken: "", appSecret: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`${base}/manual`, { method: "POST", body: form });
      setForm({ wabaId: "", phoneNumberId: "", accessToken: "", appSecret: "" });
      toast("success", "WhatsApp is connected.");
      onConnected();
    } catch (err) {
      setError(actionError(err, "connect"));
    } finally {
      setBusy(false);
    }
  };
  const field = (k: keyof typeof form, label: string, help: string, secret = false) => (
    <div>
      <label className="label" htmlFor={`wa-${k}`}>
        {label}
      </label>
      <input
        id={`wa-${k}`}
        className="input font-mono"
        type={secret ? "password" : "text"}
        inputMode={secret ? undefined : "numeric"}
        autoComplete="off"
        spellCheck={false}
        required
        value={form[k]}
        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
      />
      <p className="mt-1 text-xs text-muted">{help}</p>
    </div>
  );
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        {field("wabaId", "WhatsApp Business Account ID", "WhatsApp Manager → Account tools → Phone numbers, or the API Setup page of your Meta app.")}
        {field("phoneNumberId", "Phone number ID", "The number's ID (not the phone number itself), from the same page.")}
        {field("accessToken", "Permanent access token", "A system user token with whatsapp_business_messaging and whatsapp_business_management.", true)}
        {field("appSecret", "App secret", "Your Meta app → App settings → Basic. Insights uses it to check that webhooks really come from Meta.", true)}
      </div>
      <p className="text-xs text-muted">
        The token and secret are sent once, over HTTPS, stored encrypted on the server, and never shown again, not even to you. Insights checks them with Meta before saving.
      </p>
      <button type="submit" className="btn-primary" disabled={busy}>
        {busy ? "Checking with Meta…" : reconnect ? "Replace the connection" : "Connect"}
      </button>
    </form>
  );
}

function Copy({ value, label }: { value: string; label: string }) {
  const toast = useToast();
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-bg px-2 py-1.5 text-xs" title={value}>
        {value}
      </code>
      <button
        type="button"
        className="btn-secondary h-8 px-3 text-xs"
        aria-label={`Copy ${label}`}
        onClick={() =>
          void navigator.clipboard
            .writeText(value)
            .then(() => toast("success", `${label} copied.`))
            .catch(() => toast("error", "Couldn't copy; select the text instead."))
        }
      >
        Copy
      </button>
    </div>
  );
}

export default function ConnectWhatsapp() {
  const { base, manage } = useWa();
  const { data, error, reload } = useApi<Overview>(base);
  const { busy, run } = useAction();
  const [pin, setPin] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [showManual, setShowManual] = useState(false);
  if (error) return <LoadError what="WhatsApp" error={error} onRetry={() => void reload()} />;
  if (!data) return <Skeleton lines={5} />;
  const c = data.connection;
  const status = connectionStatus(c);
  const reloaded = () => void reload();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Connect WhatsApp"
        sub={
          <>
            Insights sends messages through Meta&apos;s official WhatsApp Business Platform (Cloud API) from your own business number. Customers see your business
            name; replies go to your WhatsApp Business account.
          </>
        }
        actions={c && manage ? (
          <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void run("refresh", "refresh from Meta", async () => {
            await api(`${base}/refresh`, { method: "POST" });
            await reload();
            return "Updated from Meta.";
          })}>
            {busy === "refresh" ? "Checking…" : "Refresh from Meta"}
          </button>
        ) : undefined}
      />

      {c && (
        <section className="card animate-rise" aria-labelledby="num-h">
          <h2 id="num-h" className="flex flex-wrap items-center gap-2 font-semibold">
            {c.verifiedName ?? "Your WhatsApp number"} <Badge tone={status.tone}>{status.label}</Badge>
          </h2>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
            <div><dt className="text-xs text-muted">Phone number</dt><dd>{c.displayPhoneNumber ?? "—"}</dd></div>
            <div><dt className="text-xs text-muted">Display name</dt><dd>{c.verifiedName ?? "—"} {c.nameStatus ? <span className="text-xs text-muted">({c.nameStatus.toLowerCase().replace(/_/g, " ")})</span> : null}</dd></div>
            <div><dt className="text-xs text-muted">Quality · limit</dt><dd>{quality(c.qualityRating)} · {tier(c.messagingLimitTier)}</dd></div>
            <div><dt className="text-xs text-muted">WhatsApp Business Account</dt><dd>{c.wabaName ?? c.wabaId}</dd></div>
            <div><dt className="text-xs text-muted">Connected</dt><dd>{fmtRelative(c.connectedAt)} · {c.mode === "embedded" ? "through Meta's sign-up" : "with your own Meta app"}</dd></div>
            <div><dt className="text-xs text-muted">Last checked</dt><dd>{c.lastSyncedAt ? fmtRelative(c.lastSyncedAt) : "—"}</dd></div>
          </dl>
          {c.lastError && c.status !== "active" && <div className="mt-3"><Alert>{c.lastError}</Alert></div>}

          {!c.registered && manage && (
            <form
              className="mt-4 rounded-lg border border-warn/50 p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void run("register", "register the number", async () => {
                  await api(`${base}/register`, { method: "POST", body: { pin } });
                  setPin("");
                  await reload();
                  return "The number is registered and can send messages.";
                });
              }}
            >
              <h3 className="font-medium">Register the number</h3>
              <p className="mt-1 text-sm text-muted">
                The number has to be registered with the Cloud API before it can send. Enter a 6-digit PIN: it becomes the number&apos;s two-step verification PIN (or, if it
                already has one, enter that).
              </p>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <div>
                  <label className="label" htmlFor="wa-pin">PIN</label>
                  <input id="wa-pin" className="input w-32 font-mono" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="off" required value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
                </div>
                <button type="submit" className="btn-primary" disabled={!!busy || pin.length !== 6}>{busy === "register" ? "Registering…" : "Register"}</button>
              </div>
            </form>
          )}
        </section>
      )}

      {c && (
        <section className="card animate-rise" aria-labelledby="hook-h">
          <h2 id="hook-h" className="flex flex-wrap items-center gap-2 font-semibold">
            Webhook {c.webhookVerifiedAt ? <Badge tone="good">Verified</Badge> : <Badge tone="warn">Not verified yet</Badge>}
          </h2>
          <p className="mt-1 text-sm text-muted">
            Meta tells Insights when messages are delivered and read, and when a customer replies STOP. Without it, marketing campaigns stay locked, because opt-outs couldn&apos;t
            reach us.
          </p>
          {c.mode === "manual" ? (
            <div className="mt-3 space-y-2 text-sm">
              <p>In your Meta app: WhatsApp → Configuration → Webhook → Edit, enter these two values, then subscribe to the <strong>messages</strong>, <strong>message_template_status_update</strong> and <strong>user_preferences</strong> fields.</p>
              <div><p className="text-xs text-muted">Callback URL</p><Copy value={data.webhookUrl} label="Callback URL" /></div>
              {c.verifyToken && <div><p className="text-xs text-muted">Verify token</p><Copy value={c.verifyToken} label="Verify token" /></div>}
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">Numbers connected through Meta&apos;s sign-up use Insights&apos; own webhook; nothing to set up.</p>
          )}
          <p className="mt-2 text-xs text-muted">
            {c.webhookVerifiedAt ? `Meta reached Insights ${fmtRelative(c.webhookVerifiedAt)}.` : "Waiting for Meta's first call."}
            {c.lastWebhookAt ? ` Last delivery ${fmtRelative(c.lastWebhookAt)}.` : ""}
          </p>
        </section>
      )}

      {manage && (
        <section className="card animate-rise" aria-labelledby="conn-h">
          <h2 id="conn-h" className="font-semibold">{c ? "Reconnect or change number" : "Connect your WhatsApp Business number"}</h2>
          {data.platform.embeddedSignup ? (
            <div className="mt-3 space-y-2">
              <p className="text-sm text-muted">
                Sign in with Facebook, choose (or create) your Meta business and WhatsApp Business Account, and verify your number. It takes a few minutes.
              </p>
              <EmbeddedSignup platform={data.platform} onConnected={reloaded} />
            </div>
          ) : (
            <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted">
              <p className="font-medium text-text">Meta&apos;s one-click sign-up isn&apos;t set up on this Insights server yet.</p>
              <p className="mt-1">
                It needs Insights&apos; Meta app (with the WhatsApp product and an Embedded Signup configuration) and its keys on the server. The steps are in docs/whatsapp.md.
                Meanwhile, you can connect with your own Meta app below.
              </p>
            </div>
          )}
          <div className="mt-4 border-t border-border pt-4">
            <button type="button" className="text-sm font-medium text-accent underline-offset-2 hover:underline" aria-expanded={showManual || !data.platform.embeddedSignup} onClick={() => setShowManual((s) => !s)}>
              {showManual || !data.platform.embeddedSignup ? "Use your own Meta app and access token" : "Use your own Meta app instead"}
            </button>
            {(showManual || !data.platform.embeddedSignup) && <div className="mt-3"><ManualConnect onConnected={reloaded} reconnect={!!c} /></div>}
          </div>
        </section>
      )}

      {!manage && !c && <div className="card text-sm text-muted">Ask a workspace owner or admin to connect WhatsApp.</div>}

      {c && manage && (
        <section className="card border-danger/40" aria-labelledby="dis-h">
          <h2 id="dis-h" className="font-semibold">Disconnect</h2>
          <p className="mt-1 text-sm text-muted">Insights deletes its access to the number and stops sending. Messages waiting to go out are cancelled; your message history stays.</p>
          <button type="button" className="btn-danger mt-3" onClick={() => setConfirmDisconnect(true)}>Disconnect WhatsApp</button>
          <ConfirmDialog
            open={confirmDisconnect}
            title="Disconnect WhatsApp?"
            confirmLabel="Disconnect"
            danger
            busy={busy === "disconnect"}
            onCancel={() => setConfirmDisconnect(false)}
            onConfirm={() =>
              void run("disconnect", "disconnect", async () => {
                await api(base!, { method: "DELETE" });
                setConfirmDisconnect(false);
                await reload();
                return "WhatsApp is disconnected.";
              })
            }
          >
            <p>{data.scheduled ? `${data.scheduled} scheduled message${data.scheduled === 1 ? " is" : "s are"} cancelled.` : "No messages are waiting."} You can connect again at any time.</p>
          </ConfirmDialog>
        </section>
      )}
    </div>
  );
}
