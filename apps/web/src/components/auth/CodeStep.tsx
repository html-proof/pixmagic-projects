"use client";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { KeyRound } from "lucide-react";
import { Alert } from "@/components/ui";
import { authErrorMessage } from "@/lib/auth";
import { AuthField, AuthSubmit } from "./AuthCard";

/** Seconds before "Send a new code" works again (Cognito also limits how often codes go out). */
const RESEND_WAIT_S = 30;

/**
 * "Enter the 6-digit code we emailed you": sign-up confirmation, email verification, an email
 * change, a sign-in code. The caller says what a code does (`onSubmit`) and how to get another.
 * `large`: the split sign-in pages' field and button (AuthSplitShell). `card`: AuthCard's field and
 * button (the raised-card pages).
 */
export function CodeStep({
  email,
  intro,
  submitLabel,
  busyLabel = "Checking…",
  onSubmit,
  onResend,
  children,
  extraValid = true,
  large = false,
  card = false,
}: {
  email: string;
  intro?: ReactNode;
  submitLabel: string;
  busyLabel?: string;
  onSubmit: (code: string) => Promise<void>;
  onResend?: () => Promise<unknown>;
  /** More fields that go with the code (the new password, on a reset). */
  children?: ReactNode;
  extraValid?: boolean;
  large?: boolean;
  card?: boolean;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [wait, setWait] = useState(RESEND_WAIT_S);

  useEffect(() => {
    if (wait <= 0) return;
    const t = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(t);
  }, [wait]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await onSubmit(code);
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (!onResend) return;
    setError(null);
    setInfo(null);
    try {
      await onResend();
      setInfo(`A new code is on its way to ${email}.`);
      setWait(RESEND_WAIT_S);
    } catch (err) {
      setError(authErrorMessage(err));
    }
  }

  const introText = intro ?? <>We emailed a 6-digit code to <strong>{email}</strong>. It expires in a few minutes; check your spam folder if it isn&apos;t there.</>;
  const resendButton = onResend && (
    <button type="button" className={card ? "auth-link" : "text-sm text-muted underline disabled:no-underline disabled:opacity-60"} onClick={() => void resend()} disabled={busy || wait > 0}>
      {wait > 0 ? `Send a new code (${wait}s)` : "Send a new code"}
    </button>
  );

  if (card) {
    return (
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <p className="text-[15px] leading-relaxed text-muted [&_strong]:font-semibold [&_strong]:text-text">{introText}</p>
        {error && <Alert>{error}</Alert>}
        {info && <Alert kind="info">{info}</Alert>}
        <AuthField
          id="code"
          label="Verification code"
          icon={KeyRound}
          className="font-medium tracking-[0.5em]"
          placeholder="••••••"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        />
        {children}
        <AuthSubmit className="mt-2" busy={busy} busyLabel={busyLabel} disabled={code.length !== 6 || !extraValid}>
          {submitLabel}
        </AuthSubmit>
        {resendButton && <p className="text-center">{resendButton}</p>}
      </form>
    );
  }

  return (
    <form onSubmit={submit} className={large ? "space-y-4" : "space-y-3"} noValidate>
      <p className="text-sm">{introText}</p>
      {error && <Alert>{error}</Alert>}
      {info && <Alert kind="info">{info}</Alert>}
      <div>
        <label className="label" htmlFor="code">
          Verification code
        </label>
        <input
          id="code"
          className={large ? "auth-field text-lg tracking-[0.5em]" : "input tracking-[0.5em]"}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        />
      </div>
      {children}
      <button className={large ? "auth-cta" : "btn-primary w-full"} disabled={busy || code.length !== 6 || !extraValid}>
        {busy ? busyLabel : submitLabel}
      </button>
      {resendButton}
    </form>
  );
}
