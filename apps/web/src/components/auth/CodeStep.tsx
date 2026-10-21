"use client";
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Alert } from "@/components/ui";
import { authErrorMessage, challengeFromError, errorCode, type CodeChallenge } from "@/lib/auth";
import { AuthSubmit } from "./AuthCard";

/** Seconds before "Send a new code" works again where the server names no countdown (the older code flows). */
const RESEND_WAIT_S = 30;
const CODE_LENGTH = 6;

/** "00:59": whole seconds left, never negative. */
const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * The server's countdowns on this device's clock. The server said `now` as it answered; the time
 * that has passed on this device since the answer arrived is added to it, so a device whose clock
 * is off still counts the right minute. Re-read four times a second; the moments never move.
 */
function useCountdown(challenge: CodeChallenge | null | undefined) {
  const [tick, setTick] = useState(0);
  /** When this challenge arrived here (this device's clock). */
  const received = useRef<{ challenge: CodeChallenge; at: number } | null>(null);
  useEffect(() => {
    if (!challenge) return;
    received.current = { challenge, at: Date.now() };
    setTick((n) => n + 1);
    const t = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(t);
  }, [challenge]);
  if (!challenge) return null;
  void tick;
  const elapsed = received.current?.challenge === challenge ? Date.now() - received.current.at : 0;
  const serverNow = challenge.now + elapsed;
  return { expiresIn: challenge.expiresAt - serverNow, resendIn: challenge.resendAt - serverNow };
}

/**
 * Six boxes for a 6-digit code: typing moves on, Backspace moves back, the arrow keys move either
 * way, and a code pasted (or filled in by the phone from the email) into any box fills them all.
 * The first box is the one the browser's one-time-code suggestion fills. `onComplete` fires once
 * the sixth digit lands.
 */
export function OtpInput({
  value,
  onChange,
  onComplete,
  disabled = false,
  invalid = false,
  large = false,
  autoFocus = false,
  label = "Verification code",
}: {
  value: string;
  onChange: (code: string) => void;
  onComplete?: (code: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  large?: boolean;
  autoFocus?: boolean;
  label?: string;
}) {
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length: CODE_LENGTH }, (_, i) => value[i] ?? "");

  const focus = (i: number) => boxes.current[Math.max(0, Math.min(CODE_LENGTH - 1, i))]?.focus();

  // A refused code: the boxes were disabled while it was checked (which drops focus), so put the
  // cursor back on the last digit for the correction.
  useEffect(() => {
    if (!disabled && invalid && value.length === CODE_LENGTH) focus(CODE_LENGTH - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the check ends with a refusal
  }, [disabled, invalid]);

  /** `typed` landed in box `at`: write its digits from there on (one key, a paste, an autofill). */
  const write = (at: number, typed: string) => {
    const clean = typed.replace(/\D/g, "");
    if (!clean) return;
    const next = digits.slice();
    let i = at;
    for (const ch of clean) {
      if (i >= CODE_LENGTH) break;
      next[i++] = ch;
    }
    const code = next.join("");
    onChange(code);
    focus(Math.min(i, CODE_LENGTH - 1));
    if (code.length === CODE_LENGTH && onComplete) onComplete(code);
  };

  const clear = (at: number) => {
    const next = digits.slice();
    next[at] = "";
    // Everything after a cleared box shifts left, so the code stays one run of digits.
    onChange(next.join("").replace(/\D/g, ""));
  };

  const onKeyDown = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      if (digits[i]) clear(i);
      else if (i > 0) {
        clear(i - 1);
        focus(i - 1);
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focus(i - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      focus(i + 1);
    } else if (e.key === "Delete") {
      e.preventDefault();
      clear(i);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    write(0, e.clipboardData.getData("text"));
  };

  const size = large ? "h-14 text-2xl" : "h-12 text-xl";
  return (
    <div role="group" aria-label={label} className={`grid grid-cols-6 gap-2 ${large ? "max-w-[22rem]" : "max-w-[19rem]"}`}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            boxes.current[i] = el;
          }}
          className={`${size} w-full min-w-0 rounded-xl border bg-[color-mix(in_oklab,var(--bg)_55%,var(--surface))] text-center font-semibold tabular-nums text-text outline-none transition focus:border-accent focus:ring-2 focus:ring-[color-mix(in_oklab,var(--accent)_28%,transparent)] disabled:opacity-60 ${
            invalid ? "border-danger" : "border-border"
          }`}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${i + 1} of ${CODE_LENGTH}`}
          aria-invalid={invalid || undefined}
          autoFocus={autoFocus && i === 0}
          disabled={disabled}
          value={d}
          onChange={(e) => (e.target.value ? write(i, e.target.value) : clear(i))}
          onKeyDown={onKeyDown(i)}
          onPaste={onPaste}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}

/**
 * "Enter the 6-digit code we emailed you": sign-up confirmation, the code after the password,
 * email verification, an email change, a sign-in code. The caller says what a code does
 * (`onSubmit`) and how to get another (`onResend`).
 *
 * With `challenge` (the server's countdowns, apps/api/src/emailCode.ts) the step shows how long
 * the code lasts and when another may be asked for, and refuses to send a code it knows has
 * expired; the server enforces both whatever the page shows. A resend's answer, or a refused
 * resend (`resend_cooldown`), carries the countdowns of the code that now counts.
 *
 * `large`: the split sign-in pages' field and button (AuthSplitShell). `card`: AuthCard's field and
 * button (the raised-card pages).
 */
export function CodeStep({
  email,
  intro,
  submitLabel,
  busyLabel = "Verifying…",
  successLabel = "Email verified successfully.",
  onSubmit,
  onResend,
  onChangeEmail,
  changeEmailLabel = "Use a different email address",
  challenge: initialChallenge,
  children,
  extraValid = true,
  large = false,
  card = false,
}: {
  email: string;
  intro?: ReactNode;
  submitLabel: string;
  busyLabel?: string;
  /** Shown once `onSubmit` has resolved (the caller usually moves on a moment later). */
  successLabel?: string;
  onSubmit: (code: string) => Promise<void>;
  /** May resolve to `{ challenge }`: the new code's countdowns. */
  onResend?: () => Promise<unknown>;
  /** "Use a different email address" under the form. */
  onChangeEmail?: () => void | Promise<void>;
  changeEmailLabel?: string;
  /** The server's countdowns for the code sent; absent for codes with no fixed minute (an authenticator app's, Cognito's 24-hour ones). */
  challenge?: CodeChallenge | null;
  /** More fields that go with the code (the new password, on a reset). */
  children?: ReactNode;
  extraValid?: boolean;
  large?: boolean;
  card?: boolean;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<CodeChallenge | null>(initialChallenge ?? null);
  const [wait, setWait] = useState(RESEND_WAIT_S);
  const submittedFor = useRef<string | null>(null);

  // A new code from the caller (another tab's resend, a reload): its countdowns replace these.
  useEffect(() => setChallenge(initialChallenge ?? null), [initialChallenge]);

  useEffect(() => {
    if (challenge || wait <= 0) return;
    const t = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(t);
  }, [wait, challenge]);

  const countdown = useCountdown(challenge);
  const expired = !!countdown && countdown.expiresIn <= 0;
  const canResend = !!onResend && !busy && (challenge ? countdown!.resendIn <= 0 : wait <= 0);

  const submit = useCallback(
    async (value: string) => {
      if (busy || done || value.length !== CODE_LENGTH || !extraValid) return;
      if (expired) {
        setError("This code has expired. Request a new code.");
        return;
      }
      setBusy(true);
      setError(null);
      setInfo(null);
      try {
        await onSubmit(value);
        setDone(true);
      } catch (err) {
        setError(authErrorMessage(err));
        // A spent or ended code: the boxes are cleared for the next one.
        if (errorCode(err) === "expired_code" || errorCode(err) === "too_many_attempts") setCode("");
      } finally {
        setBusy(false);
      }
    },
    [busy, done, extraValid, expired, onSubmit],
  );

  function onFormSubmit(e: FormEvent) {
    e.preventDefault();
    void submit(code);
  }

  /** The sixth digit just landed: send it, once per code typed. */
  function onComplete(value: string) {
    if (submittedFor.current === value) return;
    submittedFor.current = value;
    void submit(value);
  }

  function onCodeChange(value: string) {
    setCode(value);
    if (error && value.length < CODE_LENGTH) setError(null);
    if (value.length < CODE_LENGTH) submittedFor.current = null;
  }

  async function resend() {
    if (!onResend || !canResend) return;
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const r = (await onResend()) as { challenge?: CodeChallenge } | undefined;
      setCode("");
      submittedFor.current = null;
      setInfo("A new verification code has been sent.");
      if (r?.challenge) setChallenge(r.challenge);
      else setWait(RESEND_WAIT_S);
    } catch (err) {
      // Too soon (another tab asked first): the standing code's countdowns, and its message.
      const standing = challengeFromError(err);
      if (standing) setChallenge(standing);
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const introText = intro ?? (
    <>
      We sent a 6-digit verification code to <strong>{email}</strong>.{challenge ? " Enter it below before it expires." : " It expires in a few minutes; check your spam folder if it isn't there."}
    </>
  );

  const timers = challenge && countdown && (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm" data-testid="code-timers">
      {expired ? (
        <p role="status" className="font-medium text-danger">
          This code has expired. Request a new code.
        </p>
      ) : (
        <p className="text-muted">
          Code expires in{" "}
          <span className="font-semibold tabular-nums text-text" data-testid="code-expires-in">
            {clock(countdown.expiresIn)}
          </span>
        </p>
      )}
      {onResend && (
        <p className="text-muted">
          Didn&apos;t receive the code?{" "}
          {countdown.resendIn > 0 ? (
            <span data-testid="code-resend-in">
              Resend code in <span className="font-semibold tabular-nums text-text">{clock(countdown.resendIn)}</span>
            </span>
          ) : (
            <button type="button" className="font-semibold text-accent underline underline-offset-2 disabled:no-underline disabled:opacity-60" onClick={() => void resend()} disabled={!canResend}>
              Resend verification code
            </button>
          )}
        </p>
      )}
    </div>
  );

  const plainResend = !challenge && onResend && (
    <button type="button" className={card ? "auth-link" : "text-sm text-muted underline disabled:no-underline disabled:opacity-60"} onClick={() => void resend()} disabled={!canResend}>
      {wait > 0 ? `Send a new code (${wait}s)` : "Send a new code"}
    </button>
  );

  const changeEmail = onChangeEmail && (
    <button type="button" className={card ? "auth-link" : "text-sm text-muted underline"} onClick={() => void onChangeEmail()} disabled={busy}>
      {changeEmailLabel}
    </button>
  );

  const boxes = (
    <div>
      <p className={card ? "mb-2 block text-[15px] font-semibold text-text" : "label"} id="code-label">
        Verification code
      </p>
      <OtpInput value={code} onChange={onCodeChange} onComplete={onComplete} disabled={busy || done || expired} invalid={!!error} large={large || card} autoFocus />
    </div>
  );

  const messages = (
    <>
      {error && <Alert>{error}</Alert>}
      {info && !error && <Alert kind="info">{info}</Alert>}
      {done && <Alert kind="success">{successLabel}</Alert>}
    </>
  );

  if (card) {
    return (
      <form onSubmit={onFormSubmit} className="flex flex-col gap-4" noValidate>
        <p className="text-[15px] leading-relaxed text-muted [&_strong]:font-semibold [&_strong]:text-text">{introText}</p>
        {messages}
        {boxes}
        {timers}
        {children}
        <AuthSubmit className="mt-2" busy={busy} busyLabel={busyLabel} disabled={done || expired || code.length !== CODE_LENGTH || !extraValid}>
          {submitLabel}
        </AuthSubmit>
        {(plainResend || changeEmail) && (
          <p className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-center">
            {plainResend}
            {changeEmail}
          </p>
        )}
      </form>
    );
  }

  return (
    <form onSubmit={onFormSubmit} className={large ? "space-y-4" : "space-y-3"} noValidate>
      <p className="text-sm [&_strong]:font-semibold">{introText}</p>
      {messages}
      {boxes}
      {timers}
      {children}
      <button className={large ? "auth-cta" : "btn-primary w-full"} disabled={busy || done || expired || code.length !== CODE_LENGTH || !extraValid}>
        {busy ? busyLabel : submitLabel}
      </button>
      {(plainResend || changeEmail) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {plainResend}
          {changeEmail}
        </div>
      )}
    </form>
  );
}
