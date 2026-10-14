"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { DELIVERY_REPORTING, errorLabel, PROVIDER_LIMITS, SMTP_PORTS, type EmailProvider } from "@app/shared/email";
import { Badge } from "@/components/dashboard/primitives";
import { AccountStatusBadge, Note, ProviderMark, providerLabel, relative } from "@/components/email/EmailUi";
import { LoadError } from "@/components/LoadError";
import { Field, Modal } from "@/components/staff/ui";
import { Alert, EmptyState } from "@/components/ui";
import { ConfirmDialog, PageHeader, Skeleton, useAction, useToast } from "@/components/whatsapp/common";
import { actionError, api, useApi } from "@/lib/api";
import { useEmail, type AccountsResponse, type AccountView, type SenderView } from "@/lib/email";

/** What a callback's `?error=` means, in words. */
const OAUTH_ERRORS: Record<string, string> = {
  denied: "You cancelled on the provider's screen. Nothing was connected.",
  consent_required: "An administrator of your Microsoft organization must approve Insights before mailboxes can connect. Ask them to grant admin consent, then try again.",
  permission_missing: "The permission to send email wasn't granted. Connect again and leave “Send email on your behalf” ticked.",
  no_refresh_token: "The provider didn't grant offline access, so Insights couldn't send while you're away. Remove Insights from your account's connected apps, then connect again.",
  different_account: "You signed in as a different mailbox than the one you were reconnecting.",
  state_mismatch: "That sign-in wasn't started from this browser. Start again from this page.",
  state_expired: "That sign-in took too long or was already used. Start again.",
  session_mismatch: "You're signed in to Insights as someone else than the person who started this connection.",
  forbidden: "Your role no longer allows connecting email accounts.",
  not_configured: "This provider isn't set up on this server yet.",
  conditional_access: "Your organization's sign-in policy blocked the connection (for example multi-factor authentication or a trusted device). Try again from a compliant device.",
  account_disabled_by_provider: "The provider says this account is disabled.",
  auth_failed: "The provider refused the sign-in.",
  account_failed: "This account has no mailbox Insights can send from.",
  provider_unavailable: "The provider couldn't be reached. Try again in a moment.",
  temporarily_unavailable: "Something went wrong on our side. Try again in a moment.",
};

export default function EmailAccountsPage() {
  return (
    <Suspense fallback={<Skeleton lines={5} />}>
      <AccountsInner />
    </Suspense>
  );
}

function AccountsInner() {
  const { base, manage } = useEmail();
  const params = useSearchParams();
  const router = useRouter();
  const { data, error, loading, reload } = useApi<AccountsResponse>(`${base}/accounts`);
  const [adding, setAdding] = useState(params.get("add") === "1");
  const callbackError = params.get("error");
  const connected = params.get("connected");

  // The callback's message is shown once; the URL is cleaned so a reload doesn't repeat it.
  const [banner] = useState(() =>
    callbackError
      ? { kind: "error" as const, text: OAUTH_ERRORS[callbackError] ?? `The connection didn't complete (${callbackError}).` }
      : connected
        ? { kind: "success" as const, text: params.get("reconnected") ? "Account reconnected. Mail that was waiting for it is being sent." : "Account connected. You can now send from it." }
        : null,
  );
  useEffect(() => {
    if (callbackError || connected || params.get("add")) router.replace("/settings/email/accounts");
  }, [callbackError, connected, params, router]);

  if (error && !data) return <LoadError what="your email accounts" error={error} onRetry={reload} busy={loading} />;
  if (!data) return <Skeleton lines={5} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Email accounts"
        sub="The mailboxes Insights sends from. Credentials stay encrypted on Insights' servers and are never shown again."
        actions={
          manage && (
            <button className="btn-primary" onClick={() => setAdding(true)}>
              Add email account
            </button>
          )
        }
      />
      {banner && <Alert kind={banner.kind}>{banner.text}</Alert>}
      {data.accounts.length === 0 ? (
        <EmptyState title="No email accounts yet" body="Connect Gmail, Google Workspace, Outlook, Microsoft 365, or any provider that offers SMTP." action={manage ? <button className="btn-primary" onClick={() => setAdding(true)}>Add email account</button> : undefined} />
      ) : (
        <div className="space-y-3">
          {data.accounts.map((a) => (
            <AccountCard key={a.id} account={a} manage={manage} onChange={reload} />
          ))}
        </div>
      )}
      <AddAccountModal open={adding} onClose={() => setAdding(false)} configured={data.configured} smtpAvailable={data.smtpAvailable} onAdded={reload} />
    </div>
  );
}

function AccountCard({ account: a, manage, onChange }: { account: AccountView; manage: boolean; onChange: () => Promise<boolean> }) {
  const { base } = useEmail();
  const { busy, run } = useAction();
  const [confirm, setConfirm] = useState<null | "disconnect" | "disable">(null);
  const [editing, setEditing] = useState(false);
  const oauth = a.connectionMethod !== "smtp";
  const needsReconnect = a.status === "reauthorization_required";
  const act = (key: string, what: string, fn: () => Promise<string | void>) => run(key, what, async () => {
    const msg = await fn();
    await onChange();
    return msg;
  });

  async function reconnect() {
    await run("reconnect", "start reconnecting", async () => {
      const r = await api<{ url: string }>(`${base}/accounts/${a.id}/reauthorize`, { method: "POST" });
      window.location.assign(r.url);
    });
  }

  return (
    <section className="card space-y-3" aria-label={a.email}>
      <div className="flex flex-wrap items-start gap-3">
        <ProviderMark provider={a.provider} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-semibold">
            <span className="truncate">{a.email}</span>
            {a.isDefault && <Badge tone="good">Default sender</Badge>}
          </p>
          <p className="text-xs text-muted">
            {providerLabel(a.provider)}
            {a.smtp ? ` · ${a.smtp.host}:${a.smtp.port} (${a.smtp.encryption === "tls" ? "TLS" : "STARTTLS"})` : ""}
            {a.displayName ? ` · shown as “${a.displayName}”` : ""}
          </p>
        </div>
        <AccountStatusBadge status={a.status} />
      </div>
      {a.statusReason && a.status !== "connected" && (
        <Alert kind={needsReconnect || a.status === "failed" ? "error" : "info"}>
          {errorLabel(a.statusReason)}
          {needsReconnect && (oauth ? " Reconnect it to resume sending; mail waiting for it is kept for 24 hours." : " Update the password to resume sending.")}
        </Alert>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted">Last sent</dt>
          <dd>{relative(a.lastSuccessfulSendAt)}</dd>
        </div>
        <div>
          <dt className="text-muted">Last checked</dt>
          <dd>{relative(a.lastVerifiedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted">Daily limit</dt>
          <dd>{a.dailyLimit.toLocaleString()} emails</dd>
        </div>
        <div>
          <dt className="text-muted">Permission</dt>
          <dd>{oauth ? "Send email only" : "SMTP sign-in"}</dd>
        </div>
      </dl>
      <Senders account={a} manage={manage} onChange={onChange} />
      {manage && (
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          {needsReconnect && oauth && (
            <button className="btn-primary" disabled={!!busy} onClick={reconnect}>
              Reconnect
            </button>
          )}
          {a.status !== "disabled" && (
            <button className="btn-secondary" disabled={!!busy} onClick={() => act("test", "test the connection", async () => {
              const r = await api<{ test: { ok: boolean; message?: string } }>(`${base}/accounts/${a.id}/test`, { method: "POST" });
              if (!r.test.ok) throw new Error(r.test.message ?? "The connection test failed");
              return "The connection works.";
            })}>
              {busy === "test" ? "Testing…" : "Test connection"}
            </button>
          )}
          {a.canSend && (
            <button className="btn-secondary" disabled={!!busy} onClick={() => act("send", "send a test email", async () => {
              const r = await api<{ result: { status: string; message: string | null } }>(`${base}/accounts/${a.id}/test-send`, { method: "POST", body: {} });
              if (r.result.status !== "accepted_by_provider") throw new Error(r.result.message ?? `Not sent (${r.result.status})`);
              return "Test email sent to your own address. Check your inbox.";
            })}>
              {busy === "send" ? "Sending…" : "Send test email to me"}
            </button>
          )}
          {!a.isDefault && a.canSend && a.senders.some((s) => s.email === a.email && s.status === "verified") && (
            <button className="btn-secondary" disabled={!!busy} onClick={() => act("default", "set the default sender", async () => {
              await api(`${base}/accounts/${a.id}`, { method: "PATCH", body: { isDefault: true } });
              return "Default sender updated.";
            })}>
              Set as default
            </button>
          )}
          <button className="btn-secondary" disabled={!!busy} onClick={() => setEditing(true)}>
            {a.smtp ? "Edit settings" : "Edit"}
          </button>
          {a.status === "disabled" ? (
            <button className="btn-secondary" disabled={!!busy} onClick={() => act("enable", "enable the account", async () => {
              await api(`${base}/accounts/${a.id}`, { method: "PATCH", body: { enabled: true } });
              return "Enabled. Test it to confirm it still works.";
            })}>
              Enable
            </button>
          ) : (
            <button className="btn-secondary" disabled={!!busy} onClick={() => setConfirm("disable")}>
              Disable
            </button>
          )}
          <button className="btn-secondary text-danger" disabled={!!busy} onClick={() => setConfirm("disconnect")}>
            Disconnect
          </button>
        </div>
      )}
      <ConfirmDialog
        open={confirm === "disable"}
        title={`Disable ${a.email}?`}
        confirmLabel="Disable"
        busy={busy === "disable"}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          await act("disable", "disable the account", async () => {
            await api(`${base}/accounts/${a.id}`, { method: "PATCH", body: { enabled: false } });
            return "Disabled. Emails from it wait until it's enabled again (up to 3 days).";
          });
          setConfirm(null);
        }}
      >
        <p>Nothing is sent from this account until you enable it again. Its credentials are kept.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "disconnect"}
        title={`Disconnect ${a.email}?`}
        confirmLabel="Disconnect"
        danger
        busy={busy === "disconnect"}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          await act("disconnect", "disconnect the account", async () => {
            const r = await api<{ revocation: string; rulesDisabled: number; messagesCancelled: number }>(`${base}/accounts/${a.id}`, { method: "DELETE" });
            const parts = [r.revocation === "revoked" ? "Access revoked at the provider." : oauth ? "Stored tokens deleted. Remove Insights from your Microsoft account's apps to revoke it there too." : "Stored password deleted."];
            if (r.rulesDisabled) parts.push(`${r.rulesDisabled} automation${r.rulesDisabled === 1 ? " was" : "s were"} turned off.`);
            if (r.messagesCancelled) parts.push(`${r.messagesCancelled} waiting email${r.messagesCancelled === 1 ? " was" : "s were"} cancelled.`);
            return parts.join(" ");
          });
          setConfirm(null);
        }}
      >
        <p>Insights deletes the stored credentials, stops sending from this address, cancels emails waiting for it and turns off automations that send from it. Sent-email history stays.</p>
      </ConfirmDialog>
      <EditAccountModal open={editing} account={a} onClose={() => setEditing(false)} onSaved={onChange} />
    </section>
  );
}

function Senders({ account: a, manage, onChange }: { account: AccountView; manage: boolean; onChange: () => Promise<boolean> }) {
  const { base } = useEmail();
  const { busy, run } = useAction();
  const [alias, setAlias] = useState("");
  const [codes, setCodes] = useState<Record<string, string>>({});
  const act = (key: string, what: string, fn: () => Promise<string | void>) => run(key, what, async () => {
    const m = await fn();
    await onChange();
    return m;
  });
  const statusBadge = (s: SenderView) =>
    s.status === "verified" ? <Badge tone="good">Verified{s.method === "domain_ownership" ? " by domain" : s.method === "provider_oauth" ? "" : " by code"}</Badge> : <Badge tone="warn">Not verified</Badge>;
  return (
    <div className="rounded-lg border border-border">
      <p className="border-b border-border px-3 py-2 text-xs font-medium text-muted">Sender addresses</p>
      <ul className="divide-y divide-border">
        {a.senders.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{s.email}</span>
            {s.isDefault && <Badge tone="neutral">Default</Badge>}
            {statusBadge(s)}
            {manage && s.status === "pending" && a.canSend && (
              <>
                <button className="text-xs text-accent underline" disabled={!!busy} onClick={() => act(`code-${s.id}`, "send the code", async () => {
                  await api(`${base}/senders/${s.id}/send-code`, { method: "POST" });
                  return `Code sent to ${s.email} through this account.`;
                })}>
                  {s.codeSentAt ? "Send a new code" : "Send verification code"}
                </button>
                {s.codeSentAt && (
                  <form
                    className="flex items-center gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(`confirm-${s.id}`, "verify the sender", async () => {
                        await api(`${base}/senders/${s.id}/confirm`, { method: "POST", body: { code: codes[s.id] ?? "" } });
                        return "Sender verified.";
                      });
                    }}
                  >
                    <input aria-label={`Code for ${s.email}`} className="input w-24 py-1" inputMode="numeric" placeholder="123456" value={codes[s.id] ?? ""} onChange={(e) => setCodes({ ...codes, [s.id]: e.target.value })} />
                    <button className="btn-secondary px-2 py-1 text-xs">Verify</button>
                  </form>
                )}
              </>
            )}
            {manage && s.email !== a.email && (
              <button className="text-xs text-danger" disabled={!!busy} onClick={() => act(`rm-${s.id}`, "remove the sender", async () => {
                await api(`${base}/senders/${s.id}`, { method: "DELETE" });
                return "Sender removed.";
              })}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {a.connectionMethod === "smtp" && manage && (
        <form
          className="flex flex-wrap gap-2 border-t border-border px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act("alias", "add the sender", async () => {
              await api(`${base}/accounts/${a.id}/senders`, { method: "POST", body: { senderEmail: alias } });
              setAlias("");
              return "Sender added. Verify it with a code, or verify its domain.";
            });
          }}
        >
          <input aria-label="Another sender address" className="input flex-1" type="email" placeholder="another-address@yourdomain.com" value={alias} onChange={(e) => setAlias(e.target.value)} required />
          <button className="btn-secondary" disabled={!!busy}>
            Add sender
          </button>
        </form>
      )}
      {a.connectionMethod === "smtp" && a.senders.some((s) => s.status === "pending") && (
        <p className="border-t border-border px-3 py-2 text-xs text-muted">
          An SMTP address sends only once it's proven: enter the code Insights sends to it through this account, or verify the address's domain under Domains.
        </p>
      )}
    </div>
  );
}

const PROVIDER_CHOICES = [
  ["google", "Continue with Google", "Gmail and Google Workspace"],
  ["microsoft", "Continue with Microsoft", "Outlook.com and Microsoft 365"],
  ["smtp", "Connect custom SMTP", "Any other provider (Zoho, Fastmail, your host…)"],
] as const;

function AddAccountModal({ open, onClose, configured, smtpAvailable, onAdded }: { open: boolean; onClose: () => void; configured: AccountsResponse["configured"]; smtpAvailable: boolean; onAdded: () => Promise<boolean> }) {
  const { base } = useEmail();
  const toast = useToast();
  const [choice, setChoice] = useState<"pick" | "smtp">("pick");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function oauth(provider: "google" | "microsoft") {
    setErr(null);
    setBusy(provider);
    try {
      const r = await api<{ url: string }>(`${base}/oauth/${provider}/start`, { method: "POST" });
      window.location.assign(r.url);
    } catch (e) {
      setErr(actionError(e, "start the connection"));
      setBusy(null);
    }
  }

  return (
    <Modal
      open={open}
      title={choice === "smtp" ? "Connect custom SMTP" : "Add an email account"}
      wide={choice === "smtp"}
      onClose={() => {
        setChoice("pick");
        setErr(null);
        onClose();
      }}
    >
      {err && <Alert>{err}</Alert>}
      {choice === "pick" ? (
        <div className="space-y-2">
          {PROVIDER_CHOICES.map(([id, label, sub]) => {
            const available = id === "smtp" ? smtpAvailable : configured[id];
            return (
              <button
                key={id}
                type="button"
                disabled={!available || !!busy}
                className="flex w-full items-center gap-3 rounded-xl border border-border p-3 text-left transition hover:border-accent disabled:opacity-60"
                onClick={() => (id === "smtp" ? setChoice("smtp") : oauth(id))}
              >
                <ProviderMark provider={id === "google" ? "gmail" : id === "microsoft" ? "outlook" : "smtp"} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{busy === id ? "Opening…" : label}</span>
                  <span className="text-xs text-muted">{available ? sub : "Not set up on this server yet"}</span>
                </span>
              </button>
            );
          })}
          <Note>
            Insights asks Google and Microsoft only for permission to send email as you. It can&apos;t read, delete or search your mailbox. You can disconnect at any time.
          </Note>
        </div>
      ) : (
        <SmtpForm
          onCancel={() => setChoice("pick")}
          onDone={async (msg, ok) => {
            toast(ok ? "success" : "error", msg);
            await onAdded();
            setChoice("pick");
            onClose();
          }}
        />
      )}
    </Modal>
  );
}

const SMTP_HELP: Array<[string, string]> = [
  ["Gmail / Google Workspace", "Use “Continue with Google” instead: Google is phasing out password sign-in for SMTP."],
  ["Microsoft 365", "Use “Continue with Microsoft” instead: Microsoft turns off SMTP password sign-in (basic authentication) for most tenants."],
  ["Zoho Mail", "smtp.zoho.com, port 465 (TLS) or 587 (STARTTLS), with an app-specific password."],
  ["Fastmail", "smtp.fastmail.com, port 465 (TLS), with an app password."],
];

function SmtpForm({ onCancel, onDone, existing }: { onCancel: () => void; onDone: (msg: string, ok: boolean) => Promise<void>; existing?: AccountView }) {
  const { base } = useEmail();
  const [f, setF] = useState({
    emailAddress: existing?.email ?? "",
    displayName: existing?.displayName ?? "",
    host: existing?.smtp?.host ?? "",
    port: existing?.smtp?.port ?? 587,
    encryption: (existing?.smtp?.encryption ?? "starttls") as "tls" | "starttls",
    username: existing?.smtp?.username ?? "",
    password: "",
    replyTo: existing?.replyTo ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const body = { ...f, replyTo: f.replyTo || null, ...(existing && !f.password ? { password: undefined } : {}) };
      const r = existing
        ? await api<{ test: { ok: boolean; code?: string; message?: string } }>(`${base}/smtp/connections/${existing.id}`, { method: "PATCH", body: { ...body, emailAddress: undefined } })
        : await api<{ test: { ok: boolean; code?: string; message?: string } }>(`${base}/smtp/connections`, { method: "POST", body });
      await onDone(r.test.ok ? "Connected: Insights signed in to the SMTP server. Verify the sender address to start sending." : `Saved, but the connection test failed: ${errorLabel(r.test.code) ?? r.test.message}`, r.test.ok);
    } catch (e2) {
      setErr(actionError(e2, "save the SMTP connection"));
    } finally {
      setBusy(false);
    }
  }

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  return (
    <form className="space-y-3" onSubmit={submit}>
      {err && <Alert>{err}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Email address" required htmlFor="smtp-email">
          <input id="smtp-email" className="input" type="email" required disabled={!!existing} value={f.emailAddress} onChange={(e) => set("emailAddress", e.target.value)} />
        </Field>
        <Field label="Display name" htmlFor="smtp-name" hint="What recipients see as the sender's name.">
          <input id="smtp-name" className="input" maxLength={100} value={f.displayName} onChange={(e) => set("displayName", e.target.value)} />
        </Field>
        <Field label="SMTP server" required htmlFor="smtp-host">
          <input id="smtp-host" className="input" required placeholder="smtp.yourprovider.com" value={f.host} onChange={(e) => set("host", e.target.value.trim())} />
        </Field>
        <Field label="Port and security" required htmlFor="smtp-port" hint="Encrypted connections only. Port 25 isn't available.">
          <select
            id="smtp-port"
            className="input"
            value={f.port}
            onChange={(e) => {
              const port = Number(e.target.value);
              setF((x) => ({ ...x, port, encryption: SMTP_PORTS[port]! }));
            }}
          >
            <option value={587}>587 — STARTTLS (recommended)</option>
            <option value={465}>465 — TLS</option>
            <option value={2525}>2525 — STARTTLS</option>
          </select>
        </Field>
        <Field label="Username" required htmlFor="smtp-user">
          <input id="smtp-user" className="input" autoComplete="off" required value={f.username} onChange={(e) => set("username", e.target.value)} />
        </Field>
        <Field label={existing ? "New password (leave empty to keep)" : "Password or app password"} required={!existing} htmlFor="smtp-pass" hint="Stored encrypted and never shown again.">
          <input id="smtp-pass" className="input" type="password" autoComplete="new-password" required={!existing} value={f.password} onChange={(e) => set("password", e.target.value)} />
        </Field>
        <Field label="Reply-to address" htmlFor="smtp-reply" hint="Optional: where replies go, if not to the sender.">
          <input id="smtp-reply" className="input" type="email" value={f.replyTo} onChange={(e) => set("replyTo", e.target.value)} />
        </Field>
      </div>
      <details className="text-xs text-muted">
        <summary className="cursor-pointer">Settings for common providers</summary>
        <ul className="mt-2 space-y-1">
          {SMTP_HELP.map(([p, t]) => (
            <li key={p}>
              <b className="text-text">{p}:</b> {t}
            </li>
          ))}
        </ul>
      </details>
      <Note>{DELIVERY_REPORTING.smtp}</Note>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          {existing ? "Cancel" : "Back"}
        </button>
        <button className="btn-primary" disabled={busy}>
          {busy ? "Connecting and testing…" : existing ? "Save and test" : "Connect and test"}
        </button>
      </div>
    </form>
  );
}

function EditAccountModal({ open, account, onClose, onSaved }: { open: boolean; account: AccountView; onClose: () => void; onSaved: () => Promise<boolean> }) {
  const { base } = useEmail();
  const toast = useToast();
  const [displayName, setDisplayName] = useState(account.displayName ?? "");
  const [replyTo, setReplyTo] = useState(account.replyTo ?? "");
  const [limit, setLimit] = useState(String(account.dailyLimit));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const max = PROVIDER_LIMITS[account.provider as EmailProvider]?.perDay ?? account.providerDailyLimit;
  if (account.smtp) {
    return (
      <Modal open={open} title={`SMTP settings for ${account.email}`} wide onClose={onClose}>
        <SmtpForm
          existing={account}
          onCancel={onClose}
          onDone={async (msg, ok) => {
            toast(ok ? "success" : "error", msg);
            await onSaved();
            onClose();
          }}
        />
      </Modal>
    );
  }
  return (
    <Modal open={open} title={`Edit ${account.email}`} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await api(`${base}/accounts/${account.id}`, { method: "PATCH", body: { displayName, replyTo: replyTo || null, dailyLimit: Number(limit) || null } });
            toast("success", "Saved.");
            await onSaved();
            onClose();
          } catch (e2) {
            setErr(actionError(e2, "save the account"));
          } finally {
            setBusy(false);
          }
        }}
      >
        {err && <Alert>{err}</Alert>}
        <Field label="Display name" htmlFor="acc-name">
          <input id="acc-name" className="input" maxLength={100} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="Reply-to address" htmlFor="acc-reply">
          <input id="acc-reply" className="input" type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} />
        </Field>
        <Field label="Daily sending limit" htmlFor="acc-limit" hint={PROVIDER_LIMITS[account.provider as EmailProvider]?.note}>
          <input id="acc-limit" className="input" type="number" min={1} max={max} value={limit} onChange={(e) => setLimit(e.target.value)} />
        </Field>
        <Note>{DELIVERY_REPORTING[account.provider as EmailProvider]}</Note>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
