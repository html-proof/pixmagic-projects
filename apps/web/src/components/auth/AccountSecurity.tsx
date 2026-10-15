"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, type FormEvent } from "react";
import { accountPasswordProblem, ACCOUNT_PASSWORD_MIN, isEmailAddress } from "@app/shared/auth";
import { LoadError } from "@/components/LoadError";
import { Alert } from "@/components/ui";
import { ConfirmDialog, Skeleton } from "@/components/whatsapp/common";
import { CodeStep } from "@/components/auth/CodeStep";
import { PasswordField } from "@/components/auth/PasswordField";
import { useApi } from "@/lib/api";
import {
  authErrorMessage,
  changePassword,
  confirmEmailChange,
  deleteAccount,
  errorCode,
  leaveTo,
  signOut,
  signOutEverywhere,
  startEmailChange,
  type AccountInfo,
} from "@/lib/auth";

const METHOD_NAMES = { password: "Email and password", google: "Google" } as const;
const when = (t: string | number | null) => (t ? new Date(t).toLocaleString() : "never");

type Msg = { kind: "error" | "success" | "info"; text: string } | null;

/**
 * Account security, for merchants (Settings → Security) and employees (the portal's Account page):
 * email and its verification, password, how the account signs in, signing out here or everywhere,
 * and deleting the account. Every change goes through the API to Cognito.
 */
export function AccountSecurity() {
  const router = useRouter();
  const q = useApi<AccountInfo>("/auth/account");
  const a = q.data;

  if (q.error && !a) return <LoadError what="your account" error={q.error} onRetry={() => void q.reload()} busy={q.loading} />;
  if (!a) return <Skeleton lines={5} />;
  const provider = a.signedInWith === "google" ? "Google" : null;

  return (
    <div className="space-y-4">
      <EmailSection account={a} provider={provider} onChanged={() => void q.reload()} />
      <PasswordSection account={a} provider={provider} />
      <section className="card" aria-labelledby="methods-h">
        <h2 id="methods-h" className="font-semibold">
          How you sign in
        </h2>
        <ul className="mt-3 space-y-2 text-sm">
          {a.methods.map((m, i) => (
            <li key={i} className="rounded-lg border border-border bg-bg/50 px-3 py-2">
              <span className="font-medium">{METHOD_NAMES[m.method]}</span>
              {m.email && <span className="text-muted"> · {m.email}</span>}
              <span className="block text-xs text-muted">
                Added {when(m.linkedAt)} · last used {when(m.lastUsedAt)}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">
          Signing in with Google using this email address adds it here. Two-step verification isn&apos;t available yet: use a strong password you don&apos;t use anywhere else.
        </p>
      </section>
      <SessionSection account={a} router={router} />
      <DeleteSection account={a} router={router} />
    </div>
  );
}

function EmailSection({ account: a, provider, onChanged }: { account: AccountInfo; provider: string | null; onChanged: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function start(e: FormEvent) {
    e.preventDefault();
    if (!isEmailAddress(email)) return setMsg({ kind: "error", text: "Enter a valid email address." });
    setBusy(true);
    setMsg(null);
    try {
      const r = await startEmailChange(email.trim(), password);
      setPending(r.pendingEmail);
      setPassword("");
    } catch (err) {
      setMsg({ kind: "error", text: authErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="email-h">
      <h2 id="email-h" className="font-semibold">
        Email address
      </h2>
      <p className="mt-1 text-sm">
        {a.user.email}{" "}
        {a.user.emailVerified ? (
          <span className="text-good">· verified</span>
        ) : (
          <>
            <span className="text-danger">· not verified</span>{" "}
            <Link href="/verify-email" className="underline">
              Verify it now
            </Link>
          </>
        )}
      </p>
      {msg && (
        <div className="mt-3">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
      {!a.canChangeEmail ? (
        <p className="mt-2 text-xs text-muted">You signed in with {provider ?? "another provider"}, which manages this address. Change it there, or sign in with your email and password to change it here.</p>
      ) : pending ? (
        <div className="mt-3">
          <CodeStep
            email={pending}
            intro={
              <>
                We emailed a 6-digit code to <strong>{pending}</strong>. Your address changes once you enter it.
              </>
            }
            submitLabel="Confirm new address"
            onSubmit={async (code) => {
              await confirmEmailChange(code);
              setPending(null);
              setEmail("");
              setMsg({ kind: "success", text: "Your email address has been changed." });
              onChanged();
            }}
          />
          <button type="button" className="mt-2 text-sm text-muted underline" onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      ) : (
        <form onSubmit={start} className="mt-3 grid gap-3 sm:max-w-md">
          <div>
            <label className="label" htmlFor="new-email">
              New email address
            </label>
            <input id="new-email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <PasswordField id="email-password" label="Current password" autoComplete="current-password" value={password} onChange={setPassword} />
          <button className="btn-secondary justify-self-start" disabled={busy || !email || !password}>
            {busy ? "Sending code…" : "Change email"}
          </button>
        </form>
      )}
    </section>
  );
}

function PasswordSection({ account: a, provider }: { account: AccountInfo; provider: string | null }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const weak = accountPasswordProblem(next);
    if (weak) return setMsg({ kind: "error", text: weak });
    if (next !== confirm) return setMsg({ kind: "error", text: "The two new passwords don't match." });
    setBusy(true);
    setMsg(null);
    try {
      await changePassword({ currentPassword: current, password: next, confirmPassword: confirm });
      setCurrent("");
      setNext("");
      setConfirm("");
      setMsg({ kind: "success", text: "Password changed. You've been signed out on your other devices." });
    } catch (err) {
      setMsg({ kind: "error", text: authErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="password-h">
      <h2 id="password-h" className="font-semibold">
        Password
      </h2>
      {msg && (
        <div className="mt-3">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
      {a.canChangePassword ? (
        <form onSubmit={submit} className="mt-3 grid gap-3 sm:max-w-md">
          <PasswordField id="current-password" label="Current password" autoComplete="current-password" value={current} onChange={setCurrent} />
          <PasswordField id="new-password" label="New password" autoComplete="new-password" minLength={ACCOUNT_PASSWORD_MIN} value={next} onChange={setNext} hint={`At least ${ACCOUNT_PASSWORD_MIN} characters. Changing it signs you out everywhere else.`} />
          <PasswordField id="confirm-new-password" label="Confirm new password" autoComplete="new-password" value={confirm} onChange={setConfirm} />
          <button className="btn-secondary justify-self-start" disabled={busy || !current || !next || !confirm}>
            {busy ? "Changing…" : "Change password"}
          </button>
        </form>
      ) : (
        <p className="mt-1 text-sm text-muted">
          You signed in with {provider ?? "another provider"}, so there&apos;s no password to change here. To add one, sign out and use{" "}
          <Link href="/forgot-password" className="underline">
            Forgot Password?
          </Link>{" "}
          with {a.user.email}.
        </p>
      )}
    </section>
  );
}

function SessionSection({ account: a, router }: { account: AccountInfo; router: ReturnType<typeof useRouter> }) {
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const cancel = useCallback(() => setConfirmAll(false), []);

  async function everywhere() {
    setBusy(true);
    try {
      leaveTo(await signOutEverywhere(), router);
    } catch (err) {
      setMsg({ kind: "error", text: authErrorMessage(err) });
      setBusy(false);
      setConfirmAll(false);
    }
  }

  return (
    <section className="card" aria-labelledby="sessions-h">
      <h2 id="sessions-h" className="font-semibold">
        Signing out
      </h2>
      <p className="mt-1 text-sm text-muted">
        This session started {when(a.signedInAt)} and lasts until {when(a.sessionExpiresAt)}. Signed in on a shared or lost device? Sign out of all devices to end every session, including this one.
      </p>
      {msg && (
        <div className="mt-3">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" className="btn-secondary min-h-11" onClick={async () => leaveTo(await signOut(), router)}>
          Sign out
        </button>
        <button type="button" className="btn-danger min-h-11" onClick={() => setConfirmAll(true)}>
          Sign out of all devices
        </button>
      </div>
      <ConfirmDialog open={confirmAll} title="Sign out of all devices?" confirmLabel="Sign out everywhere" danger busy={busy} onCancel={cancel} onConfirm={() => void everywhere()}>
        <p>Every browser and phone signed in to your account will be signed out, including this one.</p>
      </ConfirmDialog>
    </section>
  );
}

function DeleteSection({ account: a, router }: { account: AccountInfo; router: ReturnType<typeof useRouter> }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const cancel = useCallback(() => {
    setOpen(false);
    setTyped("");
    setPassword("");
  }, []);
  const needsPassword = a.signedInWith === "password";

  async function remove() {
    if (typed !== "DELETE" || (needsPassword && !password)) return;
    setBusy(true);
    setMsg(null);
    try {
      await deleteAccount(needsPassword ? password : undefined);
      router.replace("/login?deleted=1");
    } catch (err) {
      setMsg({ kind: errorCode(err) === "reauth_required" ? "info" : "error", text: authErrorMessage(err) });
      setOpen(false);
      setBusy(false);
    }
  }

  return (
    <section className="card border-danger/40" aria-labelledby="delete-h">
      <h2 id="delete-h" className="font-semibold text-danger">
        Delete account
      </h2>
      <p className="mt-1 text-sm text-muted">
        Deletes your sign-in and your personal account. Workspaces you own with no other owner must be deleted or handed over first; workspaces others own keep running without you.
      </p>
      {msg && (
        <div className="mt-3">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
      <button type="button" className="btn-danger mt-3 min-h-11" onClick={() => setOpen(true)}>
        Delete my account
      </button>
      <ConfirmDialog open={open} title="Delete your account?" confirmLabel={busy ? "Deleting…" : "Delete account"} danger busy={busy || typed !== "DELETE" || (needsPassword && !password)} onCancel={cancel} onConfirm={() => void remove()}>
        <div className="space-y-3">
          <p>This can&apos;t be undone.</p>
          <div>
            <label className="label" htmlFor="type-delete">
              Type DELETE to confirm
            </label>
            <input id="type-delete" className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
          {needsPassword ? (
            <PasswordField id="delete-password" label="Your password" autoComplete="current-password" value={password} onChange={setPassword} />
          ) : (
            <p className="text-sm text-muted">For your safety this needs a sign-in in the last 15 minutes.</p>
          )}
        </div>
      </ConfirmDialog>
    </section>
  );
}
