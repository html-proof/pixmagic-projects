"use client";
import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { Dialog } from "@/components/AppUi";
import { Alert } from "@/components/ui";
import { CodeStep } from "@/components/auth/CodeStep";
import { PasswordField } from "@/components/auth/PasswordField";
import { confirmMfaSetup, startMfaSetup, turnOffMfa, type AccountInfo } from "@/lib/auth";
import { failure, Pill, SummaryCard, type Msg } from "./ui";

/** The app's secret in groups of four, easier to type into an authenticator app. */
const grouped = (secret: string) => secret.replace(/(.{4})/g, "$1 ").trim();

/** Two-step verification (an authenticator app's code after the password): on, off, or Google's own. */
export function TwoStepCard({
  account: a,
  open,
  onOpen,
  onClose,
  onChanged,
  onRetry,
}: {
  account: AccountInfo;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChanged: (notice: string) => void;
  onRetry: () => void;
}) {
  const settable = a.hasPassword && a.signedInWith === "password" && a.mfaEnabled === false;
  return (
    <SummaryCard
      id="mfa-h"
      t="good"
      icon={ShieldCheck}
      title="Two-step verification"
      action={
        <button type="button" className="btn-secondary min-h-10 shrink-0 px-4 whitespace-nowrap" onClick={onOpen}>
          {settable ? "Set up" : "Manage"}
        </button>
      }
    >
      <p>
        {!a.hasPassword ? (
          <Pill t="info">With Google</Pill>
        ) : a.mfaEnabled === null ? (
          <Pill t="warn">Couldn&apos;t check</Pill>
        ) : a.mfaEnabled ? (
          <Pill t="good">Enabled</Pill>
        ) : (
          <Pill t="warn">Off</Pill>
        )}
      </p>
      <p className="text-muted">{!a.hasPassword ? "Google's 2-Step Verification protects your sign-in." : "Adds an extra layer of security to your account."}</p>
      <TwoStepDialog open={open} account={a} onClose={onClose} onChanged={onChanged} onRetry={onRetry} />
    </SummaryCard>
  );
}

function TwoStepDialog({ open, account: a, onClose, onChanged, onRetry }: { open: boolean; account: AccountInfo; onClose: () => void; onChanged: (notice: string) => void; onRetry: () => void }) {
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [turningOff, setTurningOff] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  function close() {
    setPassword("");
    setSetup(null);
    setTurningOff(false);
    setCode("");
    setMsg(null);
    onClose();
  }

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
      close();
      onChanged("Two-step verification is off. Signing in needs only your password now.");
    } catch (err) {
      setMsg(failure(err));
    } finally {
      setBusy(false);
    }
  }

  let body: ReactNode;
  if (!a.hasPassword) {
    body = (
      <p className="text-muted">
        You sign in with Google, which has its own two-step verification: turn on{" "}
        <a href="https://myaccount.google.com/signinoptions/two-step-verification" target="_blank" rel="noopener noreferrer" className="underline">
          2-Step Verification in your Google account
        </a>
        . If you add a password, you can protect it here too.
      </p>
    );
  } else if (a.signedInWith !== "password") {
    body = <p className="text-muted">Two-step verification protects your password. Sign in with your email and password to set it up or change it.</p>;
  } else if (a.mfaEnabled === null) {
    body = (
      <p className="text-muted">
        We couldn&apos;t check it just now.{" "}
        <button type="button" className="underline" onClick={onRetry}>
          Try again
        </button>
      </p>
    );
  } else if (a.mfaEnabled) {
    body = turningOff ? (
      <form onSubmit={off} className="grid gap-3">
        <PasswordField id="mfa-off-password" label="Your password" autoComplete="current-password" value={password} onChange={setPassword} />
        <div>
          <label className="label" htmlFor="mfa-off-code">
            Code from your authenticator app
          </label>
          <input id="mfa-off-code" className="input tracking-[0.5em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
        </div>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" className="btn-secondary" onClick={() => setTurningOff(false)}>
            Cancel
          </button>
          <button className="btn-danger" disabled={busy || !password || code.length !== 6}>
            {busy ? "Turning off…" : "Turn off two-step verification"}
          </button>
        </div>
      </form>
    ) : (
      <div className="space-y-3">
        <p>
          <span className="font-medium text-good">On.</span> <span className="text-muted">Every sign-in with your password also asks for a code from your authenticator app.</span>
        </p>
        <div className="flex justify-end">
          <button type="button" className="btn-secondary" onClick={() => setTurningOff(true)}>
            Turn off
          </button>
        </div>
      </div>
    );
  } else if (setup) {
    body = (
      <div className="space-y-3">
        <p>
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
            close();
            onChanged("Two-step verification is on. Keep your phone safe: you'll need it to sign in.");
          }}
        />
        <button type="button" className="text-sm text-muted underline" onClick={() => setSetup(null)}>
          Cancel
        </button>
      </div>
    );
  } else {
    body = (
      <form onSubmit={begin} className="grid gap-3">
        <p className="text-muted">Off. Turn it on and every sign-in with your password also asks for a code from an authenticator app on your phone.</p>
        <PasswordField id="mfa-password" label="Current password" autoComplete="current-password" value={password} onChange={setPassword} />
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" className="btn-secondary" onClick={close}>
            Cancel
          </button>
          <button className="btn-primary" disabled={busy || !password}>
            {busy ? "Starting…" : "Set up two-step verification"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <Dialog open={open} title="Two-step verification" onClose={close}>
      <div className="space-y-3 text-sm">
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        {body}
        {a.hasPassword && a.signedInWith === "password" && a.mfaEnabled !== null && (
          <p className="text-xs text-muted">
            Lost your phone?{" "}
            <Link prefetch={false} href="/support" className="underline">
              Contact support
            </Link>{" "}
            and we&apos;ll help you back in.
          </p>
        )}
      </div>
    </Dialog>
  );
}
