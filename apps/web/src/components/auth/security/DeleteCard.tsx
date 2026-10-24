"use client";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { Mail, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/AppUi";
import { Alert } from "@/components/ui";
import { clock, OtpInput, useCountdown } from "@/components/auth/CodeStep";
import { authErrorMessage, challengeFromError, deleteAccount, errorCode, sendDeletionCode, type CodeChallenge } from "@/lib/auth";
import { ToneIcon, tone } from "./ui";

const CODE_LENGTH = 6;

/**
 * Deleting the account: typed DELETE, and a 6-digit code emailed to the account's address
 * (apps/api/src/routes/account.ts), whatever the session signed in with. No password field: beside
 * one, the browser's password manager took the DELETE box for the username and filled the account's
 * address into it. The address isn't shown in the dialog either.
 */
export function DeleteCard() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [code, setCode] = useState("");
  /** The emailed code's countdowns (the server's clock); null until one is sent. */
  const [challenge, setChallenge] = useState<CodeChallenge | null>(null);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const countdown = useCountdown(challenge);
  const expired = !!countdown && countdown.expiresIn <= 0;
  const canResend = !!countdown && countdown.resendIn <= 0 && !sending && !busy;
  const ready = typed === "DELETE" && code.length === CODE_LENGTH && !!challenge && !expired;

  const cancel = useCallback(() => {
    setOpen(false);
    setTyped("");
    setCode("");
    setChallenge(null);
    setError(null);
    setInfo(null);
  }, []);

  async function sendCode() {
    const again = !!challenge;
    // The first code waits for DELETE; "Send a new code" doesn't.
    if (sending || (!again && typed !== "DELETE")) return;
    setSending(true);
    setError(null);
    setInfo(null);
    try {
      const r = await sendDeletionCode();
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

  async function remove() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await deleteAccount(code);
      router.replace("/login?deleted=1");
    } catch (err) {
      setError(authErrorMessage(err));
      const why = errorCode(err);
      // A spent or ended code: the boxes are cleared, and one that's gone for good is asked for again.
      if (why === "expired_code" || why === "too_many_attempts" || why === "code_required") setCode("");
      if (why === "too_many_attempts" || why === "code_required") setChallenge(null);
      setBusy(false);
    }
  }

  return (
    <section className="tone-card rounded-xl border p-5 shadow-[var(--shadow)]" style={tone("danger")} aria-labelledby="delete-h">
      <div className="flex items-start gap-3.5">
        <ToneIcon icon={Trash2} t="danger" size="sm" />
        <div className="min-w-0">
          <h2 id="delete-h" className="text-base font-semibold text-danger">
            Delete account
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            Permanently deletes your sign-in and your personal account. This can&apos;t be undone. Workspaces you own with no other owner must be deleted or handed over first; workspaces others own keep running without you.
          </p>
          <button type="button" className="btn-danger mt-4 min-h-11" onClick={() => setOpen(true)}>
            Delete my account
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={open}
        title="Delete your account?"
        confirmLabel={busy ? "Deleting…" : "Delete account"}
        danger
        busy={busy}
        confirmDisabled={!ready}
        onCancel={cancel}
        onConfirm={() => void remove()}
      >
        <div className="space-y-4">
          <p>This can&apos;t be undone.</p>
          <div>
            <label className="label" htmlFor="type-delete">
              Type DELETE to confirm
            </label>
            {/* Not a username: no password manager may fill or offer anything here. */}
            <input
              id="type-delete"
              name="confirm-delete"
              className="input"
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              data-form-type="other"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
          {challenge ? (
            <div className="space-y-2">
              <p className="label">Code from the email</p>
              <p>We emailed a 6-digit code to your account&apos;s email address. Enter it below to delete your account.</p>
              <OtpInput value={code} onChange={setCode} disabled={busy || expired} invalid={!!error} label="Code from the email" autoFocus />
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
                  <button type="button" className="font-semibold text-accent underline underline-offset-2 disabled:no-underline disabled:opacity-60" onClick={() => void sendCode()} disabled={!canResend}>
                    {sending ? "Sending…" : "Send a new code"}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-bg/40 p-3.5">
              <p>To confirm it&apos;s you, we&apos;ll email a 6-digit code to your account&apos;s email address.</p>
              <button type="button" className="btn-secondary mt-3 min-h-10 px-4" onClick={() => void sendCode()} disabled={sending || typed !== "DELETE"}>
                <Mail size={16} aria-hidden />
                {sending ? "Sending…" : "Email me a code"}
              </button>
              {typed !== "DELETE" && <p className="mt-2 text-xs">Type DELETE above first.</p>}
            </div>
          )}
          {error && <Alert>{error}</Alert>}
          {info && !error && <Alert kind="info">{info}</Alert>}
        </div>
      </ConfirmDialog>
    </section>
  );
}
