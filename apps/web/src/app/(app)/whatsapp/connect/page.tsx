"use client";
import { useState, type FormEvent, type ReactNode } from "react";
import { Badge } from "@/components/dashboard/primitives";
import { fmtRelative } from "@/components/dashboard/format";
import { LoadError } from "@/components/LoadError";
import { Alert } from "@/components/ui";
import { actionError, api, useApi } from "@/lib/api";
import { ConfirmDialog, PageHeader, Skeleton, useAction, useToast, useWa, WhatsappIcon } from "@/components/whatsapp/common";
import { EmbeddedSignup } from "@/components/whatsapp/EmbeddedSignup";
import { connectionStatus, quality, tier, type Overview } from "@/components/whatsapp/types";

// ---------------------------------------------------------------------------
// The merchant's own Meta app, as three steps: paste the token, pick the number Insights found
// with it, paste the app secret. Insights points the app's webhook at itself, so nothing has to
// be copied back into Meta.
// ---------------------------------------------------------------------------

interface Discovered {
  appId: string | null;
  accounts: Array<{ id: string; name: string | null; numbers: Array<{ id: string; displayPhoneNumber: string | null; verifiedName: string | null; registered: boolean }> }>;
}

const META = {
  createApp: "https://developers.facebook.com/apps/creation/",
  apps: "https://developers.facebook.com/apps/",
  systemUsers: "https://business.facebook.com/settings/system-users",
  numbers: "https://business.facebook.com/wa/manage/phone-numbers/",
};

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline-offset-2 hover:underline">
      {children} <span aria-hidden="true">↗</span>
    </a>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${done ? "bg-good/15 text-good" : "bg-accent/15 text-accent"}`}
      >
        {done ? "✓" : n}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="font-medium">
          <span className="sr-only">
            Step {n}
            {done ? " (done)" : ""}:{" "}
          </span>
          {title}
        </h3>
        {children && <div className="mt-2 space-y-3 text-sm">{children}</div>}
      </div>
    </li>
  );
}

function ManualConnect({ onConnected, reconnect }: { onConnected: () => void; reconnect: boolean }) {
  const { base } = useWa();
  const toast = useToast();
  const [token, setToken] = useState("");
  const [found, setFound] = useState<Discovered | null>(null);
  const [pick, setPick] = useState<{ wabaId: string; phoneNumberId: string } | null>(null);
  const [typeIds, setTypeIds] = useState(false);
  const [ids, setIds] = useState({ wabaId: "", phoneNumberId: "" });
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<null | "find" | "connect">(null);
  const [error, setError] = useState<string | null>(null);

  const numbers = found?.accounts.flatMap((a) => a.numbers.map((n) => ({ ...n, wabaId: a.id, wabaName: a.name }))) ?? [];
  const typed = /^\d{5,}$/.test(ids.wabaId) && /^\d{5,}$/.test(ids.phoneNumberId) ? ids : null;
  const chosen = typeIds ? typed : pick;

  const find = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("find");
    setError(null);
    try {
      const r = await api<Discovered>(`${base}/manual/discover`, { method: "POST", body: { accessToken: token.trim() } });
      const all = r.accounts.flatMap((a) => a.numbers.map((n) => ({ wabaId: a.id, phoneNumberId: n.id })));
      setFound(r);
      setPick(all.length === 1 ? all[0]! : null);
      setTypeIds(all.length === 0);
    } catch (err) {
      setFound(null);
      setError(actionError(err, "check the token"));
    } finally {
      setBusy(null);
    }
  };

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    if (!chosen) return;
    setBusy("connect");
    setError(null);
    try {
      const r = await api<{ webhook: "verified" | "in_use" | "failed" }>(`${base}/manual`, {
        method: "POST",
        body: { ...chosen, accessToken: token.trim(), appSecret: secret.trim() },
      });
      toast(
        "success",
        r.webhook === "verified"
          ? "WhatsApp is connected. Delivery updates and replies will reach Insights automatically."
          : "WhatsApp is connected. One more thing: set up the webhook below.",
      );
      setToken("");
      setSecret("");
      setFound(null);
      onConnected();
    } catch (err) {
      setError(actionError(err, "connect"));
    } finally {
      setBusy(null);
    }
  };

  const secretLink = found?.appId ? `${META.apps}${found.appId}/settings/basic/` : META.apps;

  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <ol className="space-y-6">
        <Step n={1} title="Copy your access token from Meta" done={!!found}>
          <details className="rounded-lg border border-border px-3 py-2" open={!reconnect && !found}>
            <summary className="cursor-pointer font-medium">Don&apos;t have one yet? Here&apos;s how (about 10 minutes)</summary>
            <ol className="mt-2 list-decimal space-y-2 pl-5 text-muted">
              <li>
                <span className="text-text">Create a Meta app.</span> Choose <em>Connect with customers through WhatsApp</em> and your business. <Ext href={META.createApp}>Create an app</Ext>
              </li>
              <li>
                <span className="text-text">Add your business number</span> in the app under WhatsApp → API Setup, and enter the code Meta texts you. Use a number that isn&apos;t
                signed in to the WhatsApp app on a phone. <Ext href={META.numbers}>WhatsApp Manager</Ext>
              </li>
              <li>
                <span className="text-text">Make a token that doesn&apos;t expire.</span> In Business settings → System users, add a user (Admin) and give it your app and your
                WhatsApp account. Then <em>Generate token</em>: pick your app, choose <em>Never</em> for expiry, tick <code>whatsapp_business_messaging</code> and{" "}
                <code>whatsapp_business_management</code>, and copy it. <Ext href={META.systemUsers}>System users</Ext>
              </li>
            </ol>
          </details>
          <form onSubmit={(e) => void find(e)} className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 basis-64">
              <label className="label" htmlFor="wa-token">
                Access token
              </label>
              <input
                id="wa-token"
                className="input font-mono"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="EAA…"
                required
                minLength={20}
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setFound(null);
                  setPick(null);
                }}
              />
            </div>
            <button type="submit" className="btn-primary" disabled={busy !== null || token.trim().length < 20}>
              {busy === "find" ? "Looking…" : found ? "Look again" : "Find my numbers"}
            </button>
          </form>
        </Step>

        <Step n={2} title="Choose the number customers will see" done={!!chosen}>
          {!found ? (
            <p className="text-muted">Your WhatsApp numbers appear here once Meta accepts the token.</p>
          ) : (
            <>
              {numbers.length > 0 && !typeIds && (
                <fieldset className="space-y-2">
                  <legend className="sr-only">Your WhatsApp numbers</legend>
                  {numbers.map((n) => {
                    const on = pick?.phoneNumberId === n.id;
                    return (
                      <label
                        key={n.id}
                        className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition ${on ? "border-accent bg-accent/5" : "border-border hover:border-accent/50"}`}
                      >
                        <input type="radio" name="wa-number" className="accent-[#25D366]" checked={on} onChange={() => setPick({ wabaId: n.wabaId, phoneNumberId: n.id })} />
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">{n.displayPhoneNumber ?? "A number without a display name"}</span>
                          <span className="block text-xs text-muted">
                            {n.verifiedName ?? "No display name yet"}
                            {n.wabaName && n.wabaName !== n.verifiedName ? ` · ${n.wabaName}` : ""}
                          </span>
                        </span>
                        {!n.registered && <Badge tone="warn">Needs a PIN next</Badge>}
                      </label>
                    );
                  })}
                </fieldset>
              )}
              {numbers.length === 0 && (
                <p className="text-muted">
                  Meta accepted the token but didn&apos;t list a number for it. In System users, check the user has your WhatsApp account under <em>Assigned assets</em>, then
                  press Look again, or enter the IDs yourself.
                </p>
              )}
              {typeIds ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor="wa-waba">
                      WhatsApp Business Account ID
                    </label>
                    <input
                      id="wa-waba"
                      className="input font-mono"
                      inputMode="numeric"
                      autoComplete="off"
                      value={ids.wabaId}
                      onChange={(e) => setIds({ ...ids, wabaId: e.target.value.replace(/\D/g, "") })}
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor="wa-phone">
                      Phone number ID
                    </label>
                    <input
                      id="wa-phone"
                      className="input font-mono"
                      inputMode="numeric"
                      autoComplete="off"
                      value={ids.phoneNumberId}
                      onChange={(e) => setIds({ ...ids, phoneNumberId: e.target.value.replace(/\D/g, "") })}
                    />
                  </div>
                  <p className="text-xs text-muted sm:col-span-2">Both are on your app&apos;s WhatsApp → API Setup page. The phone number ID is a long number, not the phone number itself.</p>
                </div>
              ) : (
                <button type="button" className="text-xs text-muted underline underline-offset-2 hover:text-text" onClick={() => setTypeIds(true)}>
                  My number isn&apos;t listed: enter the IDs instead
                </button>
              )}
            </>
          )}
        </Step>

        <Step n={3} title="Paste your app secret">
          <form onSubmit={(e) => void connect(e)} className="space-y-3">
            <p className="text-muted">
              <Ext href={secretLink}>{found?.appId ? "Open your app's settings" : "Open your Meta apps"}</Ext>, click <em>Show</em> next to <em>App secret</em>, and copy it. It lets
              Insights check that updates really come from Meta.
            </p>
            <div className="max-w-md">
              <label className="label" htmlFor="wa-secret">
                App secret
              </label>
              <input
                id="wa-secret"
                className="input font-mono"
                type="password"
                autoComplete="off"
                spellCheck={false}
                required
                pattern="[A-Fa-f0-9]{32}"
                title="32 letters and numbers"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            </div>
            <button type="submit" className="btn-primary" disabled={busy !== null || !found || !chosen || !/^[a-f0-9]{32}$/i.test(secret.trim())}>
              {busy === "connect" ? "Connecting…" : reconnect ? "Replace the connection" : "Connect WhatsApp"}
            </button>
            <p className="text-xs text-muted">Your token and secret are stored encrypted and never shown again, not even to you.</p>
          </form>
        </Step>
      </ol>
    </div>
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

/** The number's two-step verification PIN, shown on request (the request is audited). */
function PinReveal({ base }: { base: string }) {
  const [pin, setPin] = useState<string | null>(null);
  const { busy, run } = useAction();
  return (
    <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
      Two-step verification PIN:
      {pin ? (
        <span className="font-mono text-text" data-testid="wa-pin-value">{pin}</span>
      ) : (
        <button type="button" className="text-accent underline-offset-2 hover:underline" disabled={!!busy} onClick={() => void run("pin", "show the PIN", async () => {
          setPin((await api<{ pin: string }>(`${base}/pin`, { method: "POST" })).pin);
        })}>
          {busy === "pin" ? "Loading…" : "Show"}
        </button>
      )}
      <span className="text-xs">You only need it to move this number to another provider. Change it in WhatsApp Manager.</span>
    </p>
  );
}

export default function ConnectWhatsapp() {
  const { base, manage } = useWa();
  const toast = useToast();
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
          {c.registered && c.hasPin && manage && base && <PinReveal base={base} />}

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
          {c.mode === "manual" && c.webhookVerifiedAt ? (
            <p className="mt-2 text-sm text-muted">Set up: Meta sends updates for this number to Insights. Nothing to do.</p>
          ) : c.mode === "manual" ? (
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
          {!c && !data.platform.embeddedSignup && <p className="mt-1 text-sm text-muted">Three steps. You need a Meta Business account; everything else is explained as you go.</p>}
          {data.platform.embeddedSignup ? (
            <>
              <div className="mt-3 space-y-2">
                <p className="text-sm text-muted">
                  Meta opens a window: log in with Facebook, choose your business and WhatsApp number (or add one), and enter the code Meta texts you. About 3
                  minutes, and nothing to copy.
                </p>
                <EmbeddedSignup base={base!} platform={data.platform} onConnected={reloaded} notify={toast} />
              </div>
              <div className="mt-4 border-t border-border pt-4">
                <button type="button" className="text-sm font-medium text-accent underline-offset-2 hover:underline" aria-expanded={showManual} onClick={() => setShowManual((s) => !s)}>
                  Use your own Meta app instead
                </button>
                {showManual && <div className="mt-3"><ManualConnect onConnected={reloaded} reconnect={!!c} /></div>}
              </div>
            </>
          ) : (
            <div className="mt-4">
              {/* The one-click button, shown but off until Insights' Meta app is configured (docs/whatsapp.md). */}
              {!c && (
                <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-border px-3 py-3">
                  <button
                    type="button"
                    disabled
                    aria-describedby="wa-soon"
                    className="inline-flex h-11 cursor-not-allowed items-center gap-2 rounded-lg bg-[#25D366] px-5 text-sm font-semibold text-[#0b3d20] opacity-50"
                  >
                    <WhatsappIcon size={20} /> Continue with WhatsApp
                  </button>
                  <p id="wa-soon" className="min-w-0 flex-1 basis-56 text-sm text-muted">
                    <span className="font-medium text-text">Coming soon:</span> connect in one click through Meta. For now, connect in three steps below.
                  </p>
                </div>
              )}
              <ManualConnect onConnected={reloaded} reconnect={!!c} />
            </div>
          )}
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
