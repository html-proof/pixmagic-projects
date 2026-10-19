"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { accountPasswordProblem, ACCOUNT_PASSWORD_MIN, isEmailAddress } from "@app/shared/auth";
import { LoadError } from "@/components/LoadError";
import { Alert } from "@/components/ui";
import { ConfirmDialog, Skeleton } from "@/components/AppUi";
import { CodeStep } from "@/components/auth/CodeStep";
import { PasswordField } from "@/components/auth/PasswordField";
import { useApi } from "@/lib/api";
import {
  addPassword,
  authErrorMessage,
  changePassword,
  confirmEmailChange,
  confirmMfaSetup,
  deleteAccount,
  errorCode,
  leaveTo,
  linkErrorMessage,
  linkGoogle,
  linkNeedsPassword,
  prepareGoogleLink,
  removeSignInMethod,
  signOut,
  signOutEverywhere,
  startEmailChange,
  startMfaSetup,
  turnOffMfa,
  type AccountInfo,
} from "@/lib/auth";

const METHOD_NAMES = { password: "Email and password", google: "Google" } as const;
const when = (t: string | number | null) => (t ? new Date(t).toLocaleString() : "never");

type Msg = { kind: "error" | "success" | "info"; text: string } | null;
/** A refusal that asks the person to sign in again is advice, not a failure. */
const failure = (err: unknown): Msg => ({ kind: errorCode(err) === "reauth_required" ? "info" : "error", text: authErrorMessage(err) });

/**
 * Account security, for merchants (Settings → Security) and employees (the portal's Account page):
 * email and its verification, password, how the account signs in (linking Google, removing a
 * method), two-step verification, signing out here or everywhere, and deleting the account. Every
 * change goes through the API to Cognito.
 */
export function AccountSecurity() {
  const router = useRouter();
  const q = useApi<AccountInfo>("/auth/account");
  const a = q.data;
  const reload = () => void q.reload();

  if (q.error && !a) return <LoadError what="your account" error={q.error} onRetry={reload} busy={q.loading} />;
  if (!a) return <Skeleton lines={5} />;
  const provider = a.signedInWith === "google" ? "Google" : null;

  return (
    <div className="space-y-4">
      <EmailSection account={a} provider={provider} onChanged={reload} />
      <PasswordSection account={a} provider={provider} onChanged={reload} router={router} />
      <MethodsSection account={a} onChanged={reload} />
      <TwoStepSection account={a} onChanged={reload} />
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
      setMsg(failure(err));
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

function PasswordSection({ account: a, provider, onChanged, router }: { account: AccountInfo; provider: string | null; onChanged: () => void; router: ReturnType<typeof useRouter> }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  function check() {
    const weak = accountPasswordProblem(next);
    if (weak) return weak;
    if (next !== confirm) return a.hasPassword ? "The two new passwords don't match." : "The two passwords don't match.";
    return null;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = check();
    if (problem) return setMsg({ kind: "error", text: problem });
    setBusy(true);
    setMsg(null);
    try {
      if (a.canChangePassword) {
        const r = await changePassword({ currentPassword: current, password: next, confirmPassword: confirm });
        // Two-step verification is on: the new password signs in with a code, this browser included.
        if (!r.signedIn) return router.replace("/login?reset=1");
        setMsg({ kind: "success", text: "Password changed. You've been signed out on your other devices." });
      } else {
        await addPassword({ password: next, confirmPassword: confirm });
        setMsg({ kind: "success", text: `Password added. You can now sign in with ${a.user.email} and this password, or with Google.` });
        onChanged();
      }
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setMsg(failure(err));
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
      ) : a.hasPassword ? (
        <p className="mt-1 text-sm text-muted">
          You signed in with {provider ?? "another provider"}. To change your password, sign in with {a.user.email} and your password, or use{" "}
          <Link prefetch={false} href="/forgot-password" className="underline">
            Forgot Password?
          </Link>{" "}
          on the sign-in page.
        </p>
      ) : (
        <form onSubmit={submit} className="mt-3 grid gap-3 sm:max-w-md">
          <p className="text-sm text-muted">
            You sign in with {provider ?? "another provider"} only. Add a password to also sign in with {a.user.email}. For your safety this needs a sign-in in the last 15 minutes.
          </p>
          <PasswordField id="add-password" label="Password" autoComplete="new-password" minLength={ACCOUNT_PASSWORD_MIN} value={next} onChange={setNext} hint={`At least ${ACCOUNT_PASSWORD_MIN} characters.`} />
          <PasswordField id="confirm-add-password" label="Confirm password" autoComplete="new-password" value={confirm} onChange={setConfirm} />
          <button className="btn-secondary justify-self-start" disabled={busy || !next || !confirm}>
            {busy ? "Adding…" : "Add a password"}
          </button>
        </form>
      )}
    </section>
  );
}

/** What the page that linking Google came back to says (?linked=google, ?link_error=<code>), once. */
function useLinkResult(): [Msg, (m: Msg) => void] {
  const [msg, setMsg] = useState<Msg>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const linked = q.get("linked");
    const linkError = q.get("link_error");
    if (!linked && !linkError) return;
    setMsg(linked === "google" ? { kind: "success", text: "Google is linked. You can now sign in with it too." } : { kind: linkError === "cancelled" ? "info" : "error", text: linkErrorMessage(linkError ?? "") });
    q.delete("linked");
    q.delete("link_error");
    const rest = q.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
  }, []);
  return [msg, setMsg];
}

function MethodsSection({ account: a, onChanged }: { account: AccountInfo; onChanged: () => void }) {
  const [msg, setMsg] = useLinkResult();
  const [removing, setRemoving] = useState<AccountInfo["methods"][number] | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // Linking after the first 15 minutes of a sign-in: the password first (the API asks for it too).
  const [confirmingLink, setConfirmingLink] = useState(false);
  const [linkPassword, setLinkPassword] = useState("");
  const cancel = useCallback(() => {
    setRemoving(null);
    setPassword("");
  }, []);
  const cancelLink = useCallback(() => {
    setConfirmingLink(false);
    setLinkPassword("");
  }, []);
  const needsPassword = a.signedInWith === "password";

  function startLink() {
    if (linkNeedsPassword(a)) return setConfirmingLink(true);
    setLeaving(true);
    linkGoogle(window.location.pathname);
  }

  async function linkWithPassword() {
    if (!linkPassword) return;
    setBusy(true);
    setMsg(null);
    try {
      await prepareGoogleLink(linkPassword);
      setLeaving(true);
      linkGoogle(window.location.pathname);
    } catch (err) {
      setMsg(failure(err));
      setBusy(false);
    } finally {
      cancelLink();
    }
  }

  async function remove() {
    if (!removing || (needsPassword && !password)) return;
    setBusy(true);
    setMsg(null);
    try {
      await removeSignInMethod(removing.id, needsPassword ? password : undefined);
      setMsg({ kind: "success", text: `${METHOD_NAMES[removing.method]} is no longer a way to sign in to your account.` });
      onChanged();
    } catch (err) {
      setMsg(failure(err));
    } finally {
      setBusy(false);
      cancel();
    }
  }

  return (
    <section className="card" aria-labelledby="methods-h">
      <h2 id="methods-h" className="font-semibold">
        How you sign in
      </h2>
      {msg && (
        <div className="mt-3">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
      <ul className="mt-3 space-y-2 text-sm">
        {a.methods.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-bg/50 px-3 py-2">
            <div className="min-w-0">
              <span className="font-medium">{METHOD_NAMES[m.method]}</span>
              {m.email && <span className="break-all text-muted"> · {m.email}</span>}
              <span className="block text-xs text-muted">
                Added {when(m.linkedAt)} · last used {when(m.lastUsedAt)}
                {m.method === a.signedInWith && " · signed in with this now"}
              </span>
            </div>
            {/* Never the last way in, nor the one this session used (the API refuses both too). */}
            {a.methods.length > 1 && m.method !== a.signedInWith && (
              <button type="button" className="btn-secondary min-h-11" onClick={() => setRemoving(m)}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {a.canLinkGoogle && (
        <button type="button" className="btn-secondary mt-3 min-h-11" disabled={leaving} onClick={startLink}>
          {leaving ? "Opening Google…" : "Link Google account"}
        </button>
      )}
      <p className="mt-3 text-xs text-muted">
        {a.canLinkGoogle ? "Link a Google account to sign in with it too, whatever its email address. We email you whenever a way to sign in is added. " : ""}
        Removing a way to sign in signs it out everywhere within a minute.
      </p>
      <ConfirmDialog
        open={confirmingLink}
        title="Confirm it's you"
        confirmLabel={busy ? "Checking…" : "Continue to Google"}
        busy={busy || !linkPassword}
        onCancel={cancelLink}
        onConfirm={() => void linkWithPassword()}
      >
        <div className="space-y-3">
          <p>A linked Google account can sign in to your account, so enter your password first.</p>
          <PasswordField id="link-password" label="Your password" autoComplete="current-password" value={linkPassword} onChange={setLinkPassword} />
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing ? METHOD_NAMES[removing.method] : ""}?`}
        confirmLabel={busy ? "Removing…" : "Remove"}
        danger
        busy={busy || (needsPassword && !password)}
        onCancel={cancel}
        onConfirm={() => void remove()}
      >
        <div className="space-y-3">
          <p>
            {removing?.method === "google"
              ? "That Google account won't be able to sign in to your account any more, unless you link it again here."
              : "You won't be able to sign in with it any more. You can add it again later."}
          </p>
          {needsPassword ? (
            <PasswordField id="remove-password" label="Your password" autoComplete="current-password" value={password} onChange={setPassword} />
          ) : (
            <p className="text-sm text-muted">For your safety this needs a sign-in in the last 15 minutes.</p>
          )}
        </div>
      </ConfirmDialog>
    </section>
  );
}

/** The app's secret in groups of four, easier to type into an authenticator app. */
const grouped = (secret: string) => secret.replace(/(.{4})/g, "$1 ").trim();

function TwoStepSection({ account: a, onChanged }: { account: AccountInfo; onChanged: () => void }) {
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [turningOff, setTurningOff] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function begin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      setSetup(await startMfaSetup(password));
      setPassword("");
    } catch (err) {
      setMsg(failure(err));
    } finally {
      setBusy(false);
    }
  }

  async function off(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await turnOffMfa(password, code);
      setTurningOff(false);
      setPassword("");
      setCode("");
      setMsg({ kind: "success", text: "Two-step verification is off. Signing in needs only your password now." });
      onChanged();
    } catch (err) {
      setMsg(failure(err));
    } finally {
      setBusy(false);
    }
  }

  let body: ReactNode;
  if (!a.hasPassword) {
    body = (
      <p className="mt-1 text-sm text-muted">
        You sign in with Google, which has its own two-step verification: turn on{" "}
        <a href="https://myaccount.google.com/signinoptions/two-step-verification" target="_blank" rel="noopener noreferrer" className="underline">
          2-Step Verification in your Google account
        </a>
        . If you add a password, you can protect it here too.
      </p>
    );
  } else if (a.signedInWith !== "password") {
    body = <p className="mt-1 text-sm text-muted">Two-step verification protects your password. Sign in with your email and password to set it up or change it.</p>;
  } else if (a.mfaEnabled === null) {
    body = (
      <p className="mt-1 text-sm text-muted">
        We couldn&apos;t check it just now.{" "}
        <button type="button" className="underline" onClick={onChanged}>
          Try again
        </button>
      </p>
    );
  } else if (a.mfaEnabled) {
    body = turningOff ? (
      <form onSubmit={off} className="mt-3 grid gap-3 sm:max-w-md">
        <PasswordField id="mfa-off-password" label="Your password" autoComplete="current-password" value={password} onChange={setPassword} />
        <div>
          <label className="label" htmlFor="mfa-off-code">
            Code from your authenticator app
          </label>
          <input id="mfa-off-code" className="input tracking-[0.5em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
        </div>
        <div className="flex flex-wrap gap-3">
          <button className="btn-danger min-h-11" disabled={busy || !password || code.length !== 6}>
            {busy ? "Turning off…" : "Turn off two-step verification"}
          </button>
          <button type="button" className="btn-secondary min-h-11" onClick={() => setTurningOff(false)}>
            Cancel
          </button>
        </div>
      </form>
    ) : (
      <>
        <p className="mt-1 text-sm">
          <span className="text-good">On.</span> <span className="text-muted">Every sign-in with your password also asks for a code from your authenticator app.</span>
        </p>
        <button type="button" className="btn-secondary mt-3 min-h-11" onClick={() => setTurningOff(true)}>
          Turn off
        </button>
      </>
    );
  } else if (setup) {
    body = (
      <div className="mt-3 space-y-3 sm:max-w-md">
        <p className="text-sm">
          In your authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, …), add an account with this key, or{" "}
          <a href={setup.otpauthUri} className="underline">
            open it in the app
          </a>{" "}
          on this phone. It is shown only now.
        </p>
        <p className="rounded-lg border border-border bg-bg/50 px-3 py-2 font-mono text-sm break-all select-all" aria-label="Your authenticator key">
          {grouped(setup.secret)}
        </p>
        <CodeStep
          email={a.user.email}
          intro={<>Then enter the 6-digit code the app shows for bizinsights.</>}
          submitLabel="Turn on two-step verification"
          onSubmit={async (c) => {
            await confirmMfaSetup(c);
            setSetup(null);
            setMsg({ kind: "success", text: "Two-step verification is on. Keep your phone safe: you'll need it to sign in." });
            onChanged();
          }}
        />
        <button type="button" className="text-sm text-muted underline" onClick={() => setSetup(null)}>
          Cancel
        </button>
      </div>
    );
  } else {
    body = (
      <form onSubmit={begin} className="mt-3 grid gap-3 sm:max-w-md">
        <p className="text-sm text-muted">Off. Turn it on and every sign-in with your password also asks for a code from an authenticator app on your phone.</p>
        <PasswordField id="mfa-password" label="Current password" autoComplete="current-password" value={password} onChange={setPassword} />
        <button className="btn-secondary justify-self-start" disabled={busy || !password}>
          {busy ? "Starting…" : "Set up two-step verification"}
        </button>
      </form>
    );
  }

  return (
    <section className="card" aria-labelledby="mfa-h">
      <h2 id="mfa-h" className="font-semibold">
        Two-step verification
      </h2>
      {msg && (
        <div className="mt-3">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
      {body}
      {a.hasPassword && a.signedInWith === "password" && a.mfaEnabled !== null && (
        <p className="mt-3 text-xs text-muted">
          Lost your phone?{" "}
          <Link prefetch={false} href="/support" className="underline">
            Contact support
          </Link>{" "}
          and we&apos;ll help you back in.
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
      setMsg(failure(err));
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
