"use client";
import { useCallback, useState } from "react";
import { Mail } from "lucide-react";
import { Alert } from "@/components/ui";
import { clock, OtpInput, useCountdown } from "@/components/auth/CodeStep";
import { authErrorMessage, challengeFromError, errorCode, type CodeChallenge } from "@/lib/auth";
import { CONTACT } from "@/lib/contact";

const CODE_LENGTH = 6;

/**
 * The 6-digit code, emailed to the account's address, that confirms a deletion
 * (apps/api/src/deletion.ts): the account's (DeleteCard) or a workspace's (DeleteWorkspaceCard).
 * `send` asks the API for one; its countdowns are the server's clock.
 */
export function useDeletionCode(send: () => Promise<{ challenge: CodeChallenge }>) {
  const [code, setCode] = useState("");
  /** The emailed code's countdowns; null until one is sent. */
  const [challenge, setChallenge] = useState<CodeChallenge | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const countdown = useCountdown(challenge);
  const expired = !!countdown && countdown.expiresIn <= 0;

  const reset = useCallback(() => {
    setCode("");
    setChallenge(null);
    setError(null);
    setInfo(null);
  }, []);

  async function sendCode() {
    if (sending) return;
    const again = !!challenge;
    setSending(true);
    setError(null);
    setInfo(null);
    try {
      const r = await send();
      setChallenge(r.challenge);
      setCode("");
      if (again) setInfo("A new code has been sent.");
    } catch (err) {
      // Asked again too soon (the dialog reopened within the minute): the code already sent still counts.
      const standing = challengeFromError(err);
      if (standing) {
        setChallenge(standing);
        setInfo(`We already emailed you a code. Enter it below. ${authErrorMessage(err)}`);
      } else setError(authErrorMessage(err));
    } finally {
      setSending(false);
    }
  }

  /** The deletion was refused: say why, and clear what the refusal ended (a spent or ended code is asked for again). */
  function refused(err: unknown) {
    // A 503's own words never reach the page (lib/apiClient.ts): this one's are here.
    setError(
      errorCode(err) === "deletion_incomplete"
        ? `We couldn't finish deleting everything. What was already removed stays removed. Try again in a few minutes; if it fails again, email ${CONTACT.supportEmail} and we'll finish it.`
        : authErrorMessage(err),
    );
    const why = errorCode(err);
    if (why === "expired_code" || why === "too_many_attempts" || why === "code_required" || why === "deletion_incomplete") setCode("");
    if (why === "too_many_attempts" || why === "code_required" || why === "deletion_incomplete") setChallenge(null);
  }

  return { code, setCode, challenge, sending, error, setError, info, countdown, expired, ready: code.length === CODE_LENGTH && !!challenge && !expired, sendCode, refused, reset };
}

export type DeletionCodeState = ReturnType<typeof useDeletionCode>;

/**
 * The code's part of a deletion dialog: "Email me a code" (once `canSend`; `hint` says what comes
 * first) until one is sent, then its boxes, its countdowns and "Send a new code". `purpose` ends
 * "Enter it below to …".
 */
export function DeletionCodeField({ state, busy, canSend, hint, purpose }: { state: DeletionCodeState; busy: boolean; canSend: boolean; hint: string | null; purpose: string }) {
  const { challenge, countdown, expired, sending } = state;
  const canResend = !!countdown && countdown.resendIn <= 0 && !sending && !busy;
  return (
    <>
      {challenge ? (
        <div className="space-y-2">
          <p className="label">Code from the email</p>
          <p>We emailed a 6-digit code to your account&apos;s email address. Enter it below to {purpose}.</p>
          <OtpInput value={state.code} onChange={state.setCode} disabled={busy || expired} invalid={!!state.error} label="Code from the email" autoFocus />
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1" data-testid="delete-code-timers">
            {expired ? (
              <p role="status" className="font-medium text-danger">
                This code has expired. Request a new code.
              </p>
            ) : (
              <p>
                Code expires in <span className="font-semibold tabular-nums text-text">{clock(countdown?.expiresIn ?? 0)}</span>
              </p>
            )}
            {countdown && countdown.resendIn > 0 ? (
              <p>
                Resend code in <span className="font-semibold tabular-nums text-text">{clock(countdown.resendIn)}</span>
              </p>
            ) : (
              <button type="button" className="font-semibold text-accent underline underline-offset-2 disabled:no-underline disabled:opacity-60" onClick={() => void state.sendCode()} disabled={!canResend}>
                {sending ? "Sending…" : "Send a new code"}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-bg/40 p-3.5">
          <p>To confirm it&apos;s you, we&apos;ll email a 6-digit code to your account&apos;s email address.</p>
          <button type="button" className="btn-secondary mt-3 min-h-10 px-4" onClick={() => canSend && void state.sendCode()} disabled={sending || !canSend}>
            <Mail size={16} aria-hidden />
            {sending ? "Sending…" : "Email me a code"}
          </button>
          {hint && <p className="mt-2 text-xs">{hint}</p>}
        </div>
      )}
      {state.error && <Alert>{state.error}</Alert>}
      {state.info && !state.error && <Alert kind="info">{state.info}</Alert>}
    </>
  );
}

/** "Type DELETE to confirm": a box no password manager may fill or offer anything for. */
export function TypeDelete({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        Type DELETE to confirm
      </label>
      {/* Not a username: no password manager may fill or offer anything here. */}
      <input
        id={id}
        name={`confirm-${id}`}
        className="input"
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        data-form-type="other"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
